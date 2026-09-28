const crypto = require('crypto');
const { Routes } = require('discord.js');
const { log, JsonStore, isSnowflake } = require('./util');

const DROP_STATUSES = new Set([400, 401, 403, 404, 405, 413]);

/**
 * Очередь всего, что бот отправляет в Discord за плагины: сообщения в каналы,
 * личные сообщения, выдача/снятие ролей.
 *
 * - Хранится на диске (data/outbox.json) — переживает перезапуск бота.
 * - Порядок внутри одного канала / получателя сохраняется.
 * - 429 обрабатывает сама библиотека discord.js (ждёт retry_after).
 * - Сеть/5xx — повтор с паузой 2 с → 4 → … → 5 мин.
 * - 400/401/403/404/413 — сообщение битое или адресат недоступен: выбрасываем с записью в лог.
 */
class Outbox {
  constructor(client, cfg, getGuildId) {
    this.client = client;
    this.cfg = cfg;
    this.getGuildId = getGuildId;
    this.maxQueue = Math.max(100, cfg.outbox.maxQueue || 5000);
    this.maxAgeMs = Math.max(1, cfg.outbox.maxAgeHours || 48) * 3600_000;
    this.store = new JsonStore('outbox.json', () => ({ items: [] }));
    this.busy = new Set();          // ключи адресатов, по которым сейчас идёт запрос
    this.channelOk = new Map();     // channelId -> true/false (канал на нашем сервере?)
    this.sent = 0;
    this.dropped = 0;
    this.timer = null;
  }

  get items() { return this.store.data.items; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), 250);
    if (this.items.length) log(`[outbox] в очереди с прошлого запуска: ${this.items.length}`);
  }

  /** Сообщение в канал. payload — { content?, embeds?, allowed_mentions? }. */
  channel(channelId, payload) {
    if (!isSnowflake(channelId)) { log(`[outbox] неверный ID канала: ${channelId}`); return false; }
    return this.push({ kind: 'channel', target: String(channelId), payload: cleanPayload(payload) });
  }

  dm(userId, payload) {
    if (!isSnowflake(userId)) return false;
    return this.push({ kind: 'dm', target: String(userId), payload: cleanPayload(payload) });
  }

  role(userId, roleId, add) {
    if (!isSnowflake(userId) || !isSnowflake(roleId)) return false;
    return this.push({ kind: 'role', target: String(userId), payload: { roleId: String(roleId), add: !!add } });
  }

  push(item) {
    if (item.kind !== 'role' && !item.payload) return false;
    item.id = crypto.randomUUID();
    item.createdAt = Date.now();
    item.attempts = 0;
    item.nextAt = 0;
    this.items.push(item);
    while (this.items.length > this.maxQueue) { this.items.shift(); this.dropped++; }
    this.store.saveSoon();
    return true;
  }

  key(item) { return `${item.kind}:${item.target}`; }

  pump() {
    if (!this.client?.isReady()) return;
    const now = Date.now();
    const seen = new Set();
    let expired = 0;
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (now - item.createdAt > this.maxAgeMs) { this.items.splice(i--, 1); expired++; continue; }
      const k = this.key(item);
      if (seen.has(k)) continue;        // только голова очереди каждого адресата
      seen.add(k);
      if (this.busy.has(k) || item.nextAt > now) continue;
      this.busy.add(k);
      this.deliver(item).finally(() => {
        this.busy.delete(k);
        setImmediate(() => this.pump()); // следующее сообщение этого адресата — сразу, без ожидания тика
      });
    }
    if (expired) { this.dropped += expired; log(`[outbox] выброшено устаревших: ${expired}`); this.store.saveSoon(); }
  }

  remove(item) {
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
    this.store.saveSoon();
  }

  async deliver(item) {
    item.attempts++;
    try {
      if (item.kind === 'channel') {
        if (!(await this.checkChannel(item.target))) {
          this.remove(item); this.dropped++;
          return;
        }
        await this.client.rest.post(Routes.channelMessages(item.target), { body: item.payload });
      } else if (item.kind === 'dm') {
        const user = await this.client.users.fetch(item.target);
        const dm = await user.createDM();
        await this.client.rest.post(Routes.channelMessages(dm.id), { body: item.payload });
      } else if (item.kind === 'role') {
        const gid = this.getGuildId();
        if (!gid) throw Object.assign(new Error('guild unknown'), { status: 503 });
        const route = Routes.guildMemberRole(gid, item.target, item.payload.roleId);
        if (item.payload.add) await this.client.rest.put(route);
        else await this.client.rest.delete(route);
      }
      this.remove(item);
      this.sent++;
    } catch (e) {
      const status = Number(e.status || e.httpStatus || 0);
      if (DROP_STATUSES.has(status)) {
        this.remove(item); this.dropped++;
        log(`[outbox] ${item.kind} ${item.target}: Discord отказал (${status} ${e.code || ''} ${e.message}) — выброшено`);
        if (item.kind === 'channel' && (status === 403 || status === 404)) this.channelOk.delete(item.target);
        return;
      }
      const delay = Math.min(300_000, 2000 * 2 ** Math.min(item.attempts - 1, 8));
      item.nextAt = Date.now() + delay;
      if (item.attempts === 1 || item.attempts % 10 === 0) {
        log(`[outbox] ${item.kind} ${item.target}: ошибка (${status || e.code || e.message}), повтор через ${Math.round(delay / 1000)} с`);
      }
    }
  }

  /** Бот пишет только в каналы своего сервера — чужой ID канала от плагина не пройдёт. */
  async checkChannel(id) {
    if (this.channelOk.has(id)) return this.channelOk.get(id);
    let ok = false;
    try {
      const ch = await this.client.channels.fetch(id);
      const gid = this.getGuildId();
      ok = !!ch && typeof ch.isTextBased === 'function' && ch.isTextBased() && (!gid || ch.guildId === gid);
      if (!ok) log(`[outbox] канал ${id} не текстовый или не на нашем сервере — сообщения туда не отправляются`);
    } catch (e) {
      const status = Number(e.status || 0);
      if (!DROP_STATUSES.has(status)) throw e; // сеть — повторим позже
      log(`[outbox] канал ${id} недоступен боту (${status}). Проверь ID и права «Просмотр канала» / «Отправка сообщений»`);
    }
    this.channelOk.set(id, ok);
    return ok;
  }

  stats() {
    return { queued: this.items.length, sent: this.sent, dropped: this.dropped };
  }
}

/** Оставляем только то, что понимает API сообщений бота, и режем по лимитам Discord. */
function cleanPayload(p) {
  if (typeof p === 'string') p = { content: p };
  if (!p || typeof p !== 'object') return null;
  const out = {};
  if (p.content != null && String(p.content).trim()) out.content = String(p.content).slice(0, 2000);
  if (Array.isArray(p.embeds) && p.embeds.length) out.embeds = p.embeds.slice(0, 10);
  if (!out.content && !out.embeds) return null;
  out.allowed_mentions = p.allowed_mentions && typeof p.allowed_mentions === 'object'
    ? p.allowed_mentions
    : { parse: [] };
  return out;
}

module.exports = { Outbox, cleanPayload };
