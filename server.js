'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const cco = require('./lib/cco');
const history = require('./lib/history');
const bepass = require('./lib/bepass');
const gate = require('./lib/gate');
const siport = require('./lib/siport');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const DATA_DIR = path.join(ROOT, 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULT_DB = {
  host: '10.200.80.6',
  port: 1433,
  database: 'SIPORTNTACC',
  user: 'sa',
  password: '',
  encrypt: false,
};

const DEFAULT_HISTORY_MYSQL = {
  enabled: false,
  host: '',
  port: 3306,
  database: 'dashshows',
  user: '',
  password: '',
  intervalMs: history.DEFAULT_INTERVAL_MS,
};

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_NAME = 'dashshows_session';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function migrateFromConfig() {
  if (fs.existsSync(SHOWS_PATH)) return;
  let legacy = {};
  try {
    legacy = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    legacy = {};
  }
  const now = new Date().toISOString();
  const show = {
    id: 'show-default',
    type: 'boletius',
    title: 'Show principal',
    slug: 'show-principal',
    eventId: String(legacy.eventId || ''),
    showId: String(legacy.showId || ''),
    apiKey: String(legacy.apiKey || ''),
    gateOpenHour: Number(legacy.gateOpenHour) || 16,
    gateOpenMinute: Number(legacy.gateOpenMinute) || 0,
    eyebrowText: String(legacy.eyebrowText || ''),
    venueName: String(legacy.venueName || ''),
    logoUrl: '',
    showArtUrl: String(legacy.showArtUrl || ''),
    createdAt: now,
    updatedAt: now,
  };
  const store = {
    port: Number(legacy.port) || 4173,
    pollIntervalMs: Number(legacy.pollIntervalMs) || 15000,
    theme: 'default',
    activeShowId: show.id,
    db: Object.assign({}, DEFAULT_DB),
    historyMysql: Object.assign({}, DEFAULT_HISTORY_MYSQL),
    defaultSectorNames: Object.assign({}, cco.DEFAULT_SECTOR_NAMES),
    shows: [show],
  };
  writeStore(store);
}

function normalizeTheme(value) {
  return value === 'nubank-parque' ? 'nubank-parque' : 'default';
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseArtFit(source, existing) {
  const from = source && typeof source === 'object' ? source : {};
  const prev = existing && typeof existing === 'object' ? existing : {};
  const zoomSrc = from.showArtZoom != null ? from.showArtZoom : prev.showArtZoom;
  const xSrc = from.showArtX != null ? from.showArtX : prev.showArtX;
  const ySrc = from.showArtY != null ? from.showArtY : prev.showArtY;
  return {
    showArtZoom: Math.round(clampNumber(zoomSrc, 0.5, 3, 1) * 100) / 100,
    showArtX: Math.round(clampNumber(xSrc, 0, 100, 50) * 10) / 10,
    showArtY: Math.round(clampNumber(ySrc, 0, 100, 50) * 10) / 10,
  };
}

function normalizeStore(store) {
  if (!Array.isArray(store.shows)) store.shows = [];
  if (!store.pollIntervalMs) store.pollIntervalMs = 15000;
  if (!store.port) store.port = 4173;
  store.theme = normalizeTheme(store.theme);
  if (!store.db || typeof store.db !== 'object') {
    store.db = Object.assign({}, DEFAULT_DB);
  } else {
    store.db = Object.assign({}, DEFAULT_DB, store.db);
  }
  if (!store.historyMysql || typeof store.historyMysql !== 'object') {
    store.historyMysql = Object.assign({}, DEFAULT_HISTORY_MYSQL);
  } else {
    store.historyMysql = Object.assign({}, DEFAULT_HISTORY_MYSQL, store.historyMysql);
    store.historyMysql.enabled = store.historyMysql.enabled === true;
    store.historyMysql.port = Number(store.historyMysql.port) || 3306;
    store.historyMysql.intervalMs = history.normalizeIntervalMs(store.historyMysql.intervalMs);
  }
  if (!store.defaultSectorNames || typeof store.defaultSectorNames !== 'object') {
    store.defaultSectorNames = Object.assign({}, cco.DEFAULT_SECTOR_NAMES);
  }
  store.shows.forEach(function (show) {
    if (!show.type) show.type = 'boletius';
    if (show.weather === undefined) show.weather = null;
    if (show.published == null) show.published = true;
    if (show.theme !== 'nubank-parque' && show.theme !== 'default') show.theme = '';
    if (show.historyEnabled == null) show.historyEnabled = true;
    if (show.eventDate == null) show.eventDate = '';
    if (show.venueCity == null) show.venueCity = '';
    if (show.eventName == null) show.eventName = show.title || '';
    if (show.logoUrl == null) show.logoUrl = '';
    if (show.type === 'cco') {
      if (!Array.isArray(show.version)) show.version = ['10'];
      if (!show.sectorNames || typeof show.sectorNames !== 'object') {
        show.sectorNames = Object.assign({}, store.defaultSectorNames);
      }
      if (show.mockData == null) show.mockData = false;
    }
    if (show.type === 'bepass') {
      if (show.companyId == null) show.companyId = '';
      if (show.authUser == null) show.authUser = '';
      if (show.authPassword == null) show.authPassword = '';
      if (show.authUrl == null) show.authUrl = bepass.defaultAuthUrl();
      if (show.clientId == null) show.clientId = bepass.defaultClientId();
    }
    const artFit = parseArtFit(show, null);
    show.showArtZoom = artFit.showArtZoom;
    show.showArtX = artFit.showArtX;
    show.showArtY = artFit.showArtY;
  });
  return store;
}

function readStore() {
  ensureDirs();
  migrateFromConfig();
  const raw = fs.readFileSync(SHOWS_PATH, 'utf8');
  const store = normalizeStore(JSON.parse(raw));
  return store;
}

function writeStore(store) {
  ensureDirs();
  const tmp = SHOWS_PATH + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, SHOWS_PATH);
}

function getAdminPassword() {
  return process.env.ADMIN_PASSWORD || process.env.DASHSHOWS_ADMIN_PASSWORD || 'admin123';
}

function getSessionSecret() {
  const fromEnv = process.env.ADMIN_SECRET || process.env.DASHSHOWS_SESSION_SECRET;
  if (fromEnv) return fromEnv;
  return crypto.createHash('sha256').update('dashshows:' + getAdminPassword()).digest('hex');
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res, status, text, type) {
  const body = String(text);
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  const parts = header.split(';');
  for (let i = 0; i < parts.length; i++) {
    const idx = parts[i].indexOf('=');
    if (idx === -1) continue;
    const key = parts[i].slice(0, idx).trim();
    const val = parts[i].slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  }
  return out;
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const body = parts[0];
  const sig = parts[1];
  const expected = crypto.createHmac('sha256', getSessionSecret()).update(body).digest('base64url');
  if (!timingSafeEqualStr(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || !payload.exp || Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function sessionCookieHeader(token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return (
    COOKIE_NAME + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge
  );
}

function clearSessionCookieHeader() {
  return COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  return !!verifySession(cookies[COOKIE_NAME]);
}

function requireAuth(req, res) {
  if (!isAuthenticated(req)) {
    sendJson(res, 401, { error: 'Não autenticado' });
    return false;
  }
  return true;
}

function slugify(input) {
  return String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80) || 'show';
}

function uniqueSlug(store, base, excludeId) {
  let slug = slugify(base);
  let candidate = slug;
  let n = 2;
  while (store.shows.some((s) => s.slug === candidate && s.id !== excludeId)) {
    candidate = slug + '-' + n;
    n += 1;
  }
  return candidate;
}

function newId() {
  return 'show-' + crypto.randomBytes(8).toString('hex');
}

function findShowById(store, id) {
  return store.shows.find((s) => s.id === id) || null;
}

function findShowBySlug(store, slug) {
  return store.shows.find((s) => s.slug === slug) || null;
}

function isShowPublished(show) {
  return !!(show && show.published === true);
}

function isDraft(show) {
  return !!(show && show.published !== true && !show.finalizedAt);
}

function resolveShowTheme(show, store) {
  if (show && (show.theme === 'nubank-parque' || show.theme === 'default')) {
    return show.theme;
  }
  return normalizeTheme(store && store.theme);
}

function canViewShow(req, show) {
  if (!show) return false;
  if (!isDraft(show)) return true;
  return isAuthenticated(req);
}

function getActiveShow(store) {
  const byId = findShowById(store, store.activeShowId);
  if (byId && !isDraft(byId)) return byId;
  const published = store.shows.find(function (s) { return !isDraft(s); });
  if (published) return published;
  return store.shows[0] || null;
}

function isShowFinalized(show) {
  return !!(show && show.finalizedAt);
}

function unpublishedPageHtml() {
  return '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Show não publicado</title>' +
    '<style>body{font-family:system-ui;background:#16002A;color:#F4ECFA;display:grid;place-items:center;min-height:100vh;margin:0}' +
    'a{color:#A7D296}</style></head><body><div><h1>Show não publicado</h1>' +
    '<p>Este endereço ainda é um rascunho.</p><p><a href="/">Ir para o dashboard ao vivo</a></p></div></body></html>';
}

function publicShowView(show, store) {
  return {
    id: show.id,
    type: show.type || 'boletius',
    title: show.title,
    slug: show.slug,
    gateOpenHour: show.gateOpenHour,
    gateOpenMinute: show.gateOpenMinute != null ? show.gateOpenMinute : 0,
    eyebrowText: show.eyebrowText,
    venueName: show.venueName,
    logoUrl: show.logoUrl || '',
    showArtUrl: show.showArtUrl || '',
    showArtZoom: show.showArtZoom != null ? show.showArtZoom : 1,
    showArtX: show.showArtX != null ? show.showArtX : 50,
    showArtY: show.showArtY != null ? show.showArtY : 50,
    pollIntervalMs: store.pollIntervalMs,
    isActive: store.activeShowId === show.id,
    publicUrl: '/shows/' + show.slug,
    finalizedAt: show.finalizedAt || null,
    isFinalized: isShowFinalized(show),
    published: isShowPublished(show),
    theme: show.theme === 'nubank-parque' || show.theme === 'default' ? show.theme : '',
  };
}

function adminShowView(show, store) {
  const base = Object.assign({}, publicShowView(show, store), {
    createdAt: show.createdAt,
    updatedAt: show.updatedAt,
    eventName: show.eventName || show.title || '',
    eventDate: show.eventDate || '',
    venueCity: show.venueCity || '',
    weather: show.weather || null,
    historyEnabled: show.historyEnabled !== false,
    historyIntervalMs: show.historyIntervalMs != null ? show.historyIntervalMs : null,
  });
  if ((show.type || 'boletius') === 'cco') {
    return Object.assign(base, {
      version: Array.isArray(show.version) ? show.version : ['10'],
      mockData: show.mockData === true,
      sectorNames: show.sectorNames || Object.assign({}, store.defaultSectorNames),
      eventId: '',
      showId: '',
      apiKey: '',
      companyId: '',
      authUser: '',
      authUrl: '',
      clientId: '',
      hasAuthPassword: false,
    });
  }
  if ((show.type || 'boletius') === 'bepass') {
    return Object.assign(base, {
      eventId: show.eventId || '',
      showId: '',
      apiKey: '',
      companyId: show.companyId || '',
      authUser: show.authUser || '',
      authUrl: show.authUrl || bepass.defaultAuthUrl(),
      clientId: show.clientId || bepass.defaultClientId(),
      hasAuthPassword: !!String(show.authPassword || '').trim(),
      mockData: false,
      sectorNames: {},
      version: [],
    });
  }
  return Object.assign(base, {
    eventId: show.eventId,
    showId: show.showId,
    apiKey: show.apiKey,
    version: [],
    mockData: false,
    sectorNames: {},
    companyId: '',
    authUser: '',
    authUrl: '',
    clientId: '',
    hasAuthPassword: false,
  });
}

function parseVersionList(input, existing) {
  if (Array.isArray(input)) {
    return input.map(function (v) { return String(v).trim(); }).filter(Boolean).slice(0, 32);
  }
  if (typeof input === 'string') {
    return input.split(/[,;\s]+/).map(function (v) { return v.trim(); }).filter(Boolean).slice(0, 32);
  }
  if (existing && Array.isArray(existing.version) && existing.version.length) {
    return existing.version.slice();
  }
  return ['10'];
}

function parseSectorNames(input, store, existing) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const out = {};
    Object.keys(input).forEach(function (key) {
      const k = String(key).trim().slice(0, 64);
      if (!k) return;
      out[k] = String(input[key] == null ? '' : input[key]).trim().slice(0, 80);
    });
    return out;
  }
  if (typeof input === 'string' && input.trim()) {
    try {
      return parseSectorNames(JSON.parse(input), store, existing);
    } catch (_) {
      throw new Error('sectorNames deve ser um JSON objeto');
    }
  }
  if (existing && existing.sectorNames && typeof existing.sectorNames === 'object') {
    return Object.assign({}, existing.sectorNames);
  }
  return Object.assign({}, store.defaultSectorNames || cco.DEFAULT_SECTOR_NAMES);
}

function parseWeather(input, existing) {
  if (input === null || input === '') return null;
  if (input && typeof input === 'object') {
    const lat = Number(input.lat);
    const lon = Number(input.lon);
    if (isNaN(lat) || isNaN(lon)) return null;
    return { lat: lat, lon: lon };
  }
  if (existing && existing.weather) return existing.weather;
  return null;
}

function sanitizeShowInput(body, store, existing) {
  const title = String(body.title || '').trim();
  if (!title) throw new Error('Título é obrigatório');

  const type = String(body.type || (existing && existing.type) || 'boletius').toLowerCase();
  if (type !== 'boletius' && type !== 'cco' && type !== 'bepass') {
    throw new Error('type deve ser boletius, cco ou bepass');
  }

  let gateOpenHour = Number(body.gateOpenHour);
  if (isNaN(gateOpenHour) || gateOpenHour < 0 || gateOpenHour > 23) {
    gateOpenHour = existing ? existing.gateOpenHour : 16;
  }

  let gateOpenMinute = Number(body.gateOpenMinute);
  if (isNaN(gateOpenMinute) || gateOpenMinute < 0 || gateOpenMinute > 59) {
    gateOpenMinute = existing && existing.gateOpenMinute != null ? existing.gateOpenMinute : 0;
  }

  const slugSource = body.slug ? String(body.slug) : title;
  const slug = uniqueSlug(store, slugSource, existing ? existing.id : null);
  const artFit = parseArtFit(body, existing);

  const eventDate = String(body.eventDate != null ? body.eventDate : (existing && existing.eventDate) || '').trim();
  if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    throw new Error('eventDate deve estar no formato YYYY-MM-DD');
  }

  let logoUrl = existing ? (existing.logoUrl || '') : '';
  if (body.logoUrl != null) logoUrl = String(body.logoUrl).trim();

  let theme = existing && (existing.theme === 'nubank-parque' || existing.theme === 'default')
    ? existing.theme
    : '';
  if (body.theme != null) {
    const t = String(body.theme).trim();
    theme = (t === 'nubank-parque' || t === 'default') ? t : '';
  }

  let published = existing ? existing.published === true : false;
  if (body.published != null) {
    published = body.published === true || body.published === 'true' || body.published === 1;
  }
  if (body.setActive) published = true;

  let historyEnabled = existing && existing.historyEnabled === false ? false : true;
  if (body.historyEnabled != null) {
    historyEnabled = body.historyEnabled === true || body.historyEnabled === 'true' || body.historyEnabled === 1;
  }

  let historyIntervalMs = existing && existing.historyIntervalMs != null ? existing.historyIntervalMs : null;
  if (body.historyIntervalMs != null && body.historyIntervalMs !== '') {
    historyIntervalMs = history.normalizeIntervalMs(body.historyIntervalMs);
  } else if (body.historyIntervalSec != null && body.historyIntervalSec !== '') {
    historyIntervalMs = history.normalizeIntervalMs(Number(body.historyIntervalSec) * 1000);
  }

  const common = {
    type: type,
    title: title.slice(0, 160),
    slug: slug,
    gateOpenHour: gateOpenHour,
    gateOpenMinute: gateOpenMinute,
    eyebrowText: body.eyebrowText != null
      ? String(body.eyebrowText).trim().slice(0, 200)
      : (existing ? existing.eyebrowText || '' : ''),
    venueName: String(body.venueName || '').trim().slice(0, 200),
    venueCity: String(body.venueCity != null ? body.venueCity : (existing && existing.venueCity) || '').trim().slice(0, 120),
    eventName: String(body.eventName != null ? body.eventName : (existing && existing.eventName) || title).trim().slice(0, 160),
    eventDate: eventDate,
    logoUrl: logoUrl,
    showArtUrl: body.showArtUrl != null ? String(body.showArtUrl).trim() : (existing ? existing.showArtUrl : ''),
    showArtZoom: artFit.showArtZoom,
    showArtX: artFit.showArtX,
    showArtY: artFit.showArtY,
    published: published,
    theme: theme,
    historyEnabled: historyEnabled,
    historyIntervalMs: historyIntervalMs,
  };

  if (type === 'cco') {
    return Object.assign(common, {
      eventId: '',
      showId: '',
      apiKey: '',
      companyId: '',
      authUser: '',
      authPassword: '',
      authUrl: '',
      clientId: '',
      version: parseVersionList(body.version, existing),
      weather: parseWeather(body.weather, existing),
      mockData: body.mockData === true || body.mockData === 'true' || body.mockData === 1,
      sectorNames: parseSectorNames(body.sectorNames, store, existing),
    });
  }

  if (type === 'bepass') {
    const eventId = String(body.eventId || '').trim();
    const companyId = String(body.companyId || '').trim();
    const authUser = String(body.authUser || '').trim();
    const authPassword = String(
      body.authPassword != null && String(body.authPassword).trim()
        ? body.authPassword
        : (existing && existing.authPassword) || ''
    ).trim();
    const authUrl = bepass.resolveAuthUrl(
      body.authUrl != null ? body.authUrl : (existing && existing.authUrl) || bepass.defaultAuthUrl()
    );
    const clientId = String(
      body.clientId != null ? body.clientId : (existing && existing.clientId) || bepass.defaultClientId()
    ).trim() || bepass.defaultClientId();
    if (!authUser) {
      throw new Error('usuário BePass é obrigatório');
    }
    if (!authPassword) {
      throw new Error('senha BePass é obrigatória');
    }
    return Object.assign(common, {
      eventId: eventId.slice(0, 64),
      showId: '',
      apiKey: '',
      companyId: companyId.slice(0, 64),
      authUser: authUser.slice(0, 200),
      authPassword: authPassword.slice(0, 256),
      authUrl: authUrl.slice(0, 400),
      clientId: clientId.slice(0, 120),
      version: [],
      weather: parseWeather(body.weather, existing),
      mockData: false,
      sectorNames: {},
    });
  }

  const eventId = String(body.eventId || '').trim();
  const showId = String(body.showId || '').trim();
  const apiKey = String(body.apiKey != null ? body.apiKey : (existing && existing.apiKey) || '').trim();
  if (!eventId || !showId || !apiKey) {
    throw new Error('eventId, showId e apiKey são obrigatórios');
  }

  return Object.assign(common, {
    eventId: eventId.slice(0, 64),
    showId: showId.slice(0, 64),
    apiKey: apiKey.slice(0, 256),
    companyId: '',
    authUser: '',
    authPassword: '',
    authUrl: '',
    clientId: '',
    version: [],
    weather: parseWeather(body.weather, existing),
    mockData: false,
    sectorNames: {},
  });
}

