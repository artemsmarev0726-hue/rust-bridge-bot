const { EmbedBuilder, MessageFlags } = require('discord.js');
const { escapeMd } = require('./util');

// Команда /top: статистика из плагина Menu (убийства, фарм, животные, онлайн…).
// Бот спрашивает сервер задачей menu_top → DiscordBridge → хук OnBridgeTask в Menu.

const KINDS = [
  { key: 'points', label: 'Очки', emoji: '🏅' },
  { key: 'kills', label: 'Убийства', emoji: '⚔️' },
  { key: 'farm', label: 'Фарм', emoji: '⛏️' },
  { key: 'animals', label: 'Животные', emoji: '🐺' },
  { key: 'deaths', label: 'Смерти', emoji: '💀' },
  { key: 'online', label: 'Онлайн', emoji: '⏱️' },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.key, k]));
// Цвет полоски эмбедов /top: config.json → commands.topColor ("#2482ed").
let COLOR = 0x2482ed;
function setTopColor(hex) {
  const v = parseInt(String(hex || '').replace(/^#/, ''), 16);
  if (Number.isFinite(v) && v >= 0 && v <= 0xffffff) COLOR = v;
}
const MEDALS = ['🥇', '🥈', '🥉'];

function topCommandDef(name) {
  return {
    name,
    description: 'Статистика игрока по SteamID или нику, либо топ сервера',
    options: [
      { type: 3, name: 'игрок', description: 'SteamID64 или ник на сервере (пусто — общий топ)', required: false, max_length: 64 },
      {
        type: 3, name: 'топ', description: 'Какой топ показать (если игрок не указан)', required: false,
        choices: KINDS.map((k) => ({ name: `${k.emoji} ${k.label}`, value: k.key })),
      },
    ],
  };
}

const fmt = (n) => Number(n || 0).toLocaleString('ru-RU').replace(/ /g, ' ');
const place = (p) => (p > 0 ? `#${p}` : '—');
const steamLink = (id) => (id ? `[${id}](https://steamcommunity.com/profiles/${id})` : '');

function parseResult(r) {
  if (!r.ok) {
    const err = String(r.error || '');
    if (/неизвестная задача/i.test(err)) return { error: 'На сервере не загружен плагин Menu (или старая версия без поддержки /top).' };
    return { error: err || 'Сервер не ответил.' };
  }
  let d = r.data;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch { return { error: 'Сервер прислал непонятный ответ.' }; }
  }
  return d && typeof d === 'object' ? { data: d } : { error: 'Пустой ответ сервера.' };
}

function buildTopEmbed(d) {
  const k = KIND[d.kind] || KIND.points;
  const rows = Array.isArray(d.rows) ? d.rows : [];
  const lines = rows.map((r) => {
    const mark = MEDALS[r.place - 1] || `\`${r.place}.\``;
    return `${mark} ${escapeMd(String(r.name || '—').slice(0, 32))} — **${escapeMd(r.value)}**`;
  });
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${k.emoji} Топ: ${k.label.toLowerCase()}`)
    .setDescription(lines.join('\n') || 'В этом топе пока никого нет.')
    .setFooter({ text: [`Всего в топе: ${d.total || 0}`, d.hostname].filter(Boolean).join(' · ').slice(0, 2048) })
    .setTimestamp(new Date());
}

function buildPlayerEmbed(d) {
  const p = d.player || {};
  const rk = d.ranks || {};
  const pl = d.places || {};
  const of = (key) => (rk[key] ? ` · ${place(rk[key])} из ${pl[key] || '?'}` : '');
  const e = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`📊 ${String(p.name || '—').slice(0, 200)}${p.online ? ' 🟢' : ''}`)
    .setDescription([steamLink(p.steamId), rk.points ? `Место в общем топе: **${place(rk.points)}**` : 'В общем топе пока нет'].filter(Boolean).join('\n'))
    .addFields(
      { name: '🏅 Очки', value: `**${fmt(p.points)}**${of('points')}`, inline: true },
      { name: '⚔️ Убийства', value: `**${fmt(p.kills)}**${of('kills')}`, inline: true },
      { name: '💀 Смерти', value: `**${fmt(p.deaths)}**${of('deaths')}`, inline: true },
      { name: '🎯 K/D', value: `**${p.kd || '0.00'}**`, inline: true },
      { name: '🤯 В голову', value: `**${fmt(p.headshots)}**`, inline: true },
      { name: '🐺 Животные', value: `**${fmt(p.animals)}**${of('animals')}`, inline: true },
      { name: '⏱️ Онлайн за вайп', value: `**${p.onlineText || '0м'}**${of('online')}`, inline: true },
      { name: '⛏️ Фарм', value: `**${fmt(p.farm)}**${of('farm')}`, inline: true },
    )
    .setFooter({ text: String(d.hostname || '').slice(0, 2048) || ' ' })
    .setTimestamp(new Date());
  if (p.farm > 0) {
    e.addFields({
      name: 'Добыто',
      value: `🪨 Камень: ${fmt(p.stone)}\n🪵 Дерево: ${fmt(p.wood)}\n🔩 Металл: ${fmt(p.metal)}\n🟡 Сера: ${fmt(p.sulfur)}\n📦 Прочее: ${fmt(p.other)}`,
      inline: false,
    });
  }
  return e;
}

function buildManyEmbed(d) {
  const list = (d.matches || []).map((m, i) => `\`${i + 1}.\` ${escapeMd(String(m.name || '—').slice(0, 32))}${m.steamId ? ` — \`${m.steamId}\`` : ''}`);
  const more = d.total > list.length ? `\n…и ещё ${d.total - list.length}` : '';
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`🔎 Найдено игроков: ${d.total}`)
    .setDescription(`По запросу «${escapeMd(String(d.query).slice(0, 64))}» подходят несколько игроков. Уточни ник или укажи SteamID:\n\n${list.join('\n')}${more}`);
}

/** Превращает ответ сервера в сообщение для Discord. */
function buildTopReply(r) {
  const { data, error } = parseResult(r);
  if (error) return { content: `❌ ${error}` };
  switch (data.mode) {
    case 'top': return { embeds: [buildTopEmbed(data)] };
    case 'player': return { embeds: [buildPlayerEmbed(data)] };
    case 'many': return { embeds: [buildManyEmbed(data)] };
    case 'none': return { content: `🔎 Игрок «${escapeMd(String(data.query || '').slice(0, 64))}» не найден в статистике этого вайпа.` };
    case 'disabled': return { content: '⛔ Статистика или команда /top выключены в конфиге плагина Menu.' };
    default: return { content: '❌ Сервер прислал непонятный ответ.' };
  }
}

async function handleTop(interaction, cfg, ctx) {
  setTopColor(cfg.commands.topColor);
  await interaction.deferReply(cfg.commands.topEphemeral ? { flags: MessageFlags.Ephemeral } : {});
  const query = String(interaction.options.getString('игрок') || '').trim().slice(0, 64);
  const kind = interaction.options.getString('топ') || 'points';
  const r = await ctx.link.request('menu_top', { query, kind, limit: 10 });
  const reply = buildTopReply(r);
  await interaction.editReply({ ...reply, allowedMentions: { parse: [] } });
}

module.exports = { topCommandDef, handleTop, buildTopReply, setTopColor, KINDS };
