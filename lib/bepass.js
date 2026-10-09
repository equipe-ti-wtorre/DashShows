'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const cco = require('./cco');
const history = require('./history');

const DEFAULT_BASE_URL = 'https://api.bepass.app';
const DEFAULT_TOKEN_URL = 'https://authsso.bepass.app/realms/bepass/protocol/openid-connect/token';
const DEFAULT_CLIENT_ID = 'app-graph';
const DEFAULT_SCOPE = 'openid tenants';
const DEFAULT_CCO_BASE = 'https://cco.bepass.app';
const DEFAULT_REDIRECT_URI = 'https://cco.bepass.app/oauth/callback';
const REQUEST_TIMEOUT_MS = 20000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TOKEN_SKEW_MS = 15 * 1000;
const DEFAULT_TOKEN_TTL_MS = 45 * 1000;
const SAO_PAULO_TZ = 'America/Sao_Paulo';

const tokenCache = Object.create(null);
const flowCache = Object.create(null);

function defaultAuthUrl() {
  return DEFAULT_TOKEN_URL;
}

function defaultClientId() {
  return DEFAULT_CLIENT_ID;
}

function resolveAuthUrl(value) {
  const raw = String(value || '').trim() || DEFAULT_TOKEN_URL;
  try {
    const url = new URL(raw);
    if (url.pathname.indexOf('/protocol/openid-connect/auth') !== -1) {
      url.pathname = url.pathname.replace(/\/protocol\/openid-connect\/auth.*/, '/protocol/openid-connect/token');
      url.search = '';
      url.hash = '';
      return url.toString();
    }
    return raw;
  } catch (_) {
    return raw;
  }
}

function resolveAuthorizeUrl(value) {
  const tokenUrl = resolveAuthUrl(value);
  try {
    const url = new URL(tokenUrl);
    url.pathname = url.pathname.replace(/\/protocol\/openid-connect\/token.*/, '/protocol/openid-connect/auth');
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (_) {
    return DEFAULT_TOKEN_URL.replace(/\/token$/, '/auth');
  }
}

function cacheKey(show) {
  return [
    resolveAuthUrl(show.authUrl),
    String(show.clientId || DEFAULT_CLIENT_ID),
    String(show.authUser || ''),
  ].join('|');
}

function parseSetCookie(setCookie) {
  const map = Object.create(null);
  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  list.forEach(function (line) {
    const part = String(line || '').split(';')[0];
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    map[part.slice(0, idx)] = part.slice(idx + 1);
  });
  return map;
}

function mergeCookies(current, incoming) {
  return Object.assign({}, current || {}, incoming || {});
}

function cookieHeader(map) {
  return Object.keys(map || {}).filter(function (key) {
    return map[key] != null && map[key] !== '';
  }).map(function (key) {
    return key + '=' + map[key];
  }).join('; ');
}

function requestHttp(options) {
  return new Promise(function (resolve, reject) {
    let parsed;
    try {
      parsed = new URL(options.url);
    } catch (err) {
      reject(new Error('URL BePass inválida'));
      return;
    }

    const lib = parsed.protocol === 'http:' ? http : https;
    const headers = Object.assign({
      'User-Agent': 'DashShows',
      Accept: options.accept || 'application/json,text/html,*/*',
    }, options.headers || {});
    const body = options.body != null ? Buffer.from(options.body) : null;
    if (body && !headers['Content-Length']) {
      headers['Content-Length'] = String(body.length);
    }

    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: headers,
    }, function (res) {
      let raw = '';
      res.on('data', function (chunk) {
        raw += chunk;
        if (raw.length > MAX_BODY_BYTES) {
          req.destroy(new Error('Resposta BePass grande demais'));
        }
      });
      res.on('end', function () {
        let parsedBody = null;
        if (raw) {
          try {
            parsedBody = JSON.parse(raw);
          } catch (_) {
            parsedBody = raw;
          }
        }
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers || {},
          location: res.headers && res.headers.location || '',
          cookies: parseSetCookie(res.headers && res.headers['set-cookie']),
          body: parsedBody,
          raw: raw,
        });
      });
    });

    req.on('error', function (err) {
      reject(err);
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, function () {
      req.destroy(new Error('Timeout na API BePass'));
    });

    if (body) req.write(body);
    req.end();
  });
}

