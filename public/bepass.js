(function () {
  'use strict';

  var DEFAULT_LOGO_URL = '/logo-nubank-parque.png';

  var state = {
    gateOpenHour: 16,
    gateOpenMinute: 0,
    pollIntervalMs: 15000,
    eventDate: '',
    lastEntered: null,
    lastFetchedAt: null,
    lastPace: null,
    slug: null,
    showArtUrl: null,
    finalized: false,
    finalizedAt: null,
  };

  var el = {
    venueLogo: document.getElementById('venueLogo'),
    eventName: document.getElementById('eventName'),
    venueName: document.getElementById('venueName'),
    venueCity: document.getElementById('venueCity'),
    weatherBlock: document.getElementById('weatherBlock'),
    wNowIcon: document.getElementById('wNowIcon'),
    wNowTemp: document.getElementById('wNowTemp'),
    wTempRange: document.getElementById('wTempRange'),
    wDayIcon: document.getElementById('wDayIcon'),
    wDayLabel: document.getElementById('wDayLabel'),
    wPrecip: document.getElementById('wPrecip'),
    wWind: document.getElementById('wWind'),
    clockDate: document.getElementById('clockDate'),
    clockTime: document.getElementById('clockTime'),
    countdownLabel: document.getElementById('countdownLabel'),
    countdownValue: document.getElementById('countdownValue'),
    posterWrap: document.getElementById('posterWrap'),
    showArt: document.getElementById('showArt'),
    posterEmpty: document.getElementById('posterEmpty'),
    gaugeProgress: document.getElementById('gaugeProgress'),
    gaugePct: document.getElementById('gaugePct'),
    gaugeFlow: document.getElementById('gaugeFlow'),
    gaugeEntered: document.getElementById('gaugeEntered'),
    gaugeRemaining: document.getElementById('gaugeRemaining'),
    kpiCapacity: document.getElementById('kpiCapacity'),
    kpiEntered: document.getElementById('kpiEntered'),
    kpiRemaining: document.getElementById('kpiRemaining'),
    kpiQuebra: document.getElementById('kpiQuebra'),
    kpiQuebraCard: document.getElementById('kpiQuebraCard'),
    kpis: document.getElementById('kpis'),
    kpiOccupancy: document.getElementById('kpiOccupancy'),
    kpiPace: document.getElementById('kpiPace'),
    kpiFlow: document.getElementById('kpiFlow'),
    kpiFlowPeak: document.getElementById('kpiFlowPeak'),
    sectorsBadge: document.getElementById('sectorsBadge'),
    sectorsChart: document.getElementById('sectorsChart'),
    sectorsAxis: document.getElementById('sectorsAxis'),
    gatesList: document.getElementById('gatesList'),
    peakBadge: document.getElementById('peakBadge'),
    hourChart: document.getElementById('hourChart'),
    footerMeta: document.getElementById('footerMeta'),
    footerError: document.getElementById('footerError'),
  };

  var GAUGE_R = 52;
  var GAUGE_C = 2 * Math.PI * GAUGE_R;

  function detectSlug() {
    var match = /^\/shows\/([^/]+)\/?$/.exec(location.pathname);
    return match ? decodeURIComponent(match[1]) : null;
  }

  state.slug = detectSlug();

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatNumber(n) {
    return new Intl.NumberFormat('pt-BR').format(n || 0);
  }

  function parseEventDate(str) {
    if (!str || typeof str !== 'string') return null;
    var parts = str.split('-').map(Number);
    if (parts.length !== 3 || parts.some(function (p) { return isNaN(p); })) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function formatDateShort(d) {
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear();
  }

  function formatClockTime(d) {
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function formatDateTimeFooter(d) {
    return (
      pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() +
      ', ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    );
  }

  function formatDuration(ms) {
    var totalSec = Math.floor(Math.abs(ms) / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    return pad2(h) + ':' + pad2(m) + ':' + pad2(s);
  }

  function niceTick(span) {
    if (!(span > 0)) return 1;
    var exp = Math.floor(Math.log10(span));
    var base = Math.pow(10, exp);
    var fraction = span / base;
    var nice;
    if (fraction <= 1) nice = 1;
    else if (fraction <= 2) nice = 2;
    else if (fraction <= 5) nice = 5;
    else nice = 10;
    return nice * base;
  }

  function computePace(entered, fetchedAt) {
    var now = fetchedAt ? new Date(fetchedAt).getTime() : Date.now();
    if (state.lastEntered != null && state.lastFetchedAt != null) {
      var dtMin = (now - state.lastFetchedAt) / 60000;
      if (dtMin > 0) {
        var delta = entered - state.lastEntered;
        state.lastPace = Math.max(0, Math.round(delta / dtMin));
      }
    }
    state.lastEntered = entered;
    state.lastFetchedAt = now;
    if (state.lastPace == null) return 'Ritmo: —';
    return 'Ritmo: ~' + formatNumber(state.lastPace) + ' /min';
  }

  function updateClockAndCountdown() {
    var now = new Date();
    if (el.clockDate) el.clockDate.textContent = formatDateShort(now);
    el.clockTime.textContent = formatClockTime(now);

    var base = parseEventDate(state.eventDate) || now;
    var open = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      Number(state.gateOpenHour) || 16,
      Number(state.gateOpenMinute) || 0,
      0
    );

    if (state.finalized) {
      el.countdownLabel.textContent = 'Tempo total';
      el.countdownValue.classList.remove('is-open');
      el.countdownValue.classList.add('is-closed');
      if (state.finalizedAt) {
        var endAt = new Date(state.finalizedAt);
        var totalMs = endAt.getTime() - open.getTime();
        el.countdownValue.textContent = totalMs > 0 ? formatDuration(totalMs) : '—';
      } else {
        el.countdownValue.textContent = '—';
      }
      return;
    }

    el.countdownValue.classList.remove('is-closed');

    var diff = now - open;
    if (diff >= 0) {
      el.countdownLabel.textContent = 'Portões abertos há';
      el.countdownValue.textContent = formatDuration(diff);
      el.countdownValue.classList.add('is-open');
    } else {
      el.countdownLabel.textContent = 'Abertura dos portões em';
      el.countdownValue.textContent = formatDuration(diff);
      el.countdownValue.classList.remove('is-open');
    }
  }

  function applyLogo(url, alt) {
    if (!el.venueLogo) return;
    var src = url || DEFAULT_LOGO_URL;
    el.venueLogo.src = src;
    el.venueLogo.alt = alt || 'Logo';
    el.venueLogo.classList.toggle('is-default', !url);
  }

  function applyArtFit(data) {
    if (!el.showArt) return;
    var zoom = Number(data && data.showArtZoom);
    var x = Number(data && data.showArtX);
    var y = Number(data && data.showArtY);
    if (isNaN(zoom) || zoom < 0.5) zoom = 1;
    if (zoom > 3) zoom = 3;
    if (isNaN(x)) x = 50;
    if (isNaN(y)) y = 50;
    el.showArt.style.objectPosition = x + '% ' + y + '%';
    el.showArt.style.transformOrigin = x + '% ' + y + '%';
    el.showArt.style.width = '100%';
    el.showArt.style.height = '100%';
    if (zoom >= 1) {
      el.showArt.style.objectFit = 'cover';
      el.showArt.style.transform = zoom === 1 ? 'none' : 'scale(' + zoom + ')';
    } else {
      el.showArt.style.objectFit = 'contain';
      el.showArt.style.transform = 'none';
    }
    if (el.posterWrap) {
      el.posterWrap.style.backgroundImage = '';
      el.posterWrap.style.backgroundSize = '';
      el.posterWrap.style.backgroundPosition = '';
    }
  }

  function applyShowArt(artUrl, data) {
    applyArtFit(data);
    if (!artUrl) {
      state.showArtUrl = null;
      el.showArt.removeAttribute('src');
      el.posterWrap.classList.add('is-empty');
      return;
    }
    if (artUrl === state.showArtUrl) return;
    state.showArtUrl = artUrl;
    el.showArt.onload = function () {
      el.posterWrap.classList.remove('is-empty');
      applyArtFit(data);
    };
    el.showArt.onerror = function () {
      el.posterWrap.classList.add('is-empty');
    };
    el.showArt.src = artUrl;
  }

  function renderGauge(pct, entered, remaining) {
    var clamped = Math.max(0, Math.min(100, pct));
    el.gaugePct.textContent = Math.round(clamped) + '%';
    el.gaugeProgress.style.strokeDasharray = String(GAUGE_C);
    el.gaugeProgress.style.strokeDashoffset = String(GAUGE_C * (1 - clamped / 100));
    el.gaugeEntered.textContent = formatNumber(entered);
    el.gaugeRemaining.textContent = formatNumber(remaining);
    el.gaugeFlow.textContent = entered > 0 ? 'Fluxo ativo' : 'Aguardando fluxo';
  }

  function renderSectors(sectors) {
    var list = Array.isArray(sectors) ? sectors : [];
    var maxF = 0;
    var maxE = 0;
    var sumE = 0;
    var sumCap = 0;
    for (var i = 0; i < list.length; i++) {
      maxF = Math.max(maxF, Number(list[i].faltante) || 0);
      maxE = Math.max(maxE, Number(list[i].entrante) || 0);
      sumE += Number(list[i].entrante) || 0;
      sumCap += (Number(list[i].faltante) || 0) + (Number(list[i].entrante) || 0);
    }
    el.sectorsBadge.textContent = formatNumber(sumE) + ' de ' + formatNumber(sumCap);

    var pad = Math.max(1, (maxF + maxE) * 0.22);
    var scaleMin = -(maxF + pad);
    var scaleMax = maxE + pad;
    var span = scaleMax - scaleMin;
    var zeroPct = ((0 - scaleMin) / span) * 100;

    var html = '';
    for (var j = 0; j < list.length; j++) {
      var f = Number(list[j].faltante) || 0;
      var e = Number(list[j].entrante) || 0;
      var leftW = (f / span) * 100;
      var rightW = (e / span) * 100;
      html +=
        '<div class="div-row">' +
          '<div class="div-name" title="' + escapeAttr(list[j].name) + '">' + escapeHtml(list[j].name) + '</div>' +
          '<div class="div-bars">' +
            '<div class="div-zero" style="left:' + zeroPct + '%"></div>' +
            '<div class="div-left" style="right:' + (100 - zeroPct) + '%;width:' + leftW + '%">' +
              (f > 0 ? '<span class="div-val left mono">' + formatNumber(f) + '</span>' : '') +
              '<div class="bar-faltante" style="width:100%"></div>' +
            '</div>' +
            '<div class="div-right" style="left:' + zeroPct + '%;width:' + rightW + '%">' +
              '<div class="bar-entrante" style="width:100%"></div>' +
              (e > 0 ? '<span class="div-val right mono">' + formatNumber(e) + '</span>' : '') +
            '</div>' +
          '</div>' +
        '</div>';
    }
    el.sectorsChart.innerHTML = html || '<div class="div-row"><div class="div-name">—</div><div class="div-bars"></div></div>';

    var tick = niceTick(span / 4);
    var ticksHtml = '';
    var start = Math.ceil(scaleMin / tick) * tick;
    for (var t = start; t <= scaleMax + 0.0001; t += tick) {
      var pct = ((t - scaleMin) / span) * 100;
      ticksHtml +=
        '<span class="axis-tick" style="left:' + pct + '%">' + formatNumber(Math.round(t)) + '</span>';
    }
    el.sectorsAxis.innerHTML = '<div></div><div class="axis-ticks">' + ticksHtml + '</div>';
  }

  function renderGates(gates) {
    var list = Array.isArray(gates) ? gates : [];
    var maxN = 1;
    for (var i = 0; i < list.length; i++) {
      maxN = Math.max(maxN, Number(list[i].count) || 0);
    }
    var html = '';
    for (var j = 0; j < list.length; j++) {
      var c = Number(list[j].count) || 0;
      html +=
        '<div class="gate-row">' +
          '<div class="bar-line">' +
            '<div class="bar-label">' + escapeHtml(list[j].name) + '</div>' +
            '<div class="bar-track"><div class="bar-fill" style="width:' + ((c / maxN) * 100) + '%"></div></div>' +
            '<div class="bar-val mono">' + formatNumber(c) + '</div>' +
          '</div>' +
        '</div>';
    }
    el.gatesList.innerHTML = html || '<div class="kpi-sub">Nenhum portão com check-in</div>';
  }

  function gatesAreOpen() {
    if (state.finalized) return true;
    var now = new Date();
    var base = parseEventDate(state.eventDate) || now;
    var open = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      Number(state.gateOpenHour) || 16,
      Number(state.gateOpenMinute) || 0,
      0
    );
    return now.getTime() >= open.getTime();
  }

  function renderHourChart(accessByHour, gatesOpen) {
    var open = gatesOpen === true || (gatesOpen !== false && gatesAreOpen());
    var list = open && Array.isArray(accessByHour) ? accessByHour : [];
    var startH = Number(state.gateOpenHour);
    if (isNaN(startH)) startH = 16;
    if (open) {
      list = list.filter(function (row) {
        return Number(row && row.hour) >= startH;
      });
    } else {
      list = [];
    }

    var max = 0;
    var peak = null;
    for (var i = 0; i < list.length; i++) {
      var c = Number(list[i].count) || 0;
      if (c > max) {
        max = c;
        peak = list[i];
      }
    }
    if (peak) {
      el.peakBadge.textContent = 'pico · ' + formatNumber(peak.count) + ' às ' + peak.hour + 'h';
    } else {
      el.peakBadge.textContent = 'pico · —';
    }

    if (!open) {
      el.hourChart.innerHTML = '<div class="kpi-sub">Acessos disponíveis após a abertura dos portões</div>';
      return;
    }
    if (!list.length) {
      el.hourChart.innerHTML = '<div class="kpi-sub">Sem dados de horário — o gráfico aparece após os snapshots do histórico</div>';
      return;
    }

    var nowH = new Date().getHours();
    var cols = '';
    for (var j = 0; j < list.length; j++) {
      var hour = Number(list[j].hour);
      var count = Number(list[j].count) || 0;
      var hPct = max > 0 ? (count / max) * 100 : 0;
      cols +=
        '<div class="chart-col">' +
          (count > 0 ? '<div class="chart-val">' + formatNumber(count) + '</div>' : '<div class="chart-val"></div>') +
          '<div class="chart-bar" style="height:' + Math.max(2, hPct) + '%"></div>' +
          '<div class="chart-hour' + (hour === nowH ? ' is-now' : '') + '">' + pad2(hour) + '</div>' +
        '</div>';
    }

    el.hourChart.innerHTML =
      '<div class="chart-grid">' +
        '<div class="chart-grid-line" style="top:25%"></div>' +
        '<div class="chart-grid-line" style="top:50%"></div>' +
        '<div class="chart-grid-line" style="top:75%"></div>' +
      '</div>' +
      cols;
  }

  function applyWeather(weather) {
    if (!weather) {
      el.weatherBlock.classList.add('hidden');
      return;
    }
    el.weatherBlock.classList.remove('hidden');
    el.wNowIcon.textContent = (weather.current && weather.current.icon) || '—';
    el.wNowTemp.textContent = ((weather.current && weather.current.tempC) != null ? weather.current.tempC : '—') + '°C';
    el.wTempRange.textContent =
      (weather.tempMin != null ? weather.tempMin : '—') + '°C - ' +
      (weather.tempMax != null ? weather.tempMax : '—') + '°C';
    el.wDayIcon.textContent = weather.icon || '';
    el.wDayLabel.textContent = weather.label || '';
    el.wPrecip.textContent = (weather.precipitationMm != null ? weather.precipitationMm : '—') + 'mm';
    el.wWind.textContent = (weather.windKmh != null ? weather.windKmh : '—') + ' km/h';
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, '&#39;');
  }

  function normalizeTheme(value) {
    return value === 'nubank-parque' ? 'nubank-parque' : 'default';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', normalizeTheme(theme));
  }

  function applyData(data) {
    state.gateOpenHour = Number(data.gateOpenHour);
    if (isNaN(state.gateOpenHour)) state.gateOpenHour = 16;
    state.gateOpenMinute = Number(data.gateOpenMinute);
    if (isNaN(state.gateOpenMinute) || state.gateOpenMinute < 0 || state.gateOpenMinute > 59) {
      state.gateOpenMinute = 0;
    }
    state.pollIntervalMs = Number(data.pollIntervalMs) || 15000;
    state.eventDate = data.eventDate || '';
    state.finalizedAt = data.finalizedAt || null;
    applyTheme(data.theme);

    el.eventName.textContent = data.eventName || data.title || 'Evento';
    applyLogo(data.logoUrl || '', data.venueName || 'Nubank Parque');
    el.venueName.textContent = data.venueName || '—';
    el.venueCity.textContent = data.venueCity || '—';

    applyShowArt(data.showArtUrl || '', data);
    applyWeather(data.weather || null);

    var totals = data.totals || {};
    var faltante = Number(totals.faltante) || 0;
    var entrante = Number(totals.entrante) || 0;
    var capacity = faltante + entrante;
    var occupancy = capacity > 0 ? (entrante / capacity) * 100 : 0;
    var quebra = capacity > 0 ? (faltante / capacity) * 100 : 0;

    el.kpiCapacity.textContent = formatNumber(capacity);
    el.kpiEntered.textContent = formatNumber(entrante);
    el.kpiRemaining.textContent = formatNumber(faltante);
    if (el.kpiQuebraCard) {
      el.kpiQuebraCard.classList.toggle('hidden', !state.finalized);
    }
    if (el.kpis) {
      el.kpis.classList.toggle('has-quebra', !!state.finalized);
    }
    if (state.finalized && el.kpiQuebra) {
      el.kpiQuebra.textContent = Math.round(quebra) + '%';
    }
    el.kpiOccupancy.textContent = Math.round(occupancy) + '%';
    el.kpiPace.textContent = computePace(entrante, data.fetchedAt);

    var flow = data.flow || {};
    el.kpiFlow.textContent = formatNumber(flow.lastMinute);
    el.kpiFlowPeak.textContent = 'pico: ' + formatNumber(flow.maxPerMinute) + ' /min';

    renderGauge(occupancy, entrante, faltante);
    renderSectors(data.sectors);
    renderGates(data.gates);
    renderHourChart(data.accessByHour, data.gatesOpen);
    updateClockAndCountdown();

    var fetched = data.fetchedAt ? new Date(data.fetchedAt) : new Date();
    var secs = Math.round(state.pollIntervalMs / 1000);
    if (data.finalized) {
      el.footerMeta.textContent =
        'Evento finalizado · últimos dados de ' + formatDateTimeFooter(fetched);
    } else {
      el.footerMeta.textContent =
        'Última atualização: ' + formatDateTimeFooter(fetched) +
        ' · atualiza a cada ' + secs + 's';
    }
    el.footerError.textContent = '';
    updatePdfButtonVisibility();
  }

  function updatePdfButtonVisibility() {
    var btn = document.getElementById('exportPdfBtn');
    if (!btn) return;
    btn.hidden = !state.finalized;
  }

  function dataUrl() {
    if (state.slug) return '/api/data/' + encodeURIComponent(state.slug);
    return '/api/data';
  }

  function scheduleNext() {
    if (state.finalized) return;
    setTimeout(poll, state.pollIntervalMs);
  }

  function poll() {
    fetch(dataUrl(), { cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status));
          return body;
        });
      })
      .then(function (data) {
        state.finalized = !!data.finalized;
        applyData(data);
      })
      .catch(function (err) {
        el.footerError.textContent = String(err.message || err);
      })
      .then(function () {
        scheduleNext();
      });
  }

  function bindPdfExport() {
    var btn = document.getElementById('exportPdfBtn');
    if (!btn || !window.DashShowsPdf) return;
    window.DashShowsPdf.bindExportButton(
      btn,
      function () {
        return document.getElementById('exportRoot') || document.querySelector('.shell');
      },
      function () {
        var Pdf = window.DashShowsPdf;
        var name = Pdf.slugify((el.eventName && el.eventName.textContent) || 'evento');
        return 'evento-' + name + '-' + Pdf.stamp() + '.pdf';
      },
      {
        hideSelectors: ['.pdf-hide', '[data-pdf-hide]'],
        orientation: 'landscape',
      }
    );
  }

  el.gaugeProgress.style.strokeDasharray = String(GAUGE_C);
  el.gaugeProgress.style.strokeDashoffset = String(GAUGE_C);
  updateClockAndCountdown();
  setInterval(updateClockAndCountdown, 1000);
  bindPdfExport();
  poll();
})();
