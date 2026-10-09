const {
  EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const { log, formatDuration, escapeMd, placeholder } = require('./util');
const { topCommandDef, handleTop } = require('./tops');

const MAX_IN_EMBED = 40;       // игроков в сообщении /stats (полный список — файлом)
const EMBED_LIMIT = 3900;      // запас от лимита 4096 символов описания

function names(cfg) {
  const c = cfg.commands;
  return {
    tw: c.twitch || 'tw',
    stats: c.stats || 'stats',
    reset: c.reset || 'reset',
    top: c.top || 'top',
    link: cfg.raid.slashCommand || 'link',
  };
}

// Обычным участникам доступна только /top. Остальные команды Discord показывает
// только администраторам (плюс проверка прав при выполнении — на случай, если доступ
// к команде выдали вручную в настройках интеграции).
const ADMIN = String(PermissionFlagsBits.Administrator);

function commandDefs(cfg) {
  const n = names(cfg);
  const defs = [
    { name: n.tw, description: 'Стримеры: сколько стримили и сколько наиграли на сервере за вайп', default_member_permissions: ADMIN },
    { name: n.stats, description: 'Наигранное время всех игроков за вайп', default_member_permissions: ADMIN },
    {
      name: n.reset,
      description: 'Обнулить статистику на сервере и в боте (итоги сохранятся файлом)',
      default_member_permissions: ADMIN,
    },
  ];
  if (cfg.commands.topEnabled !== false) defs.push(topCommandDef(n.top));
  if (cfg.raid.enabled !== false) {
    defs.push({
      name: n.link,
      description: 'Привязать аккаунт к оповещениям о рейде (код берётся в игре)',
      default_member_permissions: ADMIN,
      options: [{ type: 3, name: 'код', description: 'Код из игры', required: true, min_length: 4, max_length: 12 }],
    });
  }
  return defs;
}

async function registerCommands(client, cfg, guildIds) {
  const defs = commandDefs(cfg);
  for (const id of guildIds) {
    try {
      const guild = await client.guilds.fetch(id);
      await guild.commands.set(defs);
      log(`[commands] зарегистрированы на сервере ${guild.name}: ${defs.map((d) => '/' + d.name).join(' ')}`);
    } catch (e) {
      log(`[commands] не удалось зарегистрировать на ${id}:`, e.message);
    }
  }
}

function isAdmin(interaction, cfg) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  const roles = cfg.adminRoleIds || [];
  const memberRoles = interaction.member?.roles?.cache ?? interaction.member?.roles;
  if (!memberRoles) return false;
  return roles.some((id) => (memberRoles.has ? memberRoles.has(id) : memberRoles.includes?.(id)));
}

/** Наигранное время: сначала спрашиваем сервер, не ответил — последний снимок. */
async function getPlaytime(link) {
  const r = await link.request('playtime');
  if (r.ok && r.data && Array.isArray(r.data.players)) {
    link.setPlaytime(r.data);
    return { data: r.data, fresh: true };
  }
  const cached = link.getCachedPlaytime();
  return { data: cached, fresh: false, error: r.error };
}

function staleNote(pt) {
  if (pt.fresh) return null;
  if (!pt.data) return `⚠️ ${pt.error || 'Сервер не отвечает'} Данных пока нет.`;
  const at = Math.floor(Date.parse(pt.data.receivedAt) / 1000);
  return `⚠️ Сервер сейчас не отвечает — показан последний снимок от <t:${at}:R>.`;
}

function playerRows(data, twitch) {
  const streamers = twitch.bySteamId();
  const rows = (data?.players || []).map((p) => ({
    steamId: String(p.steamId),
    name: String(p.name || '—'),
    seconds: Math.max(0, Math.floor(Number(p.seconds) || 0)),
    online: !!p.online,
    twitch: streamers.get(String(p.steamId))?.url || '',
  }));
  rows.sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));
  return rows;
}

function buildCsv(rows, twitch) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['SteamID;Ник;Секунд;Часов;Время;Twitch'];
  for (const r of rows) {
    lines.push([r.steamId, esc(r.name), r.seconds, (r.seconds / 3600).toFixed(2), esc(formatDuration(r.seconds)), r.twitch].join(';'));
  }
  if (twitch.streamers.length) {
    lines.push('', 'Twitch;SteamID;Стримов;Секунд стрима;Время стрима');
    for (const s of twitch.streamers) {
      const t = twitch.summary(s);
      lines.push([s.url, s.steamId, t.count, t.totalSec, esc(formatDuration(t.totalSec))].join(';'));
    }
  }
  return Buffer.from('﻿' + lines.join('\r\n'), 'utf8'); // BOM — чтобы Excel открыл кириллицу
}

function sinceField(data) {
  const since = Date.parse(data?.since || '');
  return Number.isFinite(since) ? `<t:${Math.floor(since / 1000)}:f>` : '—';
}