function requestJson(options) {
  return requestHttp(options);
}

function decodeJwt(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function tokenExpiryMs(token, expiresInSec) {
  const payload = decodeJwt(token);
  if (payload && payload.exp) return Number(payload.exp) * 1000;
  if (expiresInSec) return Date.now() + Number(expiresInSec) * 1000;
  return 0;
}

function isTokenFresh(entry) {
  return !!(entry && entry.token && entry.expiresAt && Date.now() < entry.expiresAt);
}

function firstUuid(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    const match = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0] : value.trim();
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = firstUuid(value[i]);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    return firstUuid(
      value.id ||
      value.companyId ||
      value.company_id ||
      value.tenantId ||
      value.tenant_id ||
      value.tenant
    );
  }
  return '';
}

function tenantsFromClaims(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.tenants)) {
    return payload.tenants.map(function (item) {
      return typeof item === 'string' ? item.trim() : firstUuid(item);
    }).filter(Boolean);
  }
  if (payload.tenants_roles && typeof payload.tenants_roles === 'object') {
    return Object.keys(payload.tenants_roles);
  }
  const single = firstUuid(
    payload.company_id ||
    payload.companyId ||
    payload.tenant ||
    payload.tenant_id ||
    payload.tenantId
  );
  return single ? [single] : [];
}

function companyIdFromClaims(payload) {
  const tenants = tenantsFromClaims(payload);
  if (tenants.length) return tenants[0];
  return firstUuid(
    payload && (
      payload.company_id ||
      payload.companyId ||
      payload.tenant ||
      payload.tenant_id ||
      payload.tenantId ||
      payload.tenants ||
      payload.tenant_ids
    )
  );
}

function resolveCompanyId(show, token, tenants) {
  const configured = String(show.companyId || '').trim();
  if (configured) return configured;
  if (Array.isArray(tenants) && tenants.length) return tenants[0];
  return companyIdFromClaims(decodeJwt(token));
}

function rememberSession(show, fields) {
  const token = fields.token || (fields.body && (
    fields.body.access_token ||
    fields.body.accessToken ||
    fields.body.clientAccessToken ||
    fields.body.token
  ));
  if (!token) throw new Error('Login BePass não retornou access_token');
  const body = fields.body || {};
  const tenants = fields.tenants || tenantsFromClaims(decodeJwt(token)) || [];
  const expiresIn = fields.expiresIn != null ? fields.expiresIn : body.expires_in || body.expiresIn;
  const exp = tokenExpiryMs(token, expiresIn);
  tokenCache[cacheKey(show)] = {
    token: String(token),
    refreshToken: fields.refreshToken || body.refresh_token || body.refreshToken || '',
    cookies: mergeCookies(fields.cookies, {}),
    tenants: tenants,
    companyId: resolveCompanyId(show, token, tenants),
    source: fields.source || 'keycloak',
    expiresAt: exp ? exp - TOKEN_SKEW_MS : Date.now() + DEFAULT_TOKEN_TTL_MS,
  };
  return tokenCache[cacheKey(show)];
}

function clearToken(show) {
  delete tokenCache[cacheKey(show)];
}

function formBody(fields) {
  return Object.keys(fields).map(function (key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(fields[key] == null ? '' : fields[key]);
  }).join('&');
}

function keycloakError(res, fallback) {
  if (res.body && typeof res.body === 'object') {
    const msg = res.body.error_description || res.body.error || res.body.message;
    if (typeof msg === 'string') return msg;
    if (msg && typeof msg === 'object' && msg.message) return msg.message;
  }
  return fallback;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier: verifier, challenge: challenge };
}

