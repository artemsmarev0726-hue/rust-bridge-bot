const { EmbedBuilder } = require('discord.js');
const { log, formatDuration, twitchLogin, escapeMd, JsonStore, isSteamId, placeholder } = require('./util');

/**
 * Следит за стримерами из конфига через Twitch Helix API.
 * Начало стрима -> сообщение в канал; конец -> сообщение с длительностью (ответом на стартовое).
 * Состояние хранится в data/streams.json, поэтому перезапуск бота не шлёт дубли,
 * а если стрим закончился, пока бот был выключен, — конец всё равно будет объявлен.
 * Суммарное время стримов за вайп — data/stream-stats.json (обнуляется /reset и вайпом).
 */
class TwitchWatcher {
  constructor(client, cfg) {
    this.client = client;
    this.cfg = cfg.twitch;
    this.token = null;
    this.tokenExpires = 0;
    this.busy = false;
    this.enabled = false;
    this.state = new JsonStore('streams.json', () => ({ streams: {} }));
    this.stats = new JsonStore('stream-stats.json', () => ({ since: new Date().toISOString(), streams: {} }));

    this.streamers = [];
    for (const s of this.cfg.streamers || []) {
      const login = twitchLogin(s.url);
      if (!login) { log(`[twitch] не понял ссылку: ${s.url}`); continue; }
      const steamId = String(s.steamId || '').trim();
      if (steamId && !isSteamId(steamId)) log(`[twitch] ${login}: steamId «${steamId}» не похож на SteamID64 — время на сервере не покажу`);
      this.streamers.push({ login, url: `https://www.twitch.tv/${login}`, steamId: isSteamId(steamId) ? steamId : '' });
    }
  }

  start() {
    if (!this.cfg || this.cfg.enabled === false) return;
    if (placeholder(this.cfg.clientId) || placeholder(this.cfg.clientSecret)) {
      log('[twitch] не заданы clientId/clientSecret — отслеживание стримов выключено');
      return;
    }
    if (!this.streamers.length) { log('[twitch] список стримеров пуст'); return; }
    this.enabled = true;
    log(`[twitch] слежу за: ${this.streamers.map((s) => s.login).join(', ')}`);
    this.tick();
    setInterval(() => this.tick(), Math.max(30, this.cfg.checkIntervalSec || 60) * 1000);
  }

