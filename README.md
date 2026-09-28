# Rust Bridge Bot 2.0

Бот-посредник между Rust-сервером (хостинг в МСК) и Discord. Сервер в Discord больше не ходит — всё идёт по HTTPS на бота, а бот (хостинг вне РФ) пишет в Discord сам.

```
Rust-сервер ──HTTPS──▶ bot-1790555988-1262-xo4y-d.bothost.tech ──▶ Discord
  (DiscordBridge)  ◀── сервер сам забирает задачи раз в 2 с (статистика, сброс, привязка)
```

| Что | Откуда | Куда |
|---|---|---|
| Логи чата, команд, ЛС, мутов | плагин **Chat** | канал `1535261519334346792` |
| Вход/выход с точной причиной из консоли | плагин **DiscordPresenceDynamic** 3.0 | канал `1535261407191236608` |
| Репорты (и проверки) | плагин **QuickPanelBridge** | канал `1535261345878904932` |
| Коды привязки RaidAlert | игрок пишет код | канал `1535257267534823515` (или `/link КОД`) |
| Оповещения о рейде | плагин **RaidAlert** | личка игрока |
| Начало/конец стрима | Twitch API | `twitch.notifyChannelId` |
| Статус бота | Discord | «👥 Участников: N» ⇄ «🟢 Онлайн: M» каждые 5 с |

Команды: `/tw` — стримеры (сколько стримили за вайп + сколько наиграли на сервере), `/stats` — все игроки за вайп (+ CSV), `/reset` — обнулить статистику на сервере и в боте (админы, с подтверждением, итоги файлом), `/link КОД` — привязка RaidAlert.

## 1. Discord Developer Portal

1. <https://discord.com/developers/applications> → New Application → **Bot** → Reset Token (токен → переменная `DISCORD_TOKEN`).
2. Bot → Privileged Gateway Intents → включи **Message Content Intent** (бот читает коды в канале привязки). Без него бот тоже запустится, но привязка будет работать только через `/link КОД`.
3. OAuth2 → URL Generator: scopes `bot` + `applications.commands`. Права: View Channels, Send Messages, Embed Links, Attach Files, Read Message History, **Manage Messages** (удалять сообщения с кодом), **Mention Everyone** (репорты с @everyone, стримы), **Manage Roles** (если выдаёшь роль при привязке — роль бота должна стоять выше выдаваемой).
4. У игроков должны быть открыты ЛС от участников сервера — иначе оповещение о рейде не дойдёт (бот это пропустит и запишет в лог).

## 2. bothost

1. Залей эту папку в **приватный** репозиторий GitHub (в корне `package.json`, `Dockerfile`, `src/`). Папку `plugins/` можно не заливать.
2. Слот `bot-1790555988-1262-xo4y-d` → язык Node.js / Dockerfile → вкладка «Домен»: домен включён, порт **3000**.
3. Вкладка «Переменные» (значения — в `bothost-variables.txt`, его в Git не коммить):
   `DISCORD_TOKEN`, `GUILD_ID`, `API_SECRET`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, по желанию `ALLOWED_IPS` (IP игрового сервера) и `DATA_DIR` (путь к постоянному диску).
4. Проверка: `https://bot-1790555988-1262-xo4y-d.bothost.tech/api/health` → `{"ok":true,...}`. Проверь и **с игрового сервера**: `curl https://bot-1790555988-1262-xo4y-d.bothost.tech/api/health`.

Всё несекретное — в `config.json`:

- `raid.linkChannelId` — канал привязки; `raid.linkRoleId` — роль при привязке (пусто — не выдавать); `raid.deleteCodeMessage`, `raid.wrongCodeReply`.
- `twitch.notifyChannelId` — **канал уведомлений о стримах (впиши ID)**; `twitch.streamers` — список `{ "url": "https://www.twitch.tv/ник", "steamId": "7656119…" }`. `steamId` нужен для `/tw` (наигранное время).
- `presence.frames` — кадры статуса (можно добавить `"🎮 {server_online}/{server_max}"`), `presence.frameSeconds` — 5.
- `adminRoleIds` — роли, которым можно `/reset` кроме администраторов.
- `commands.statsInChannel: false` — ответы `/tw` и `/stats` видит только вызвавший.

Данные бота — `data/` (очередь сообщений, коды привязки, время стримов). При передеплое может стираться — укажи `DATA_DIR` на постоянный диск или делай бэкап.

## 3. Плагины (oxide/plugins)

| Файл | Что изменено |
|---|---|
| `DiscordBridge.cs` | **новый**: связь с ботом, очередь с повторами (переживает рестарт), наигранное время за вайп (сброс на вайпе автоматически) |
| `Chat.cs` 1.1.0 | вместо `Webhook` — `ID канала Discord` (по умолчанию `1535261519334346792`), отправка через DiscordBridge |
| `DiscordPresenceDynamic.cs` 3.0.0 | не нужен Oxide.Ext.Discord и токен; вход/выход → `1535261407191236608`; причина: перевод **+ строка из консоли** (`Kicked: EAC: …`, `Timed Out` …) и сколько был в игре |
| `QuickPanelBridge.cs` 1.9.0 | `ReportsChannelId` = `1535261345878904932`, `BansChannelId` (пусто — не слать) вместо вебхуков |
| `RaidAlert.cs` 2.0.0 | токен бота и опрос канала убраны: код уходит боту, привязка приходит от бота, ЛС о рейде шлёт бот. API для Menu не менялось |

`oxide/config/DiscordBridge.json` создаётся сам: адрес бота и секрет уже вписаны (секрет = `API_SECRET` из `bothost-variables.txt`).

У Chat, DiscordPresenceDynamic и QuickPanelBridge старые ключи вебхуков в конфиге больше не читаются — после загрузки проверь, что включены нужные `Включить логирование` в Chat.

Консоль сервера:

- `bridge.status` — связь с ботом, очередь, сколько отправлено;
- `bridge.test 1535261519334346792` — тестовое сообщение в канал;
- `bridge.flush` — отправить очередь немедленно;
- `quickpanel.discordtest` — проверка канала репортов; `dpd.debug`.

## 4. API бота (для своих плагинов)

Из любого плагина: `DiscordBridge.Call("API_SendMessage", "ID_канала", jsonСообщения)` — JSON как у вебхука (`content`, `embeds`, `allowed_mentions`). Также `API_SendText`, `API_SendDm`, `API_GetPlaytime(steamId)`.

HTTP (заголовок `Authorization: Bearer API_SECRET`): `POST /api/push`, `POST /api/status`, `POST /api/playtime`, `GET /api/poll`, `POST /api/ack`, `GET /api/bot-state` (отладка).

Бот пишет только в каналы своего Discord-сервера (`GUILD_ID`), чужие ID отклоняются.
