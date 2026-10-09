(function () {
  'use strict';

  var DEFAULT_LOGO_URL = '/logo-nubank-parque.png';

  var accessChart = null;
  var weatherChart = null;

  var el = {
    brandLogo: document.getElementById('brandLogo'),
    showSelect: document.getElementById('showSelect'),
    statusMsg: document.getElementById('statusMsg'),
    metaBar: document.getElementById('metaBar'),
    metaTitle: document.getElementById('metaTitle'),
    metaDate: document.getElementById('metaDate'),
    metaGate: document.getElementById('metaGate'),
    metaWindow: document.getElementById('metaWindow'),
    kpiGrid: document.getElementById('kpiGrid'),
    kpiEntered: document.getElementById('kpiEntered'),
    kpiCapacity: document.getElementById('kpiCapacity'),
    kpiOccupancy: document.getElementById('kpiOccupancy'),
    kpiRemaining: document.getElementById('kpiRemaining'),
    kpiPeakFlow: document.getElementById('kpiPeakFlow'),
    kpiWeatherStart: document.getElementById('kpiWeatherStart'),
    kpiWeatherStartIcon: document.getElementById('kpiWeatherStartIcon'),
    kpiWeatherStartLabel: document.getElementById('kpiWeatherStartLabel'),
    kpiWeatherEnd: document.getElementById('kpiWeatherEnd'),
    kpiWeatherEndIcon: document.getElementById('kpiWeatherEndIcon'),
    kpiWeatherEndLabel: document.getElementById('kpiWeatherEndLabel'),
    accessChart: document.getElementById('accessChart'),
    weatherChart: document.getElementById('weatherChart'),
    accessChartDesc: document.getElementById('accessChartDesc'),
    weatherChartDesc: document.getElementById('weatherChartDesc'),
    weatherChartIcon: document.getElementById('weatherChartIcon'),
    exportPdfBtn: document.getElementById('exportPdfBtn'),
  };

  var lastExportData = null;

  function setExportVisible(on) {
    if (!el.exportPdfBtn) return;
    el.exportPdfBtn.hidden = !on;
    el.exportPdfBtn.disabled = !on;
  }

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function applyTheme(theme) {
    var next = theme === 'nubank-parque' ? 'nubank-parque' : 'default';
    document.documentElement.setAttribute('data-theme', next);
    return next;
  }

  function applyLogo(url, alt) {
    if (!el.brandLogo) return;
    var src = url || DEFAULT_LOGO_URL;
    el.brandLogo.src = src;
    el.brandLogo.alt = alt || 'Logo';
    el.brandLogo.classList.toggle('is-default', !url);
  }

  function setStatus(text, isError) {
    if (!text) {
      el.statusMsg.hidden = true;
      el.statusMsg.textContent = '';
      el.statusMsg.classList.remove('is-error');
      return;
    }
    el.statusMsg.hidden = false;
    el.statusMsg.textContent = text;
    el.statusMsg.classList.toggle('is-error', !!isError);
  }

  function formatInt(n) {
    if (n == null || isNaN(n)) return '—';
    return Math.round(n).toLocaleString('pt-BR');
  }

  function formatTemp(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toFixed(1).replace('.', ',') + '°C';
  }

  function formatPrecip(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toFixed(1).replace('.', ',') + ' mm';
  }

  function weatherIconForLabel(label, precipMm) {
    var t = String(label || '').toLowerCase();
    var precip = Number(precipMm) || 0;
    if (/tempestade|trovoada|granizo/.test(t)) return '⛈️';
    if (/neve|gelo/.test(t)) return '🌨️';
    if (/pancada|chuva|garoa|chuvisco/.test(t) || precip > 0) {
      if (/leve|garoa|chuvisco/.test(t) || (precip > 0 && precip < 1)) return '🌦️';
      return '🌧️';
    }
    if (/neblina|névoa|nevoeiro/.test(t)) return '🌫️';
    if (/parcial|parcialmente/.test(t)) return '⛅';
    if (/principalmente limpo|poucas nuvens/.test(t)) return '🌤️';
    if (/limpo|céu limpo|ensolarado|claro/.test(t)) return '☀️';
    if (/nublado|nuvens/.test(t)) return '☁️';
    return '🌡️';
  }

  function weatherSubLabel(point) {
    if (!point) return 'Sem dado';
    var parts = [];
    if (point.weatherLabel) parts.push(point.weatherLabel);
    if (point.precipitationMm != null) parts.push(formatPrecip(point.precipitationMm));
    if (point.windKmh != null) parts.push(Math.round(point.windKmh) + ' km/h');
    if (parts.length) return parts.join(' · ');
    return point.recordedAt ? formatDateShort(point.recordedAt) : 'Sem dado';
  }

  function formatPct(n) {
    if (n == null || isNaN(n)) return '—';
    return String(n).replace('.', ',') + '%';
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatDateShort(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatTimeOnly(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatGate(hour, minute) {
    var h = Number(hour);
    var m = Number(minute);
    if (isNaN(h)) return '—';
    if (isNaN(m)) m = 0;
    return pad2(h) + ':' + pad2(m);
  }

  function chartColors() {
    return {
      text: cssVar('--text', '#f5f3fa'),
      dim: cssVar('--dim', '#a49eb8'),
      faint: cssVar('--faint', '#6b6580'),
      brand: cssVar('--brand', '#9b5cff'),
      gold: cssVar('--gold', '#e9b949'),
      entered: cssVar('--entered', '#37d99a'),
      grid: 'rgba(255,255,255,0.06)',
    };
  }

  function destroyCharts() {
    if (accessChart) {
      accessChart.destroy();
      accessChart = null;
    }
    if (weatherChart) {
      weatherChart.destroy();
      weatherChart = null;
    }
  }

  function toTs(iso) {
    if (!iso) return null;
    var t = new Date(iso).getTime();
    return isNaN(t) ? null : t;
  }

  function formatTickTime(ts) {
    return new Date(ts).toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatTickDateTime(ts) {
    return new Date(ts).toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).replace(',', '');
  }

  function formatTooltipTime(ts) {
    return new Date(ts).toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatDayMonth(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
    });
  }

  function formatDayMonthTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).replace(',', '');
  }

  function points(series, field) {
    return series
      .map(function (p) {
        var x = toTs(p.recordedAt);
        if (x == null) return null;
        var y = p[field];
        if (y == null || y === '') return { x: x, y: null };
        return { x: x, y: Number(y) };
      })
      .filter(Boolean);
  }

  function filterFromGate(series, gateOpenAt) {
    var gateTs = toTs(gateOpenAt);
    if (gateTs == null) return series.slice();
    return series.filter(function (p) {
      var t = toTs(p.recordedAt);
      return t != null && t >= gateTs;
    });
  }

  function seriesSpanLabel(series) {
    if (!series.length) return '';
    var a = formatDayMonth(series[0].recordedAt);
    var b = formatDayMonth(series[series.length - 1].recordedAt);
    if (!a || !b) return '';
    return a === b ? a : a + ' → ' + b;
  }

  function hexAlpha(hex, a) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6) return 'rgba(155,92,255,' + a + ')';
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function areaGradient(ctx, color) {
    var chart = ctx.chart;
    var area = chart.chartArea;
    if (!area) return hexAlpha(color, 0.28);
    var g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0, hexAlpha(color, 0.45));
    g.addColorStop(1, hexAlpha(color, 0.02));
    return g;
  }

  function gateAnnotation(gateOpenAt, colors) {
    var gateTs = toTs(gateOpenAt);
    if (gateTs == null) return {};
    return {
      gateOpen: {
        type: 'line',
        xMin: gateTs,
        xMax: gateTs,
        borderColor: colors.brand,
        borderWidth: 1.5,
        borderDash: [6, 4],
        label: {
          display: true,
          content: 'portões / público',
          position: 'start',
          backgroundColor: 'transparent',
          color: colors.brand,
          font: { size: 11, weight: '500' },
          yAdjust: -6,
        },
      },
    };
  }

  function baseChartOptions(colors, opts) {
    opts = opts || {};
    var scales = {
      x: {
        type: 'linear',
        ticks: {
          color: colors.faint,
          maxRotation: 0,
          autoSkipPadding: 16,
          maxTicksLimit: opts.maxTicksLimit || 14,
          callback: function (value) {
            return opts.xDateTime ? formatTickDateTime(value) : formatTickTime(value);
          },
        },
        grid: { display: false },
        border: { color: colors.grid },
      },
      y: {
        beginAtZero: !!opts.yBeginZero,
        ticks: {
          color: colors.faint,
          callback: opts.yTick || function (v) { return v; },
        },
        grid: { color: colors.grid },
        border: { color: colors.grid },
        title: {
          display: !!opts.yTitle,
          text: opts.yTitle || '',
          color: colors.dim,
        },
      },
    };
    if (opts.y1Title) {
      scales.y1 = {
        position: 'right',
        beginAtZero: true,
        ticks: {
          color: colors.faint,
          callback: opts.y1Tick || function (v) { return v; },
        },
        grid: { drawOnChartArea: false },
        border: { color: colors.grid },
        title: {
          display: true,
          text: opts.y1Title,
          color: colors.dim,
        },
      };
    }
    if (opts.y2Title) {
      scales.y2 = {
        position: 'right',
        beginAtZero: true,
        offset: true,
        ticks: {
          color: colors.faint,
          callback: opts.y2Tick || function (v) { return v; },
        },
        grid: { drawOnChartArea: false },
        border: { color: colors.grid },
        title: {
          display: true,
          text: opts.y2Title,
          color: colors.dim,
        },
      };
    }
    return {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            color: colors.dim,
            usePointStyle: true,
            pointStyleWidth: 8,
            boxHeight: 6,
            padding: 14,
            font: { size: 12 },
          },
        },
        tooltip: {
          callbacks: {
            title: function (items) {
              if (!items || !items.length) return '';
              return formatTooltipTime(items[0].parsed.x);
            },
          },
        },
        annotation: {
          annotations: opts.annotations || {},
        },
      },
      scales: scales,
    };
  }

  function renderAccessChart(series, show) {
    var colors = chartColors();
    var purple = colors.brand;
    var flowColor = '#3ddc97';
    var accessSeries = filterFromGate(series, show && show.gateOpenAt);

    var entered = points(accessSeries, 'totalEntered').filter(function (p) {
      return p.y != null;
    });
    var flow = points(accessSeries, 'flowPerMin').filter(function (p) {
      return p.y != null;
    });
    var hasFlow = flow.length > 0;

    // Com eixo X linear, o Chart.js costuma calcular largura ~0 para barras.
    var barThickness = 2;
    if (flow.length > 1) {
      var span = flow[flow.length - 1].x - flow[0].x;
      var avgGap = span / (flow.length - 1);
      // ~55–70% do intervalo médio, limitado para não virar um bloco sólido
      barThickness = Math.max(1, Math.min(4, Math.round(avgGap / (60 * 1000) * 2.5)));
    }

    var fromLabel = accessSeries[0]
      ? formatDayMonthTime(accessSeries[0].recordedAt)
      : '';
    if (el.accessChartDesc) {
      el.accessChartDesc.textContent =
        'Público acumulado (área) e fluxo por minuto (barras)' +
        (fromLabel ? ' — ' + fromLabel + ' até o encerramento' : '');
    }

    var datasets = [
      {
        type: 'line',
        label: 'Público acumulado',
        data: entered,
        borderColor: purple,
        backgroundColor: function (ctx) {
          return areaGradient(ctx, purple);
        },
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 2,
        yAxisID: 'y',
        order: 0,
      },
    ];
    if (hasFlow) {
      datasets.push({
        type: 'bar',
        label: 'Fluxo/min',
        data: flow,
        backgroundColor: hexAlpha(flowColor, 0.85),
        borderColor: flowColor,
        borderWidth: 0,
        borderRadius: 1,
        yAxisID: 'y1',
        // order maior = desenhado por cima da área
        order: 1,
        barThickness: barThickness,
        maxBarThickness: 5,
      });
    }

    accessChart = new Chart(el.accessChart, {
      type: 'line',
      data: { datasets: datasets },
      options: baseChartOptions(colors, {
        yTitle: 'Acumulado',
        yBeginZero: true,
        yTick: function (v) {
          return v >= 1000 ? v / 1000 + 'k' : v;
        },
        y1Title: hasFlow ? 'Fluxo/min' : null,
        maxTicksLimit: 14,
      }),
    });
  }

  function renderWeatherChart(series, show) {
    var colors = chartColors();
    var tempColor = '#ff8a5c';
    var windColor = '#5cc8ff';
    var precipColor = '#6b8cff';
    var temps = points(series, 'tempC').filter(function (p) { return p.y != null; });
    var wind = points(series, 'windKmh').filter(function (p) { return p.y != null; });
    var precip = points(series, 'precipitationMm').filter(function (p) { return p.y != null; });
    var hasWind = wind.length > 0;
    var hasTemp = temps.length > 0;
    var hasPrecip = precip.length > 0;

    var precipBarThickness = 2;
    if (precip.length > 1) {
      var spanMs = precip[precip.length - 1].x - precip[0].x;
      var avgGap = spanMs / (precip.length - 1);
      precipBarThickness = Math.max(1, Math.min(4, Math.round(avgGap / (60 * 1000) * 2.5)));
    }

    var span = seriesSpanLabel(series);
    if (el.weatherChartDesc) {
      el.weatherChartDesc.textContent =
        'Temperatura, vento e precipitação no dia do evento' +
        (span ? ' (' + span + ')' : '') +
        ' · linha tracejada = abertura de portões do show';
    }

    var datasets = [];
    if (hasPrecip) {
      datasets.push({
        type: 'bar',
        label: 'Precipitação (mm)',
        data: precip,
        backgroundColor: hexAlpha(precipColor, 0.55),
        borderColor: precipColor,
        borderWidth: 0,
        borderRadius: 1,
        yAxisID: 'y2',
        order: 0,
        barThickness: precipBarThickness,
        maxBarThickness: 5,
      });
    }
    if (hasTemp) {
      datasets.push({
        type: 'line',
        label: 'Temperatura (°C)',
        data: temps,
        borderColor: tempColor,
        backgroundColor: function (ctx) {
          return areaGradient(ctx, tempColor);
        },
        fill: true,
        stepped: 'after',
        tension: 0,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 2,
        yAxisID: 'y',
        order: 1,
      });
    }
    if (hasWind) {
      datasets.push({
        type: 'line',
        label: 'Vento (km/h)',
        data: wind,
        borderColor: windColor,
        backgroundColor: 'transparent',
        fill: false,
        stepped: 'after',
        tension: 0,
        pointRadius: 0,
        pointHoverRadius: 3,
        borderWidth: 1.75,
        borderDash: [6, 4],
        yAxisID: 'y1',
        order: 2,
      });
    }

    weatherChart = new Chart(el.weatherChart, {
      type: 'bar',
      data: { datasets: datasets },
      options: baseChartOptions(colors, {
        yTitle: '°C',
        y1Title: hasWind ? 'km/h' : null,
        y2Title: hasPrecip ? 'mm' : null,
        xDateTime: true,
        maxTicksLimit: 12,
        annotations: gateAnnotation(show && show.gateOpenAt, colors),
      }),
    });
  }

  function renderKpis(data) {
    var k = data.kpis || {};
    el.kpiEntered.textContent = formatInt(k.totalEntered);
    el.kpiCapacity.textContent =
      k.totalCapacity != null
        ? 'Capacidade ' + formatInt(k.totalCapacity)
        : 'Capacidade —';
    el.kpiOccupancy.textContent = formatPct(k.occupancyPct);
    el.kpiRemaining.textContent =
      k.totalRemaining != null
        ? formatInt(k.totalRemaining) + ' restantes'
        : '—';
    el.kpiPeakFlow.textContent =
      k.peakFlowPerMin != null ? formatInt(k.peakFlowPerMin) : '—';

    var ws = k.weatherAtStart;
    var we = k.weatherAtEnd;
    var startIcon = weatherIconForLabel(ws && ws.weatherLabel, ws && ws.precipitationMm);
    var endIcon = weatherIconForLabel(we && we.weatherLabel, we && we.precipitationMm);
    el.kpiWeatherStart.textContent = formatTemp(ws && ws.tempC);
    if (el.kpiWeatherStartIcon) el.kpiWeatherStartIcon.textContent = startIcon;
    el.kpiWeatherStartLabel.textContent = weatherSubLabel(ws);
    el.kpiWeatherEnd.textContent = formatTemp(we && we.tempC);
    if (el.kpiWeatherEndIcon) el.kpiWeatherEndIcon.textContent = endIcon;
    el.kpiWeatherEndLabel.textContent = weatherSubLabel(we);
    if (el.weatherChartIcon) el.weatherChartIcon.textContent = startIcon || endIcon || '🌤️';
  }

  function firstEntryAt(data) {
    var series = data.series || [];
    for (var i = 0; i < series.length; i++) {
      if ((series[i].totalEntered || 0) > 0) return series[i].recordedAt;
    }
    var st = data.sectorTimeline || [];
    var idx = Math.max(0, data.entryStartIndex || 0);
    if (st[idx] && st[idx].t) return st[idx].t;
    return (data.show && data.show.gateOpenAt) || (data.window && data.window.from) || null;
  }

  function renderMeta(data) {
    var s = data.show || {};
    var w = data.window || {};
    el.metaTitle.textContent = s.eventName || s.title || '—';
    el.metaDate.textContent = s.eventDate || '—';
    el.metaGate.textContent = formatGate(s.gateOpenHour, s.gateOpenMinute);
    el.metaWindow.textContent =
      formatTimeOnly(firstEntryAt(data)) + ' → ' + formatTimeOnly(w.to);
    el.metaBar.hidden = false;
    el.kpiGrid.hidden = false;
  }

  function renderCharts(data) {
    destroyCharts();
    if (typeof Chart === 'undefined') {
      setStatus('Biblioteca de gráficos não carregou. Recarregue a página.', true);
      return;
    }
    var series = data.series || [];
    if (!series.length) {
      setStatus('Sem snapshots no MySQL para a janela deste evento.', true);
      return;
    }
    setStatus('');
    renderAccessChart(series, data.show);
    renderWeatherChart(series, data.show);
  }

  function fillShowSelect(shows, selectedId) {
    el.showSelect.innerHTML = '';
    if (!shows.length) {
      var empty = document.createElement('option');
      empty.value = '';
      empty.textContent = 'Nenhum evento com histórico';
      el.showSelect.appendChild(empty);
      el.showSelect.disabled = true;
      return;
    }
    shows.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s.showId;
      var label = s.title || s.eventName || s.showId;
      if (s.eventDate) label += ' · ' + s.eventDate;
      opt.textContent = label;
      el.showSelect.appendChild(opt);
    });
    el.showSelect.disabled = false;
    if (selectedId) el.showSelect.value = selectedId;
  }

  function loadSeries(showId) {
    if (!showId) return;
    setExportVisible(false);
    lastExportData = null;
    setStatus('Carregando série histórica…');
    fetch('/api/history/' + encodeURIComponent(showId), {
      headers: { Accept: 'application/json' },
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) {
            var err = new Error((body && body.error) || 'Falha ao carregar histórico');
            err.status = res.status;
            throw err;
          }
          return body;
        });
      })
      .then(function (data) {
        applyTheme(data.theme);
        applyLogo((data.show && data.show.logoUrl) || '', (data.show && data.show.venueName) || 'Nubank Parque');
        lastExportData = data;
        renderMeta(data);
        renderKpis(data);
        renderCharts(data);
        if (typeof renderExtraCharts === 'function') renderExtraCharts(data);
        var s = data.show || {};
        var finalized = !!s.finalizedAt;
        var hasSeries = (data.series || []).length > 0;
        setExportVisible(finalized && hasSeries);
      })
      .catch(function (err) {
        destroyCharts();
        el.metaBar.hidden = true;
        el.kpiGrid.hidden = true;
        lastExportData = null;
        setExportVisible(false);
        setStatus(err.message || 'Falha ao carregar histórico', true);
      });
  }

  function buildHistoryPdf() {
    if (!window.DashShowsPdf || !lastExportData) {
      return Promise.reject(new Error('Dados do histórico indisponíveis'));
    }
    var Pdf = window.DashShowsPdf;
    var data = lastExportData;
    var s = data.show || {};
    var k = data.kpis || {};
    var w = data.window || {};
    var title = s.eventName || s.title || 'Evento';
    var datePart = s.eventDate
      ? String(s.eventDate).replace(/[^\d-]/g, '')
      : Pdf.stamp();

    var charts = [
      { title: 'Evolução dos acessos', canvas: document.getElementById('accessChart') },
      { title: 'Evolução do clima', canvas: document.getElementById('weatherChart') },
      { title: 'Evolução das entradas por setor', canvas: document.getElementById('evoChart') },
      { title: 'Entradas por setor · total', canvas: document.getElementById('sectorTotalChart') },
      { title: 'Entradas por portão', canvas: document.getElementById('gateChart') },
    ].filter(function (ch) {
      return ch.canvas && ch.canvas.width > 0;
    });

    if (!charts.length) {
      return Promise.reject(new Error('Nenhum gráfico disponível para exportar'));
    }

    return Pdf.exportHistoryDocument({
      filename: 'historico-' + Pdf.slugify(title) + '-' + datePart + '.pdf',
      title: title,
      subtitle: s.eventDate ? 'Data do evento: ' + s.eventDate : '',
      dashboardSlug: s.slug || '',
      meta: [
        { label: 'Local', value: [s.venueName, s.venueCity].filter(Boolean).join(' · ') || '—' },
        { label: 'Abertura', value: formatGate(s.gateOpenHour, s.gateOpenMinute) },
        {
          label: 'Janela',
          value: formatTimeOnly(firstEntryAt(data)) + ' → ' + formatTimeOnly(w.to),
        },
        {
          label: 'Encerrado',
          value: s.finalizedAt ? formatDateShort(s.finalizedAt) : '—',
        },
      ],
      kpis: [
        {
          label: 'Público entrante',
          value: formatInt(k.totalEntered),
          sub: k.totalCapacity != null ? 'Capacidade ' + formatInt(k.totalCapacity) : '',
        },
        {
          label: 'Ocupação',
          value: formatPct(k.occupancyPct),
          sub: k.totalRemaining != null ? formatInt(k.totalRemaining) + ' restantes' : '',
        },
        {
          label: 'Pico de fluxo',
          value: k.peakFlowPerMin != null ? formatInt(k.peakFlowPerMin) : '—',
          sub: 'por minuto',
        },
        {
          label: 'Clima ~1h antes',
          value: formatTemp(k.weatherAtStart && k.weatherAtStart.tempC),
          sub: weatherSubLabel(k.weatherAtStart),
        },
        {
          label: 'Clima no fim',
          value: formatTemp(k.weatherAtEnd && k.weatherAtEnd.tempC),
          sub: weatherSubLabel(k.weatherAtEnd),
        },
      ],
      charts: charts,
    });
  }

  function bindPdfExport() {
    if (!el.exportPdfBtn || !window.DashShowsPdf) return;
    window.DashShowsPdf.bindAsyncExportButton(el.exportPdfBtn, buildHistoryPdf);
  }

  function init() {
    setExportVisible(false);
    bindPdfExport();

    el.showSelect.addEventListener('change', function () {
      loadSeries(el.showSelect.value);
    });

    fetch('/api/history/shows', { headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) {
            var err = new Error((body && body.error) || 'Falha ao listar eventos');
            err.status = res.status;
            throw err;
          }
          return body;
        });
      })
      .then(function (data) {
        applyTheme(data.theme);
        var shows = data.shows || [];
        fillShowSelect(shows, shows[0] && shows[0].showId);
        if (!shows.length) {
          setStatus('Sem snapshots no MySQL. Ative o histórico e aguarde coletas durante o evento.', true);
          return;
        }
        loadSeries(shows[0].showId);
      })
      .catch(function (err) {
        fillShowSelect([], null);
        setExportVisible(false);
        setStatus(err.message || 'Histórico indisponível', true);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
