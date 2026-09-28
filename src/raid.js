const { MessageFlags } = require('discord.js');
const { log, JsonStore, isSnowflake, isSteamId, escapeMd, placeholder } = require('./util');

const CODE_RE = /^[A-Z0-9]{4,12}$/;

/**
 * RaidAlert через бота.
 *
 * 1. Игрок берёт код в игре → плагин RaidAlert → DiscordBridge → событие raid_code (код, SteamID, срок).
 * 2. Игрок пишет код в канал привязки (или /link код) → бот находит код, удаляет сообщение,
 *    выдаёт роль, пишет в личку и ставит серверу задачу raid_linked (хранится, пока сервер не подтвердит).
 * 3. Рейд: плагин → событие raid_alert → бот пишет игроку в личку.
 */
class RaidLink {
  constructor(client, cfg, link, outbox) {
    this.client = client;
    this.cfg = cfg.raid;
    this.link = link;
    this.outbox = outbox;
    this.store = new JsonStore('raid.json', () => ({ codes: {}, links: {} }));
    this.enabled = this.cfg.enabled !== false;
  }

  get codes() { return this.store.data.codes; }

  register() {
    if (!this.enabled) return;
    this.link.on('raid_code', (d) => this.onCode(d));
    this.link.on('raid_alert', (d) => this.onAlert(d));
    this.link.on('raid_dm', (d) => this.onDm(d));
    this.link.on('raid_unlink', (d) => this.onUnlink(d));
    this.link.on('raid_role', (d) => this.onRole(d));
    setInterval(() => this.prune(), 60_000);
  }

  prune() {
    const now = Date.now();
    let n = 0;
    for (const [code, c] of Object.entries(this.codes)) if (c.expiresAt <= now) { delete this.codes[code]; n++; }
    if (n) this.store.saveSoon();
  }

  onCode(d) {
    const code = String(d.code || '').trim().toUpperCase();
    const steamId = String(d.steamId || '');
    if (!CODE_RE.test(code) || !isSteamId(steamId)) return;
    for (const [k, c] of Object.entries(this.codes)) if (c.steamId === steamId) delete this.codes[k];
    const ttl = Math.min(Math.max(Number(d.ttl) || 900, 60), 86400);
    this.codes[code] = { steamId, name: String(d.name || '').slice(0, 64), expiresAt: Date.now() + ttl * 1000 };
    this.store.saveSoon();
  }

  hostname() {
    return this.link.getStatus()?.hostname || 'Rust-сервер';
  }

  onAlert(d) {
    if (!isSnowflake(d.discordId)) return;
    const grid = String(d.grid || '?');
    const server = String(d.server || this.hostname());
    const embed = {
      color: 0xf87171,
      title: '🚨 Рейд!',
      description: d.text
        ? String(d.text).slice(0, 2000)
        : `Твою базу атакуют — квадрат **${escapeMd(grid)}**.`,
      fields: [
        { name: 'Квадрат', value: escapeMd(grid), inline: true },
        { name: 'Сервер', value: escapeMd(server).slice(0, 1024), inline: true },
      ],
      timestamp: d.time || new Date().toISOString(),
    };
    this.outbox.dm(String(d.discordId), { embeds: [embed] });
  }

  onDm(d) {
    if (!isSnowflake(d.discordId) || !d.text) return;
    this.outbox.dm(String(d.discordId), { content: String(d.text).slice(0, 2000) });
  }

  onUnlink(d) {
    const discordId = String(d.discordId || '');
    if (!isSnowflake(discordId)) return;
    delete this.store.data.links[discordId];
    this.store.saveSoon();
    if (this.cfg.removeRoleOnUnlink !== false && isSnowflake(this.cfg.linkRoleId)) this.outbox.role(discordId, this.cfg.linkRoleId, false);
  }

  onRole(d) {
    if (!isSnowflake(d.discordId) || !isSnowflake(this.cfg.linkRoleId)) return;
    this.outbox.role(String(d.discordId), this.cfg.linkRoleId, d.add !== false);
  }

  /** Попытка привязки. Возвращает запись кода или null. */
  tryLink(rawCode, user) {
    const code = String(rawCode || '').trim().toUpperCase();
    const entry = this.codes[code];
    if (!entry || entry.expiresAt <= Date.now()) return null;
    delete this.codes[code];
    this.store.data.links[user.id] = entry.steamId;
    this.store.save();

    this.link.enqueue('raid_linked', {
      steamId: entry.steamId,
      discordId: user.id,
      discordName: user.username,
      code,
    });
    if (isSnowflake(this.cfg.linkRoleId)) this.outbox.role(user.id, this.cfg.linkRoleId, true);
    this.outbox.dm(user.id, {
      content: `✅ Аккаунт привязан${entry.name ? ` к **${escapeMd(entry.name)}**` : ''}. Теперь я напишу сюда, если твою базу начнут рейдить на сервере **${escapeMd(this.hostname())}**.`,
    });
    log(`[raid] привязка: ${user.username} (${user.id}) → ${entry.steamId}`);
    return entry;
  }

  /** Сообщения в канале привязки. Нужен Message Content Intent (включается в Developer Portal). */
  async onMessage(msg) {
    if (!this.enabled || msg.author?.bot) return;
    if (placeholder(this.cfg.linkChannelId) || msg.channelId !== String(this.cfg.linkChannelId)) return;
    const text = String(msg.content || '').trim().toUpperCase();
    if (!CODE_RE.test(text)) return;

    const entry = this.tryLink(text, msg.author);
    if (entry) {
      if (this.cfg.deleteCodeMessage !== false) msg.delete().catch(() => {});
      else msg.react('✅').catch(() => {});
      return;
    }
    if (this.cfg.wrongCodeReply === false) return;
    try {
      const reply = await msg.reply({ content: '❌ Код не найден или истёк. Возьми новый код в игре.', allowedMentions: { repliedUser: true } });
      setTimeout(() => { reply.delete().catch(() => {}); if (this.cfg.deleteCodeMessage !== false) msg.delete().catch(() => {}); }, 10_000);
    } catch { /* нет прав писать в канал */ }
  }

  /** /link код — работает и без Message Content Intent. */
  async onSlash(interaction) {
    const code = interaction.options.getString('код', true);
    const entry = this.tryLink(code, interaction.user);
    await interaction.reply({
      content: entry
        ? `✅ Аккаунт привязан${entry.name ? ` к **${escapeMd(entry.name)}**` : ''}. Оповещения о рейде будут приходить в личные сообщения — не закрывай их для участников сервера.`
        : '❌ Код не найден или истёк. Возьми новый код в игре.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

module.exports = { RaidLink };
