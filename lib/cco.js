'use strict';

const https = require('https');
const sql = require('mssql');

const WEATHER_CACHE_MS = 10 * 60 * 1000;

const DEFAULT_SECTOR_NAMES = {
  A: 'ANFT',
  ANFT: 'ANFT',
  B: 'FANZONE',
  FANZ: 'FANZONE',
  C: 'DECK',
  DECK: 'DECK',
  D: '0017,DECK',
  '0017,DECK': '0017,DECK',
  E: 'CM03',
  CM03: 'CM03',
  F: 'CM04',
  CM04: 'CM04',
  G: 'G040,G080',
  'G040,G080': 'G040,G080',
  H: 'G020',
  G020: 'G020',
  I: 'G010',
  G010: 'G010',
  J: 'G030,G050,G060',
  'G030,G050,G060': 'G030,G050,G060',
  L: 'VIP',
  G031: 'VIP',
  'G031,G051': 'VIP',
  'DECK,G020': 'PISTA PREMIUM',
};

const WMO_WEATHER = {
  0: { icon: '☀️', label: 'Céu limpo' },
  1: { icon: '🌤️', label: 'Principalmente limpo' },
  2: { icon: '⛅', label: 'Parcialmente nublado' },
  3: { icon: '☁️', label: 'Nublado' },
  45: { icon: '🌫️', label: 'Neblina' },
  48: { icon: '🌫️', label: 'Neblina' },
  51: { icon: '🌦️', label: 'Garoa leve' },
  53: { icon: '🌦️', label: 'Garoa' },
  55: { icon: '🌦️', label: 'Garoa forte' },
  61: { icon: '🌧️', label: 'Chuva leve' },
  63: { icon: '🌧️', label: 'Chuva' },
  65: { icon: '🌧️', label: 'Chuva forte' },
  71: { icon: '🌨️', label: 'Neve leve' },
  73: { icon: '🌨️', label: 'Neve' },
  75: { icon: '🌨️', label: 'Neve forte' },
  80: { icon: '🌦️', label: 'Pancadas leves' },
  81: { icon: '🌧️', label: 'Pancadas' },
  82: { icon: '🌧️', label: 'Pancadas fortes' },
  95: { icon: '⛈️', label: 'Tempestade' },
  96: { icon: '⛈️', label: 'Tempestade com granizo' },
  99: { icon: '⛈️', label: 'Tempestade com granizo' },
};

const MOCK_SECTORS = [
  { name: 'PISTA', capacidade: 7600, taxa: 0.95 },
  { name: 'PISTA PREMIUM', capacidade: 2100, taxa: 0.88 },
  { name: 'FANZONE', capacidade: 1800, taxa: 0.9 },
  { name: 'CAMAROTE', capacidade: 900, taxa: 0.7 },
  { name: 'VIP', capacidade: 340, taxa: 0.55 },
  { name: 'DECK', capacidade: 1200, taxa: 0.75 },
  { name: 'MEIA', capacidade: 800, taxa: 0.82 },
  { name: 'SOCIAL', capacidade: 1500, taxa: 0.78 },
  { name: 'ACESSIBILIDADE', capacidade: 120, taxa: 0.6 },
];

const GATE_WEIGHTS = [
  { name: 'Portão A', w: 0.32 },
  { name: 'Portão B', w: 0.28 },
  { name: 'Portão C', w: 0.18 },
  { name: 'C 1', w: 0.1 },
  { name: 'Portão D', w: 0.12 },
];

let pool = null;
let poolConnect = null;
let poolConfigKey = '';
let weatherCache = { key: '', at: 0, data: null };

function pad2(n) {
  return String(n).padStart(2, '0');
}

function gateHourParam(gateOpenHour, gateOpenMinute) {
  const h = Math.max(0, Math.min(23, Number(gateOpenHour) || 0));
  const m = Math.max(0, Math.min(59, Number(gateOpenMinute) || 0));
  return pad2(h) + ':' + pad2(m) + ':00';
}

function resolveSectorNames(store, show) {
  return Object.assign({}, DEFAULT_SECTOR_NAMES, store.defaultSectorNames || {}, show.sectorNames || {});
}

function sectorLabel(code, names) {
  const key = String(code == null ? '' : code);
  return names[key] || key;
}

function dbConfigKey(db) {
  if (!db) return '';
  return [db.host, db.port, db.database, db.user, db.encrypt].join('|');
}