function isLocalUpload(url) {
  return typeof url === 'string' && url.startsWith('/uploads/');
}

function unlinkUploadIfLocal(url) {
  if (!isLocalUpload(url)) return;
  const name = path.basename(url);
  const filePath = path.join(UPLOADS_DIR, name);
  if (!filePath.startsWith(UPLOADS_DIR)) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {
    // ignore
  }
}

function fetchUpstream(show, callback) {
  const qs =
    'eventId=' + encodeURIComponent(show.eventId) +
    '&apiKey=' + encodeURIComponent(show.apiKey) +
    '&showId=' + encodeURIComponent(show.showId);

  const url = 'https://api.boletius.com/DashboardsWs/access?' + qs;

  const req = https.get(url, (upstream) => {
    let raw = '';
    upstream.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        req.destroy(new Error('Resposta upstream grande demais'));
      }
    });
    upstream.on('end', () => {
      if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        callback(new Error('Upstream HTTP ' + upstream.statusCode));
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !parsed.data) {
          callback(new Error('Resposta upstream sem campo data'));
          return;
        }
        callback(null, parsed.data);
      } catch (err) {
        callback(new Error('JSON inválido da API'));
      }
    });
  });

  req.on('error', (err) => {
    callback(err);
  });

  req.setTimeout(15000, () => {
    req.destroy(new Error('Timeout na API upstream'));
  });
}

