const crypto = require('crypto');
const { log, JsonStore } = require('./util');
const { sendJson, readJson, makeAuth } = require('./http');

const STATUS_STALE_MS = 3 * 60_000;    // нет вестей от сервера 3 мин — считаем офлайн
const POLL_ALIVE_MS = 20_000;          // сервер опрашивает бота раз в 2 с; 20 с тишины — не на связи
const PICKUP_TIMEOUT_MS = 20_000;      // запрос не забран за 20 с — отвечаем «сервер не отвечает»
const RESULT_TIMEOUT_MS = 30_000;
const REDELIVER_MS = 30_000;           // постоянную задачу забрали, но не подтвердили — отдать ещё раз
const PERSISTENT_TTL_MS = 7 * 86400_000;
const KEEP_EVENT_IDS = 5000;

/**
 * Связь с плагином DiscordBridge на Rust-сервере. Сервер всегда сам ходит к боту,
 * входящие порты на нём не нужны. Все запросы: Authorization: Bearer <api.secret>.
 *
 * Сервер -> бот
 *   POST /api/push      { events: [ { id, type, data } ] }   — логи, коды привязки, оповещения о рейде…
 *   POST /api/status    { online, max, queue, joining, hostname }
 *   POST /api/playtime  { since, players: [...] }            — снимок наигранного времени
 * Бот -> сервер (сервер забирает сам)
 *   GET  /api/poll      -> { tasks: [ { id, type, data } ] }
 *   POST /api/ack       { results: [ { id, ok, data?, error? } ] }
 */
class GameLink {
  constructor(cfg) {
    this.cfg = cfg;
    this.status = null;
    this.statusAt = 0;
    this.lastPollAt = 0;
    this.lastPushAt = 0;
    this.handlers = new Map();
    this.seenIds = new Set();
    this.seenOrder = [];
    this.oneShot = [];                 // запросы с ожиданием ответа (в памяти)
    this.waiting = new Map();          // id -> запрос, забранный сервером
    this.store = new JsonStore('tasks.json', () => ({ tasks: [], playtime: null }));
  }

  /** Обработчик события от сервера: fn(data, event). */
  on(type, fn) { this.handlers.set(type, fn); }

  isOnline() { return Date.now() - this.lastPollAt < POLL_ALIVE_MS; }

  getStatus() {
    if (!this.status || Date.now() - this.statusAt > STATUS_STALE_MS) return null;
    return this.status;
  }

  /** Последний присланный снимок наигранного времени (на случай, если сервер сейчас недоступен). */
  getCachedPlaytime() { return this.store.data.playtime; }