function ensurePool(db) {
  if (!db || !db.host) {
    throw new Error('Configuração do banco SQL não definida');
  }
  const key = dbConfigKey(db);
  if (pool && poolConfigKey === key && poolConnect) {
    return poolConnect;
  }
  if (pool) {
    pool.close().catch(function () {});
    pool = null;
    poolConnect = null;
  }
  poolConfigKey = key;
  pool = new sql.ConnectionPool({
    server: db.host,
    port: Number(db.port) || 1433,
    database: db.database || 'SIPORTNTACC',
    user: db.user,
    password: db.password || '',
    options: {
      encrypt: db.encrypt === true,
      trustServerCertificate: true,
    },
    pool: { max: 6, min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: 15000,
  });
  poolConnect = pool.connect();
  return poolConnect;
}

function bindVersions(request, versions) {
  const list = Array.isArray(versions) && versions.length ? versions : ['10'];
  const names = [];
  for (let i = 0; i < list.length; i++) {
    const name = 'v' + i;
    names.push('@' + name);
    request.input(name, sql.VarChar(32), String(list[i]));
  }
  return names.join(', ');
}

async function querySectors(poolRef, versions) {
  const request = poolRef.request();
  const inList = bindVersions(request, versions);
  const result = await request.query(`
    WITH Base AS (
      SELECT
        dbo.GetStdProfiles(Data_Auto_ID) AS STD_PROFILES,
        COUNT(DATA_20_Ident_no_CN) AS NAO_ENTROU,
        SUM(CASE WHEN DATA_20_Room_RN NOT IN (0, -1) THEN 1 ELSE 0 END) AS ENTROU
      FROM [SIPORTNTACC].[dbo].[SIST_Pers]
      WHERE DATA_20_Validto_D2 >= CONCAT(CONVERT(VARCHAR(20), GETDATE(), 23), ' 00:00:00')
        AND DATA_20_Version_VN IN (${inList})
        AND DATA_20_Lockflag_OF = ''
      GROUP BY dbo.GetStdProfiles(Data_Auto_ID)
    ),
    Agrupado AS (
      SELECT STD_PROFILES, SUM(NAO_ENTROU - ENTROU) AS FALTANTE, SUM(ENTROU) AS ENTRANTE
      FROM Base GROUP BY STD_PROFILES
    )
    SELECT STD_PROFILES, FALTANTE, ENTRANTE
    FROM Agrupado ORDER BY (FALTANTE + ENTRANTE) ASC
  `);
  return result.recordset || [];
}

async function queryPublico(poolRef, versions) {
  const request = poolRef.request();
  const inList = bindVersions(request, versions);
  const result = await request.query(`
    SELECT
      unlocked.FALTANTE,
      unlocked.ENTRANTE,
      locked.BLOQUEADOS
    FROM (
      SELECT
        SUM(CASE WHEN DATA_20_Room_RN IN (0, -1) THEN 1 ELSE 0 END) AS FALTANTE,
        SUM(CASE WHEN DATA_20_Room_RN NOT IN (0, -1) THEN 1 ELSE 0 END) AS ENTRANTE
      FROM [SIPORTNTACC].[dbo].[SIST_Pers]
      WHERE DATA_20_Validto_D2 >= CONCAT(CONVERT(VARCHAR(20), GETDATE(), 23), ' 00:00:00')
        AND DATA_20_Version_VN IN (${inList})
        AND DATA_20_Lockflag_OF = ''
    ) unlocked
    CROSS JOIN (
      SELECT COUNT(*) AS BLOQUEADOS
      FROM [SIPORTNTACC].[dbo].[SIST_Pers]
      WHERE DATA_20_Validto_D2 >= CONCAT(CONVERT(VARCHAR(20), GETDATE(), 23), ' 00:00:00')
        AND DATA_20_Version_VN IN (${inList})
        AND DATA_20_Lockflag_OF <> ''
    ) locked
  `);
  const row = (result.recordset && result.recordset[0]) || {};
  return {
    faltante: Number(row.FALTANTE) || 0,
    entrante: Number(row.ENTRANTE) || 0,
    bloqueados: Number(row.BLOQUEADOS) || 0,
  };
}

async function queryGates(poolRef) {
  const request = poolRef.request();
  // Relatorio_Acessos.Codigo_ticketeira = SIST_ZLOG.PersField1 ('10' normal, '25' supervisor)
  const result = await request.query(`
    SELECT
      CASE
        WHEN Ort LIKE 'PISA%' THEN 'Portão A'
        WHEN Ort LIKE 'PREM%' THEN 'Portão B'
        WHEN Ort LIKE 'INFC%' THEN 'Portão C'
        WHEN Ort LIKE 'Deck%' OR Ort LIKE 'CAM%' OR Ort LIKE 'CAMAR%' OR Ort LIKE 'VIP%' THEN 'C 1'
        WHEN Ort LIKE 'INFD%' THEN 'Portão D'
        ELSE NULL
      END AS GATE,
      SUM(CASE WHEN LTRIM(RTRIM(PersField1)) = '10' THEN 1 ELSE 0 END) AS NORMAL_COUNT,
      SUM(CASE WHEN LTRIM(RTRIM(PersField1)) = '25' THEN 1 ELSE 0 END) AS SUPERVISOR_COUNT
    FROM [SIPORTNTACC].[dbo].[SIST_ZLOG]
    WHERE Uhrzeit >= CAST(CAST(GETDATE() AS DATE) AS DATETIME)
      AND LTRIM(RTRIM(PersField1)) IN ('10', '25')
    GROUP BY
      CASE
        WHEN Ort LIKE 'PISA%' THEN 'Portão A'
        WHEN Ort LIKE 'PREM%' THEN 'Portão B'
        WHEN Ort LIKE 'INFC%' THEN 'Portão C'
        WHEN Ort LIKE 'Deck%' OR Ort LIKE 'CAM%' OR Ort LIKE 'CAMAR%' OR Ort LIKE 'VIP%' THEN 'C 1'
        WHEN Ort LIKE 'INFD%' THEN 'Portão D'
        ELSE NULL
      END
  `);
  const order = ['Portão A', 'Portão B', 'Portão C', 'C 1', 'Portão D'];
  const map = {};
  (result.recordset || []).forEach(function (row) {
    if (!row.GATE) return;
    map[row.GATE] = {
      name: row.GATE,
      count: Number(row.NORMAL_COUNT) || 0,
      supervisor: Number(row.SUPERVISOR_COUNT) || 0,
    };
  });
  return order.map(function (name) {
    return map[name] || { name: name, count: 0, supervisor: 0 };
  });
}

async function queryErrors(poolRef, hora) {
  const request = poolRef.request();
  request.input('hora', sql.VarChar(16), hora);
  const result = await request.query(`
    SELECT
      SUM(CASE WHEN Alarmtext LIKE '%In/out Control%' OR Alarmtext LIKE '%In/Out Control%' THEN 1 ELSE 0 END) AS DUPLA_ENTRADA,
      SUM(CASE WHEN Alarmtext LIKE '%wrong access level%' THEN 1 ELSE 0 END) AS PORTAO_ERRADO,
      SUM(CASE WHEN Alarmtext LIKE '%ID-Card unknown%' OR Alarmtext LIKE '%unknow%' THEN 1 ELSE 0 END) AS CARTAO_DESCONHECIDO,
      SUM(CASE WHEN Alarmtext LIKE '%Not went through%' THEN 1 ELSE 0 END) AS NAO_GIROU,
      SUM(CASE WHEN Alarmtext LIKE '%ID-Card not valid%' OR Alarmtext LIKE '%valid%' THEN 1 ELSE 0 END) AS CARTAO_FORA_HORARIO
    FROM [SIPORTNTACC].[dbo].[Relatorio_Alarmes]
    WHERE Uhrzeit >= CONCAT(CONVERT(VARCHAR(20), GETDATE(), 23), ' ', @hora);

    SELECT COUNT(*) AS SUPERVISOR
    FROM [SIPORTNTACC].[dbo].[SIST_ZLOG]
    WHERE LTRIM(RTRIM(PersField1)) = '25'
      AND Uhrzeit >= CONCAT(CONVERT(VARCHAR(20), GETDATE(), 23), ' ', @hora);
  `);
  const alarmRow = (result.recordsets && result.recordsets[0] && result.recordsets[0][0]) || {};
  const supRow = (result.recordsets && result.recordsets[1] && result.recordsets[1][0]) || {};
  return {
    supervisor: Number(supRow.SUPERVISOR) || 0,
    duplaEntrada: Number(alarmRow.DUPLA_ENTRADA) || 0,
    portaoErrado: Number(alarmRow.PORTAO_ERRADO) || 0,
    cartaoDesconhecido: Number(alarmRow.CARTAO_DESCONHECIDO) || 0,
    naoGirou: Number(alarmRow.NAO_GIROU) || 0,
    cartaoForaHorario: Number(alarmRow.CARTAO_FORA_HORARIO) || 0,
  };
}

async function queryFlow(poolRef) {
  const request = poolRef.request();
  // Mesmo critério da view Relatorio_Acessos: PersField1 IN (10,19,14,25)
  const result = await request.query(`
    SELECT
      ISNULL((
        SELECT COUNT(*)
        FROM [SIPORTNTACC].[dbo].[SIST_ZLOG]
        WHERE Uhrzeit >= DATEADD(MINUTE, -1, GETDATE())
          AND LTRIM(RTRIM(PersField1)) IN ('10', '19', '14', '25')
      ), 0) AS LAST_MINUTE,
      ISNULL((
        SELECT MAX(cnt) FROM (
          SELECT COUNT(*) AS cnt
          FROM [SIPORTNTACC].[dbo].[SIST_ZLOG]
          WHERE Uhrzeit >= CAST(CAST(GETDATE() AS DATE) AS DATETIME)
            AND LTRIM(RTRIM(PersField1)) IN ('10', '19', '14', '25')
          GROUP BY
            DATEPART(YEAR, Uhrzeit),
            DATEPART(MONTH, Uhrzeit),
            DATEPART(DAY, Uhrzeit),
            DATEPART(HOUR, Uhrzeit),
            DATEPART(MINUTE, Uhrzeit)
        ) t
      ), 0) AS MAX_PER_MINUTE
  `);
  const row = (result.recordset && result.recordset[0]) || {};
  return {
    lastMinute: Number(row.LAST_MINUTE) || 0,
    maxPerMinute: Number(row.MAX_PER_MINUTE) || 0,
  };
}

async function queryAccessByHour(poolRef, hora, eventDate) {
  const request = poolRef.request();
  request.input('hora', sql.VarChar(16), hora);
  const hourNum = Number(String(hora).slice(0, 2)) || 0;
  request.input('horaInt', sql.Int, hourNum);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(eventDate || '').trim());
  const dayExpr = day ? '@eventDay' : 'CONVERT(VARCHAR(20), GETDATE(), 23)';
  if (day) {
    request.input('eventDay', sql.VarChar(10), day[0]);
  }
  const result = await request.query(`
    SELECT
      h.number AS HOUR,
      ISNULL(a.cnt, 0) AS COUNT
    FROM master.dbo.spt_values h
    LEFT JOIN (
      SELECT DATEPART(HOUR, Uhrzeit) AS HOUR, COUNT(*) AS cnt
      FROM [SIPORTNTACC].[dbo].[SIST_ZLOG]
      WHERE Uhrzeit >= CONCAT(${dayExpr}, ' ', @hora)
        AND LTRIM(RTRIM(PersField1)) IN ('10', '19', '14', '25')
      GROUP BY DATEPART(HOUR, Uhrzeit)
    ) a ON a.HOUR = h.number
    WHERE h.type = 'P'
      AND h.number >= @horaInt
      AND h.number <= CASE
        WHEN ${dayExpr} < CONVERT(VARCHAR(20), GETDATE(), 23) THEN 23
        WHEN ${dayExpr} > CONVERT(VARCHAR(20), GETDATE(), 23) THEN -1
        ELSE DATEPART(HOUR, GETDATE())
      END
    ORDER BY h.number
  `);
  return (result.recordset || []).map(function (row) {
    return { hour: Number(row.HOUR), count: Number(row.COUNT) || 0 };
  });
}

