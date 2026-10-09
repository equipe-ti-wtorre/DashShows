'use strict';

const SAO_PAULO_OFFSET_MS = -3 * 60 * 60 * 1000;

function parseEventDateParts(eventDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(eventDate || '').trim());
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

function clampHour(value, fallback) {
  const n = Number(value);
  if (isNaN(n)) return fallback;
  return Math.max(0, Math.min(23, n));
}

function clampMinute(value) {
  const n = Number(value);
  if (isNaN(n) || n < 0 || n > 59) return 0;
  return n;
}

function gateOpenHourOf(show) {
  return clampHour(show && show.gateOpenHour, 16);
}

function gateOpenMinuteOf(show) {
  return clampMinute(show && show.gateOpenMinute);
}

function gateOpenAtSaoPaulo(eventDate, gateOpenHour, gateOpenMinute) {
  const parts = parseEventDateParts(eventDate);
  if (!parts) return null;
  const h = clampHour(gateOpenHour, NaN);
  const min = clampMinute(gateOpenMinute);
  if (isNaN(h)) return null;
  return new Date(
    Date.UTC(parts.y, parts.mo - 1, parts.d, h, min, 0, 0) - SAO_PAULO_OFFSET_MS
  );
}

function saoPauloWallClock(now) {
  return new Date((now || new Date()).getTime() + SAO_PAULO_OFFSET_MS);
}

function resolveGateOpenAt(show, now) {
  const hour = gateOpenHourOf(show);
  const minute = gateOpenMinuteOf(show);
  const fromEvent = gateOpenAtSaoPaulo(show && show.eventDate, hour, minute);
  if (fromEvent) return fromEvent;
  const sp = saoPauloWallClock(now);
  return new Date(
    Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate(), hour, minute, 0, 0)
      - SAO_PAULO_OFFSET_MS
  );
}

function isGateOpen(show, now) {
  const at = resolveGateOpenAt(show, now);
  return (now || new Date()).getTime() >= at.getTime();
}

function filterAccessByHour(rows, show) {
  if (!Array.isArray(rows) || !rows.length) return [];
  if (!isGateOpen(show)) return [];
  const startH = gateOpenHourOf(show);
  return rows.filter(function (row) {
    return Number(row && row.hour) >= startH;
  });
}

function stripLiveAccesses(payload) {
  const next = Object.assign({}, payload || {}, {
    accessByHour: [],
    gatesOpen: false,
  });

  if (next.totals) {
    const faltante = Math.max(0, Number(next.totals.faltante) || 0);
    const entrante = Math.max(0, Number(next.totals.entrante) || 0);
    next.totals = Object.assign({}, next.totals, {
      faltante: faltante + entrante,
      entrante: 0,
    });
  }

  if (Array.isArray(next.sectors)) {
    next.sectors = next.sectors.map(function (row) {
      const faltante = Math.max(0, Number(row && row.faltante) || 0);
      const entrante = Math.max(0, Number(row && row.entrante) || 0);
      return Object.assign({}, row, {
        faltante: faltante + entrante,
        entrante: 0,
      });
    });
  }

  if (Array.isArray(next.gates)) {
    next.gates = next.gates.map(function (row) {
      return Object.assign({}, row, { count: 0, supervisor: 0 });
    });
  }

  if (next.errors) {
    next.errors = {
      supervisor: 0,
      duplaEntrada: 0,
      portaoErrado: 0,
      cartaoDesconhecido: 0,
      naoGirou: 0,
      cartaoForaHorario: 0,
    };
  }

  if (next.flow) {
    next.flow = Object.assign({}, next.flow, {
      lastMinute: 0,
      maxPerMinute: 0,
    });
  }

  if (Array.isArray(next.accessReport)) {
    next.accessReport = next.accessReport.map(function (row) {
      return Object.assign({}, row, { used: 0 });
    });
  }

  return next;
}

function applyLiveAccessRule(show, payload) {
  const next = Object.assign({}, payload || {});
  const open = isGateOpen(show);
  next.gatesOpen = open;
  if (!open) return stripLiveAccesses(next);
  next.accessByHour = filterAccessByHour(next.accessByHour, show);
  return next;
}

module.exports = {
  SAO_PAULO_OFFSET_MS,
  parseEventDateParts,
  gateOpenAtSaoPaulo,
  resolveGateOpenAt,
  isGateOpen,
  filterAccessByHour,
  stripLiveAccesses,
  applyLiveAccessRule,
  gateOpenHourOf,
  gateOpenMinuteOf,
};