function buildBoletiusPayload(store, show, data, weather) {
  return Object.assign({}, data, {
    type: 'boletius',
    pollIntervalMs: store.pollIntervalMs,
    theme: resolveShowTheme(show, store),
    eventName: show.eventName || show.title || '',
    eventDate: show.eventDate || '',
    gateOpenHour: show.gateOpenHour,
    gateOpenMinute: show.gateOpenMinute != null ? show.gateOpenMinute : 0,
    showArtUrl: show.showArtUrl,
    showArtZoom: show.showArtZoom != null ? show.showArtZoom : 1,
    showArtX: show.showArtX != null ? show.showArtX : 50,
    showArtY: show.showArtY != null ? show.showArtY : 50,
    logoUrl: show.logoUrl || '',
    eyebrowText: show.eyebrowText,
    venueName: show.venueName,
    venueCity: show.venueCity || '',
    slug: show.slug,
    title: show.title,
    weather: weather || null,
    fetchedAt: new Date().toISOString(),
  });
}

function withFinalizedFlags(show, payload, store) {
  return Object.assign({}, payload || {}, {
    finalized: true,
    finalizedAt: show.finalizedAt || null,
    theme: resolveShowTheme(show, store),
  });
}

function fetchBoletiusPayload(store, show) {
  return new Promise(function (resolve, reject) {
    fetchUpstream(show, function (err, data) {
      if (err) {
        reject(err);
        return;
      }
      cco.fetchWeather(show.weather)
        .then(function (weather) {
          resolve(buildBoletiusPayload(store, show, data, weather));
        })
        .catch(function () {
          resolve(buildBoletiusPayload(store, show, data, null));
        });
    });
  });
}

