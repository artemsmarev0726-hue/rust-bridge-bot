const { ActivityType } = require('discord.js');
const { log } = require('./util');

const TYPES = {
  custom: ActivityType.Custom,
  watching: ActivityType.Watching,
  playing: ActivityType.Playing,
  listening: ActivityType.Listening,
  competing: ActivityType.Competing,
};

/**
 * Статус бота по кругу: кадр 1 → через N секунд кадр 2 → …
 * По умолчанию: «👥 Участников: {members}» ⇄ «🟢 Онлайн: {online}» каждые 5 секунд.
 *
 * Плейсхолдеры: {members} {online} — Discord;
 * {server_online} {server_max} {server_queue} {server_joining} — Rust-сервер (присылает плагин DiscordBridge).
 *
 * Счётчики берутся из approximate_member_count / approximate_presence_count — привилегированные
 * интенты (Server Members / Presence) для этого не нужны. Запрашиваются реже, чем меняются кадры.
 */
function startPresence(client, cfg, getGuildId, link) {
  const pc = cfg.presence;
  if (pc.enabled === false) return;
  const type = TYPES[String(pc.type || 'custom').toLowerCase()] ?? ActivityType.Custom;
  const frames = (Array.isArray(pc.frames) && pc.frames.length ? pc.frames : ['👥 Участников: {members}', '🟢 Онлайн: {online}'])
    .map(String);
  // Discord пропускает не больше ~5 смен статуса за 20 с — ниже 4 с не опускаемся
  const frameMs = Math.max(4, Number(pc.frameSeconds) || 5) * 1000;
  const countsMs = Math.max(15, Number(pc.countsRefreshSeconds) || 30) * 1000;

  let members = null;
  let online = null;
  let frame = 0;
  let lastText = null;
  let lastSetAt = 0;

  async function refreshCounts() {
    try {
      const gid = getGuildId();
      if (!gid) return;
      const guild = await client.guilds.fetch({ guild: gid, withCounts: true, force: true });
      members = guild.approximateMemberCount ?? guild.memberCount ?? members;
      online = guild.approximatePresenceCount ?? online;
    } catch (e) {
      log('[presence] не удалось получить счётчики:', e.message);
    }
  }

  function render(tpl) {
    const st = link?.getStatus();
    const off = pc.serverOfflineText ?? 'офлайн';
    return tpl
      .replace(/\{members\}/g, members ?? '…')
      .replace(/\{online\}/g, online ?? '…')
      .replace(/\{server_online\}/g, st ? st.online : off)
      .replace(/\{server_max\}/g, st ? st.max : '—')
      .replace(/\{server_queue\}/g, st ? st.queue : 0)
      .replace(/\{server_joining\}/g, st ? st.joining : 0)
      .slice(0, 128);
  }

  function show() {
    if (!client.isReady() || members === null) return;
    const text = render(frames[frame % frames.length]);
    frame++;
    // Одинаковый кадр не отправляем, но раз в 2 минуты обновляем в любом случае (после реконнекта статус сбрасывается)
    if (text === lastText && Date.now() - lastSetAt < 120_000) return;
    const activity = type === ActivityType.Custom ? { name: 'Custom Status', state: text, type } : { name: text, type };
    try {
      client.user.setPresence({ activities: [activity], status: 'online' });
      lastText = text;
      lastSetAt = Date.now();
    } catch (e) {
      log('[presence] ошибка:', e.message);
    }
  }

  client.on('shardResume', () => { lastText = null; });
  refreshCounts().then(show);
  setInterval(refreshCounts, countsMs);
  setInterval(show, frameMs);
  log(`[presence] кадров: ${frames.length}, смена каждые ${frameMs / 1000} с`);
}

module.exports = { startPresence };
