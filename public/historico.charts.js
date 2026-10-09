// =============================================================================
// public/historico.charts.js
// Gráficos adicionais para a página /historico já existente.
// Requisitos: Chart.js carregado + resposta de /api/history/:showId contendo
//   sectorTimeline, sectorsOrdered, sectorTotals, gateTotals, errors,
//   entryStartIndex, entered.
//
// USO: depois do fetch da API, chame:
//   renderExtraCharts(data);
// =============================================================================

const SECTOR_COLORS = ['#a259ff','#3ddc97','#5cc8ff','#ff8a5c','#ffd166',
                       '#f77fbe','#c89bff','#7dd3c0','#ff6b81','#b0a8c9'];

let _evoChart = null, _sectorTotalChart = null, _gateChart = null, _evoData = null;

function _hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function _fmt(iso, multiDay) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (!multiDay) return `${hh}:${mm}`;
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mo} ${hh}:${mm}`;
}

// ---- ponto de entrada ----
function renderExtraCharts(data) {
  if (!data || !Array.isArray(data.sectorTimeline) || !Array.isArray(data.sectorsOrdered)) {
    return;
  }
  if (typeof Chart === 'undefined') return;

  _evoData = data;
  const idx = Math.max(0, data.entryStartIndex ?? 0);
  _evoData._rows = data.sectorTimeline.slice(idx);
  _buildEvo('lines');
  _renderSectorTotal(data);
  _renderGates(data);
  _renderErrors(data);
}

// ---- 1. Evolução por setor (3 modos) ----
function _buildEvo(mode) {
  const rows = _evoData._rows;
  const secs = _evoData.sectorsOrdered;
  const evoEl = document.getElementById('evoChart');
  if (!evoEl) return;

  const multiDay = new Set(rows.map(r => r.t.slice(0, 10))).size > 1;
  const labels = rows.map(r => _fmt(r.t, multiDay));
  const stacked = (mode === 'stack' || mode === 'pct');

  const datasets = secs.map((s, i) => {
    let vals;
    if (mode === 'pct') {
      vals = rows.map(r => {
        const tot = secs.reduce((a, k) => a + (r[k] || 0), 0);
        return tot ? +(100 * (r[s] || 0) / tot).toFixed(2) : 0;
      });
    } else {
      vals = rows.map(r => r[s] || 0);
    }
    const col = SECTOR_COLORS[i] || '#a259ff';
    return {
      label: s, data: vals, borderColor: col,
      backgroundColor: stacked ? _hexA(col, 0.55) : _hexA(col, 0.08),
      fill: stacked, tension: 0.3, borderWidth: stacked ? 1 : 2,
      pointRadius: 0, pointHitRadius: 6, stack: 's',
    };
  });

  const cfg = {
    type: 'line', data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, pointStyleWidth: 8, boxHeight: 6, padding: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.parsed.y.toLocaleString('pt-BR')}${mode === 'pct' ? '%' : ''}` } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 14, maxRotation: 0 }, grid: { display: false }, stacked },
        y: {
          stacked,
          title: { display: true, text: mode === 'pct' ? '% do público' : 'Entradas acumuladas' },
          ticks: { callback: v => (mode === 'pct' ? v + '%' : (v >= 1000 ? (v / 1000) + 'k' : v)) },
          max: mode === 'pct' ? 100 : undefined,
        },
      },
    },
  };
  if (_evoChart) _evoChart.destroy();
  _evoChart = new Chart(evoEl, cfg);
}

function setSectorMode(mode) {
  ['lines', 'stack', 'pct'].forEach(m => {
    const btn = document.getElementById('evo-mode-' + m);
    if (btn) btn.classList.toggle('active', m === mode);
  });
  _buildEvo(mode);
}
window.setSectorMode = setSectorMode;

// ---- 2. Total por setor (barra horizontal, cor fixa por setor) ----
function _renderSectorTotal(data) {
  const el = document.getElementById('sectorTotalChart');
  if (!el) return;
  const names = data.sectorsOrdered;
  const vals = names.map(n => data.sectorTotals[n] || 0);
  const total = data.entered || vals.reduce((a, b) => a + b, 0);
  if (_sectorTotalChart) _sectorTotalChart.destroy();
  _sectorTotalChart = new Chart(el, {
    type: 'bar',
    data: { labels: names, datasets: [{ data: vals, backgroundColor: names.map((_, i) => SECTOR_COLORS[i] || '#a259ff'), borderRadius: 5 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${c.parsed.x.toLocaleString('pt-BR')} (${total ? (100 * c.parsed.x / total).toFixed(1) : 0}%)` } } },
      scales: { x: { ticks: { callback: v => (v >= 1000 ? (v / 1000) + 'k' : v) } }, y: { grid: { display: false } } },
    },
  });
}

// ---- 3. Entradas por portão ----
function _renderGates(data) {
  const el = document.getElementById('gateChart');
  if (!el) return;
  const entries = Object.entries(data.gateTotals || {}).sort((a, b) => b[1] - a[1]);
  if (_gateChart) _gateChart.destroy();
  _gateChart = new Chart(el, {
    type: 'bar',
    data: { labels: entries.map(e => e[0]), datasets: [{ data: entries.map(e => e[1]), backgroundColor: 'rgba(61,220,151,.7)', borderRadius: 5 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { left: 4, right: 8, top: 4, bottom: 2 } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${c.parsed.y.toLocaleString('pt-BR')} entradas` } } },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: v => (v >= 1000 ? (v / 1000) + 'k' : v) },
        },
        x: {
          grid: { display: false },
          ticks: {
            autoSkip: true,
            maxRotation: 0,
            minRotation: 0,
            font: { size: 11 },
          },
        },
      },
    },
  });
}

// ---- 4. Ocorrências de catraca (cards) ----
function _renderErrors(data) {
  const LABELS = { duplaEntrada: 'Dupla entrada', portaoErrado: 'Portão errado', naoGirou: 'Não girou', cartaoDesconhecido: 'Cartão desconhecido', supervisor: 'Supervisor', cartaoForaHorario: 'Fora de horário' };
  const el = document.getElementById('errorCards');
  if (!el) return;
  el.innerHTML = '';
  Object.entries(data.errors || {}).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    const d = document.createElement('div');
    d.className = 'errbox' + (v > 500 ? ' hot' : '');
    d.innerHTML = `<div class="n">${Number(v).toLocaleString('pt-BR')}</div><div class="l">${LABELS[k] || k}</div>`;
    el.appendChild(d);
  });
}
