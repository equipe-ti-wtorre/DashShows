'use strict';

const mysql = require('mysql2/promise');

const MIN_INTERVAL_MS = 15 * 1000;
const MAX_INTERVAL_MS = 3600 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000;

let pool = null;
let poolKey = '';
let schemaReady = false;
const lastSavedAt = Object.create(null);

function cfgKey(cfg) {
  if (!cfg) return '';
  return [
    cfg.host || '',
    cfg.port || 3306,
    cfg.database || '',
    cfg.user || '',
    cfg.password || '',
  ].join('|');
}

function normalizeIntervalMs(value) {
  const n = Number(value);
  if (isNaN(n)) return DEFAULT_INTERVAL_MS;
  if (n < MIN_INTERVAL_MS) return MIN_INTERVAL_MS;
  if (n > MAX_INTERVAL_MS) return MAX_INTERVAL_MS;
  return Math.round(n);
}

function isConfigured(cfg) {
  return !!(
    cfg &&
    cfg.enabled === true &&
    cfg.host &&
    String(cfg.host).trim() &&
    cfg.database &&
    String(cfg.database).trim()
  );
}

async function ensurePool(cfg) {
  const key = cfgKey(cfg);
  if (pool && poolKey === key) return pool;
  if (pool) {
    try {
      await pool.end();
    } catch (_) {
      /* ignore */
    }
    pool = null;
    schemaReady = false;
  }
  pool = mysql.createPool({
    host: String(cfg.host).trim(),
    port: Number(cfg.port) || 3306,
    database: String(cfg.database).trim(),
    user: String(cfg.user || '').trim(),
    password: String(cfg.password || ''),
    waitForConnections: true,
    connectionLimit: 4,
    enableKeepAlive: true,
    timezone: 'Z',
  });
  poolKey = key;
  schemaReady = false;
  return pool;
}