function buildStatsEmbeds(rows, data, note) {
  const total = rows.reduce((a, r) => a + r.seconds, 0);
  const online = rows.filter((r) => r.online).length;
  const lines = rows.slice(0, MAX_IN_EMBED).map((r, i) => {
    const steam = `[${r.steamId}](https://steamcommunity.com/profiles/${r.steamId})`;
    const tw = r.twitch ? ` · [Twitch](${r.twitch})` : '';
    const on = r.online ? ' 🟢' : '';
    return `**${i + 1}.** ${escapeMd(r.name)}${on} — **${formatDuration(r.seconds)}**\n${steam}${tw}`;
  });

  const chunks = [];
  let chunk = '';
  for (const line of lines) {
    if (chunk.length + line.length + 1 > EMBED_LIMIT) { chunks.push(chunk); chunk = ''; }
    chunk += (chunk ? '\n' : '') + line;
  }
  if (chunk) chunks.push(chunk);
  if (!chunks.length) chunks.push('За этот вайп ещё никто не играл.');

  const embeds = chunks.map((desc, i) => {
    const e = new EmbedBuilder().setColor(0xce422b).setDescription(desc);
    if (i === 0) {
      e.setTitle('📊 Наигранное время за вайп').addFields(
        { name: 'Считается с', value: sinceField(data), inline: true },
        { name: 'Игроков', value: `${rows.length} (сейчас 🟢 ${online})`, inline: true },
        { name: 'Всего', value: formatDuration(total), inline: true },
      );
    }
    return e;
  });
  const rest = rows.length - Math.min(rows.length, MAX_IN_EMBED);
  const footer = [rest > 0 ? `…и ещё ${rest} игрок(ов) — полный список в файле` : null, data?.hostname].filter(Boolean).join(' · ');
  if (footer) embeds[embeds.length - 1].setFooter({ text: footer.slice(0, 2048) });
  return { embeds, content: note || undefined };
}

function buildTwitchEmbeds(twitch, rows, data, note) {
  const bySteam = new Map(rows.map((r) => [r.steamId, r]));
  const items = twitch.streamers.map((s) => ({ s, t: twitch.summary(s), p: s.steamId ? bySteam.get(s.steamId) : null }));
  items.sort((a, b) => (b.t.live - a.t.live) || (b.t.totalSec - a.t.totalSec));

  const fields = items.map(({ s, t, p }) => {
    const head = `${t.live ? '🔴' : '⚫'} ${t.name}${t.live ? ' — в эфире' : ''}`;
    const lines = [`[twitch.tv/${s.login}](${s.url})`];
    lines.push(`🎥 Стримил за вайп: **${formatDuration(t.totalSec)}** (стримов: ${t.count})`);
    if (!s.steamId) lines.push('🎮 На сервере: SteamID не указан в конфиге');
    else lines.push(`🎮 Наиграл на сервере: **${formatDuration(p?.seconds || 0)}**${p?.online ? ' · 🟢 сейчас на сервере' : ''}`);
    if (t.live) {
      lines.push(`⏱️ Текущий стрим идёт ${formatDuration(t.currentSec)}${t.game ? ` · ${escapeMd(t.game)}` : ''}`);
      if (t.title) lines.push(`> ${escapeMd(t.title).slice(0, 200)}`);
    }
    return { name: head.slice(0, 256), value: lines.join('\n').slice(0, 1024), inline: false };
  });

  const embeds = [];
  for (let i = 0; i < fields.length || i === 0; i += 10) {
    const e = new EmbedBuilder().setColor(0x9146ff);
    if (i === 0) {
      const live = items.filter((x) => x.t.live).length;
      e.setTitle('🎥 Стримеры сервера')
        .setDescription(fields.length ? `В эфире сейчас: **${live}** из ${items.length}\nСчитается с ${sinceField(data)} (сервер) · стримы с <t:${Math.floor(Date.parse(twitch.stats.data.since) / 1000)}:f>` : 'В конфиге бота нет стримеров (twitch.streamers).');
    }
    const part = fields.slice(i, i + 10);
    if (part.length) e.addFields(part);
    embeds.push(e);
    if (!fields.length) break;
  }
  if (!twitch.enabled) embeds[0].setFooter({ text: 'Отслеживание Twitch выключено или не настроено (clientId/clientSecret)' });
  return { embeds, content: note || undefined };
}

/** Discord: не больше 10 эмбедов и ~6000 символов на сообщение. */
function packMessages(embeds) {
  const msgs = [];
  let cur = [];
  let size = 0;
  for (const e of embeds) {
    const len = JSON.stringify(e.toJSON()).length;
    if (cur.length && (size + len > 5500 || cur.length >= 10)) { msgs.push(cur); cur = []; size = 0; }
    cur.push(e);
    size += len;
  }
  if (cur.length) msgs.push(cur);
  return msgs;
}

