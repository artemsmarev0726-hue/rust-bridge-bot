const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// DATA_DIR — постоянный диск хостинга (volume), чтобы данные не пропадали при передеплое
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

function log(...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}]`, ...args);
}

const placeholder = (v) => !v || /^(ВСТАВЬ|ПРИДУМАЙ|ID_|TWITCH_)/.test(String(v));

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  cfg.api = cfg.api || {};
  cfg.http = cfg.http || {};
  cfg.presence = cfg.presence || {};
  cfg.outbox = cfg.outbox || {};
  cfg.raid = cfg.raid || {};
  cfg.twitch = cfg.twitch || {};
  cfg.commands = cfg.commands || {};
  // Секреты — из переменных окружения хостинга (в репозитории только заглушки)
  const env = process.env;
  if (env.DISCORD_TOKEN) cfg.token = env.DISCORD_TOKEN;
  if (env.GUILD_ID) cfg.guildId = env.GUILD_ID;
  if (env.API_SECRET) cfg.api.secret = env.API_SECRET;
  if (env.TWITCH_CLIENT_ID) cfg.twitch.clientId = env.TWITCH_CLIENT_ID;
  if (env.TWITCH_CLIENT_SECRET) cfg.twitch.clientSecret = env.TWITCH_CLIENT_SECRET;
  if (env.ALLOWED_IPS) cfg.api.allowedIps = env.ALLOWED_IPS.split(/[,\s]+/).filter(Boolean);
  return cfg;
}

/** JSON-хранилище с атомарной записью (временный файл + rename). */
class JsonStore {
  constructor(name, defaults) {
    this.name = name;
    this.file = path.join(DATA_DIR, name);
    this.defaults = defaults;
    this.data = defaults();
    this.timer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        this.data = Object.assign(defaults(), JSON.parse(fs.readFileSync(this.file, 'utf8')));
      } catch (e) {
        const broken = `${this.file}.broken-${Date.now()}`;
        fs.copyFileSync(this.file, broken);
        log(`[store] ${name} повреждён, копия: ${broken}. Начинаю с пустого.`);
      }
    }
  }

  save() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      log(`[store] не удалось сохранить ${this.name}:`, e.message);
    }
  }

  /** Отложенная запись: частые изменения (очередь сообщений) не пишут диск на каждое событие. */
  saveSoon(ms = 1000) {
    if (!this.timer) this.timer = setTimeout(() => this.save(), ms);
  }

  backup(prefix, data = this.data) {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `${prefix}-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
  }
}

/** 45296 -> "12 ч 34 мин" */
function formatDuration(seconds) {
  seconds = Math.max(0, Math.floor(seconds || 0));
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d === 0 && h === 0 && m === 0) return seconds > 0 ? '< 1 мин' : '0 мин';
  if (d === 0 && h === 0) return `${m} мин`;
  if (d === 0) return `${h} ч ${String(m).padStart(2, '0')} мин`;
  return `${d} д ${h} ч ${String(m).padStart(2, '0')} мин`;
}

/** "https://www.twitch.tv/Name/" -> "name" */
function twitchLogin(url) {
  const s = String(url || '').trim();
  const m = s.match(/twitch\.tv\/([A-Za-z0-9_]{2,25})/i);
  if (m) return m[1].toLowerCase();
  if (/^[A-Za-z0-9_]{2,25}$/.test(s)) return s.toLowerCase();
  return null;
}

function escapeMd(text) {
  return String(text ?? '').replace(/([\\*_`~|>\[\]()])/g, '\\$1');
}

const isSnowflake = (v) => /^\d{17,20}$/.test(String(v || ''));
const isSteamId = (v) => /^7656\d{13}$/.test(String(v || ''));

module.exports = {
  log, loadConfig, JsonStore, formatDuration, twitchLogin, escapeMd,
  isSnowflake, isSteamId, placeholder, DATA_DIR,
};