function isUnauthorizedClient(err) {
  const msg = String(err && err.message || '');
  return /unauthorized_client|direct access grants|invalid_client/i.test(msg);
}

async function requestToken(show, fields) {
  const res = await requestJson({
    method: 'POST',
    url: resolveAuthUrl(show.authUrl),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: formBody(fields),
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(keycloakError(res, 'Login BePass HTTP ' + res.statusCode));
  }
  if (!res.body || typeof res.body !== 'object') {
    throw new Error('Login BePass retornou resposta inválida');
  }
  return rememberSession(show, {
    body: res.body,
    source: 'keycloak',
    tenants: tenantsFromClaims(decodeJwt(res.body.access_token)),
  });
}

async function loginPassword(show) {
  const user = String(show.authUser || '').trim();
  const password = String(show.authPassword || '');
  if (!user || !password) {
    throw new Error('Usuário e senha BePass são obrigatórios');
  }
  return requestToken(show, {
    grant_type: 'password',
    client_id: String(show.clientId || DEFAULT_CLIENT_ID).trim() || DEFAULT_CLIENT_ID,
    username: user,
    password: password,
    scope: DEFAULT_SCOPE,
  });
}

async function loginPkceViaCco(show) {
  const user = String(show.authUser || '').trim();
  const password = String(show.authPassword || '');
  if (!user || !password) {
    throw new Error('Usuário e senha BePass são obrigatórios');
  }

  const clientId = String(show.clientId || DEFAULT_CLIENT_ID).trim() || DEFAULT_CLIENT_ID;
  const pkce = pkcePair();
  const authorize = new URL(resolveAuthorizeUrl(show.authUrl));
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', DEFAULT_REDIRECT_URI);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', DEFAULT_SCOPE);
  authorize.searchParams.set('code_challenge', pkce.challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('response_mode', 'query');

  const page = await requestHttp({
    method: 'GET',
    url: authorize.toString(),
    accept: 'text/html,*/*',
  });
  const actionMatch = String(page.raw || '').match(/<form[^>]*action="([^"]+)"/i);
  if (!actionMatch) {
    throw new Error('Keycloak não devolveu o formulário de login');
  }
  const actionUrl = new URL(decodeHtml(actionMatch[1]), authorize.origin).toString();
  const form = formBody({
    username: user,
    password: password,
    credentialId: '',
  });
  const login = await requestHttp({
    method: 'POST',
    url: actionUrl,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: authorize.origin,
      Referer: authorize.toString(),
      Cookie: cookieHeader(page.cookies),
    },
    body: form,
  });

  if (!login.location) {
    throw new Error('Usuário ou senha BePass inválidos');
  }

  let redirected;
  try {
    redirected = new URL(login.location, DEFAULT_REDIRECT_URI);
  } catch (_) {
    throw new Error('Keycloak redirecionou para uma URL inválida');
  }
  const code = redirected.searchParams.get('code');
  const oauthError = redirected.searchParams.get('error_description') || redirected.searchParams.get('error');
  if (!code) {
    throw new Error(oauthError || 'Keycloak não devolveu o código de autorização');
  }

  const exchangeBody = JSON.stringify({
    code: code,
    codeVerifier: pkce.verifier,
    redirectUri: DEFAULT_REDIRECT_URI,
  });
  const exchange = await requestHttp({
    method: 'POST',
    url: DEFAULT_CCO_BASE + '/api/auth/exchange',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: DEFAULT_CCO_BASE,
      Referer: DEFAULT_REDIRECT_URI,
    },
    body: exchangeBody,
  });
  if (exchange.statusCode < 200 || exchange.statusCode >= 300 || !exchange.body || typeof exchange.body !== 'object') {
    throw new Error(keycloakError(exchange, 'Falha ao trocar o código Keycloak no CCO'));
  }

  return rememberSession(show, {
    token: exchange.body.clientAccessToken || exchange.body.access_token,
    refreshToken: exchange.cookies.bepass_refresh_token || '',
    cookies: exchange.cookies,
    tenants: exchange.body.tenants || tenantsFromClaims(decodeJwt(exchange.body.clientAccessToken)),
    expiresIn: exchange.body.expiresIn || 60,
    source: 'cco',
    body: exchange.body,
  });
}