function fetchLivePayload(store, show) {
  const type = show.type || 'boletius';
  let pending;
  if (type === 'cco') {
    pending = cco.getCcoPayload(store, show);
  } else if (type === 'bepass') {
    pending = bepass.getBepassPayload(store, show);
  } else {
    pending = fetchBoletiusPayload(store, show);
  }
  return pending.then(function (payload) {
    return gate.applyLiveAccessRule(show, payload);
  });
}

function serveFinalizedPayload(res, store, show) {
  if (show.finalSnapshot && typeof show.finalSnapshot === 'object') {
    sendJson(res, 200, withFinalizedFlags(show, show.finalSnapshot, store));
    return;
  }

  fetchLivePayload(store, show)
    .then(function (payload) {
      show.finalSnapshot = payload;
      show.updatedAt = new Date().toISOString();
      writeStore(store);
      sendJson(res, 200, withFinalizedFlags(show, payload, store));
    })
    .catch(function (err) {
      sendJson(res, 502, { error: String(err.message || err) });
    });
}

function handleApiData(req, res, show, store) {
  if (!show) {
    sendJson(res, 404, { error: 'Show não encontrado' });
    return;
  }

  if (!canViewShow(req, show)) {
    sendJson(res, 404, { error: 'Show não publicado' });
    return;
  }

  if (isShowFinalized(show)) {
    serveFinalizedPayload(res, store, show);
    return;
  }

  fetchLivePayload(store, show)
    .then(function (payload) {
      maybeRecordHistory(store, show, payload);
      sendJson(res, 200, payload);
    })
    .catch(function (err) {
      sendJson(res, 502, { error: String(err.message || err) });
    });
}

function readBody(req, limit, callback) {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) {
      callback(new Error('Payload grande demais'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    callback(null, Buffer.concat(chunks));
  });
  req.on('error', (err) => callback(err));
}

function parseJsonBody(req, callback) {
  readBody(req, 1024 * 1024, (err, buf) => {
    if (err) {
      callback(err);
      return;
    }
    if (!buf || !buf.length) {
      callback(null, {});
      return;
    }
    try {
      callback(null, JSON.parse(buf.toString('utf8')));
    } catch (_) {
      callback(new Error('JSON inválido'));
    }
  });
}

function parseMultipart(buffer, boundary) {
  const delim = Buffer.from('--' + boundary);
  const parts = [];
  let start = buffer.indexOf(delim);
  if (start === -1) return parts;
  start += delim.length;
  if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;

  while (start < buffer.length) {
    const next = buffer.indexOf(delim, start);
    let end = next === -1 ? buffer.length : next;
    let partBuf = buffer.slice(start, end);
    if (partBuf.length >= 2 && partBuf[partBuf.length - 2] === 13 && partBuf[partBuf.length - 1] === 10) {
      partBuf = partBuf.slice(0, partBuf.length - 2);
    }
    if (partBuf.length === 2 && partBuf[0] === 45 && partBuf[1] === 45) break;
    if (partBuf.length >= 1 && partBuf[0] === 45) break;

    const headerEnd = partBuf.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerText = partBuf.slice(0, headerEnd).toString('utf8');
      let content = partBuf.slice(headerEnd + 4);
      if (content.length >= 2 && content[content.length - 2] === 13 && content[content.length - 1] === 10) {
        content = content.slice(0, content.length - 2);
      }

      const nameMatch = /name="([^"]+)"/i.exec(headerText);
      const fileMatch = /filename="([^"]*)"/i.exec(headerText);
      const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
      if (nameMatch) {
        parts.push({
          name: nameMatch[1],
          filename: fileMatch ? fileMatch[1] : null,
          contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
          data: content,
        });
      }
    }

    if (next === -1) break;
    start = next + delim.length;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break;
  }
  return parts;
}

function detectImageExt(filename, contentType, data) {
  const fromName = path.extname(String(filename || '')).toLowerCase();
  if (IMAGE_EXTS.has(fromName)) return fromName;

  const type = String(contentType || '').toLowerCase();
  if (type.includes('png')) return '.png';
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
  if (type.includes('webp')) return '.webp';
  if (type.includes('gif')) return '.gif';
  if (type.includes('svg')) return '.svg';

  if (data && data.length >= 8) {
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return '.png';
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return '.jpg';
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
        data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return '.webp';
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return '.gif';
    const head = data.slice(0, 256).toString('utf8').toLowerCase();
    if (head.includes('<svg')) return '.svg';
  }
  return null;
}

function saveUploadPart(part) {
  if (!part || !part.data || !part.data.length) {
    throw new Error('Arquivo vazio');
  }
  if (part.data.length > MAX_UPLOAD_BYTES) {
    throw new Error('Arquivo excede 5 MB');
  }
  const ext = detectImageExt(part.filename, part.contentType, part.data);
  if (!ext) {
    throw new Error('Tipo de imagem inválido. Use JPEG, PNG, WebP, GIF ou SVG');
  }
  const name = Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex') + ext;
  const filePath = path.join(UPLOADS_DIR, name);
  fs.writeFileSync(filePath, part.data);
  return '/uploads/' + name;
}

function serveStaticFile(filePath, res) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      sendText(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const cache = filePath.startsWith(UPLOADS_DIR) ? 'public, max-age=86400' : 'no-store';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': cache,
    });
    res.end(content);
  });
}

function resolvePublicPath(urlPath) {
  const safeRel = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safeRel);
  if (!filePath.startsWith(PUBLIC_DIR)) return null;
  return filePath;
}

function serveDashboard(res, show) {
  const type = show && (show.type || 'boletius');
  const file = type === 'cco' ? 'cco.html' : type === 'bepass' ? 'bepass.html' : 'index.html';
  serveStaticFile(path.join(PUBLIC_DIR, file), res);
}

function serveAdminPage(res) {
  serveStaticFile(path.join(PUBLIC_DIR, 'admin.html'), res);
}

function handleLogin(req, res) {
  parseJsonBody(req, (err, body) => {
    if (err) {
      sendJson(res, 400, { error: String(err.message || err) });
      return;
    }
    const password = String((body && body.password) || '');
    if (!timingSafeEqualStr(password, getAdminPassword())) {
      sendJson(res, 401, { error: 'Senha incorreta' });
      return;
    }
    const token = signSession({
      role: 'admin',
      exp: Date.now() + SESSION_TTL_MS,
    });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': sessionCookieHeader(token),
    });
    res.end(JSON.stringify({ ok: true }));
  });
}

function handleLogout(req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': clearSessionCookieHeader(),
  });
  res.end(JSON.stringify({ ok: true }));
}

function handleAuthMe(req, res) {
  if (!isAuthenticated(req)) {
    sendJson(res, 401, { authenticated: false });
    return;
  }
  sendJson(res, 200, { authenticated: true });
}

function publicDbView(db) {
  return {
    host: db.host || '',
    port: Number(db.port) || 1433,
    database: db.database || 'SIPORTNTACC',
    user: db.user || '',
    encrypt: db.encrypt === true,
    hasPassword: !!(db.password && String(db.password).length),
  };
}

function publicHistoryMysqlView(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  return {
    enabled: c.enabled === true,
    host: c.host || '',
    port: Number(c.port) || 3306,
    database: c.database || 'dashshows',
    user: c.user || '',
    intervalMs: history.normalizeIntervalMs(c.intervalMs),
    hasPassword: !!(c.password && String(c.password).length),
  };
}

function maybeRecordHistory(store, show, payload) {
  if (!store || !store.historyMysql || !show || !payload) return;
  if (isShowFinalized(show)) return;
  if (show.historyEnabled === false) return;
  if (!gate.isGateOpen(show)) return;
  const cfg = Object.assign({}, store.historyMysql);
  if (show.historyIntervalMs != null) {
    cfg.intervalMs = history.normalizeIntervalMs(show.historyIntervalMs);
  }
  history.maybeSaveSnapshot(cfg, show, payload);
}