function mapWeatherCode(code) {
  const n = Number(code);
  if (WMO_WEATHER[n]) return WMO_WEATHER[n];
  if (n >= 1 && n <= 3) return WMO_WEATHER[n] || WMO_WEATHER[2];
  if (n >= 51 && n <= 55) return WMO_WEATHER[53];
  if (n >= 61 && n <= 65) return WMO_WEATHER[63];
  if (n >= 71 && n <= 75) return WMO_WEATHER[73];
  if (n >= 80 && n <= 82) return WMO_WEATHER[81];
  if (n >= 95 && n <= 99) return WMO_WEATHER[95];
  return { icon: '🌡️', label: 'Clima' };
}

function httpGetJson(url) {
  return new Promise(function (resolve, reject) {
    const req = https.get(url, function (res) {
      let raw = '';
      res.on('data', function (chunk) {
        raw += chunk;
        if (raw.length > 1024 * 1024) {
          req.destroy(new Error('Resposta de clima grande demais'));
        }
      });
      res.on('end', function () {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('Clima HTTP ' + res.statusCode));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (_) {
          reject(new Error('JSON de clima inválido'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, function () {
      req.destroy(new Error('Timeout no clima'));
    });
  });
}

async function fetchWeather(weatherCfg) {
  if (!weatherCfg || weatherCfg.lat == null || weatherCfg.lon == null) {
    return null;
  }
  const lat = Number(weatherCfg.lat);
  const lon = Number(weatherCfg.lon);
  if (isNaN(lat) || isNaN(lon)) return null;

  const key = lat + ',' + lon;
  const now = Date.now();
  if (weatherCache.key === key && weatherCache.data && now - weatherCache.at < WEATHER_CACHE_MS) {
    return weatherCache.data;
  }

  const url =
    'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(lat) +
    '&longitude=' + encodeURIComponent(lon) +
    '&current=temperature_2m,weather_code' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum,wind_speed_10m_max' +
    '&forecast_days=1&timezone=America/Sao_Paulo';

  try {
    const json = await httpGetJson(url);
    const currentCode = json.current && json.current.weather_code;
    const dailyCode = json.daily && json.daily.weather_code && json.daily.weather_code[0];
    const currentMeta = mapWeatherCode(currentCode);
    const dailyMeta = mapWeatherCode(dailyCode);
    const data = {
      current: {
        tempC: Math.round(Number(json.current && json.current.temperature_2m) || 0),
        icon: currentMeta.icon,
        label: currentMeta.label,
      },
      tempMin: Math.round(Number(json.daily && json.daily.temperature_2m_min && json.daily.temperature_2m_min[0]) || 0),
      tempMax: Math.round(Number(json.daily && json.daily.temperature_2m_max && json.daily.temperature_2m_max[0]) || 0),
      icon: dailyMeta.icon,
      label: dailyMeta.label,
      precipitationMm: Number(json.daily && json.daily.precipitation_sum && json.daily.precipitation_sum[0]) || 0,
      windKmh: Math.round(Number(json.daily && json.daily.wind_speed_10m_max && json.daily.wind_speed_10m_max[0]) || 0),
    };
    weatherCache = { key: key, at: now, data: data };
    return data;
  } catch (_) {
    if (weatherCache.key === key && weatherCache.data) return weatherCache.data;
    return null;
  }
}

function mockProgress(gateOpenHour, gateOpenMinute) {
  const now = new Date();
  const open = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    Number(gateOpenHour) || 16,
    Number(gateOpenMinute) || 0,
    0
  );
  const minutes = Math.max(0, (now - open) / 60000);
  return Math.min(0.92, 1 - Math.exp(-minutes / 120));
}

function buildMockData(show, sectorNames) {
  const progress = mockProgress(show.gateOpenHour, show.gateOpenMinute);
  const sectors = MOCK_SECTORS.map(function (s) {
    const entrante = Math.round(s.capacidade * progress * s.taxa);
    const faltante = Math.max(0, s.capacidade - entrante);
    return { name: s.name, faltante: faltante, entrante: entrante };
  }).sort(function (a, b) {
    return (a.faltante + a.entrante) - (b.faltante + b.entrante);
  });

  const totalEntrante = sectors.reduce(function (acc, s) { return acc + s.entrante; }, 0);
  const totalFaltante = sectors.reduce(function (acc, s) { return acc + s.faltante; }, 0);
  const bloqueados = Math.round(totalEntrante * 0.012);

  let assigned = 0;
  const gates = GATE_WEIGHTS.map(function (g, i) {
    let count;
    if (i === GATE_WEIGHTS.length - 1) {
      count = Math.max(0, totalEntrante - assigned);
    } else {
      count = Math.round(totalEntrante * g.w);
      assigned += count;
    }
    return {
      name: g.name,
      count: count,
      supervisor: Math.round(count * 0.03),
    };
  });

  const now = new Date();
  const startH = Number(show.gateOpenHour) || 16;
  const endH = now.getHours();
  const accessByHour = [];
  const span = Math.max(1, endH - startH);
  for (let h = startH; h <= endH; h++) {
    const t = (h - startH) / span;
    const curve = Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
    accessByHour.push({
      hour: h,
      count: Math.round((totalEntrante / Math.max(1, span + 1)) * (0.4 + curve * 1.6)),
    });
  }

  return {
    totals: {
      faltante: totalFaltante,
      entrante: totalEntrante,
      bloqueados: bloqueados,
    },
    sectors: sectors,
    gates: gates,
    errors: {
      supervisor: Math.round(totalEntrante * 0.015),
      duplaEntrada: Math.round(totalEntrante * 0.008),
      portaoErrado: Math.round(totalEntrante * 0.006),
      cartaoDesconhecido: Math.round(totalEntrante * 0.004),
      naoGirou: Math.round(totalEntrante * 0.01),
      cartaoForaHorario: Math.round(totalEntrante * 0.003),
    },
    flow: {
      lastMinute: progress >= 0.99 ? 0 : Math.floor(8 + Math.random() * 40),
      maxPerMinute: Math.floor(60 + Math.random() * 80),
    },
    accessByHour: accessByHour,
    _sectorNames: sectorNames,
  };
}

async function fetchSqlAccessData(store, show) {
  const versions = Array.isArray(show.version) && show.version.length ? show.version : ['10'];
  const hora = gateHourParam(show.gateOpenHour, show.gateOpenMinute);
  const names = resolveSectorNames(store, show);

  await ensurePool(store.db);
  const [
    sectorRows,
    totals,
    gates,
    errors,
    flow,
    accessByHour,
  ] = await Promise.all([
    querySectors(pool, versions),
    queryPublico(pool, versions),
    queryGates(pool),
    queryErrors(pool, hora),
    queryFlow(pool),
    queryAccessByHour(pool, hora, show.eventDate),
  ]);

  const sectors = sectorRows.map(function (row) {
    const code = row.STD_PROFILES;
    return {
      name: sectorLabel(code, names),
      faltante: Math.max(0, Number(row.FALTANTE) || 0),
      entrante: Math.max(0, Number(row.ENTRANTE) || 0),
    };
  });

  return {
    totals: totals,
    sectors: sectors,
    gates: gates,
    errors: errors,
    flow: flow,
    accessByHour: accessByHour,
  };
}

async function getCcoPayload(store, show) {
  const sectorNames = resolveSectorNames(store, show);
  const mockData = show.mockData === true;

  const [access, weather] = await Promise.all([
    mockData
      ? Promise.resolve(buildMockData(show, sectorNames))
      : fetchSqlAccessData(store, show),
    fetchWeather(show.weather),
  ]);

  return {
    type: 'cco',
    eventName: show.eventName || show.title || 'Evento',
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
    errors: access.errors,
    flow: access.flow,
    accessByHour: access.accessByHour,
    fetchedAt: new Date().toISOString(),
  };
}

async function listSectorCodes(store, versions) {
  const list = Array.isArray(versions) && versions.length ? versions : ['10'];
  if (!store || !store.db || !store.db.host) {
    throw new Error('Configuração do banco SQL não definida');
  }
  await ensurePool(store.db);
  const rows = await querySectors(pool, list);
  return rows.map(function (row) {
    const code = String(row.STD_PROFILES == null ? '' : row.STD_PROFILES).trim();
    const faltante = Math.max(0, Number(row.FALTANTE) || 0);
    const entrante = Math.max(0, Number(row.ENTRANTE) || 0);
    return {
      code: code,
      faltante: faltante,
      entrante: entrante,
      total: faltante + entrante,
    };
  }).filter(function (row) {
    return !!row.code;
  });
}

async function testConnection(db) {
  if (!db || !db.host) {
    throw new Error('Configuração do banco SQL não definida');
  }
  const started = Date.now();
  const testPool = new sql.ConnectionPool({
    server: db.host,
    port: Number(db.port) || 1433,
    database: db.database || 'SIPORTNTACC',
    user: db.user,
    password: db.password || '',
    options: {
      encrypt: db.encrypt === true,
      trustServerCertificate: true,
    },
    connectionTimeout: 8000,
    requestTimeout: 8000,
    pool: { max: 1, min: 0, idleTimeoutMillis: 1000 },
  });
  try {
    await testPool.connect();
    await testPool.request().query('SELECT 1 AS ok');
    return { ok: true, ms: Date.now() - started };
  } finally {
    testPool.close().catch(function () {});
  }
}

module.exports = {
  DEFAULT_SECTOR_NAMES,
  getCcoPayload,
  fetchWeather,
  resolveSectorNames,
  listSectorCodes,
  testConnection,
};