async function sendPacked(interaction, { embeds, content }, files = []) {
  const msgs = packMessages(embeds);
  await interaction.editReply({ content, embeds: msgs[0], files: msgs.length === 1 ? files : [] });
  for (let i = 1; i < msgs.length; i++) {
    await interaction.followUp({ embeds: msgs[i], files: i === msgs.length - 1 ? files : [] });
  }
}

async function handleTwitch(interaction, cfg, ctx) {
  await interaction.deferReply(cfg.commands.statsInChannel === false ? { flags: MessageFlags.Ephemeral } : {});
  const pt = await getPlaytime(ctx.link);
  const rows = playerRows(pt.data, ctx.twitch);
  await sendPacked(interaction, buildTwitchEmbeds(ctx.twitch, rows, pt.data, staleNote(pt)));
}

async function handleStats(interaction, cfg, ctx) {
  await interaction.deferReply(cfg.commands.statsInChannel === false ? { flags: MessageFlags.Ephemeral } : {});
  const pt = await getPlaytime(ctx.link);
  const rows = playerRows(pt.data, ctx.twitch);
  const file = new AttachmentBuilder(buildCsv(rows, ctx.twitch), { name: 'playtime.csv' });
  await sendPacked(interaction, buildStatsEmbeds(rows, pt.data, staleNote(pt)), rows.length ? [file] : []);
}

async function handleReset(interaction, cfg, ctx) {
  if (!isAdmin(interaction, cfg)) {
    return interaction.reply({ content: '⛔ Нет прав.', flags: MessageFlags.Ephemeral });
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('reset_yes').setLabel('Да, обнулить').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('reset_no').setLabel('Отмена').setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({
    content: '⚠️ Обнулить наигранное время **на Rust-сервере** (плагин DiscordBridge) и время стримов **в боте**? Итоги до сброса будут приложены файлом.',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
  const msg = await interaction.fetchReply();
  let click;
  try {
    click = await msg.awaitMessageComponent({ filter: (i) => i.user.id === interaction.user.id, time: 30_000 });
  } catch {
    return interaction.editReply({ content: 'Время вышло — сброс отменён.', components: [] });
  }
  if (click.customId !== 'reset_yes') return click.update({ content: 'Сброс отменён.', components: [] });

  await click.update({ content: '⏳ Сбрасываю на сервере…', components: [] });
  const r = await ctx.link.request('reset', { by: interaction.user.username });
  if (!r.ok) {
    return interaction.editReply({ content: `❌ Сервер не выполнил сброс: ${r.error || 'нет ответа'}\nВ боте ничего не менял.` });
  }

  // Итоги до сброса: сервер присылает снимок в ответе
  const before = r.data?.before || { players: [] };
  const rows = playerRows(before, ctx.twitch);
  const csv = buildCsv(rows, ctx.twitch);
  ctx.twitch.reset(`/reset от ${interaction.user.username}`);
  ctx.link.setPlaytime({ since: new Date().toISOString(), players: [], hostname: before.hostname });
  log(`[reset] ${interaction.user.tag}: сброшено, игроков было ${rows.length}`);

  await interaction.editReply({ content: '✅ Готово.' });
  const stamp = new Date().toISOString().slice(0, 10);
  await interaction.followUp({
    content: `🧹 Статистика обнулена (${interaction.user}). Итоги за период с ${sinceField(before)} — в файле.`,
    files: [new AttachmentBuilder(csv, { name: `playtime-${stamp}.csv` })],
    allowedMentions: { parse: [] },
  });
}

function setupCommands(client, cfg, ctx) {
  const n = names(cfg);
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      const adminOnly = [n.tw, n.stats, n.reset, n.link].includes(interaction.commandName);
      if (adminOnly && !isAdmin(interaction, cfg)) {
        await interaction.reply({ content: '⛔ Эта команда только для администрации. Тебе доступна `/' + n.top + '`.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.commandName === n.tw) await handleTwitch(interaction, cfg, ctx);
      else if (interaction.commandName === n.stats) await handleStats(interaction, cfg, ctx);
      else if (interaction.commandName === n.reset) await handleReset(interaction, cfg, ctx);
      else if (interaction.commandName === n.top && cfg.commands.topEnabled !== false) await handleTop(interaction, cfg, ctx);
      else if (interaction.commandName === n.link && ctx.raid) await ctx.raid.onSlash(interaction);
    } catch (e) {
      log('[commands] ошибка:', e);
      const payload = { content: '❌ Ошибка при выполнении команды.', flags: MessageFlags.Ephemeral };
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch { /* ignore */ }
    }
  });
}

module.exports = {
  commandDefs, registerCommands, setupCommands, playerRows, buildCsv, buildStatsEmbeds, buildTwitchEmbeds, packMessages,
  isPlaceholder: placeholder,
};
