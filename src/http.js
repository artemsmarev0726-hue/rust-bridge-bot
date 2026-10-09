const http = require('http');
const crypto = require('crypto');
const { log } = require('./util');

function sendJson(res, code, obj) {
  if (res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** Читает JSON-тело (с лимитом). cb(body) вызывается только если JSON разобран. */
function readJson(req, res, limit, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { sendJson(res, 413, { ok: false, error: 'too large' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
    try { cb(body); } catch (e) {
      log('[http] ошибка обработки:', e);
      sendJson(res, 500, { ok: false, error: 'internal' });
    }
  });
  req.on('error', () => {});
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
  }
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

/** Authorization: Bearer <secret> (или X-Secret) + необязательный белый список IP. */
function makeAuth(cfg) {
  const want = Buffer.from(String(cfg.api.secret || ''));
  const ips = (cfg.api.allowedIps || []).map(String);
  const trust = cfg.http?.trustProxy !== false;
  let warned = 0;
  return (req) => {
    if (!want.length) return false;
    if (ips.length) {
      const ip = clientIp(req, trust);
      if (!ips.includes(ip)) {
        if (Date.now() - warned > 60_000) { warned = Date.now(); log(`[http] запрос с неразрешённого IP ${ip}`); }
        return false;
      }
    }
    const h = String(req.headers.authorization || '');
    const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-secret'] || ''));
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };
}

/** Один HTTP-сервер: обработчики вида (req, res, path) => true, если запрос их. */
function startHttpServer(cfg, handlers) {
  const port = Number(process.env.PORT) || cfg.http.port || 3000;
  const host = cfg.http.host || '0.0.0.0';
  const list = handlers.filter(Boolean);

  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (req.method === 'GET' && (path === '/' || path === '/api/health')) return sendJson(res, 200, { ok: true, name: 'rust-bridge-bot' });
    try {
      for (const h of list) if (h(req, res, path)) return;
    } catch (e) {
      log('[http] ошибка обработчика:', e);
      return sendJson(res, 500, { ok: false, error: 'internal' });
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
  });
  server.requestTimeout = 60_000;
  server.on('error', (e) => log('[http] сервер:', e.message));
  server.listen(port, host, () => log(`[http] слушаю http://${host}:${port}`));
  return server;
}

module.exports = { startHttpServer, sendJson, readJson, makeAuth };