  async getToken(force = false) {
    if (!force && this.token && Date.now() < this.tokenExpires - 60_000) return this.token;
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      grant_type: 'client_credentials',
    });
    const res = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body: params });
    if (!res.ok) throw new Error(`token HTTP ${res.status}: ${await res.text()}`);
    const j = await res.json();
    this.token = j.access_token;
    this.tokenExpires = Date.now() + j.expires_in * 1000;
    return this.token;
  }

  async helix(path, retry = true) {
    const token = await this.getToken();
    const res = await fetch(`https://api.twitch.tv/helix/${path}`, {
      headers: { 'Client-Id': this.cfg.clientId, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 && retry) {
      await this.getToken(true);
      return this.helix(path, false);
    }
    if (!res.ok) throw new Error(`helix ${path.split('?')[0]} HTTP ${res.status}`);
    return res.json();
  }

  /** Возвращает Map(login -> stream) для тех, кто сейчас в эфире. */
  async fetchLive() {
    const live = new Map();
    const logins = this.streamers.map((s) => s.login);
    for (let i = 0; i < logins.length; i += 100) {
      const q = logins.slice(i, i + 100).map((l) => `user_login=${encodeURIComponent(l)}`).join('&');
      const j = await this.helix(`streams?first=100&${q}`);
      for (const s of j.data || []) {
        if (s.type === 'live') live.set(String(s.user_login).toLowerCase(), s);
      }
    }
    return live;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      let live;
      try {
        live = await this.fetchLive();
      } catch (e) {
        // Ошибка API — пропускаем проверку целиком, чтобы не засчитать ложный «оффлайн»
        log('[twitch] ошибка запроса:', e.message);
        return;
      }
      const now = Date.now();
      const need = Math.max(1, this.cfg.offlineConfirmChecks || 2);

      for (const s of this.streamers) {
        const st = this.state.data.streams[s.login] || (this.state.data.streams[s.login] = { live: false });
        const stream = live.get(s.login);

        if (stream) {
          if (st.live && st.streamId !== stream.id) {
            // Стрим перезапустили — закрываем старый и открываем новый
            await this.announceEnd(s, st);
          }
          if (!st.live || st.streamId !== stream.id) {
            const startedAt = Date.parse(stream.started_at) || now;
            Object.assign(st, {
              live: true,
              streamId: stream.id,
              startedAt,
              // Время стрима, начатого до сброса статистики, считаем только с момента сброса
              countFrom: Math.max(startedAt, Date.parse(this.stats.data.since) || 0),
              lastSeenAt: now,
              offlineCount: 0,
              displayName: stream.user_name,
              title: stream.title,
              game: stream.game_name,
              messageId: null,
            });
            st.messageId = await this.announceStart(s, stream);
          } else {
            Object.assign(st, { lastSeenAt: now, offlineCount: 0, title: stream.title, game: stream.game_name, displayName: stream.user_name });
          }
        } else if (st.live) {
          st.offlineCount = (st.offlineCount || 0) + 1;
          if (st.offlineCount >= need) await this.announceEnd(s, st);
        }
      }
      this.state.save();
    } catch (e) {
      log('[twitch] ошибка:', e);
    } finally {
      this.busy = false;
    }
  }

  async channel() {
    const id = this.cfg.notifyChannelId;
    if (placeholder(id)) return null;
    try {
      return await this.client.channels.fetch(id);
    } catch (e) {
      log('[twitch] не найден канал уведомлений:', id, e.message);
      return null;
    }
  }

  async announceStart(s, stream) {
    const ch = await this.channel();
    if (!ch) return null;
    const name = stream.user_name || s.login;
    const thumb = String(stream.thumbnail_url || '')
      .replace('{width}', '1280').replace('{height}', '720') + `?t=${Date.now()}`;
    const embed = new EmbedBuilder()
      .setColor(0x9146ff)
      .setAuthor({ name: `${name} начал стрим!`, url: s.url })
      .setTitle(stream.title ? stream.title.slice(0, 256) : s.url)
      .setURL(s.url)
      .addFields(
        { name: 'Игра', value: escapeMd(stream.game_name || '—'), inline: true },
        { name: 'Начало', value: `<t:${Math.floor(Date.parse(stream.started_at) / 1000)}:t>`, inline: true },
      )
      .setImage(thumb)
      .setTimestamp(new Date(stream.started_at));
    const content = [this.cfg.mentionOnStart, `🔴 **${escapeMd(name)}** в эфире: ${s.url}`].filter(Boolean).join(' ');
    try {
      const msg = await ch.send({ content, embeds: [embed], allowedMentions: { parse: ['everyone', 'roles'] } });
      log(`[twitch] ${s.login}: стрим начался`);
      return msg.id;
    } catch (e) {
      log('[twitch] не удалось отправить уведомление о начале:', e.message);
      return null;
    }
  }

  async announceEnd(s, st) {
    const endedAt = st.lastSeenAt || Date.now();
    const duration = Math.max(0, Math.floor((endedAt - st.startedAt) / 1000));
    const counted = Math.max(0, Math.floor((endedAt - (st.countFrom || st.startedAt)) / 1000));
    const name = st.displayName || s.login;
    st.live = false;
    st.offlineCount = 0;
    this.addStream(s.login, name, counted);
    log(`[twitch] ${s.login}: стрим окончен, ${formatDuration(duration)}`);

    if (this.cfg.announceEnd === false) return;
    const ch = await this.channel();
    if (!ch) return;
    const embed = new EmbedBuilder()
      .setColor(0x6b6b76)
      .setAuthor({ name: `${name} закончил стрим`, url: s.url })
      .setDescription(`⏹️ Стрим окончен.\n⏱️ Стримил: **${formatDuration(duration)}**`)
      .addFields(
        { name: 'Начало', value: `<t:${Math.floor(st.startedAt / 1000)}:f>`, inline: true },
        { name: 'Конец', value: `<t:${Math.floor(endedAt / 1000)}:f>`, inline: true },
      )
      .setTimestamp(new Date(endedAt));
    if (st.title) embed.setTitle(st.title.slice(0, 256)).setURL(s.url);
    try {
      await ch.send({
        embeds: [embed],
        reply: st.messageId ? { messageReference: st.messageId, failIfNotExists: false } : undefined,
        allowedMentions: { repliedUser: false, parse: [] },
      });
    } catch (e) {
      log('[twitch] не удалось отправить уведомление о конце:', e.message);
    }
  }

  addStream(login, name, seconds) {
    const d = this.stats.data.streams;
    const e = d[login] || (d[login] = { name, seconds: 0, count: 0 });
    e.name = name || e.name;
    e.seconds += seconds;
    e.count += 1;
    this.stats.save();
  }

  /** Сводка по стримеру за текущий период (с учётом идущего сейчас стрима). */
  summary(s) {
    const t = this.stats.data.streams[s.login] || { name: s.login, seconds: 0, count: 0 };
    const st = this.state.data.streams[s.login];
    const live = !!st?.live;
    const now = Date.now();
    const currentSec = live ? Math.max(0, Math.floor((now - st.startedAt) / 1000)) : 0;
    const currentCounted = live ? Math.max(0, Math.floor((now - (st.countFrom || st.startedAt)) / 1000)) : 0;
    return {
      name: st?.displayName || t.name || s.login,
      live,
      title: live ? st.title : null,
      game: live ? st.game : null,
      startedAt: live ? st.startedAt : null,
      currentSec,
      totalSec: t.seconds + currentCounted,
      count: t.count + (live ? 1 : 0),
    };
  }

  /** Обнуляет время стримов (копия — в data/backups). Идущие стримы дальше считаются с этого момента. */
  reset(reason) {
    const file = this.stats.backup('streams');
    const now = Date.now();
    this.stats.data = { since: new Date(now).toISOString(), streams: {} };
    this.stats.save();
    for (const st of Object.values(this.state.data.streams)) if (st.live) st.countFrom = now;
    this.state.save();
    log(`[twitch] время стримов обнулено (${reason}), копия: ${file}`);
    return file;
  }

  /** steamId -> стример */
  bySteamId() {
    const map = new Map();
    for (const s of this.streamers) if (s.steamId) map.set(s.steamId, s);
    return map;
  }
}

module.exports = { TwitchWatcher };