async function login(show) {
  const clientId = String(show.clientId || DEFAULT_CLIENT_ID).trim() || DEFAULT_CLIENT_ID;
  if (clientId === DEFAULT_CLIENT_ID) {
    return loginPkceViaCco(show);
  }
  try {
    return await loginPassword(show);
  } catch (err) {
    if (isUnauthorizedClient(err)) return loginPkceViaCco(show);
    throw err;
  }
}

async function refreshCco(show, entry) {
  const res = await requestHttp({
    method: 'POST',
    url: DEFAULT_CCO_BASE + '/api/auth/refresh',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: DEFAULT_CCO_BASE,
      Referer: DEFAULT_CCO_BASE + '/',
      Cookie: cookieHeader(entry && entry.cookies),
    },
    body: '{}',
  });
  if (res.statusCode < 200 || res.statusCode >= 300 || !res.body || typeof res.body !== 'object') {
    throw new Error(keycloakError(res, 'Refresh BePass HTTP ' + res.statusCode));
  }
  return rememberSession(show, {
    token: res.body.clientAccessToken || res.body.access_token || (entry && entry.token),
    refreshToken: res.cookies.bepass_refresh_token || (entry && entry.refreshToken) || '',
    cookies: mergeCookies(entry && entry.cookies, res.cookies),
    tenants: res.body.tenants || (entry && entry.tenants) || [],
    expiresIn: res.body.expiresIn || 60,
    source: 'cco',
    body: res.body,
  });
}

async function refresh(show, entry) {
  if (entry && entry.source === 'cco' && entry.cookies && entry.cookies.bepass_refresh_token) {
    try {
      return await refreshCco(show, entry);
    } catch (_) {
      clearToken(show);
      return login(show);
    }
  }
  if (!entry || !entry.refreshToken) return login(show);
  try {
    return await requestToken(show, {
      grant_type: 'refresh_token',
      client_id: String(show.clientId || DEFAULT_CLIENT_ID).trim() || DEFAULT_CLIENT_ID,
      refresh_token: entry.refreshToken,
    });
  } catch (_) {
    clearToken(show);
    return login(show);
  }
}

async function getSession(show, force) {
  const key = cacheKey(show);
  const cached = tokenCache[key];
  if (!force && isTokenFresh(cached)) return cached;
  if (!force && cached && (cached.refreshToken || (cached.cookies && cached.cookies.bepass_refresh_token))) {
    return refresh(show, cached);
  }
  return login(show);
}