  handler() {
    const secret = this.cfg.api.secret;
    if (!secret || /^(ПРИДУМАЙ|ВСТАВЬ)/.test(String(secret))) {
      log('[link] ВНИМАНИЕ: не задан api.secret (переменная API_SECRET) — плагины не смогут подключиться');
      return null;
    }
    const auth = makeAuth(this.cfg);
    const routes = new Set(['/api/push', '/api/status', '/api/playtime', '/api/poll', '/api/ack', '/api/state']);

    return (req, res, path) => {
      if (!routes.has(path)) return false;
      if (!auth(req)) { sendJson(res, 401, { ok: false, error: 'unauthorized' }); return true; }

      if (req.method === 'GET') {
        if (path === '/api/poll') { this.lastPollAt = Date.now(); sendJson(res, 200, { ok: true, tasks: this.takeTasks() }); return true; }
        if (path === '/api/state') { sendJson(res, 200, { ok: true, ...this.debugState() }); return true; }
        sendJson(res, 405, { ok: false }); return true;
      }
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false }); return true; }

      readJson(req, res, 2 * 1024 * 1024, (body) => {
        this.lastPushAt = Date.now();
        if (path === '/api/push') return sendJson(res, 200, { ok: true, ...this.acceptEvents(body.events) });
        if (path === '/api/status') { this.setStatus(body); return sendJson(res, 200, { ok: true }); }
        if (path === '/api/playtime') { this.setPlaytime(body); return sendJson(res, 200, { ok: true }); }
        if (path === '/api/ack') { this.acceptAcks(body.results); return sendJson(res, 200, { ok: true }); }
        sendJson(res, 404, { ok: false });
      });
      return true;
    };
  }

  setStatus(b) {
    this.status = {
      online: Number(b.online) || 0,
      max: Number(b.max) || 0,
      queue: Number(b.queue) || 0,
      joining: Number(b.joining) || 0,
      hostname: String(b.hostname || '').slice(0, 120),
    };
    this.statusAt = Date.now();
  }

  setPlaytime(b) {
    if (!Array.isArray(b.players)) return;
    this.store.data.playtime = { ...b, receivedAt: new Date().toISOString() };
    this.store.saveSoon(5000);
  }

  /** События приходят пачкой. Плагин повторяет пачку, пока не получит 200, поэтому id запоминаем. */
  acceptEvents(events) {
    if (!Array.isArray(events)) return { accepted: 0 };
    let accepted = 0;
    for (const ev of events.slice(0, 500)) {
      if (!ev || typeof ev !== 'object') continue;
      const id = String(ev.id || '');
      if (id) {
        if (this.seenIds.has(id)) { accepted++; continue; }
        this.seenIds.add(id);
        this.seenOrder.push(id);
        if (this.seenOrder.length > KEEP_EVENT_IDS) this.seenIds.delete(this.seenOrder.shift());
      }
      const fn = this.handlers.get(String(ev.type || ''));
      if (!fn) { log(`[link] неизвестное событие: ${ev.type}`); accepted++; continue; }
      try { fn(ev.data || {}, ev); } catch (e) { log(`[link] ошибка в обработчике ${ev.type}:`, e); }
      accepted++;
    }
    return { accepted };
  }

  /** Что отдать серверу на очередном опросе. */
  takeTasks() {
    const now = Date.now();
    const out = [];

    while (this.oneShot.length) {
      const t = this.oneShot.shift();
      if (now - t.createdAt > PICKUP_TIMEOUT_MS) continue;
      clearTimeout(t.pickupTimer);
      t.resultTimer = setTimeout(() => this.finish(t.id, { ok: false, error: 'Сервер забрал запрос, но не ответил за 30 с.' }), RESULT_TIMEOUT_MS);
      this.waiting.set(t.id, t);
      out.push({ id: t.id, type: t.type, data: t.data });
    }

    const tasks = this.store.data.tasks;
    let changed = false;
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (now - t.createdAt > PERSISTENT_TTL_MS) { tasks.splice(i--, 1); changed = true; continue; }
      if (t.sentAt && now - t.sentAt < REDELIVER_MS) continue;
      t.sentAt = now;
      changed = true;
      out.push({ id: t.id, type: t.type, data: t.data });
    }
    if (changed) this.store.saveSoon();
    return out;
  }

  acceptAcks(results) {
    if (!Array.isArray(results)) return;
    for (const r of results) {
      const id = String(r?.id || '');
      if (!id) continue;
      const tasks = this.store.data.tasks;
      const i = tasks.findIndex((t) => t.id === id);
      if (i >= 0) {
        // Постоянная задача снимается только при успехе; иначе будет отдана серверу ещё раз
        if (r.ok !== false) { tasks.splice(i, 1); this.store.saveSoon(); }
        else if (r.error) log(`[link] сервер не выполнил ${tasks[i].type}: ${String(r.error).slice(0, 200)}`);
        continue;
      }
      this.finish(id, { ok: r.ok !== false, data: r.data, error: r.error });
    }
  }

  finish(id, result) {
    const t = this.waiting.get(id);
    if (!t) return;
    this.waiting.delete(id);
    clearTimeout(t.resultTimer);
    t.resolve(result);
  }

  /** Запрос к серверу с ожиданием ответа (статистика, сброс). */
  request(type, data = {}) {
    return new Promise((resolve) => {
      const t = { id: crypto.randomUUID(), type, data, createdAt: Date.now(), resolve };
      t.pickupTimer = setTimeout(() => {
        const i = this.oneShot.indexOf(t);
        if (i >= 0) this.oneShot.splice(i, 1);
        resolve({ ok: false, error: 'Rust-сервер не на связи с ботом (выключен или плагин DiscordBridge не загружен).' });
      }, PICKUP_TIMEOUT_MS);
      this.oneShot.push(t);
    });
  }

  /** Задача, которая обязана дойти (привязка аккаунта): хранится на диске, повторяется до подтверждения. */
  enqueue(type, data = {}) {
    this.store.data.tasks.push({ id: crypto.randomUUID(), type, data, createdAt: Date.now(), sentAt: 0 });
    this.store.save();
  }

  debugState() {
    return {
      serverPolling: this.isOnline(),
      lastPollAgoSec: this.lastPollAt ? Math.round((Date.now() - this.lastPollAt) / 1000) : null,
      status: this.getStatus(),
      pendingTasks: this.store.data.tasks.length,
      waitingRequests: this.oneShot.length + this.waiting.size,
    };
  }
}

module.exports = { GameLink };
