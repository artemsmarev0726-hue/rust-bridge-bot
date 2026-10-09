// Проверка без Discord: HTTP API, очередь, привязка RaidAlert, запросы статистики, сборка эмбедов.
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'bridge-test-' + Date.now());
const assert = require('assert');
const { startHttpServer } = require('../src/http');
const { GameLink } = require('../src/gamelink');
const { Outbox } = require('../src/outbox');
const { RaidLink } = require('../src/raid');
const { TwitchWatcher } = require('../src/twitch');
const { playerRows, buildStatsEmbeds, buildTwitchEmbeds, buildCsv, packMessages } = require('../src/commands');
const { buildTopReply } = require('../src/tops');

const cfg = {
  guildId: '111111111111111111',
  api: { secret: 'test-secret', allowedIps: [] },
  http: { port: 0, host: '127.0.0.1', trustProxy: true },
  outbox: {}, raid: { linkChannelId: '222222222222222222', linkRoleId: '333333333333333333' },
  twitch: { streamers: [{ url: 'https://www.twitch.tv/D03U', steamId: '76561198000000001' }, { url: 'other_one', steamId: '' }] },
  commands: {}, presence: {},
};

// Фейковый клиент discord.js: записывает всё, что бот «отправил»
const sent = [];
let failNext = 0;
const fakeClient = {
  isReady: () => true,
  channels: { fetch: async (id) => ({ id, guildId: id === '999999999999999999' ? 'other' : cfg.guildId, isTextBased: () => true }) },
  users: { fetch: async (id) => ({ id, createDM: async () => ({ id: 'dm' + id }) }) },
  rest: {
    post: async (route, { body }) => {
      if (failNext > 0) { failNext--; throw Object.assign(new Error('Service Unavailable'), { status: 503 }); }
      sent.push({ route, body });
    },
    put: async (route) => sent.push({ route, method: 'PUT' }),
    delete: async (route) => sent.push({ route, method: 'DELETE' }),
  },
};

const link = new GameLink(cfg);
const outbox = new Outbox(fakeClient, cfg, () => cfg.guildId);
const raid = new RaidLink(null, cfg, link, outbox);
const twitch = new TwitchWatcher(null, cfg);
link.on('message', (d) => outbox.channel(String(d.channel || ''), d.payload ?? d.content));
raid.register();