async function ensureSchema(conn) {
  if (schemaReady) return;
  await conn.query(`
    CREATE TABLE IF NOT EXISTS access_history (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      dashboard_type VARCHAR(16) NOT NULL,
      show_id VARCHAR(64) NOT NULL,
      slug VARCHAR(120) NOT NULL DEFAULT '',
      event_name VARCHAR(200) NOT NULL DEFAULT '',
      event_date VARCHAR(40) NOT NULL DEFAULT '',
      recorded_at DATETIME(3) NOT NULL,
      fetched_at DATETIME(3) NULL,
      temp_c DECIMAL(6,2) NULL,
      temp_min DECIMAL(6,2) NULL,
      temp_max DECIMAL(6,2) NULL,
      precipitation_mm DECIMAL(8,2) NULL,
      wind_kmh DECIMAL(8,2) NULL,
      weather_label VARCHAR(80) NULL,
      total_capacity INT NULL,
      total_entered INT NULL,
      total_remaining INT NULL,
      flow_per_min INT NULL,
      payload_json JSON NOT NULL,
      PRIMARY KEY (id),
      KEY idx_show_recorded (show_id, recorded_at),
      KEY idx_type_recorded (dashboard_type, recorded_at),
      KEY idx_event_recorded (event_date, recorded_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  schemaReady = true;
}

function sumReport(report, field) {
  if (!Array.isArray(report)) return 0;
  let total = 0;
  for (let i = 0; i < report.length; i++) {
    total += Math.max(0, Number(report[i] && report[i][field]) || 0);
  }
  return total;
}

function extractSummary(show, payload) {
  const type = (payload && payload.type) || show.type || 'boletius';
  const weather = payload && payload.weather ? payload.weather : null;
  let totalCapacity = null;
  let totalEntered = null;
  let totalRemaining = null;
  let flowPerMin = null;

  if (type === 'cco' || type === 'bepass') {
    const totals = payload.totals || {};
    const faltante = Math.max(0, Number(totals.faltante) || 0);
    const entrante = Math.max(0, Number(totals.entrante) || 0);
    totalEntered = entrante;
    totalRemaining = faltante;
    totalCapacity = entrante + faltante;
    if (payload.flow && payload.flow.lastMinute != null) {
      flowPerMin = Math.max(0, Number(payload.flow.lastMinute) || 0);
    }
  } else {
    const report = payload.accessReport || [];
    totalCapacity = sumReport(report, 'total');
    totalEntered = sumReport(report, 'used');
    totalRemaining = Math.max(0, totalCapacity - totalEntered);
  }

  return {
    dashboardType: type === 'cco' ? 'cco' : type === 'bepass' ? 'bepass' : 'boletius',
    eventName: String(
      (payload && (payload.eventName || payload.showName || payload.title)) ||
        show.eventName ||
        show.title ||
        ''
    ).slice(0, 200),
    eventDate: String((payload && payload.eventDate) || show.eventDate || '').slice(0, 40),
    tempC: weather && weather.current && weather.current.tempC != null
      ? Number(weather.current.tempC)
      : null,
    tempMin: weather && weather.tempMin != null ? Number(weather.tempMin) : null,
    tempMax: weather && weather.tempMax != null ? Number(weather.tempMax) : null,
    precipitationMm: weather && weather.precipitationMm != null
      ? Number(weather.precipitationMm)
      : null,
    windKmh: weather && weather.windKmh != null ? Number(weather.windKmh) : null,
    weatherLabel: weather && weather.label
      ? String(weather.label).slice(0, 80)
      : weather && weather.current && weather.current.label
        ? String(weather.current.label).slice(0, 80)
        : null,
    totalCapacity: totalCapacity,
    totalEntered: totalEntered,
    totalRemaining: totalRemaining,
    flowPerMin: flowPerMin,
  };
}

function buildPayloadJson(show, payload) {
  const type = (payload && payload.type) || show.type || 'boletius';
  if (type === 'cco' || type === 'bepass') {
    return {
      type: type,
      totals: payload.totals || null,
      sectors: payload.sectors || null,
      gates: payload.gates || null,
      errors: type === 'cco' ? payload.errors || null : null,
      flow: payload.flow || null,
      accessByHour: payload.accessByHour || null,
      weather: payload.weather || null,
      eventName: payload.eventName || null,
      venueName: payload.venueName || null,
      venueCity: payload.venueCity || null,
      eventDate: payload.eventDate || null,
      gateOpenHour: payload.gateOpenHour != null ? payload.gateOpenHour : null,
      gateOpenMinute: payload.gateOpenMinute != null ? payload.gateOpenMinute : null,
    };
  }
  return {
    type: 'boletius',
    accessReport: payload.accessReport || null,
    accessByHour: payload.accessByHour || null,
    eventName: payload.eventName || payload.showName || payload.title || null,
    venueName: payload.venueName || null,
    gateOpenHour: payload.gateOpenHour != null ? payload.gateOpenHour : null,
    gateOpenMinute: payload.gateOpenMinute != null ? payload.gateOpenMinute : null,
    title: payload.title || show.title || null,
  };
}

function isThrottled(showId, intervalMs) {
  const key = String(showId || '');
  const last = lastSavedAt[key] || 0;
  return Date.now() - last < intervalMs;
}

function markSaved(showId) {
  lastSavedAt[String(showId || '')] = Date.now();
}

function toMysqlDatetime(value) {
  const d = value ? new Date(value) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 23).replace('T', ' ');
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

async function saveSnapshot(cfg, show, payload) {
  if (!isConfigured(cfg) || !show || !payload) return false;

  const intervalMs = normalizeIntervalMs(cfg.intervalMs);
  if (isThrottled(show.id, intervalMs)) return false;

  const p = await ensurePool(cfg);
  const conn = await p.getConnection();
  try {
    await ensureSchema(conn);
    const summary = extractSummary(show, payload);
    const recordedAt = toMysqlDatetime(new Date());
    const fetchedAt = payload.fetchedAt ? toMysqlDatetime(payload.fetchedAt) : null;
    const payloadJson = JSON.stringify(buildPayloadJson(show, payload));

    // MariaDB aceita JSON como LONGTEXT + CHECK(json_valid); CAST(? AS JSON) falha no parser.
    await conn.execute(
      `INSERT INTO access_history (
        dashboard_type, show_id, slug, event_name, event_date,
        recorded_at, fetched_at,
        temp_c, temp_min, temp_max, precipitation_mm, wind_kmh, weather_label,
        total_capacity, total_entered, total_remaining, flow_per_min,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        summary.dashboardType,
        String(show.id || '').slice(0, 64),
        String(show.slug || '').slice(0, 120),
        summary.eventName,
        summary.eventDate,
        recordedAt,
        fetchedAt,
        summary.tempC,
        summary.tempMin,
        summary.tempMax,
        summary.precipitationMm,
        summary.windKmh,
        summary.weatherLabel,
        summary.totalCapacity,
        summary.totalEntered,
        summary.totalRemaining,
        summary.flowPerMin,
        payloadJson,
      ]
    );
    markSaved(show.id);
    return true;
  } finally {
    conn.release();
  }
}

function maybeSaveSnapshot(cfg, show, payload) {
  Promise.resolve()
    .then(function () {
      return saveSnapshot(cfg, show, payload);
    })
    .catch(function (err) {
      console.error('[history] falha ao gravar snapshot:', err && err.message ? err.message : err);
    });
}

function toIsoOrNull(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value.toISOString();
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return isNaN(n) ? null : n;
}