function operationalUrl(pathname, query) {
  const url = new URL(pathname, DEFAULT_BASE_URL);
  Object.keys(query || {}).forEach(function (key) {
    const value = query[key];
    if (value == null || value === '') return;
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function tenantHeaders(companyId) {
  const headers = {};
  if (!companyId) return headers;
  headers['x-company-id'] = companyId;
  headers['x-company-slug'] = companyId;
  return headers;
}

async function operationalGet(show, pathname, query, retried) {
  const session = await getSession(show, retried === true);
  const companyId = session.companyId || String(show.companyId || '').trim();
  const headers = Object.assign({
    Accept: 'application/json',
    Authorization: 'Bearer ' + session.token,
  }, tenantHeaders(companyId));
  const res = await requestJson({
    method: 'GET',
    url: operationalUrl(pathname, query),
    headers: headers,
  });

  if (res.statusCode === 401 && !retried) {
    clearToken(show);
    return operationalGet(show, pathname, query, true);
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const err = new Error(
      res.body && typeof res.body === 'object' && (res.body.message || res.body.error)
        ? (typeof res.body.message === 'string' ? res.body.message : (res.body.error || 'BePass HTTP ' + res.statusCode))
        : 'BePass HTTP ' + res.statusCode + ' em ' + pathname
    );
    err.statusCode = res.statusCode;
    throw err;
  }

  return res.body && typeof res.body === 'object' ? res.body : {};
}

async function ccoGet(show, pathname, query, retried) {
  const session = await getSession(show, retried === true);
  const companyId = session.companyId || String(show.companyId || '').trim();
  const url = new URL(pathname, DEFAULT_CCO_BASE);
  Object.keys(query || {}).forEach(function (key) {
    const value = query[key];
    if (value == null || value === '') return;
    url.searchParams.set(key, String(value));
  });
  const headers = Object.assign({
    Accept: 'application/json',
    Origin: DEFAULT_CCO_BASE,
    Referer: DEFAULT_CCO_BASE + '/',
    Cookie: cookieHeader(session.cookies),
    Authorization: 'Bearer ' + session.token,
  }, tenantHeaders(companyId));
  const res = await requestHttp({
    method: 'GET',
    url: url.toString(),
    headers: headers,
  });

  if (res.statusCode === 401 && !retried) {
    clearToken(show);
    return ccoGet(show, pathname, query, true);
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const err = new Error(keycloakError(res, 'CCO HTTP ' + res.statusCode + ' em ' + pathname));
    err.statusCode = res.statusCode;
    throw err;
  }

  return res.body;
}

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

function asTotal(payload) {
  if (payload == null) return 0;
  if (typeof payload === 'number') return Math.max(0, payload);
  if (typeof payload.total === 'number') return Math.max(0, payload.total);
  if (payload.data && typeof payload.data.total === 'number') {
    return Math.max(0, payload.data.total);
  }
  if (typeof payload.totalEntrances === 'number') return Math.max(0, payload.totalEntrances);
  if (typeof payload.usedEntrances === 'number') return Math.max(0, payload.usedEntrances);
  return 0;
}

function sectorKey(value) {
  if (value == null || value === '') return 'Sem setor';
  const name = String(value).trim();
  return name || 'Sem setor';
}

function gateKey(value) {
  if (value == null || value === '') return 'Portão';
  const name = String(value).trim();
  return name || 'Portão';
}

function computeFlow(showId, entered) {
  const now = Date.now();
  const prev = flowCache[showId];
  let lastMinute = 0;
  let maxPerMinute = prev && prev.maxPerMinute ? prev.maxPerMinute : 0;
  if (prev && prev.at) {
    const dtMin = (now - prev.at) / 60000;
    if (dtMin > 0) {
      lastMinute = Math.max(0, Math.round((entered - prev.entered) / dtMin));
      maxPerMinute = Math.max(maxPerMinute, lastMinute);
    } else {
      lastMinute = prev.lastMinute || 0;
    }
  }
  flowCache[showId] = {
    entered: entered,
    at: now,
    lastMinute: lastMinute,
    maxPerMinute: maxPerMinute,
  };
  return {
    lastMinute: lastMinute,
    maxPerMinute: maxPerMinute,
  };
}

function hourInSaoPaulo(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SAO_PAULO_TZ,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(d);
  const hour = parts.find(function (part) { return part.type === 'hour'; });
  const n = hour ? Number(hour.value) : NaN;
  return isNaN(n) ? null : n % 24;
}

function accessByHourFromSeries(series) {
  if (!Array.isArray(series) || !series.length) return [];
  const byHour = Object.create(null);
  let prevEntered = null;
  for (let i = 0; i < series.length; i++) {
    const row = series[i];
    const hour = hourInSaoPaulo(row && row.recordedAt);
    if (hour == null) continue;
    const entered = row.totalEntered == null ? prevEntered : Math.max(0, Number(row.totalEntered) || 0);
    if (entered == null) continue;
    if (prevEntered == null) {
      prevEntered = entered;
      if (byHour[hour] == null) byHour[hour] = 0;
      continue;
    }
    byHour[hour] = (byHour[hour] || 0) + Math.max(0, entered - prevEntered);
    prevEntered = entered;
  }
  return hoursToSeries(byHour);
}

function accessByHourFromIntervals(items) {
  if (!Array.isArray(items) || !items.length) return [];
  const byHour = Object.create(null);
  items.forEach(function (item) {
    const hour = hourInSaoPaulo(item && item.interval);
    if (hour == null) return;
    byHour[hour] = (byHour[hour] || 0) + Math.max(0, Number(item.entrancesCount) || 0);
  });
  return hoursToSeries(byHour);
}

function hoursToSeries(byHour) {
  const hours = Object.keys(byHour).map(Number).sort(function (a, b) { return a - b; });
  if (!hours.length) return [];
  const out = [];
  for (let h = hours[0]; h <= hours[hours.length - 1]; h++) {
    out.push({ hour: h, count: byHour[h] || 0 });
  }
  return out;
}

async function fetchAccessByHour(store, show) {
  if (!history.isConfigured(store && store.historyMysql) || !show || !show.id) {
    return [];
  }
  try {
    const data = await history.getHistorySeries(store.historyMysql, show.id);
    return accessByHourFromSeries(data && data.series);
  } catch (_) {
    return [];
  }
}

function normalizeAccess(ticketsTotal, ticketsBySector, accessesByGate) {
  const enteredBySector = Object.create(null);
  const capacityBySector = Object.create(null);
  const enteredByGate = Object.create(null);
  let entered = 0;

  accessesByGate.forEach(function (row) {
    const count = Math.max(0, Number(row && row.total) || 0);
    entered += count;
    const sector = sectorKey(row && row.sector);
    enteredBySector[sector] = (enteredBySector[sector] || 0) + count;
    const gate = gateKey(row && row.gate);
    enteredByGate[gate] = (enteredByGate[gate] || 0) + count;
  });

  ticketsBySector.forEach(function (row) {
    const sector = sectorKey(row && row.sector);
    capacityBySector[sector] = (capacityBySector[sector] || 0) + Math.max(0, Number(row && row.total) || 0);
  });

  const names = {};
  Object.keys(enteredBySector).forEach(function (name) { names[name] = true; });
  Object.keys(capacityBySector).forEach(function (name) { names[name] = true; });

  const sectors = Object.keys(names).map(function (name) {
    const used = enteredBySector[name] || 0;
    const capacity = capacityBySector[name] != null ? capacityBySector[name] : used;
    return {
      name: name,
      entrante: used,
      faltante: Math.max(0, capacity - used),
    };
  }).sort(function (a, b) {
    return (b.entrante + b.faltante) - (a.entrante + a.faltante);
  });

  const gates = Object.keys(enteredByGate).map(function (name) {
    return {
      name: name,
      count: enteredByGate[name] || 0,
      supervisor: 0,
    };
  }).sort(function (a, b) {
    return (b.count || 0) - (a.count || 0);
  });

  const capacity = Math.max(ticketsTotal, entered);
  const faltante = Math.max(0, capacity - entered);

  return {
    totals: {
      publico: capacity,
      entrante: entered,
      faltante: faltante,
    },
    sectors: sectors,
    gates: gates,
  };
}

function normalizeCcoAccess(stats, operation) {
  const points = operation && Array.isArray(operation.logicalAccessPoints)
    ? operation.logicalAccessPoints
    : [];
  const sectors = points.map(function (row) {
    const used = Math.max(0, Number(row && row.numberOfEntries) || 0);
    const expected = row && row.numberOfEntriesExpected != null
      ? Math.max(0, Number(row.numberOfEntriesExpected) || 0)
      : Math.max(0, Number(row && row.capacity) || 0);
    return {
      name: sectorKey(row && row.logicalAccessPointName),
      entrante: used,
      faltante: Math.max(0, expected - used),
    };
  }).sort(function (a, b) {
    return (b.entrante + b.faltante) - (a.entrante + a.faltante);
  });

  const gates = points.map(function (row) {
    const names = Array.isArray(row && row.physicalAccessPointsNames)
      ? row.physicalAccessPointsNames.filter(Boolean)
      : [];
    return {
      name: gateKey(names.join(', ') || (row && row.logicalAccessPointName)),
      count: Math.max(0, Number(row && row.numberOfEntries) || 0),
      supervisor: 0,
    };
  }).sort(function (a, b) {
    return (b.count || 0) - (a.count || 0);
  });

  const publico = Math.max(0, Number(stats && stats.totalEntrances) || 0);
  const entered = Math.max(0, Number(stats && stats.usedEntrances) || 0);
  const faltante = stats && stats.availableEntrances != null
    ? Math.max(0, Number(stats.availableEntrances) || 0)
    : Math.max(0, publico - entered);

  return {
    totals: {
      publico: publico || entered,
      entrante: entered,
      faltante: faltante,
    },
    sectors: sectors,
    gates: gates,
  };
}

function eventDateFilter(show) {
  const date = String(show && show.eventDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return {};
  return { dateFrom: date, dateTo: date };
}

function eventGroupsList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.eventGroups)) return payload.eventGroups;
  return [];
}

function dateInSaoPaulo(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SAO_PAULO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function byStartsAtDesc(a, b) {
  return String((b && b.startsAt) || '').localeCompare(String((a && a.startsAt) || ''));
}

function pickFallbackEvent(groups, eventDate) {
  const dated = (groups || []).filter(function (row) { return row && row.startsAt; });
  if (eventDate && /^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    const sameDay = dated.filter(function (row) {
      return dateInSaoPaulo(row.startsAt) === eventDate;
    }).sort(byStartsAtDesc);
    if (sameDay.length) return sameDay[0];
  }
  const recent = dated.slice().sort(byStartsAtDesc);
  return recent[0] || (groups && groups[0]) || null;
}

function asEventChoice(row, slug) {
  if (!row || !row.id) return null;
  return {
    eventId: row.id,
    slug: slug,
    eventName: row.name || '',
  };
}

async function resolveEventContext(show, session) {
  const pinId = String(show.eventId || '').trim();
  const configuredSlug = String(show.companyId || '').trim();
  const tenants = configuredSlug
    ? [configuredSlug]
    : ((session && session.tenants) || []).filter(Boolean);
  const slugs = tenants.length ? tenants : (session && session.companyId ? [session.companyId] : []);
  const eventDate = String(show && show.eventDate || '').trim();

  let pinned = null;
  let active = null;
  let fallback = null;
  let lastSlug = slugs[0] || configuredSlug || '';

  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    let groups = [];
    try {
      const previous = session.companyId;
      session.companyId = slug;
      groups = eventGroupsList(await ccoGet(show, '/api/bff/api/event-groups', {}));
      session.companyId = previous;
    } catch (_) {
      continue;
    }
    lastSlug = slug;

    if (pinId) {
      const match = groups.find(function (row) { return row && row.id === pinId; });
      if (match) {
        pinned = asEventChoice(match, slug);
        break;
      }
    }

    const activeRow = groups.find(function (row) { return row && row.status === 'active'; });
    if (activeRow && !active) {
      active = asEventChoice(activeRow, slug);
    }

    if (!fallback) {
      fallback = asEventChoice(pickFallbackEvent(groups, eventDate), slug);
    }
  }

  const chosen = pinned || active || fallback;
  if (!chosen || !chosen.eventId) {
    throw new Error('Nenhum evento BePass ativo ou recente encontrado para este tenant');
  }
  session.companyId = chosen.slug || lastSlug;
  return chosen;
}

async function fetchOperationalRest(show) {
  const eventId = String(show.eventId || '').trim();
  if (!eventId) throw new Error('eventId BePass é obrigatório');
  const dateFilter = eventDateFilter(show);
  const [ticketsTotal, ticketsBySector, accessesByGate] = await Promise.all([
    operationalGet(show, '/operational/tickets/total', {
      eventId: eventId,
      status: 'active',
    }),
    operationalGet(show, '/operational/tickets/by-sector', {
      eventId: eventId,
      status: 'active',
    }),
    operationalGet(show, '/operational/accesses/by-gate', Object.assign({
      eventId: eventId,
    }, dateFilter)),
  ]);

  return {
    access: normalizeAccess(
      asTotal(ticketsTotal),
      asList(ticketsBySector),
      asList(accessesByGate)
    ),
    accessByHour: [],
    eventName: '',
  };
}

async function fetchCcoBff(show) {
  const session = await getSession(show, false);
  const ctx = await resolveEventContext(show, session);
  const query = ctx.eventId ? { eventId: ctx.eventId } : {};
  const [stats, operation, interval] = await Promise.all([
    ccoGet(show, '/api/bff/api/access-points/event-entrance-statistics', query),
    ccoGet(show, '/api/bff/api/access-points/operation-statistics', query),
    ccoGet(show, '/api/bff/api/access-points/event-entrances-by-interval', query).catch(function () {
      return { items: [] };
    }),
  ]);

  return {
    access: normalizeCcoAccess(stats, operation),
    accessByHour: accessByHourFromIntervals(interval && interval.items),
    eventName: ctx.eventName,
  };
}

async function fetchOperationalData(show) {
  const session = await getSession(show, false);
  if (session.source === 'cco' && session.cookies && session.cookies.bepass_access_token) {
    return fetchCcoBff(show);
  }
  try {
    return await fetchOperationalRest(show);
  } catch (err) {
    if (err && (err.statusCode === 401 || err.statusCode === 403 || err.statusCode === 404)) {
      return fetchCcoBff(show);
    }
    throw err;
  }
}

async function getBepassPayload(store, show) {
  const [live, weather, historyHours] = await Promise.all([
    fetchOperationalData(show),
    cco.fetchWeather(show.weather),
    fetchAccessByHour(store, show),
  ]);

  const access = live.access;
  const flow = computeFlow(show.id, access.totals.entrante);
  const accessByHour = (live.accessByHour && live.accessByHour.length)
    ? live.accessByHour
    : historyHours;

  return {
    type: 'bepass',
    eventName: show.eventName || show.title || live.eventName || 'Evento',
    venueName: show.venueName || '',
    venueCity: show.venueCity || '',
    eyebrowText: show.eyebrowText || '',
    showArtUrl: show.showArtUrl || '',
    showArtZoom: show.showArtZoom != null ? show.showArtZoom : 1,
    showArtX: show.showArtX != null ? show.showArtX : 50,
    showArtY: show.showArtY != null ? show.showArtY : 50,
    logoUrl: show.logoUrl || '',
    eventDate: show.eventDate || '',
    gateOpenHour: Number(show.gateOpenHour) || 16,
    gateOpenMinute: Number(show.gateOpenMinute) || 0,
    pollIntervalMs: store.pollIntervalMs || 15000,
    theme: (show.theme === 'nubank-parque' || show.theme === 'default')
      ? show.theme
      : (store.theme === 'nubank-parque' ? 'nubank-parque' : 'default'),
    slug: show.slug,
    title: show.title,
    weather: weather,
    totals: access.totals,
    sectors: access.sectors,
    gates: access.gates,
    flow: flow,
    accessByHour: accessByHour,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_TOKEN_URL,
  DEFAULT_CLIENT_ID,
  defaultAuthUrl,
  defaultClientId,
  resolveAuthUrl,
  getBepassPayload,
  getSession,
};
