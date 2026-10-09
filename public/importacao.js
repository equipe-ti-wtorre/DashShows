'use strict';

const $ = (sel) => document.querySelector(sel);
const state = { versoes: null, paused: false, timer: null, opcoes: [] };

function fmt(n) {
  if (n == null || n === '') return '—';
  return Number(n).toLocaleString('pt-BR');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function setConn(ok, text) {
  const el = $('#conn');
  el.classList.toggle('ok', ok);
  el.classList.toggle('err', !ok);
  el.querySelector('span').textContent = text;
}

function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('#clockTime').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  $('#clockDate').textContent = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function versoesUrl() {
  const raw = new URLSearchParams(location.search).get('versoes');
  if (raw == null || raw.trim() === '') return null;
  const out = [];
  raw.split(',').forEach((item) => {
    const s = item.trim();
    if (s && !out.includes(s)) out.push(s);
  });
  return out.length ? out : null;
}

function syncUrl() {
  const q = new URLSearchParams();
  q.set('versoes', state.versoes.join(','));
  history.replaceState(null, '', '/importacao?' + q.toString());
}

function renderVersions() {
  const box = $('#versions');
  const options = state.opcoes.slice();
  state.versoes.forEach((v) => { if (!options.includes(v)) options.push(v); });
  box.innerHTML = options.map((v) => {
    const on = state.versoes.includes(v) ? ' on' : '';
    return `<button type="button" class="ver${on}" data-v="${esc(v)}">${esc(v)}</button>`;
  }).join('');
}

function levelOf(value) {
  if (value == null) return 'off';
  if (value >= 80) return 'bad';
  if (value >= 60) return 'warn';
  return 'ok';
}

function paintGauge(ringId, valId, value) {
  const ring = $(ringId);
  const p = value == null ? 0 : Math.max(0, Math.min(100, Number(value)));
  ring.style.setProperty('--p', String(p));
  ring.dataset.level = levelOf(value);
  $(valId).textContent = value == null ? '—' : `${Math.round(p)}%`;
}

function avisoCurto(erro) {
  if (!erro) return '';
  if (/permission was denied/i.test(erro)) return 'Sem permissão de leitura';
  if (/invalid object name/i.test(erro)) return 'Tabela não encontrada';
  if (/timeout/i.test(erro)) return 'Consulta demorou demais';
  return 'Consulta indisponível';
}

function setAviso(id, erro) {
  const el = $(id);
  if (!erro) {
    el.hidden = true;
    el.textContent = '';
    el.removeAttribute('title');
    return;
  }
  el.hidden = false;
  el.textContent = avisoCurto(erro);
  el.title = erro;
}

function paintKernel(value, erro) {
  const el = $('#kernelVal');
  el.textContent = fmt(value);
  el.className = 'big' + (value == null ? '' : (value >= 80 ? ' bad' : ' ok'));
  setAviso('#kernelErro', erro);
}

function paintStat(id, value, badWhenPositive) {
  const el = $(id);
  el.textContent = fmt(value);
  el.className = 'big';
  if (value == null) return;
  if (badWhenPositive && value > 0) el.classList.add('bad');
  else if (!badWhenPositive && id !== '#filaVal') el.classList.add('ok');
}

function renderBars(perfis, erro) {
  const box = $('#bars');
  const rows = Array.isArray(perfis) ? perfis : [];
  setAviso('#perfisErro', erro);
  if (!rows.length) {
    box.innerHTML = '<p class="empty">Nenhum ingresso nessas versões.</p>';
    $('#sumAtivos').textContent = '0';
    $('#sumBloq').textContent = '0';
    return;
  }
  let max = 1;
  let sumA = 0;
  let sumB = 0;
  rows.forEach((row) => {
    max = Math.max(max, Number(row.ativos) || 0, Number(row.bloqueados) || 0);
    sumA += Number(row.ativos) || 0;
    sumB += Number(row.bloqueados) || 0;
  });
  box.innerHTML = rows.map((row) => {
    const a = Number(row.ativos) || 0;
    const b = Number(row.bloqueados) || 0;
    const wa = Math.round((a / max) * 100);
    const wb = Math.round((b / max) * 100);
    return `<div class="prow">
      <div class="plabel" title="${esc(row.perfil)}">${esc(row.perfil)}</div>
      <div class="ptracks">
        <div class="ptrack"><span class="pfill ativos"><i style="width:${wa}%"></i></span><b>${fmt(a)}</b></div>
        <div class="ptrack"><span class="pfill bloq"><i style="width:${wb}%"></i></span><b>${fmt(b)}</b></div>
      </div>
    </div>`;
  }).join('');
  $('#sumAtivos').textContent = fmt(sumA);
  $('#sumBloq').textContent = fmt(sumB);
}

function apply(data) {
  state.opcoes = Array.isArray(data.opcoesVersao) && data.opcoesVersao.length ? data.opcoesVersao : state.opcoes;
  if (!state.versoes) state.versoes = (data.versoes && data.versoes.length) ? data.versoes.slice() : ['10'];
  renderVersions();
  $('#local').textContent = data.local ? `${data.local} · SiPort` : 'SiPort';
  $('#demoBadge').hidden = data.modo !== 'demo';
  const erros = data.erros || {};
  const totais = data.totais || {};
  paintKernel(data.kernel, erros.kernel);
  paintStat('#totalVal', totais.total, false);
  paintStat('#filaVal', totais.fila, false);
  paintStat('#bloqVal', totais.bloqueados, true);
  paintStat('#ativosVal', totais.ativos, false);
  setAviso('#filaErro', erros.fila);
  setAviso('#totaisErro', erros.totais);
  renderBars(data.perfis, erros.perfis);
  const host = data.host || {};
  paintGauge('#cpuRing', '#cpuVal', host.cpu);
  paintGauge('#memRing', '#memVal', host.memoria);
  $('#hostErro').textContent = host.erro || '';
  $('#pageError').hidden = true;
}

async function refresh() {
  const q = state.versoes ? `?versoes=${encodeURIComponent(state.versoes.join(','))}` : '';
  try {
    const res = await fetch('/api/siport/importacao' + q);
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    apply(data);
    setConn(true, `atualizado ${new Date().toLocaleTimeString('pt-BR')}`);
  } catch (err) {
    setConn(false, 'falha na consulta');
    $('#pageError').hidden = false;
    $('#pageError').textContent = err.message;
  }
}

function schedule() {
  clearInterval(state.timer);
  if (!state.paused) state.timer = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
}

function toggleVersao(value) {
  const has = state.versoes.includes(value);
  if (has && state.versoes.length === 1) return;
  state.versoes = has ? state.versoes.filter((v) => v !== value) : state.versoes.concat(value);
  renderVersions();
  syncUrl();
  refresh();
}

state.versoes = versoesUrl();
tickClock();
setInterval(tickClock, 1000);
$('#pause').addEventListener('click', (e) => {
  state.paused = !state.paused;
  e.currentTarget.textContent = state.paused ? 'Pausado' : 'Ao vivo';
  e.currentTarget.classList.toggle('paused', state.paused);
  schedule();
});
$('#versions').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-v]');
  if (!btn || !state.versoes) return;
  toggleVersao(btn.dataset.v);
});
refresh().then(schedule);