/** Offset fixo America/Sao_Paulo (UTC-3, sem horário de verão desde 2019). */
const SAO_PAULO_OFFSET_MS = -3 * 60 * 60 * 1000;

function parseEventDateParts(eventDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(eventDate || '').trim());
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

function gateOpenAtSaoPaulo(eventDate, gateOpenHour, gateOpenMinute) {
  const parts = parseEventDateParts(eventDate);
  if (!parts) return null;
  const h = Math.max(0, Math.min(23, Number(gateOpenHour)));
  const min = Math.max(0, Math.min(59, Number(gateOpenMinute)));
  if (isNaN(h) || isNaN(min)) return null;
  // Wall-clock SP → UTC: subtrair offset negativo = somar 3h
  return new Date(
    Date.UTC(parts.y, parts.mo - 1, parts.d, h, min, 0, 0) - SAO_PAULO_OFFSET_MS
  );
}

function weatherHighlight(point) {
  if (!point) return null;
  return {
    recordedAt: point.recordedAt || null,
    tempC: point.tempC,
    precipitationMm: point.precipitationMm,
    windKmh: point.windKmh,
    weatherLabel: point.weatherLabel,
  };
}

function nearestSeriesPoint(series, targetDate) {
  if (!targetDate || !series || !series.length) return null;
  const target = targetDate.getTime();
  if (isNaN(target)) return null;
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < series.length; i++) {
    const p = series[i];
    if (!p || !p.recordedAt) continue;
    const t = new Date(p.recordedAt).getTime();
    if (isNaN(t)) continue;
    const dist = Math.abs(t - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

function startOfDaySaoPaulo(eventDate) {
  const parts = parseEventDateParts(eventDate);
  if (!parts) return null;
  return new Date(
    Date.UTC(parts.y, parts.mo - 1, parts.d, 0, 0, 0, 0) - SAO_PAULO_OFFSET_MS
  );
}

function handleHistoryError(res, err) {
  if (err && err.code === 'HISTORY_DISABLED') {
    sendJson(res, 503, {
      error: 'Histórico MySQL desabilitado ou não configurado',
    });
    return;
  }
  console.error('[history-api]', err && err.message ? err.message : err);
  sendJson(res, 500, {
    error: 'Falha ao consultar histórico',
    detail: err && err.message ? String(err.message) : String(err),
  });
}

function handleHistoryShows(req, res) {
  const store = readStore();
  if (!history.isConfigured(store.historyMysql)) {
    sendJson(res, 503, {
      error: 'Histórico MySQL desabilitado ou não configurado',
    });
    return;
  }
  history
    .listShowsWithHistory(store.historyMysql)
    .then(function (rows) {
      const shows = rows.map(function (row) {
        const show = findShowById(store, row.showId);
        return {
          showId: row.showId,
          slug: (show && show.slug) || row.slug || '',
          title: (show && show.title) || row.eventName || row.showId,
          eventName: (show && (show.eventName || show.title)) || row.eventName || '',
          eventDate: (show && show.eventDate) || row.eventDate || '',
          dashboardType:
            (show && (show.type || 'boletius')) || row.dashboardType || '',
          gateOpenHour: show
            ? Number(show.gateOpenHour) || 16
            : 16,
          gateOpenMinute: show && show.gateOpenMinute != null
            ? Number(show.gateOpenMinute) || 0
            : 0,
          finalizedAt: show && show.finalizedAt ? show.finalizedAt : null,
          firstRecordedAt: row.firstRecordedAt,
          lastRecordedAt: row.lastRecordedAt,
          maxEntered: row.maxEntered,
          snapshotCount: row.snapshotCount,
        };
      });
      sendJson(res, 200, {
        theme: normalizeTheme(store.theme),
        shows: shows,
      });
    })
    .catch(function (err) {
      handleHistoryError(res, err);
    });
}

function handleHistorySeries(req, res, showId) {
  const store = readStore();
  if (!history.isConfigured(store.historyMysql)) {
    sendJson(res, 503, {
      error: 'Histórico MySQL desabilitado ou não configurado',
    });
    return;
  }

  const id = String(showId || '').slice(0, 64);
  const show = findShowById(store, id);

  history
    .getShowHistoryMeta(store.historyMysql, id)
    .then(function (meta) {
      if (!meta) {
        sendJson(res, 404, { error: 'Show sem histórico no MySQL' });
        return null;
      }

      const eventDate =
        (show && show.eventDate) || meta.eventDate || '';
      const gateOpenHour = show
        ? Number(show.gateOpenHour) || 16
        : 16;
      const gateOpenMinute =
        show && show.gateOpenMinute != null
          ? Number(show.gateOpenMinute) || 0
          : 0;
      const gateOpenAt = gateOpenAtSaoPaulo(
        eventDate,
        gateOpenHour,
        gateOpenMinute
      );

      // Clima: a partir do início do dia do evento (SP), sem o dia anterior da coleta.
      // Acessos no frontend continuam filtrados a partir da abertura dos portões.
      let from = startOfDaySaoPaulo(eventDate);
      if (!from && meta.firstRecordedAt) {
        from = new Date(meta.firstRecordedAt);
      } else if (!from && gateOpenAt) {
        from = new Date(gateOpenAt.getTime() - 60 * 60 * 1000);
      }

      let to = null;
      if (show && show.finalizedAt) {
        to = new Date(show.finalizedAt);
      } else if (meta.lastRecordedAt) {
        to = new Date(meta.lastRecordedAt);
      }

      return history
        .getHistorySeries(store.historyMysql, id, from, to)
        .then(function (result) {
          const series = (result && result.series) || [];
          const extras = (result && result.extras) || {};
          const last = series.length ? series[series.length - 1] : null;
          const first = series.length ? series[0] : null;
          const gateTs = gateOpenAt ? gateOpenAt.getTime() : null;
          let peakFlow = null;
          for (let i = 0; i < series.length; i++) {
            const p = series[i];
            if (gateTs != null && p.recordedAt) {
              const t = new Date(p.recordedAt).getTime();
              if (!isNaN(t) && t < gateTs) continue;
            }
            const f = p.flowPerMin;
            if (f == null) continue;
            if (peakFlow == null || f > peakFlow) peakFlow = f;
          }

          const capacity = last && last.totalCapacity != null ? last.totalCapacity : null;
          const entered = last && last.totalEntered != null ? last.totalEntered : null;
          const occupancyPct =
            capacity != null && capacity > 0 && entered != null
              ? Math.round((entered / capacity) * 1000) / 10
              : null;

          const weatherStartTarget = gateOpenAt
            ? new Date(gateOpenAt.getTime() - 60 * 60 * 1000)
            : null;
          const weatherStartPoint =
            nearestSeriesPoint(series, weatherStartTarget) || first;

          sendJson(res, 200, {
            theme: resolveShowTheme(show, store),
            show: {
              showId: id,
              slug: (show && show.slug) || meta.slug || '',
              title: (show && show.title) || meta.eventName || id,
              eventName:
                (show && (show.eventName || show.title)) || meta.eventName || '',
              eventDate: eventDate,
              dashboardType:
                (show && (show.type || 'boletius')) || meta.dashboardType || '',
              venueName: (show && show.venueName) || '',
              venueCity: (show && show.venueCity) || '',
              logoUrl: (show && show.logoUrl) || '',
              gateOpenHour: gateOpenHour,
              gateOpenMinute: gateOpenMinute,
              gateOpenAt: gateOpenAt ? gateOpenAt.toISOString() : null,
              finalizedAt: show && show.finalizedAt ? show.finalizedAt : null,
            },
            window: {
              from: from ? from.toISOString() : null,
              to: to ? to.toISOString() : null,
            },
            kpis: {
              totalEntered: entered,
              totalCapacity: capacity,
              totalRemaining: last ? last.totalRemaining : null,
              occupancyPct: occupancyPct,
              peakFlowPerMin: peakFlow,
              snapshotCount: series.length,
              weatherAtStart: weatherHighlight(weatherStartPoint),
              weatherAtEnd: weatherHighlight(last),
            },
            series: series,
            sectorTimeline: extras.sectorTimeline || [],
            sectorsOrdered: extras.sectorsOrdered || [],
            sectorTotals: extras.sectorTotals || {},
            gateTotals: extras.gateTotals || {},
            errors: extras.errors || {},
            entryStartIndex: extras.entryStartIndex || 0,
            entered: extras.entered != null ? extras.entered : entered,
          });
        });
    })
    .catch(function (err) {
      handleHistoryError(res, err);
    });
}

function serveHistoricoPage(res) {
  serveStaticFile(path.join(PUBLIC_DIR, 'historico.html'), res);
}

function handleListShows(req, res) {
  if (!requireAuth(req, res)) return;
  const store = readStore();
  sendJson(res, 200, {
    activeShowId: store.activeShowId,
    pollIntervalMs: store.pollIntervalMs,
    theme: normalizeTheme(store.theme),
    db: publicDbView(store.db),
    historyMysql: publicHistoryMysqlView(store.historyMysql),
    defaultSectorNames: store.defaultSectorNames || cco.DEFAULT_SECTOR_NAMES,
    shows: store.shows.map((s) => adminShowView(s, store)),
  });
}

function handleCreateShow(req, res) {
  if (!requireAuth(req, res)) return;
  parseJsonBody(req, (err, body) => {
    if (err) {
      sendJson(res, 400, { error: String(err.message || err) });
      return;
    }
    try {
      const store = readStore();
      const fields = sanitizeShowInput(body || {}, store, null);
      const now = new Date().toISOString();
      const show = Object.assign({
        id: newId(),
        createdAt: now,
        updatedAt: now,
      }, fields);
      store.shows.push(show);
      if (!store.activeShowId || (body && body.setActive)) {
        store.activeShowId = show.id;
        show.published = true;
      }
      writeStore(store);
      sendJson(res, 201, { show: adminShowView(show, store) });
    } catch (e) {
      sendJson(res, 400, { error: String(e.message || e) });
    }
  });
}

function handleUpdateShow(req, res, id) {
  if (!requireAuth(req, res)) return;
  parseJsonBody(req, (err, body) => {
    if (err) {
      sendJson(res, 400, { error: String(err.message || err) });
      return;
    }
    try {
      const store = readStore();
      const existing = findShowById(store, id);
      if (!existing) {
        sendJson(res, 404, { error: 'Show não encontrado' });
        return;
      }
      const fields = sanitizeShowInput(body || {}, store, existing);
      const oldLogo = existing.logoUrl;
      const oldArt = existing.showArtUrl;
      Object.assign(existing, fields, { updatedAt: new Date().toISOString() });
      if (body && body.setActive) store.activeShowId = existing.id;
      writeStore(store);
      if (oldLogo && oldLogo !== existing.logoUrl) unlinkUploadIfLocal(oldLogo);
      if (oldArt && oldArt !== existing.showArtUrl) unlinkUploadIfLocal(oldArt);
      sendJson(res, 200, { show: adminShowView(existing, store) });
    } catch (e) {
      sendJson(res, 400, { error: String(e.message || e) });
    }
  });
}

function handleDeleteShow(req, res, id) {
  if (!requireAuth(req, res)) return;
  const store = readStore();
  const idx = store.shows.findIndex((s) => s.id === id);
  if (idx === -1) {
    sendJson(res, 404, { error: 'Show não encontrado' });
    return;
  }
  if (store.shows.length === 1) {
    sendJson(res, 400, { error: 'Não é possível excluir o único show' });
    return;
  }
  const [removed] = store.shows.splice(idx, 1);
  if (store.activeShowId === removed.id) {
    store.activeShowId = store.shows[0].id;
  }
  writeStore(store);
  unlinkUploadIfLocal(removed.logoUrl);
  unlinkUploadIfLocal(removed.showArtUrl);
  sendJson(res, 200, { ok: true, activeShowId: store.activeShowId });
}

function handleSetActive(req, res, id) {
  if (!requireAuth(req, res)) return;
  const store = readStore();
  const show = findShowById(store, id);
  if (!show) {
    sendJson(res, 404, { error: 'Show não encontrado' });
    return;
  }
  show.published = true;
  store.activeShowId = show.id;
  show.updatedAt = new Date().toISOString();
  writeStore(store);
  sendJson(res, 200, { ok: true, activeShowId: store.activeShowId, show: adminShowView(show, store) });
}

function handlePublishShow(req, res, id) {
  if (!requireAuth(req, res)) return;
  const store = readStore();
  const show = findShowById(store, id);
  if (!show) {
    sendJson(res, 404, { error: 'Show não encontrado' });
    return;
  }
  show.published = true;
  show.updatedAt = new Date().toISOString();
  writeStore(store);
  sendJson(res, 200, { show: adminShowView(show, store) });
}

function handleDuplicateShow(req, res, id) {
  if (!requireAuth(req, res)) return;
  const store = readStore();
  const source = findShowById(store, id);
  if (!source) {
    sendJson(res, 404, { error: 'Show não encontrado' });
    return;
  }
  const now = new Date().toISOString();
  const copy = JSON.parse(JSON.stringify(source));
  copy.id = newId();
  copy.title = String(source.title || 'Show').slice(0, 140) + ' (cópia)';
  copy.slug = uniqueSlug(store, source.slug || copy.title, copy.id);
  copy.published = false;
  copy.finalizedAt = null;
  copy.finalSnapshot = null;
  copy.createdAt = now;
  copy.updatedAt = now;
  store.shows.push(copy);
  writeStore(store);
  sendJson(res, 201, { show: adminShowView(copy, store) });
}

function mergeDbForTest(body, stored) {
  const src = body && typeof body === 'object' ? body : {};
  const prev = stored && typeof stored === 'object' ? stored : {};
  return {
    host: String(src.host != null ? src.host : prev.host || '').trim(),
    port: Number(src.port != null ? src.port : prev.port) || 1433,
    database: String(src.database != null ? src.database : prev.database || '').trim(),
    user: String(src.user != null ? src.user : prev.user || '').trim(),
    password: String(src.password != null && String(src.password).length ? src.password : prev.password || ''),
    encrypt: src.encrypt != null ? (src.encrypt === true || src.encrypt === 'true') : prev.encrypt === true,
  };
}

function mergeMysqlForTest(body, stored) {
  const src = body && typeof body === 'object' ? body : {};
  const prev = stored && typeof stored === 'object' ? stored : {};
  return {
    enabled: true,
    host: String(src.host != null ? src.host : prev.host || '').trim(),
    port: Number(src.port != null ? src.port : prev.port) || 3306,
    database: String(src.database != null ? src.database : prev.database || '').trim(),
    user: String(src.user != null ? src.user : prev.user || '').trim(),
    password: String(src.password != null && String(src.password).length ? src.password : prev.password || ''),
  };
}

function handleTestDb(req, res) {
  if (!requireAuth(req, res)) return;
  parseJsonBody(req, function (err, body) {
    if (err) {
      sendJson(res, 400, { error: String(err.message || err) });
      return;
    }
    const store = readStore();
    const db = mergeDbForTest(body && body.db, store.db);
    if (!db.host) {
      sendJson(res, 400, { error: 'Informe o servidor do SQL Server' });
      return;
    }
    cco.testConnection(db)
      .then(function (result) {
        sendJson(res, 200, result);
      })
      .catch(function (e) {
        sendJson(res, 502, { ok: false, error: String(e.message || e) });
      });
  });
}

function handleTestMysql(req, res) {
  if (!requireAuth(req, res)) return;
  parseJsonBody(req, function (err, body) {
    if (err) {
      sendJson(res, 400, { error: String(err.message || err) });
      return;
    }
    const store = readStore();
    const cfg = mergeMysqlForTest(body && body.historyMysql, store.historyMysql);
    if (!cfg.host || !cfg.database) {
      sendJson(res, 400, { error: 'Informe servidor e banco do MySQL' });
      return;
    }
    history.testConnection(cfg)
      .then(function (result) {
        sendJson(res, 200, result);
      })
      .catch(function (e) {
        sendJson(res, 502, { ok: false, error: String(e.message || e) });
      });
  });
}

function handleFinalizeShow(req, res, id) {
  if (!requireAuth(req, res)) return;
  const store = readStore();
  const show = findShowById(store, id);
  if (!show) {
    sendJson(res, 404, { error: 'Show não encontrado' });
    return;
  }

  if (isShowFinalized(show) && show.finalSnapshot && typeof show.finalSnapshot === 'object') {
    sendJson(res, 200, { show: adminShowView(show, store) });
    return;
  }

  fetchLivePayload(store, show)
    .then(function (payload) {
      const now = new Date().toISOString();
      show.finalSnapshot = payload;
      show.finalizedAt = show.finalizedAt || now;
      show.updatedAt = now;
      writeStore(store);
      sendJson(res, 200, { show: adminShowView(show, store) });
    })
    .catch(function (err) {
      sendJson(res, 502, {
        error: 'Não foi possível capturar o último estado do evento: ' + String(err.message || err),
      });
    });
}

function handleReopenShow(req, res, id) {
  if (!requireAuth(req, res)) return;
  const store = readStore();
  const show = findShowById(store, id);
  if (!show) {
    sendJson(res, 404, { error: 'Show não encontrado' });
    return;
  }
  show.finalizedAt = null;
  show.finalSnapshot = null;
  show.updatedAt = new Date().toISOString();
  writeStore(store);
  sendJson(res, 200, { show: adminShowView(show, store) });
}

function handleUpload(req, res) {
  if (!requireAuth(req, res)) return;

  const contentType = String(req.headers['content-type'] || '');
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) {
    sendJson(res, 400, { error: 'multipart/form-data esperado' });
    return;
  }
  const boundary = (match[1] || match[2] || '').trim();

  readBody(req, MAX_UPLOAD_BYTES + 64 * 1024, (err, buf) => {
    if (err) {
      sendJson(res, 400, { error: String(err.message || err) });
      return;
    }
    try {
      const parts = parseMultipart(buf, boundary);
      const filePart = parts.find((p) => p.filename != null && p.name === 'file') ||
        parts.find((p) => p.filename != null);
      if (!filePart) {
        sendJson(res, 400, { error: 'Arquivo não enviado' });
        return;
      }
      const url = saveUploadPart(filePart);
      const field = parts.find((p) => p.name === 'field' && !p.filename);
      sendJson(res, 201, {
        url: url,
        field: field ? field.data.toString('utf8') : null,
      });
    } catch (e) {
      sendJson(res, 400, { error: String(e.message || e) });
    }
  });
}

function handleCcoSectors(req, res, parsed) {
  if (!requireAuth(req, res)) return;
  const store = readStore();
  if (!store.db || !store.db.host) {
    sendJson(res, 400, { error: 'Configure o host do SQL Server nas credenciais CCO' });
    return;
  }

  const versionParam = parsed.searchParams.get('version') || '10';
  const versions = parseVersionList(versionParam, null);

  cco.listSectorCodes(store, versions)
    .then(function (sectors) {
      sendJson(res, 200, {
        sectors: sectors,
        names: cco.resolveSectorNames(store, { sectorNames: {} }),
        version: versions,
      });
    })
    .catch(function (err) {
      sendJson(res, 502, { error: String(err.message || err) });
    });
}

function handleSettings(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method === 'GET') {
    const store = readStore();
    sendJson(res, 200, {
      pollIntervalMs: store.pollIntervalMs,
      theme: normalizeTheme(store.theme),
      activeShowId: store.activeShowId,
      db: publicDbView(store.db),
      historyMysql: publicHistoryMysqlView(store.historyMysql),
      defaultSectorNames: store.defaultSectorNames || cco.DEFAULT_SECTOR_NAMES,
    });
    return;
  }
  if (req.method === 'PUT') {
    parseJsonBody(req, (err, body) => {
      if (err) {
        sendJson(res, 400, { error: String(err.message || err) });
        return;
      }
      const store = readStore();
      if (body && body.pollIntervalMs != null) {
        const n = Number(body.pollIntervalMs);
        if (!isNaN(n) && n >= 5000 && n <= 300000) store.pollIntervalMs = n;
      }
      if (body && body.theme != null) {
        store.theme = normalizeTheme(body.theme);
      }
      if (body && body.db && typeof body.db === 'object') {
        const next = Object.assign({}, store.db);
        if (body.db.host != null) next.host = String(body.db.host).trim().slice(0, 200);
        if (body.db.port != null) {
          const p = Number(body.db.port);
          if (!isNaN(p) && p > 0 && p < 65536) next.port = p;
        }
        if (body.db.database != null) next.database = String(body.db.database).trim().slice(0, 120);
        if (body.db.user != null) next.user = String(body.db.user).trim().slice(0, 120);
        if (body.db.encrypt != null) next.encrypt = body.db.encrypt === true || body.db.encrypt === 'true';
        if (body.db.password != null && String(body.db.password).length) {
          next.password = String(body.db.password);
        }
        store.db = next;
      }
      if (body && body.historyMysql && typeof body.historyMysql === 'object') {
        const next = Object.assign({}, store.historyMysql || DEFAULT_HISTORY_MYSQL);
        if (body.historyMysql.enabled != null) {
          next.enabled = body.historyMysql.enabled === true || body.historyMysql.enabled === 'true';
        }
        if (body.historyMysql.host != null) {
          next.host = String(body.historyMysql.host).trim().slice(0, 200);
        }
        if (body.historyMysql.port != null) {
          const p = Number(body.historyMysql.port);
          if (!isNaN(p) && p > 0 && p < 65536) next.port = p;
        }
        if (body.historyMysql.database != null) {
          next.database = String(body.historyMysql.database).trim().slice(0, 120);
        }
        if (body.historyMysql.user != null) {
          next.user = String(body.historyMysql.user).trim().slice(0, 120);
        }
        if (body.historyMysql.password != null && String(body.historyMysql.password).length) {
          next.password = String(body.historyMysql.password);
        }
        if (body.historyMysql.intervalMs != null) {
          next.intervalMs = history.normalizeIntervalMs(body.historyMysql.intervalMs);
        } else if (body.historyMysql.intervalSec != null) {
          next.intervalMs = history.normalizeIntervalMs(Number(body.historyMysql.intervalSec) * 1000);
        }
        store.historyMysql = next;
      }
      if (body && body.defaultSectorNames != null) {
        store.defaultSectorNames = parseSectorNames(body.defaultSectorNames, store, {
          sectorNames: store.defaultSectorNames,
        });
      }
      writeStore(store);
      sendJson(res, 200, {
        pollIntervalMs: store.pollIntervalMs,
        theme: normalizeTheme(store.theme),
        activeShowId: store.activeShowId,
        db: publicDbView(store.db),
        historyMysql: publicHistoryMysqlView(store.historyMysql),
        defaultSectorNames: store.defaultSectorNames,
      });
    });
    return;
  }
  sendText(res, 405, 'Method not allowed');
}