function mapSeriesRow(row) {
  return {
    recordedAt: toIsoOrNull(row.recorded_at),
    totalEntered: numOrNull(row.total_entered),
    totalRemaining: numOrNull(row.total_remaining),
    totalCapacity: numOrNull(row.total_capacity),
    flowPerMin: numOrNull(row.flow_per_min),
    tempC: numOrNull(row.temp_c),
    precipitationMm: numOrNull(row.precipitation_mm),
    windKmh: numOrNull(row.wind_kmh),
    weatherLabel: row.weather_label != null ? String(row.weather_label) : null,
  };
}

function parsePayloadJson(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch (_) {
    return null;
  }
}

function emptyExtraCharts() {
  return {
    sectorTimeline: [],
    sectorsOrdered: [],
    sectorTotals: {},
    gateTotals: {},
    errors: {},
    entryStartIndex: 0,
    entered: null,
  };
}

function deriveExtraCharts(rows) {
  const empty = emptyExtraCharts();
  if (!rows || !rows.length) return empty;

  const sectorTimeline = [];
  let entryStartIndex = 0;
  let foundEntry = false;
  let lastSectors = null;
  let lastGates = null;
  let lastErrors = null;
  let lastEntered = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const payload = parsePayloadJson(row.payload_json);
    const point = { t: toIsoOrNull(row.recorded_at) };
    let hasEntry = false;

    if (payload && Array.isArray(payload.sectors)) {
      lastSectors = payload.sectors;
      for (let j = 0; j < payload.sectors.length; j++) {
        const s = payload.sectors[j];
        const name = s && s.name != null ? String(s.name).trim() : '';
        if (!name) continue;
        const entrante = Number(s.entrante) || 0;
        point[name] = entrante;
        if (entrante > 0) hasEntry = true;
      }
    }

    if (payload && Array.isArray(payload.gates)) lastGates = payload.gates;
    if (payload && payload.errors && typeof payload.errors === 'object') {
      lastErrors = payload.errors;
    }

    const te = numOrNull(row.total_entered);
    if (te != null) lastEntered = te;

    sectorTimeline.push(point);
    if (!foundEntry && hasEntry) {
      entryStartIndex = i;
      foundEntry = true;
    }
  }

  // Totais e legenda: apenas setores do último snapshot.
  // Nomes antigos/renomeados ao longo do evento não entram com valor 0
  // (evita duplicar "CAD. INFERIOR" + "Cadeira Inferior", etc.).
  const sectorTotals = {};
  if (lastSectors) {
    for (let j = 0; j < lastSectors.length; j++) {
      const s = lastSectors[j];
      const name = s && s.name != null ? String(s.name).trim() : '';
      if (!name) continue;
      sectorTotals[name] = Number(s.entrante) || 0;
    }
  }

  const sectorsOrdered = Object.keys(sectorTotals).sort(function (a, b) {
    return (sectorTotals[b] || 0) - (sectorTotals[a] || 0);
  });

  // Timeline: preenche só as chaves finais (nomes atuais) em cada ponto
  const finalNames = sectorsOrdered;
  if (finalNames.length) {
    for (let i = 0; i < sectorTimeline.length; i++) {
      const point = sectorTimeline[i];
      for (let n = 0; n < finalNames.length; n++) {
        const name = finalNames[n];
        if (point[name] == null) point[name] = 0;
      }
      // remove chaves de nomes antigos que não existem mais no snapshot final
      Object.keys(point).forEach(function (key) {
        if (key === 't') return;
        if (!Object.prototype.hasOwnProperty.call(sectorTotals, key)) {
          delete point[key];
        }
      });
    }
  }

  const gateTotals = {};
  if (lastGates) {
    for (let j = 0; j < lastGates.length; j++) {
      const g = lastGates[j];
      const name = g && g.name != null ? String(g.name) : '';
      if (!name) continue;
      gateTotals[name] = Number(g.count) || 0;
    }
  }

  return {
    sectorTimeline: sectorTimeline,
    sectorsOrdered: sectorsOrdered,
    sectorTotals: sectorTotals,
    gateTotals: gateTotals,
    errors: lastErrors || {},
    entryStartIndex: foundEntry ? entryStartIndex : 0,
    entered: lastEntered,
  };
}

async function withHistoryConn(cfg, fn) {
  if (!isConfigured(cfg)) {
    const err = new Error('Histórico MySQL não configurado');
    err.code = 'HISTORY_DISABLED';
    throw err;
  }
  const p = await ensurePool(cfg);
  const conn = await p.getConnection();
  try {
    await ensureSchema(conn);
    return await fn(conn);
  } finally {
    conn.release();
  }
}

