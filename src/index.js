const { Client, GatewayIntentBits, Events } = require('discord.js');
const { log, loadConfig, placeholder } = require('./util');
const { startHttpServer, sendJson, makeAuth } = require('./http');
const { startPresence } = require('./presence');
const { TwitchWatcher } = require('./twitch');
const { GameLink } = require('./gamelink');
const { Outbox } = require('./outbox');
const { RaidLink } = require('./raid');
const { registerCommands, setupCommands } = require('./commands');

const cfg = loadConfig();
if (placeholder(cfg.token)) {
  console.error('Не задан токен бота: переменная DISCORD_TOKEN на хостинге (или token в config.json).');
  process.exit(1);
}

let client = null;
const getGuildId = () => {
  if (!placeholder(cfg.guildId)) return String(cfg.guildId);
  return client?.guilds.cache.first()?.id; // не указан — первый сервер, где есть бот
};

// Всё, что не требует Discord, создаётся сразу: плагины могут слать логи ещё до входа бота,
// они просто полежат в очереди (data/outbox.json).
const link = new GameLink(cfg);
const outbox = new Outbox(null, cfg, getGuildId);
const twitch = new TwitchWatcher(null, cfg);
const raid = new RaidLink(null, cfg, link, outbox);

// ---- события от плагинов ----
link.on('message', (d) => { outbox.channel(String(d.channel || ''), d.payload ?? d.content); });
link.on('dm', (d) => { outbox.dm(String(d.userId || ''), d.payload ?? d.content); });
link.on('wipe', (d) => {
  log(`[link] сервер сообщил о вайпе (${d.hostname || ''}) — обнуляю время стримов`);
  twitch.reset('вайп');
});
link.on('log', (d) => log(`[server] ${String(d.text || '').slice(0, 500)}`));
raid.register();

// Состояние бота для отладки: GET /api/bot-state (с секретом)
const stateHandler = (() => {
  if (placeholder(cfg.api.secret)) return null;
  const auth = makeAuth(cfg);
  return (req, res, path) => {
    if (path !== '/api/bot-state') return false;
    if (!auth(req)) { sendJson(res, 401, { ok: false }); return true; }
    sendJson(res, 200, {
      ok: true,
      discord: client?.isReady() ? client.user.tag : 'не подключён',
      outbox: outbox.stats(),
      link: link.debugState(),
      raidCodes: Object.keys(raid.codes).length,
      twitch: twitch.enabled,
    });
    return true;
  };
})();

startHttpServer(cfg, [link.handler(), stateHandler]);
outbox.start();

function makeClient(withMessages) {
  const intents = [GatewayIntentBits.Guilds];
  if (withMessages) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  return new Client({ intents });
}

function useClient(c) {
  client = c;
  outbox.client = c;
  twitch.client = c;
  raid.client = c;
  wire(c); // обработчики вешаем до входа, иначе можно пропустить событие ready
  return c;
}

async function login() {
  const wantMessages = cfg.raid.enabled !== false && !placeholder(cfg.raid.linkChannelId);
  useClient(makeClient(wantMessages));
  try {
    await client.login(cfg.token);
  } catch (e) {
    if (wantMessages && /intent/i.test(`${e.code || ""} ${e.message}`)) {
      log('ВНИМАНИЕ: в Discord Developer Portal не включён «Message Content Intent». '
        + 'Бот не видит коды в канале привязки — работает только команда /' + (cfg.raid.slashCommand || 'link') + '. '
        + 'Включи интент (Bot → Privileged Gateway Intents) и перезапусти бота.');
      try { await client.destroy(); } catch { /* ignore */ }
      useClient(makeClient(false));
      await client.login(cfg.token);
    } else {
      throw e;
    }
  }
}

let started = false;
function wire(c) {
  c.once(Events.ClientReady, async () => {
    log(`Бот запущен как ${c.user.tag}. Серверов: ${c.guilds.cache.size}`);
    const gid = getGuildId();
    if (!gid) log('ВНИМАНИЕ: бот не добавлен ни на один сервер');
    await registerCommands(c, cfg, gid ? [gid] : []);
    setupCommands(c, cfg, { link, twitch, raid });
    if (started) return; // таймеры статуса и Twitch запускаются один раз
    started = true;
    startPresence(c, cfg, getGuildId, link);
    twitch.start();
  });
  c.on(Events.MessageCreate, (m) => raid.onMessage(m).catch((e) => log('[raid] ошибка:', e.message)));
  c.on(Events.GuildCreate, (g) => { if (placeholder(cfg.guildId)) registerCommands(c, cfg, [g.id]); });
  c.on('error', (e) => log('[discord] ошибка:', e.message));
}

process.on('unhandledRejection', (e) => log('[unhandledRejection]', e));

const shutdown = () => {
  log('Остановка…');
  try { outbox.store.save(); link.store.save(); raid.store.save(); twitch.state.save(); twitch.stats.save(); } catch { /* ignore */ }
  Promise.resolve(client?.destroy()).finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Не вошли в Discord — не падаем: HTTP продолжает принимать логи от сервера в очередь, вход повторяется.
function tryLogin() {
  login().catch((e) => {
    log(`Не удалось войти в Discord: ${e.code || ''} ${e.message}. Повтор через 60 с. Проверь DISCORD_TOKEN.`);
    try { client?.destroy(); } catch { /* ignore */ }
    setTimeout(tryLogin, 60_000);
  });
}
tryLogin();