const server = http.createServer((req, res) => {
  const host = req.headers.host || 'localhost';
  let parsed;
  try {
    parsed = new URL(req.url, 'http://' + host);
  } catch (_) {
    sendText(res, 400, 'Bad request');
    return;
  }

  const pathname = parsed.pathname;
  const method = req.method || 'GET';

  // Auth
  if (pathname === '/api/admin/login' && method === 'POST') {
    handleLogin(req, res);
    return;
  }
  if (pathname === '/api/admin/logout' && method === 'POST') {
    handleLogout(req, res);
    return;
  }
  if (pathname === '/api/admin/me' && method === 'GET') {
    handleAuthMe(req, res);
    return;
  }

  // Admin shows API
  if (pathname === '/api/admin/shows' && method === 'GET') {
    handleListShows(req, res);
    return;
  }
  if (pathname === '/api/admin/shows' && method === 'POST') {
    handleCreateShow(req, res);
    return;
  }

  const showMatch = /^\/api\/admin\/shows\/([^/]+)$/.exec(pathname);
  if (showMatch) {
    const id = decodeURIComponent(showMatch[1]);
    if (method === 'PUT') {
      handleUpdateShow(req, res, id);
      return;
    }
    if (method === 'DELETE') {
      handleDeleteShow(req, res, id);
      return;
    }
  }

  const activeMatch = /^\/api\/admin\/shows\/([^/]+)\/activate$/.exec(pathname);
  if (activeMatch && method === 'POST') {
    handleSetActive(req, res, decodeURIComponent(activeMatch[1]));
    return;
  }

  const publishMatch = /^\/api\/admin\/shows\/([^/]+)\/publish$/.exec(pathname);
  if (publishMatch && method === 'POST') {
    handlePublishShow(req, res, decodeURIComponent(publishMatch[1]));
    return;
  }

  const duplicateMatch = /^\/api\/admin\/shows\/([^/]+)\/duplicate$/.exec(pathname);
  if (duplicateMatch && method === 'POST') {
    handleDuplicateShow(req, res, decodeURIComponent(duplicateMatch[1]));
    return;
  }

  const finalizeMatch = /^\/api\/admin\/shows\/([^/]+)\/finalize$/.exec(pathname);
  if (finalizeMatch && method === 'POST') {
    handleFinalizeShow(req, res, decodeURIComponent(finalizeMatch[1]));
    return;
  }

  const reopenMatch = /^\/api\/admin\/shows\/([^/]+)\/reopen$/.exec(pathname);
  if (reopenMatch && method === 'POST') {
    handleReopenShow(req, res, decodeURIComponent(reopenMatch[1]));
    return;
  }

  if (pathname === '/api/admin/upload' && method === 'POST') {
    handleUpload(req, res);
    return;
  }

  if (pathname === '/api/admin/settings' && (method === 'GET' || method === 'PUT')) {
    handleSettings(req, res);
    return;
  }

  if (pathname === '/api/admin/settings/test-db' && method === 'POST') {
    handleTestDb(req, res);
    return;
  }

  if (pathname === '/api/admin/settings/test-mysql' && method === 'POST') {
    handleTestMysql(req, res);
    return;
  }

  if (pathname === '/api/admin/cco/sectors' && method === 'GET') {
    handleCcoSectors(req, res, parsed);
    return;
  }

  // Public data API
  if (pathname === '/api/data' && method === 'GET') {
    const store = readStore();
    const slug = parsed.searchParams.get('slug');
    const show = slug ? findShowBySlug(store, slug) : getActiveShow(store);
    handleApiData(req, res, show, store);
    return;
  }

  const dataSlugMatch = /^\/api\/data\/([^/]+)$/.exec(pathname);
  if (dataSlugMatch && method === 'GET') {
    const store = readStore();
    const show = findShowBySlug(store, decodeURIComponent(dataSlugMatch[1]));
    handleApiData(req, res, show, store);
    return;
  }

  // Public history API
  if (pathname === '/api/history/shows' && method === 'GET') {
    handleHistoryShows(req, res);
    return;
  }

  const historyShowMatch = /^\/api\/history\/([^/]+)$/.exec(pathname);
  if (historyShowMatch && method === 'GET') {
    handleHistorySeries(req, res, decodeURIComponent(historyShowMatch[1]));
    return;
  }

  if (pathname === '/api/siport' || pathname.startsWith('/api/siport/')) {
    siport.handle(req, res, parsed, { sendJson: sendJson, parseJsonBody: parseJsonBody });
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed');
    return;
  }

  // Pages
  if (pathname === '/admin' || pathname === '/admin/') {
    serveAdminPage(res);
    return;
  }

  if (pathname === '/historico' || pathname === '/historico/') {
    serveHistoricoPage(res);
    return;
  }

  if (pathname === '/siport' || pathname === '/siport/') {
    serveStaticFile(path.join(PUBLIC_DIR, 'siport.html'), res);
    return;
  }

  if (pathname === '/importacao' || pathname === '/importacao/') {
    serveStaticFile(path.join(PUBLIC_DIR, 'importacao.html'), res);
    return;
  }

  const showPageMatch = /^\/shows\/([^/]+)\/?$/.exec(pathname);
  if (showPageMatch) {
    const store = readStore();
    const show = findShowBySlug(store, decodeURIComponent(showPageMatch[1]));
    if (!show) {
      sendText(
        res,
        404,
        '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Show não encontrado</title>' +
        '<style>body{font-family:system-ui;background:#0b0910;color:#f5f3fa;display:grid;place-items:center;min-height:100vh;margin:0}' +
        'a{color:#e9b949}</style></head><body><div><h1>Show não encontrado</h1>' +
        '<p>O endereço informado não corresponde a nenhum show.</p><p><a href="/">Ir para o dashboard ativo</a></p></div></body></html>',
        'text/html; charset=utf-8'
      );
      return;
    }
    if (!canViewShow(req, show)) {
      sendText(res, 404, unpublishedPageHtml(), 'text/html; charset=utf-8');
      return;
    }
    serveDashboard(res, show);
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    const store = readStore();
    const homeShow = getActiveShow(store);
    if (!homeShow || !canViewShow(req, homeShow)) {
      sendText(res, 404, unpublishedPageHtml(), 'text/html; charset=utf-8');
      return;
    }
    serveDashboard(res, homeShow);
    return;
  }

  if (pathname === '/cco.html') {
    serveStaticFile(path.join(PUBLIC_DIR, 'cco.html'), res);
    return;
  }

  if (pathname === '/bepass.html') {
    serveStaticFile(path.join(PUBLIC_DIR, 'bepass.html'), res);
    return;
  }

  const filePath = resolvePublicPath(pathname);
  if (!filePath) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  serveStaticFile(filePath, res);
});

ensureDirs();
migrateFromConfig();

const store = readStore();
const port = Number(process.env.PORT) || Number(store.port) || 4173;
server.listen(port, () => {
  console.log('Dashboard rodando em http://localhost:' + port);
  console.log('Admin em http://localhost:' + port + '/admin');
  console.log('Histórico em http://localhost:' + port + '/historico');
  console.log('SiPort em http://localhost:' + port + '/siport');
  console.log('Importação em http://localhost:' + port + '/importacao');
  siport.startScheduler();
  if (!process.env.ADMIN_PASSWORD && !process.env.DASHSHOWS_ADMIN_PASSWORD) {
    console.log('Senha admin padrão: admin123 (defina ADMIN_PASSWORD para alterar)');
  }
});