async function listShowsWithHistory(cfg) {
  return withHistoryConn(cfg, async function (conn) {
    const [rows] = await conn.query(`
      SELECT
        show_id,
        MAX(slug) AS slug,
        MAX(event_name) AS event_name,
        MAX(event_date) AS event_date,
        MAX(dashboard_type) AS dashboard_type,
        MIN(recorded_at) AS first_recorded_at,
        MAX(recorded_at) AS last_recorded_at,
        MAX(total_entered) AS max_entered,
        COUNT(*) AS snapshot_count
      FROM access_history
      GROUP BY show_id
      ORDER BY last_recorded_at DESC
    `);
    return (rows || []).map(function (row) {
      return {
        showId: String(row.show_id || ''),
        slug: row.slug != null ? String(row.slug) : '',
        eventName: row.event_name != null ? String(row.event_name) : '',
        eventDate: row.event_date != null ? String(row.event_date) : '',
        dashboardType: row.dashboard_type != null ? String(row.dashboard_type) : '',
        firstRecordedAt: toIsoOrNull(row.first_recorded_at),
        lastRecordedAt: toIsoOrNull(row.last_recorded_at),
        maxEntered: numOrNull(row.max_entered),
        snapshotCount: numOrNull(row.snapshot_count) || 0,
      };
    });
  });
}

async function getHistorySeries(cfg, showId, from, to) {
  const id = String(showId || '').slice(0, 64);
  if (!id) {
    return { series: [], extras: emptyExtraCharts() };
  }

  return withHistoryConn(cfg, async function (conn) {
    const params = [id];
    let sql = `
      SELECT
        recorded_at, total_entered, total_remaining, total_capacity,
        flow_per_min, temp_c, precipitation_mm, wind_kmh, weather_label,
        payload_json
      FROM access_history
      WHERE show_id = ?
    `;
    if (from) {
      sql += ' AND recorded_at >= ?';
      params.push(toMysqlDatetime(from));
    }
    if (to) {
      sql += ' AND recorded_at <= ?';
      params.push(toMysqlDatetime(to));
    }
    sql += ' ORDER BY recorded_at ASC';

    const [rows] = await conn.execute(sql, params);
    const list = rows || [];
    return {
      series: list.map(mapSeriesRow),
      extras: deriveExtraCharts(list),
    };
  });
}

async function getShowHistoryMeta(cfg, showId) {
  const id = String(showId || '').slice(0, 64);
  if (!id) return null;

  return withHistoryConn(cfg, async function (conn) {
    const [rows] = await conn.execute(
      `
      SELECT
        show_id,
        MAX(slug) AS slug,
        MAX(event_name) AS event_name,
        MAX(event_date) AS event_date,
        MAX(dashboard_type) AS dashboard_type,
        MIN(recorded_at) AS first_recorded_at,
        MAX(recorded_at) AS last_recorded_at,
        MAX(total_entered) AS max_entered,
        COUNT(*) AS snapshot_count
      FROM access_history
      WHERE show_id = ?
      GROUP BY show_id
      `,
      [id]
    );
    if (!rows || !rows.length) return null;
    const row = rows[0];
    return {
      showId: String(row.show_id || ''),
      slug: row.slug != null ? String(row.slug) : '',
      eventName: row.event_name != null ? String(row.event_name) : '',
      eventDate: row.event_date != null ? String(row.event_date) : '',
      dashboardType: row.dashboard_type != null ? String(row.dashboard_type) : '',
      firstRecordedAt: toIsoOrNull(row.first_recorded_at),
      lastRecordedAt: toIsoOrNull(row.last_recorded_at),
      maxEntered: numOrNull(row.max_entered),
      snapshotCount: numOrNull(row.snapshot_count) || 0,
    };
  });
}

async function testConnection(cfg) {
  if (!cfg || !cfg.host || !String(cfg.host).trim() || !cfg.database || !String(cfg.database).trim()) {
    throw new Error('Configuração do MySQL incompleta');
  }
  const started = Date.now();
  const conn = await mysql.createConnection({
    host: String(cfg.host).trim(),
    port: Number(cfg.port) || 3306,
    database: String(cfg.database).trim(),
    user: String(cfg.user || '').trim(),
    password: String(cfg.password || ''),
    connectTimeout: 8000,
  });
  try {
    await conn.ping();
    let records = null;
    try {
      const [rows] = await conn.query('SELECT COUNT(*) AS n FROM access_history');
      records = rows && rows[0] != null ? Number(rows[0].n) : 0;
      if (isNaN(records)) records = 0;
    } catch (_) {
      records = null;
    }
    return { ok: true, ms: Date.now() - started, records: records };
  } finally {
    await conn.end();
  }
}

module.exports = {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  normalizeIntervalMs,
  isConfigured,
  saveSnapshot,
  maybeSaveSnapshot,
  listShowsWithHistory,
  getHistorySeries,
  getShowHistoryMeta,
  deriveExtraCharts,
  testConnection,
};