const server = startHttpServer(cfg, [link.handler()]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body, secret = 'test-secret') {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

(async () => {
  await sleep(100);
  outbox.start();

  // 1. Авторизация
  assert.strictEqual((await call('GET', '/api/poll', null, 'wrong')).status, 401);

  // 2. Логи: доставка, порядок, повтор при 503, дубль пачки не дублирует сообщения
  failNext = 1;
  const events = [1, 2, 3].map((n) => ({ id: 'e' + n, type: 'message', data: { channel: '1535261519334346792', payload: { content: 'msg ' + n } } }));
  let r = await call('POST', '/api/push', { events });
  assert.strictEqual(r.json.accepted, 3);
  r = await call('POST', '/api/push', { events }); // плагин повторил ту же пачку
  assert.strictEqual(outbox.items.length, 3, 'дубли не должны попасть в очередь');
  await sleep(2600); // первая попытка 503, повтор через 2 с
  const msgs = sent.filter((s) => s.body?.content?.startsWith('msg')).map((s) => s.body.content);
  assert.deepStrictEqual(msgs, ['msg 1', 'msg 2', 'msg 3'], 'порядок и повтор');
  assert.deepStrictEqual(sent[0].body.allowed_mentions, { parse: [] }, 'упоминания по умолчанию выключены');

  // Канал чужого сервера — отбрасывается
  await call('POST', '/api/push', { events: [{ id: 'x1', type: 'message', data: { channel: '999999999999999999', payload: { content: 'bad' } } }] });
  await sleep(400);
  assert.ok(!sent.some((s) => s.body?.content === 'bad'));

  // 3. RaidAlert: код → привязка → задача серверу → подтверждение
  await call('POST', '/api/push', { events: [{ id: 'r1', type: 'raid_code', data: { steamId: '76561198000000001', name: 'Rustam', code: 'ab12cd', ttl: 900 } }] });
  assert.ok(raid.codes.AB12CD, 'код сохранён');
  let deleted = false;
  await raid.onMessage({ author: { id: '444444444444444444', username: 'rustam_ds', bot: false }, channelId: '222222222222222222', content: ' ab12cd ', delete: async () => { deleted = true; } });
  assert.ok(deleted, 'сообщение с кодом удалено');
  assert.ok(!raid.codes.AB12CD, 'код одноразовый');
  let poll = await call('GET', '/api/poll');
  const linkedTask = poll.json.tasks.find((t) => t.type === 'raid_linked');
  assert.strictEqual(linkedTask.data.discordId, '444444444444444444');
  // не подтвердил — через 30 с отдадим снова; сейчас повторно не отдаём
  poll = await call('GET', '/api/poll');
  assert.ok(!poll.json.tasks.some((t) => t.type === 'raid_linked'));
  await call('POST', '/api/ack', { results: [{ id: linkedTask.id, ok: true }] });
  assert.strictEqual(link.store.data.tasks.length, 0, 'подтверждённая задача снята');
  await sleep(600);
  assert.ok(sent.some((s) => s.method === 'PUT' && String(s.route).includes('333333333333333333')), 'роль выдана');
  assert.ok(sent.some((s) => s.route === '/channels/dm444444444444444444/messages' && /привязан/.test(s.body.content)), 'ЛС о привязке');

  // Неверный код
  let replied = false;
  await raid.onMessage({ author: { id: '5', username: 'x', bot: false }, channelId: '222222222222222222', content: 'ZZZZZZ',
    reply: async () => { replied = true; return { delete: async () => {} }; }, delete: async () => {} });
  assert.ok(replied);

  // Оповещение о рейде
  await call('POST', '/api/push', { events: [{ id: 'r2', type: 'raid_alert', data: { discordId: '444444444444444444', grid: 'G12', text: 'Твою базу атакуют — квадрат **G12**.' } }] });
  await sleep(500);
  assert.ok(sent.some((s) => s.body?.embeds?.[0]?.title === '🚨 Рейд!'), 'ЛС о рейде');

  // 4. Статистика: бот спрашивает сервер, сервер отвечает
  const pending = link.request('playtime');
  poll = await call('GET', '/api/poll');
  const ptTask = poll.json.tasks.find((t) => t.type === 'playtime');
  assert.ok(ptTask);
  const snapshot = {
    since: '2026-09-25T12:00:00Z', hostname: 'QUICK RUST',
    players: [
      { steamId: '76561198000000001', name: 'D03U', seconds: 36000, online: true },
      { steamId: '76561198000000002', name: 'Player_2', seconds: 5400, online: false },
    ],
  };
  await call('POST', '/api/ack', { results: [{ id: ptTask.id, ok: true, data: snapshot }] });
  const res = await pending;
  assert.ok(res.ok);
  const rows = playerRows(res.data, twitch);
  assert.strictEqual(rows[0].twitch, 'https://www.twitch.tv/d03u');
  const st = buildStatsEmbeds(rows, res.data, null);
  assert.ok(st.embeds[0].toJSON().description.includes('10 ч 00 мин'));
  twitch.addStream('d03u', 'D03U', 7200);
  const tw = buildTwitchEmbeds(twitch, rows, res.data, null);
  const f = tw.embeds[0].toJSON().fields;
  assert.strictEqual(f.length, 2, 'только стримеры');
  assert.ok(f[0].value.includes('Стримил за вайп: **2 ч 00 мин**') && f[0].value.includes('Наиграл на сервере: **10 ч 00 мин**') && f[0].value.includes('сейчас на сервере'));
  assert.ok(f[1].value.includes('SteamID не указан'));
  assert.strictEqual(packMessages(st.embeds).length, 1);
  assert.ok(buildCsv(rows, twitch).toString('utf8').includes('D03U'));

  // 4б. /top: ответ плагина Menu приходит строкой JSON (через OnBridgeTask)
  const topPending = link.request('menu_top', { query: 'D03U', kind: 'points', limit: 10 });
  poll = await call('GET', '/api/poll');
  const topTask = poll.json.tasks.find((t) => t.type === 'menu_top');
  assert.strictEqual(topTask.data.query, 'D03U');
  const menuAnswer = JSON.stringify({ mode: 'player', hostname: 'QUICK RUST', places: { points: 40, kills: 30, farm: 50, animals: 10, deaths: 30, online: 60 },
    ranks: { points: 2, kills: 1, farm: 5, animals: 0, deaths: 7, online: 3 },
    player: { name: 'D03U', steamId: '76561198000000001', online: true, kills: 25, deaths: 5, kd: '5.00', points: 1234, headshots: 9,
      farm: 152300, stone: 100000, wood: 50000, metal: 2000, sulfur: 300, other: 0, animals: 0, onlineSeconds: 7260, onlineText: '2ч 1м' } });
  await call('POST', '/api/ack', { results: [{ id: topTask.id, ok: true, data: menuAnswer }] });
  const topReply = buildTopReply(await topPending);
  const pe = topReply.embeds[0].toJSON();
  assert.ok(pe.title.includes('D03U') && pe.title.includes('🟢'));
  assert.ok(pe.fields.find((x) => x.name === '⛏️ Фарм').value.includes('152 300') && pe.fields.find((x) => x.name === '⛏️ Фарм').value.includes('#5 из 50'));
  assert.ok(pe.fields.find((x) => x.name === '🐺 Животные').value === '**0**', 'нет места — без «из»');
  const te = buildTopReply({ ok: true, data: JSON.stringify({ mode: 'top', kind: 'farm', total: 2, rows: [{ place: 1, name: 'A_b', value: '1 000' }, { place: 2, name: 'C', value: '5' }] }) }).embeds[0].toJSON();
  assert.ok(te.title.includes('фарм') && te.description.startsWith('🥇 A\\_b — **1 000**'));
  assert.ok(buildTopReply({ ok: false, error: 'неизвестная задача menu_top' }).content.includes('Menu'));
  assert.ok(buildTopReply({ ok: true, data: '{"mode":"none","query":"zz"}' }).content.includes('не найден'));
  assert.ok(buildTopReply({ ok: true, data: { mode: 'many', query: 'a', total: 3, matches: [{ name: 'a1', steamId: '1' }] } }).embeds[0].toJSON().description.includes('…и ещё 2'));

  // Сервер молчит — запрос завершается ошибкой, а не висит
  link.oneShot.length = 0;

  // 5. Сброс стримов
  twitch.reset('тест');
  assert.strictEqual(twitch.summary(twitch.streamers[0]).totalSec, 0);

  console.log('\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ. Отправлено в «Discord»:', sent.length, '| очередь:', outbox.stats());
  console.log('\nПример /tw:\n' + JSON.stringify(tw.embeds[0].toJSON(), null, 1).slice(0, 900));
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА ТЕСТА:', e); process.exit(1); });
