(function () {
  'use strict';

  var DEFAULT_LOGO_URL = '/logo-nubank-parque.png';

  var SECTOR_COLORS = [
    '#9b5cff',
    '#37d99a',
    '#f6b73c',
    '#5bb8ff',
    '#ff7ab8',
    '#7aefc0',
    '#c084fc',
    '#fb923c',
  ];

  var state = {
    startDate: null,
    gateOpenHour: 16,
    gateOpenMinute: 0,
    pollIntervalMs: 15000,
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
    venueCityDot: document.getElementById('venueCityDot'),
    eventDate: document.getElementById('eventDate'),
    weatherBlock: document.getElementById('weatherBlock'),
    wNowIcon: document.getElementById('wNowIcon'),
    wNowTemp: document.getElementById('wNowTemp'),
    wTempRange: document.getElementById('wTempRange'),
    wDayIcon: document.getElementById('wDayIcon'),
    wDayLabel: document.getElementById('wDayLabel'),
    wPrecip: document.getElementById('wPrecip'),
    wWind: document.getElementById('wWind'),
    clockTime: document.getElementById('clockTime'),
    clockDate: document.getElementById('clockDate'),
    countdownLabel: document.getElementById('countdownLabel'),
    countdownValue: document.getElementById('countdownValue'),
    kpiCapacity: document.getElementById('kpiCapacity'),
    kpiCapacitySub: document.getElementById('kpiCapacitySub'),
    kpiEntered: document.getElementById('kpiEntered'),
    kpiEnteredSub: document.getElementById('kpiEnteredSub'),
    kpiRemaining: document.getElementById('kpiRemaining'),
    kpiQuebra: document.getElementById('kpiQuebra'),
    kpiQuebraCard: document.getElementById('kpiQuebraCard'),
    kpis: document.getElementById('kpis'),
    kpiOccupancy: document.getElementById('kpiOccupancy'),
    kpiPace: document.getElementById('kpiPace'),
    showArt: document.getElementById('showArt'),
    posterFallback: document.getElementById('posterFallback'),
    gaugeProgress: document.getElementById('gaugeProgress'),
    gaugePct: document.getElementById('gaugePct'),
    gaugeFlow: document.getElementById('gaugeFlow'),
    sectorsBadge: document.getElementById('sectorsBadge'),
    gaugeEntered: document.getElementById('gaugeEntered'),
    gaugeRemaining: document.getElementById('gaugeRemaining'),
    sectorsList: document.getElementById('sectorsList'),
    peakBadge: document.getElementById('peakBadge'),
    hourChart: document.getElementById('hourChart'),
    footerMeta: document.getElementById('footerMeta'),
    footerError: document.getElementById('footerError'),
  };

  function detectSlug() {
    var match = /^\/shows\/([^/]+)\/?$/.exec(location.pathname);
    return match ? decodeURIComponent(match[1]) : null;
  }

  state.slug = detectSlug();

  var GAUGE_R = 52;
  var GAUGE_C = 2 * Math.PI * GAUGE_R;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatNumber(n) {
    return new Intl.NumberFormat('pt-BR').format(n || 0);
  }

  function formatDateShort(d) {
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear();
  }

  function formatTime(d) {
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function formatDateTimeFooter(d) {
    return (
      pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() +
      ', ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    );
  }

  function computeGateOpenDate(startDateIso, gateOpenHour, gateOpenMinute) {
    var d = new Date(startDateIso);
    return new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      gateOpenHour,
      Number(gateOpenMinute) || 0,
      0
    );
  }

  function formatDuration(ms) {
    var totalSec = Math.floor(Math.abs(ms) / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    return pad2(h) + ':' + pad2(m) + ':' + pad2(s);
  }

  function updateClockAndCountdown() {
    var now = new Date();
    el.clockTime.textContent = formatTime(now);
    if (el.clockDate) el.clockDate.textContent = formatDateShort(now);

    if (state.finalized) {
      el.countdownLabel.textContent = 'Tempo total';
      el.countdownValue.classList.remove('is-open');
      el.countdownValue.classList.add('is-closed');
      if (state.startDate && state.finalizedAt) {
        var gateOpenClosed = computeGateOpenDate(state.startDate, state.gateOpenHour, state.gateOpenMinute);
        var endAt = new Date(state.finalizedAt);
        var totalMs = endAt.getTime() - gateOpenClosed.getTime();
        el.countdownValue.textContent = totalMs > 0 ? formatDuration(totalMs) : '—';
      } else {
        el.countdownValue.textContent = '—';
      }
      return;
    }

    el.countdownValue.classList.remove('is-closed');

    if (!state.startDate) {
      el.countdownValue.textContent = '--:--:--';
      el.countdownLabel.textContent = 'Abertura dos portões em';
      return;
    }

    var gateOpen = computeGateOpenDate(state.startDate, state.gateOpenHour, state.gateOpenMinute);
    var diff = gateOpen.getTime() - now.getTime();

    if (diff > 0) {
      el.countdownLabel.textContent = 'Abertura dos portões em';
      el.countdownValue.textContent = formatDuration(diff);
      el.countdownValue.classList.remove('is-open');
    } else {
      el.countdownLabel.textContent = 'Portões abertos há';
      el.countdownValue.textContent = formatDuration(diff);
      el.countdownValue.classList.add('is-open');
    }
  }

  function sumReport(report, key) {
    var total = 0;
    for (var i = 0; i < report.length; i++) {
      total += Number(report[i][key]) || 0;
    }
    return total;
  }

  function computePace(entered, fetchedAtIso) {
    var fetchedAt = fetchedAtIso ? new Date(fetchedAtIso) : new Date();
    var paceText = 'Ritmo: —';

    if (state.lastEntered != null && state.lastFetchedAt) {
      var deltaEntered = entered - state.lastEntered;
      var deltaMs = fetchedAt.getTime() - state.lastFetchedAt.getTime();
      var deltaMin = deltaMs / 60000;
      if (deltaMin > 0 && deltaEntered >= 0) {
        var perMin = deltaEntered / deltaMin;
        state.lastPace = perMin;
        paceText = 'Ritmo: ~' + Math.round(perMin) + ' /min';
      } else if (state.lastPace != null) {
        paceText = 'Ritmo: ~' + Math.round(state.lastPace) + ' /min';
      }
    }

    state.lastEntered = entered;
    state.lastFetchedAt = fetchedAt;
    return paceText;
  }

  function renderGauge(pct, entered, remaining) {
    var clamped = Math.max(0, Math.min(100, pct));
    var offset = GAUGE_C * (1 - clamped / 100);
    el.gaugeProgress.style.strokeDasharray = String(GAUGE_C);
    el.gaugeProgress.style.strokeDashoffset = String(offset);
    el.gaugePct.textContent = Math.round(clamped) + '%';
    el.gaugeEntered.textContent = formatNumber(entered);
    el.gaugeRemaining.textContent = formatNumber(remaining);
    el.gaugeFlow.textContent = entered > 0 ? 'Fluxo ativo' : 'Aguardando fluxo';
  }

  function renderSectors(report) {
    var sorted = report.slice().sort(function (a, b) {
      return (Number(b.total) || 0) - (Number(a.total) || 0);
    });

    var html = '';
    for (var i = 0; i < sorted.length; i++) {
      var item = sorted[i];
      var used = Number(item.used) || 0;
      var total = Number(item.total) || 0;
      var pct = total > 0 ? (used / total) * 100 : 0;
      var color = SECTOR_COLORS[i % SECTOR_COLORS.length];
      var name = item.resource || ('Setor ' + (i + 1));

      html +=
        '<div class="sector-row">' +
          '<div class="sector-head">' +
            '<div class="sector-name">' +
              '<i class="sector-tag" style="background:' + color + '"></i>' +
              '<span title="' + escapeAttr(name) + '">' + escapeHtml(name) + '</span>' +
            '</div>' +
            '<div class="sector-nums mono">' +
              '<strong>' + formatNumber(used) + '</strong> / ' + formatNumber(total) +
              ' <span class="sector-pct">' + Math.round(pct) + '%</span>' +
            '</div>' +
          '</div>' +
          '<div class="sector-bar"><i style="width:' + clampedPct(pct) + '%;background:' + color + '"></i></div>' +
        '</div>';
    }

    el.sectorsList.innerHTML = html || '<div class="kpi-sub">Nenhum setor mapeado</div>';
  }

  function clampedPct(n) {
    return Math.max(0, Math.min(100, n)).toFixed(1);
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

  function gatesAreOpen() {
    if (state.finalized) return true;
    var now = new Date();
    if (!state.startDate) {
      var todayOpen = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        Number(state.gateOpenHour) || 16,
        Number(state.gateOpenMinute) || 0,
        0
      );
      return now.getTime() >= todayOpen.getTime();
    }
    return now.getTime() >= computeGateOpenDate(
      state.startDate,
      state.gateOpenHour,
      state.gateOpenMinute
    ).getTime();
  }

  function renderHourChart(accessByHour, gatesOpen) {
    var open = gatesOpen === true || (gatesOpen !== false && gatesAreOpen());
    var rows = open && Array.isArray(accessByHour) ? accessByHour : [];
    var startH = Number(state.gateOpenHour);
    if (isNaN(startH)) startH = 16;
    if (open) {
      rows = rows.filter(function (row) {
        return Number(row && row.hour) >= startH;
      });
    } else {
      rows = [];
    }
    var nowHour = new Date().getHours();
    var max = 0;
    var peakHour = null;
    var peakCount = 0;

    for (var i = 0; i < rows.length; i++) {
      var count = rows[i].count == null ? 0 : Number(rows[i].count) || 0;
      if (count > max) max = count;
      if (count > peakCount) {
        peakCount = count;
        peakHour = rows[i].hour;
      }
    }

    if (peakHour == null) {
      el.peakBadge.textContent = 'pico · —';
    } else {
      el.peakBadge.textContent = 'pico · ' + formatNumber(peakCount) + ' às ' + peakHour + 'h';
    }

    if (!open) {
      el.hourChart.innerHTML = '<div class="kpi-sub">Acessos disponíveis após a abertura dos portões</div>';
      return;
    }

    if (!rows.length) {
      el.hourChart.innerHTML = '<div class="kpi-sub">Sem dados de horário</div>';
      return;
    }

    var bars = '';
    for (var j = 0; j < rows.length; j++) {
      var hour = rows[j].hour;
      var value = rows[j].count == null ? 0 : Number(rows[j].count) || 0;
      var height = max > 0 ? (value / max) * 100 : 0;
      var isCurrent = Number(hour) === nowHour;
      bars +=
        '<div class="bar-col' + (isCurrent ? ' is-current' : '') + '">' +
          '<div class="bar-value">' + (value > 0 ? formatNumber(value) : '') + '</div>' +
          '<div class="bar" style="height:' + Math.max(height, value > 0 ? 4 : 2) + '%"></div>' +
          '<div class="bar-hour">' + pad2(Number(hour)) + 'h</div>' +
        '</div>';
    }

    el.hourChart.innerHTML =
      '<div class="chart-grid"><span></span><span></span><span></span><span></span></div>' +
      '<div class="chart-bars">' + bars + '</div>';
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
    var frame = el.showArt.parentElement;
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
    if (frame) {
      frame.style.backgroundImage = '';
      frame.style.backgroundSize = '';
      frame.style.backgroundPosition = '';
    }
  }

  function applyShowArt(artUrl, alt, data) {
    if (!el.showArt) return;
    applyArtFit(data);
    if (artUrl && artUrl !== state.showArtUrl) {
      state.showArtUrl = artUrl;
      el.showArt.onload = function () {
        if (el.posterFallback) el.posterFallback.classList.add('hidden');
        el.showArt.style.display = 'block';
        applyArtFit(data);
      };
      el.showArt.onerror = function () {
        el.showArt.style.display = 'none';
        if (el.posterFallback) el.posterFallback.classList.remove('hidden');
      };
      el.showArt.alt = alt || 'Arte do show';
      el.showArt.src = artUrl;
    } else if (!artUrl) {
      state.showArtUrl = null;
      el.showArt.removeAttribute('src');
      el.showArt.style.display = 'none';
      if (el.posterFallback) el.posterFallback.classList.remove('hidden');
    } else {
      el.showArt.alt = alt || 'Arte do show';
    }
  }

  function normalizeTheme(value) {
    return value === 'nubank-parque' ? 'nubank-parque' : 'default';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', normalizeTheme(theme));
  }

  function applyData(data) {
    state.startDate = data.startDate || null;
    state.gateOpenHour = Number(data.gateOpenHour);
    if (isNaN(state.gateOpenHour)) state.gateOpenHour = 16;
    state.gateOpenMinute = Number(data.gateOpenMinute);
    if (isNaN(state.gateOpenMinute) || state.gateOpenMinute < 0 || state.gateOpenMinute > 59) {
      state.gateOpenMinute = 0;
    }
    state.pollIntervalMs = Number(data.pollIntervalMs) || 15000;
    state.finalizedAt = data.finalizedAt || null;
    applyTheme(data.theme);

    el.eventName.textContent = data.title || data.eventName || data.showName || 'Evento';
    applyLogo(data.logoUrl || '', data.venueName || 'Nubank Parque');
    el.venueName.textContent = data.venueName || '—';

    var city = data.venueCity || '';
    if (city) {
      el.venueCity.textContent = city;
      el.venueCity.classList.remove('hidden');
      if (el.venueCityDot) el.venueCityDot.classList.remove('hidden');
    } else {
      el.venueCity.textContent = '';
      el.venueCity.classList.add('hidden');
      if (el.venueCityDot) el.venueCityDot.classList.add('hidden');
    }

    if (el.eventDate) {
      el.eventDate.textContent = data.startDate
        ? formatDateShort(new Date(data.startDate))
        : '—';
    }

    applyShowArt(data.showArtUrl || '', data.title || data.eventName || data.showName || 'Arte do show', data);
    applyWeather(data.weather || null);

    var report = Array.isArray(data.accessReport) ? data.accessReport : [];
    var capacity = sumReport(report, 'total');
    var entered = sumReport(report, 'used');
    var remaining = Math.max(0, capacity - entered);
    var occupancy = capacity > 0 ? (entered / capacity) * 100 : 0;
    var quebra = capacity > 0 ? (remaining / capacity) * 100 : 0;

    el.kpiCapacity.textContent = formatNumber(capacity);
    el.kpiCapacitySub.textContent =
      report.length + ' setor' + (report.length === 1 ? '' : 'es') + ' mapeado' + (report.length === 1 ? '' : 's');

    el.kpiEntered.textContent = formatNumber(entered);
    el.kpiEnteredSub.textContent =
      entered > 0 ? 'Fluxo em andamento' : 'Aguardando 1ª entrada';

    el.kpiRemaining.textContent = formatNumber(remaining);
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
    el.kpiPace.textContent = computePace(entered, data.fetchedAt);
    el.sectorsBadge.textContent = formatNumber(entered) + ' de ' + formatNumber(capacity);

    renderGauge(occupancy, entered, remaining);
    renderSectors(report);
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

  function scheduleNext() {
    if (state.finalized) return;
    setTimeout(poll, state.pollIntervalMs);
  }

  function dataUrl() {
    if (state.slug) {
      return '/api/data/' + encodeURIComponent(state.slug);
    }
    return '/api/data';
  }

  function poll() {
    fetch(dataUrl(), { cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) {
            throw new Error((body && body.error) || ('HTTP ' + res.status));
          }
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
