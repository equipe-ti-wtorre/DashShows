// Monitor de Ingressos — front-end (JS puro, sem build).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('pt-BR');
const n = (v) => nf.format(v || 0);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

const state = { cfg: null, date: '', inicio: '', paused: false, tab: 'monitor', seenReads: new Set(), seenAlarms: new Set(), openBloco: null, alarms: [], reads: [], timer: null };

// "2026-09-13 20:45:25" -> "20:45:25" (ou "14/09 00:12:03" se for o dia seguinte)
function hora(dt, withSec = true) {
  if (!dt) return '—';
  const h = dt.slice(11, withSec ? 19 : 16);
  return dt.slice(0, 10) === state.date ? h : `${dt.slice(8, 10)}/${dt.slice(5, 7)} ${h}`;
}
function dataHora(dt) {
  return dt ? `${dt.slice(8, 10)}/${dt.slice(5, 7)}/${dt.slice(0, 4)} ${dt.slice(11, 19)}` : '—';
}
function atras(dt) {
  if (!dt) return '';
  const min = Math.round((Date.now() - new Date(dt.replace(' ', 'T'))) / 60000);
  if (min < 0 || min > 24 * 60) return '';
  return min < 1 ? 'agora' : min < 60 ? `há ${min} min` : `há ${Math.floor(min / 60)} h ${min % 60} min`;
}
const code = (c) => (c ? `<button class="code" data-code="${esc(c)}">${esc(c)}</button>` : '<span class="hint">sem código</span>');

async function api(path, params = {}) {
  const qs = new URLSearchParams({ date: state.date, inicio: state.inicio, ...params });
  const res = await fetch(`${path}?${qs}`);
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function setConn(ok, msg) {
  const el = $('#conn');
  el.className = `conn ${ok ? 'ok' : 'err'}`;
  $('span', el).textContent = msg;
}

// ====================== MONITORAMENTO ======================
function renderKpis(s) {
  const t = s.totais;
  const p = pct(t.lidos, t.emitidos);
  $('#kpis').innerHTML = `
    <div class="kpi"><span>Ingressos válidos no dia</span><b>${n(t.emitidos)}</b><small>base de dados</small></div>
    <div class="kpi accent"><span>Lidos</span><b>${n(t.lidos)}</b><small>${p}% dos ingressos</small><div class="meter"><i style="width:${p}%"></i></div></div>
    <div class="kpi"><span>Não lidos</span><b>${n(t.naoLidos)}</b><small>${pct(t.naoLidos, t.emitidos)}% ainda fora</small></div>
    <div class="kpi"><span>Passagens na catraca</span><b>${n(t.leituras)}</b><small>${n(t.cartoesLidos)} cartões distintos</small></div>
    <div class="kpi alarm"><span>Alarmes</span><b>${n(t.alarmes)}</b><small>${pct(t.alarmes, t.leituras + t.alarmes)}% das tentativas</small></div>
    <div class="kpi"><span>Última leitura</span><b>${t.ultimaLeitura ? hora(t.ultimaLeitura, false) : '—'}</b><small>${atras(t.ultimaLeitura) || '&nbsp;'}</small></div>`;
}

function renderBars(el, rows, { alarm = false } = {}) {
  if (!rows.length) { el.innerHTML = '<div class="empty">Sem dados no dia.</div>'; return; }
  const max = Math.max(...rows.map((r) => r.max));
  el.innerHTML = rows.map((r) => `
    <div class="bar-row${alarm ? ' alarm' : ''}" title="${esc(r.title || '')}">
      <span class="lbl">${esc(r.label)}</span>
      <span class="track"><i style="width:${Math.max((r.value / (alarm ? max : r.max)) * 100, r.value ? 1 : 0)}%"></i></span>
      <span class="val">${r.text}</span>
    </div>`).join('');
}

function renderChart(s) {
  const el = $('#chart');
  const reads = new Map(s.serie.leituras);
  const alarms = new Map(s.serie.alarmes);
  const keys = [...reads.keys(), ...alarms.keys()];
  if (!keys.length) { el.innerHTML = '<div class="empty">Nenhuma leitura no período.</div>'; return; }
  const b0 = Math.min(...keys);
  const b1 = Math.max(...keys, b0 + 11);
  const count = b1 - b0 + 1;
  const W = Math.max(el.clientWidth, 300);
  const H = 220;
  const padL = 40, padB = 22, padT = 8;
  const splitY = padT + (H - padT - padB) * 0.74; // leituras acima, alarmes abaixo
  const maxR = Math.max(...reads.values(), 1);
  const maxA = Math.max(...alarms.values(), 1);
  const bw = (W - padL - 4) / count;
  const x = (b) => padL + (b - b0) * bw;
  const hr = splitY - padT;
  const ha = H - padB - splitY - 4;
  const passo = s.serie.passoMin;
  const label = (b) => {
    const ini = new Date(`${s.janela.ini.replace(' ', 'T')}`);
    ini.setMinutes(ini.getMinutes() + b * passo);
    return `${String(ini.getHours()).padStart(2, '0')}:${String(ini.getMinutes()).padStart(2, '0')}`;
  };
  let bars = '';
  for (let b = b0; b <= b1; b++) {
    const r = reads.get(b) || 0;
    const a = alarms.get(b) || 0;
    const h1 = (r / maxR) * hr;
    const h2 = (a / maxA) * ha;
    bars += `<g><title>${label(b)}–${label(b + 1)}: ${n(r)} leituras, ${n(a)} alarmes</title>
      <rect x="${x(b) + 0.5}" y="${padT}" width="${Math.max(bw - 1, 1)}" height="${H - padB - padT}" fill="transparent"/>
      ${r ? `<rect x="${x(b) + 0.5}" y="${splitY - h1}" width="${Math.max(bw - 1, 1)}" height="${h1}" rx="1.5" fill="var(--read)"/>` : ''}
      ${a ? `<rect x="${x(b) + 0.5}" y="${splitY + 4}" width="${Math.max(bw - 1, 1)}" height="${h2}" rx="1.5" fill="var(--alarm)"/>` : ''}</g>`;
  }
  // marca de hora cheia
  const step = Math.max(1, Math.ceil(count / (W / 60)));
  const hourTicks = [];
  for (let b = b0; b <= b1 + 1; b++) {
    const minutos = b * passo;
    if (minutos % 60 === 0 && ((b - b0) % step === 0 || step <= 12)) hourTicks.push(b);
  }
  const ticks = (hourTicks.length ? hourTicks : [b0, b1]).map((b) => `<text x="${x(b)}" y="${H - 6}" text-anchor="middle">${label(b)}</text>`).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <g class="grid"><line x1="${padL}" x2="${W}" y1="${padT}" y2="${padT}"/><line x1="${padL}" x2="${W}" y1="${splitY}" y2="${splitY}"/></g>
    <g class="axis"><text x="${padL - 6}" y="${padT + 10}" text-anchor="end">${n(maxR)}</text><text x="${padL - 6}" y="${splitY}" text-anchor="end">0</text>
      <text x="${padL - 6}" y="${H - padB}" text-anchor="end" style="fill:var(--alarm)">${n(maxA)}</text>${ticks}</g>
    ${bars}</svg>`;
}

function renderBlocos(s) {
  const el = $('#blocos');
  if (!s.blocos.length) { el.innerHTML = '<div class="empty">Nenhuma catraca com movimento.</div>'; return; }
  const ultima = s.totais.ultimaLeitura ? new Date(s.totais.ultimaLeitura.replace(' ', 'T')) : null;
  el.innerHTML = s.blocos.map((b) => {
    const open = state.openBloco === b.bloco;
    const taxa = pct(b.alarmes, b.leituras + b.alarmes);
    // catraca parada ha +10 min enquanto as vizinhas do mesmo bloco continuam lendo
    const ts = (c) => (c.ultima ? new Date(c.ultima.replace(' ', 'T')) : 0);
    const blocoUltima = Math.max(...b.catracas.map(ts));
    const blocoAtivo = ultima && ultima - blocoUltima < 5 * 60000;
    const paradas = blocoAtivo ? b.catracas.filter((c) => c.leituras && blocoUltima - ts(c) > 10 * 60000).length : 0;
    return `<div class="bloco${open ? ' open' : ''}" data-bloco="${esc(b.bloco)}">
      <h3><span>${esc(b.bloco)}</span><span class="tag">${b.catracas.length} catracas</span></h3>
      <div class="stats"><span><b>${n(b.leituras)}</b> leituras</span><span class="al"><b>${n(b.alarmes)}</b> alarmes (${taxa}%)</span></div>
      ${paradas ? `<div class="quiet">${paradas} sem leitura há +10 min</div>` : ''}
      ${open ? `<div class="catracas">${b.catracas.map((c) => `
        <div class="catraca"><strong>${esc(c.catraca)}</strong>
          ${n(c.leituras)} leituras · <span class="al">${n(c.alarmes)} alarmes</span><br>
          <span class="hint">última ${c.ultima ? hora(c.ultima) : '—'}</span></div>`).join('')}</div>` : ''}
    </div>`;
  }).join('');
}

function renderFeeds(f) {
  const first = state.seenReads.size === 0 && state.seenAlarms.size === 0;
  $('#feedLeituras').innerHTML = f.leituras.length ? f.leituras.map((l) => {
    const isNew = !first && !state.seenReads.has(l.id);
    return `<div class="feed-item${isNew ? ' new' : ''}">
      <span class="t">${hora(l.dt)}</span>
      <div class="main"><div>${code(l.codigo)} <span class="tag accent">${esc(l.setor || '—')}</span></div>
        <div class="sub">${esc(l.info)}</div></div>
      <span class="tag">${esc(l.catraca)}</span></div>`;
  }).join('') : '<div class="empty">Nenhuma leitura.</div>';
  $('#feedAlarmes').innerHTML = f.alarmes.length ? f.alarmes.map((a) => {
    const isNew = !first && !state.seenAlarms.has(a.id);
    const r = resolucao(a);
    return `<div class="feed-item${isNew ? ' new' : ''}">
      <span class="t">${hora(a.dt)}</span>
      <div class="main"><div>${code(a.codigo)} <b>${esc(a.tipo)}</b></div>
        <div class="sub">${esc(a.categoria || 'fora da base')} · <span class="tag ${r.cls}">${r.txt}</span></div></div>
      <span class="tag">${esc(a.catraca)}</span></div>`;
  }).join('') : '<div class="empty">Nenhum alarme.</div>';
  f.leituras.forEach((l) => state.seenReads.add(l.id));
  f.alarmes.forEach((a) => state.seenAlarms.add(a.id));
}

// O ingresso entrou depois do alarme? (anti-passback normalmente ja tinha entrado antes)
function resolucao(a) {
  if (a.ultimaLeitura && a.ultimaLeitura > a.dt) return { cls: 'ok', txt: `entrou ${hora(a.ultimaLeitura, false)}`, pend: false };
  if (a.primeiraLeitura) return { cls: '', txt: `já tinha entrado ${hora(a.primeiraLeitura, false)}`, pend: false };
  return { cls: 'warn', txt: 'não entrou', pend: true };
}

async function refreshMonitor() {
  const [s, f] = await Promise.all([api('/api/siport/summary'), api('/api/siport/feed', { limit: 40 })]);
  renderKpis(s);
  $('#janelaInfo').textContent = `de ${dataHora(s.janela.ini).slice(0, 16)} até ${dataHora(s.janela.fim).slice(0, 16)}`;
  renderChart(s);
  renderBars($('#setores'), s.setores.map((r) => ({
    label: r.setor, value: r.lidos, max: r.total,
    text: `<b>${n(r.lidos)}</b> / ${n(r.total)} · ${pct(r.lidos, r.total)}%`,
  })));
  renderBars($('#tipos'), s.alarmesTipo.map((r) => ({
    label: r.tipo, value: r.n, max: r.n, text: `<b>${n(r.n)}</b> · ${pct(r.n, s.totais.alarmes)}%`,
  })), { alarm: true });
  renderBlocos(s);
  renderFeeds(f);
  state.lastSummary = s;
}

// ====================== CONSULTA ======================
function statusIngresso(t) {
  const win = state.lastWin;
  const fora = win && (t.validoAte < win.ini || t.validoDe >= win.fim);
  if (t.leituras.length) {
    const p = t.leituras[0];
    return { cls: 'ok', big: t.leituras.length > 1 ? `LIDO ${t.leituras.length}×` : 'LIDO', why: `Primeira leitura às ${hora(p.dt)} na catraca ${esc(p.catraca)}` };
  }
  if (t.alarmes.length) {
    const a = t.alarmes[t.alarmes.length - 1];
    return { cls: 'warn', big: 'NÃO LIDO', why: `Tentou entrar: ${esc(a.tipo)} às ${hora(a.dt)} na ${esc(a.catraca)}` };
  }
  if (fora) return { cls: 'bad', big: 'FORA DA VALIDADE', why: `Válido de ${dataHora(t.validoDe)} até ${dataHora(t.validoAte)}` };
  return { cls: 'muted', big: 'NÃO LIDO', why: `Nenhuma passagem nem alarme desde ${win ? hora(win.ini, false) : 'o início'}` };
}

function timeline(leituras, alarmes) {
  const ev = [
    ...leituras.map((l) => ({ dt: l.dt, al: false, t: 'Leitura OK', s: `${l.catraca}${l.setor ? ` · ${l.setor}` : ''}` })),
    ...alarmes.map((a) => ({ dt: a.dt, al: true, t: a.tipo, s: `${a.catraca} · ${a.texto}` })),
  ].sort((a, b) => a.dt.localeCompare(b.dt));
  if (!ev.length) return '<div class="empty">Sem passagens nem alarmes no período.</div>';
  return `<ul class="timeline">${ev.map((e) => `<li class="${e.al ? 'al' : ''}"><span class="t">${hora(e.dt)}</span><span class="dot"></span>
    <span class="what"><b>${esc(e.t)}</b><span>${esc(e.s)}</span></span></li>`).join('')}</ul>`;
}

function renderTicket(t) {
  const st = statusIngresso(t);
  const zona = t.zona == null ? '—' : Number(t.zona) === -1 ? 'fora (−1)' : `zona ${t.zona}`;
  const fds = Object.entries(t.freedefs || {}).map(([k, v]) => `<dt>FREEDEF${k}</dt><dd>${esc(v)}</dd>`).join('');
  return `<article class="ticket">
    <div class="ticket-status ${st.cls}"><span class="big">${st.big}</span><span class="why">${st.why}</span></div>
    <div class="ticket-body">
      <div>
        <h3>Ingresso</h3>
        <dl class="facts">
          <dt>Código do ingresso</dt><dd class="mono">${esc(t.codigo)}</dd>
          <dt>Código de barras</dt><dd class="mono">${esc(t.codigoBarras || '—')}</dd>
          <dt>Setor</dt><dd>${esc(t.setor || '—')}</dd>
          <dt>Categoria</dt><dd>${esc(t.categoria || '—')}</dd>
          <dt>Portão</dt><dd>${esc(t.portao || '—')}</dd>
          <dt>Perfis de acesso</dt><dd>${t.perfis.length ? t.perfis.map((p) => `<span class="tag accent">${esc(p)}</span>`).join(' ') : '—'}</dd>
          <dt>Validade</dt><dd>${dataHora(t.validoDe)} → ${dataHora(t.validoAte)}</dd>
          <dt>Status SiPort</dt><dd>${esc(t.status ?? '—')}</dd>
          <dt>Posição (Room)</dt><dd>${esc(zona)}</dd>
          <dt>Nº identificação</dt><dd class="mono">${esc(t.ident || '—')}</dd>
        </dl>
      </div>
      <div>
        <h3>Linha do tempo no evento</h3>
        ${timeline(t.leituras, t.alarmes)}
      </div>
    </div>
    <details class="extra"><summary>Todos os campos (versão ${esc(t.versao)}, tenant ${esc(t.tenant)})</summary><dl class="facts">${fds}</dl></details>
  </article>`;
}

async function doSearch(q) {
  const out = $('#searchOut');
  q = String(q || '').trim();
  if (!q) return;
  $('#q').value = q;
  history.replaceState(null, '', `#consulta=${encodeURIComponent(q)}`);
  out.innerHTML = '<div class="empty">Consultando…</div>';
  try {
    const r = await api('/api/siport/search', { q });
    state.lastWin = r.janela;
    let html = r.ingressos.map(renderTicket).join('');
    const av = r.avulsos;
    if (av.leituras.length || av.alarmes.length) {
      html += `<article class="ticket">
        <div class="ticket-status bad"><span class="big">NÃO CADASTRADO</span><span class="why">Código não está na base de ingressos, mas aparece nas catracas</span></div>
        <div class="ticket-body"><div><h3>Código consultado</h3><dl class="facts"><dt>Código</dt><dd class="mono">${esc(r.q)}</dd>
          ${av.leituras[0] ? `<dt>Info SiPort</dt><dd>${esc(av.leituras[0].info)}</dd><dt>Tipo (PersField1)</dt><dd>${esc(av.leituras[0].versao)}</dd>` : ''}</dl></div>
        <div><h3>Linha do tempo no evento</h3>${timeline(av.leituras, av.alarmes)}</div></div></article>`;
    }
    if (!html) html = `<div class="ticket"><div class="ticket-status muted"><span class="big">NÃO ENCONTRADO</span><span class="why">Nenhum ingresso, leitura ou alarme com “${esc(r.q)}” em ${dataHora(r.janela.ini).slice(0, 10)}</span></div></div>`;
    if (r.ingressos.length > 1) html = `<p class="hint center">${r.ingressos.length} ingressos encontrados</p>` + html;
    out.innerHTML = html;
    setConn(true, `consultado ${new Date().toLocaleTimeString('pt-BR')}`);
  } catch (err) {
    setConn(false, 'falha na consulta');
    out.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
  }
  $('#q').select();
}

// ====================== ALARMES / LEITURAS ======================
async function loadAlarms() {
  state.alarms = await api('/api/siport/alarms', { catraca: $('#aCatraca').value, codigo: $('#aCodigo').value, limit: 5000 });
  const sel = $('#aTipo');
  const cur = sel.value;
  const tipos = [...new Set(state.alarms.map((a) => a.tipo))].sort();
  sel.innerHTML = '<option value="">Todos os tipos</option>' + tipos.map((t) => `<option ${t === cur ? 'selected' : ''}>${esc(t)}</option>`).join('');
  renderAlarms();
}
function filteredAlarms() {
  const tipo = $('#aTipo').value;
  const pend = $('#aPend').checked;
  return state.alarms.filter((a) => (!tipo || a.tipo === tipo) && (!pend || resolucao(a).pend));
}
function renderAlarms() {
  const rows = filteredAlarms();
  $('#aCount').textContent = `${n(rows.length)} alarmes${state.alarms.length >= 5000 ? ' (limite de 5.000)' : ''}`;
  $('#aTable').innerHTML = `<thead><tr><th>Horário</th><th>Catraca</th><th>Tipo</th><th>Código</th><th>Categoria</th><th>Depois do alarme</th><th>Texto SiPort</th></tr></thead>
    <tbody>${rows.map((a) => {
      const r = resolucao(a);
      return `<tr><td class="n">${hora(a.dt)}</td><td>${esc(a.catraca)}</td><td>${esc(a.tipo)}</td><td>${code(a.codigo)}</td>
        <td>${esc(a.categoria || 'fora da base')}</td><td><span class="tag ${r.cls}">${r.txt}</span></td><td class="wrap hint">${esc(a.texto)}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="empty">Nenhum alarme.</td></tr>'}</tbody>`;
}

// ---------- lista de ingressos ativos (paginada no servidor) ----------
const TPAGE = 500;
state.tOffset = 0;
function ticketParams(extra = {}) {
  return { codigo: $('#tCodigo').value, setor: $('#tSetor').value, versao: $('#tVersao').value, status: $('#tStatus').value, ordem: $('#tOrdem').value, ...extra };
}
function statusTicket(t) {
  if (!t.primeiraLeitura) return '<span class="tag warn">não lido</span>';
  const vezes = t.leituras > 1 ? ` · ${t.leituras}×` : '';
  return `<span class="tag ok">lido ${hora(t.primeiraLeitura, false)}</span> <span class="hint">${esc(t.primeiraCatraca)}${vezes}</span>`;
}
async function loadTickets() {
  const r = await api('/api/siport/tickets', ticketParams({ offset: state.tOffset, limit: TPAGE }));
  if (r.total && state.tOffset >= r.total) { state.tOffset = 0; return loadTickets(); }
  state.tickets = r;
  $('#tKpis').innerHTML = `
    <div class="kpi"><span>Ingressos ativos</span><b>${n(r.total)}</b><small>com os filtros atuais</small></div>
    <div class="kpi accent"><span>Lidos</span><b>${n(r.lidos)}</b><small>${pct(r.lidos, r.total)}%</small></div>
    <div class="kpi"><span>Não lidos</span><b>${n(r.naoLidos)}</b><small>${pct(r.naoLidos, r.total)}%</small></div>`;
  $('#tTable').innerHTML = `<thead><tr><th>Código</th><th>Versão</th><th>Setor</th><th>Categoria</th><th>Portão</th><th>Perfis</th><th>Status</th><th>Última leitura</th><th>Validade</th></tr></thead>
    <tbody>${r.ingressos.map((t) => `<tr><td>${code(t.codigo)}</td><td>${esc(t.versao)}</td><td>${esc(t.setor || '—')}</td><td>${esc(t.categoria)}</td><td>${esc(t.portao)}</td>
      <td>${t.perfis.map((p) => `<span class="tag accent">${esc(p)}</span>`).join(' ')}</td><td>${statusTicket(t)}</td>
      <td class="n">${t.ultimaLeitura ? hora(t.ultimaLeitura) : '—'}</td><td class="n hint">${dataHora(t.validoAte).slice(0, 16)}</td></tr>`).join('')
      || '<tr><td colspan="9" class="empty">Nenhum ingresso ativo com esses filtros.</td></tr>'}</tbody>`;
  const ate = Math.min(state.tOffset + TPAGE, r.total);
  $('#tCount').textContent = r.total ? `${n(state.tOffset + 1)}–${n(ate)} de ${n(r.total)}` : '0 ingressos';
  $('#tPrev').disabled = state.tOffset === 0;
  $('#tNext').disabled = ate >= r.total;
  fillSetores();
}
async function fillSetores() {
  const dl = $('#tSetores');
  if (dl.dataset.for === state.date + state.inicio) return;
  try {
    const s = state.lastSummary && state.lastSummary.janela.ini === `${state.date} ${state.inicio}:00` ? state.lastSummary : await api('/api/siport/summary');
    dl.innerHTML = s.setores.map((x) => `<option value="${esc(x.setor)}">`).join('');
    dl.dataset.for = state.date + state.inicio;
  } catch { /* datalist e so conveniencia */ }
}
async function exportTickets() {
  const btn = $('#tCsv');
  btn.disabled = true;
  const rows = [];
  try {
    for (let off = 0; ; off += 5000) {
      btn.textContent = `Exportando ${n(off)}…`;
      const r = await api('/api/siport/tickets', ticketParams({ offset: off, limit: 5000 }));
      r.ingressos.forEach((t) => rows.push([t.codigo, t.versao, t.codigoBarras, t.ident, t.setor, t.categoria, t.portao, t.perfis.join(','),
        t.primeiraLeitura ? 'Lido' : 'Não lido', t.primeiraLeitura || '', t.primeiraCatraca, t.ultimaLeitura || '', t.leituras, t.validoDe, t.validoAte]));
      if (off + 5000 >= r.total) break;
    }
    csv('ingressos', ['Codigo', 'Versao', 'Codigo de barras', 'Identificacao', 'Setor', 'Categoria', 'Portao', 'Perfis', 'Status',
      'Primeira leitura', 'Catraca', 'Ultima leitura', 'Leituras', 'Valido de', 'Valido ate'], rows);
  } catch (err) {
    setConn(false, err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Exportar CSV';
  }
}

async function loadReads() {
  state.reads = await api('/api/siport/reads', { catraca: $('#rCatraca').value, setor: $('#rSetor').value, codigo: $('#rCodigo').value, limit: 5000 });
  $('#rCount').textContent = `${n(state.reads.length)} leituras${state.reads.length >= 5000 ? ' (limite de 5.000)' : ''}`;
  $('#rTable').innerHTML = `<thead><tr><th>Horário</th><th>Catraca</th><th>Código</th><th>Setor</th><th>Info do ingresso</th><th>Tipo</th></tr></thead>
    <tbody>${state.reads.map((l) => `<tr><td class="n">${hora(l.dt)}</td><td>${esc(l.catraca)}</td><td>${code(l.codigo)}</td>
      <td>${esc(l.setor)}</td><td class="wrap">${esc(l.info)}</td><td>${esc(l.versao)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nenhuma leitura.</td></tr>'}</tbody>`;
}

function csv(name, header, rows) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = [header, ...rows].map((r) => r.map(q).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' }));
  a.download = `${name}-${state.date}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ====================== CONFIGURACAO ======================
const ADMIN_KEY = 'siportAdminSenha';
function adminSenha() { try { return sessionStorage.getItem(ADMIN_KEY) || ''; } catch { return ''; } }

async function adminApi(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Senha': adminSenha() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(data.error), { auth: res.status });
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showCfgLogin(err) {
  $('#cfgForm').hidden = true;
  $('#cfgLogin').hidden = false;
  $('#cfgLoginMsg').textContent = err.message;
  // sem senha definida (403) nao adianta digitar: so na maquina do servidor
  $('.row-inline', $('#cfgLogin')).hidden = err.auth === 403;
  if (err.auth === 401) $('#cfgAdminSenha').focus();
}

function fillSettings(s) {
  const f = $('#cfgForm');
  const set = (name, v) => { const el = f.elements[name]; if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? ''; };
  const d = s.db;
  set('autenticacao', d.autenticacao); set('server', d.server); set('instanceName', d.instanceName); set('port', d.port);
  set('database', d.database); set('domain', d.domain); set('user', d.user); set('password', '');
  set('encrypt', d.encrypt); set('trustServerCertificate', d.trustServerCertificate);
  $('#pwHint').textContent = d.temSenha ? 'senha salva — deixe em branco para manter' : 'nenhuma senha salva';
  set('modo', s.modo); set('refreshS', Math.round(s.refreshMs / 1000)); set('viradaHora', s.viradaHora); set('horaInicio', s.horaInicio); set('nomeLocal', s.nomeLocal);
  f.elements.modo.querySelector('[value=demo]').disabled = !s.temDemo;
  const fl = s.filtros || {};
  set('versoes', (fl.versoes || []).join(', '));
  set('zlogPersField1', (fl.zlogPersField1 || []).join(', '));
  set('zlogTenantIds', (fl.zlogTenantIds || []).join(', '));
  set('alarmesIncluir', (fl.alarmes?.incluir || []).join(', '));
  set('alarmesExcluir', (fl.alarmes?.excluirCatracas || []).join(', '));
  const rel = s.relatorio || {};
  set('relAuto', rel.automatico); set('relHora', rel.hora); set('relPasta', rel.pasta); set('relAgenda', rel.agenda);
  set('perfisSetor', Object.entries(s.perfisSetor || {}).map(([k, v]) => `${k} = ${v}`).join('\n'));
  loadPerfisLivres();
  loadRelStatus();
  set('novaSenhaAdmin', ''); set('removerSenhaAdmin', false);
  $('.local-only', f).hidden = !s.local || !s.temSenhaAdmin;
  $('#secHint').textContent = s.temSenhaAdmin ? 'senha definida — liberada pela rede com senha' : 'sem senha — só nesta máquina';
  $('#cfgSaveMsg').textContent = s.forceDemo ? 'Servidor iniciado com --demo: a fonte de dados fica em demonstração até reiniciar sem o parâmetro.' : '';
  $('#cfgSaveMsg').className = 'hint';
  toggleAuth();
}

function toggleAuth() {
  const win = $('#cfgForm').elements.autenticacao.value === 'windows';
  $$('.win-only').forEach((el) => { el.hidden = !win; });
}

function dbForm() {
  const e = $('#cfgForm').elements;
  return {
    autenticacao: e.autenticacao.value, server: e.server.value, instanceName: e.instanceName.value, port: e.port.value,
    database: e.database.value, domain: e.domain.value, user: e.user.value, password: e.password.value,
    encrypt: e.encrypt.checked, trustServerCertificate: e.trustServerCertificate.checked,
  };
}

async function loadSettings() {
  try {
    const s = await adminApi('/api/siport/settings');
    $('#cfgLogin').hidden = true;
    $('#cfgForm').hidden = false;
    $('#cfgTestOut').innerHTML = '';
    $('#cfgTestMsg').textContent = '';
    fillSettings(s);
    setConn(true, 'configuração carregada');
  } catch (err) {
    if (err.auth) showCfgLogin(err);
    else { $('#cfgForm').hidden = true; $('#cfgLogin').hidden = false; $('#cfgLoginMsg').textContent = err.message; }
  }
}

async function testConnection() {
  const btn = $('#cfgTest');
  btn.disabled = true;
  $('#cfgTestMsg').textContent = 'Conectando…';
  $('#cfgTestOut').innerHTML = '';
  try {
    const r = await adminApi('/api/siport/settings/test', { db: dbForm() });
    $('#cfgTestMsg').textContent = '';
    if (r.erro) {
      $('#cfgTestOut').innerHTML = `<div class="test-box bad"><b>Não conectou.</b> ${esc(r.erro)}</div>`;
      return;
    }
    const checks = [
      ...r.objetos.map((o) => ({ ok: o.ok, txt: o.nome })),
      { ok: r.podeLer, txt: 'permissão de leitura (SELECT)' },
      { ok: r.podeExecutar, txt: 'permissão nas funções (EXECUTE)' },
    ];
    $('#cfgTestOut').innerHTML = `<div class="test-box ${r.ok ? 'ok' : 'bad'}">
      <b>${r.ok ? 'Conexão OK' : 'Conectou, mas falta algo'}</b> — ${esc(r.servidor || '')} / ${esc(r.banco)} como ${esc(r.usuario)}
      · SQL Server ${esc(r.versao)} · ${r.ms} ms · hora do servidor ${esc(hora(r.agora))}
      <ul class="checks">${checks.map((c) => `<li class="${c.ok ? '' : 'no'}">${esc(c.txt)}</li>`).join('')}</ul></div>`;
  } catch (err) {
    if (err.auth) showCfgLogin(err);
    else $('#cfgTestOut').innerHTML = `<div class="test-box bad">${esc(err.message)}</div>`;
    $('#cfgTestMsg').textContent = '';
  } finally {
    btn.disabled = false;
  }
}

async function saveSettings(e) {
  e.preventDefault();
  const el = $('#cfgForm').elements;
  const msg = $('#cfgSaveMsg');
  msg.className = 'hint';
  msg.textContent = 'Salvando…';
  try {
    const r = await adminApi('/api/siport/settings', {
      db: dbForm(),
      modo: el.modo.value,
      refreshMs: Number(el.refreshS.value) * 1000,
      viradaHora: el.viradaHora.value,
      horaInicio: el.horaInicio.value || '00:00',
      nomeLocal: el.nomeLocal.value,
      filtros: {
        versoes: el.versoes.value, zlogPersField1: el.zlogPersField1.value, zlogTenantIds: el.zlogTenantIds.value,
        alarmes: { incluir: el.alarmesIncluir.value, excluirCatracas: el.alarmesExcluir.value },
      },
      relatorio: {
        automatico: el.relAuto.checked, hora: el.relHora.value, pasta: el.relPasta.value, agenda: el.relAgenda.value,
      },
      novaSenhaAdmin: el.novaSenhaAdmin.value,
      removerSenhaAdmin: el.removerSenhaAdmin.checked,
      perfisSetor: el.perfisSetor.value,
    });
    // quem esta pela rede e acabou de trocar a senha continua logado com a nova
    if (el.novaSenhaAdmin.value) { try { sessionStorage.setItem(ADMIN_KEY, el.novaSenhaAdmin.value); } catch { /* sem storage */ } }
    $('#tSetores').dataset.for = ''; // nomes de setor podem ter mudado
    fillSettings(r.settings);
    await loadCfg();
    state.seenReads.clear(); state.seenAlarms.clear();
    schedule();
    msg.className = r.erro ? 'bad' : 'ok';
    msg.textContent = r.erro ? `Salvo, mas: ${r.erro}` : `Salvo às ${new Date().toLocaleTimeString('pt-BR')} — painel usando ${r.modo === 'demo' ? 'demonstração' : 'o banco'}.`;
  } catch (err) {
    if (err.auth) showCfgLogin(err);
    msg.className = 'bad';
    msg.textContent = err.message;
  }
}

// Perfis que aparecem no dia sem nome de setor: um clique acrescenta a linha para nomear.
async function loadPerfisLivres() {
  const box = $('#perfisLivres');
  try {
    const s = await api('/api/siport/summary');
    const livres = s.setores.filter((x) => /^Perfil /.test(x.setor));
    box.innerHTML = livres.length
      ? `Sem nome neste dia: ${livres.map((x) => `<button type="button" data-perfil="${esc(x.setor.slice(7))}">${esc(x.setor.slice(7))} · ${n(x.total)}</button>`).join('')}`
      : '';
  } catch { box.innerHTML = ''; }
}
function addPerfilLinha(codigo) {
  const ta = $('#cfgForm').elements.perfisSetor;
  ta.value = `${ta.value.replace(/\s+$/, '')}${ta.value.trim() ? '\n' : ''}${codigo} = `;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

async function loadRelStatus() {
  try {
    const st = await api('/api/siport/relatorio/status');
    $('#relMsg').textContent = st.gerando ? `Gerando o relatório de ${dataHora(`${st.gerando} 00:00:00`).slice(0, 10)}…` : `Show deste dia na agenda: ${st.nomeSugerido}`;
    $('#relHist').innerHTML = st.historico.map((h) => `<li><span>${dataHora(`${h.date} 00:00:00`).slice(0, 10)}</span><span>
      ${h.arquivo ? `<b>✓ ${esc(h.origem)}</b> · ${n(h.linhas?.Relatorio_BasedeDados)} ingressos, ${n(h.linhas?.['Relatorio Acessos'])} acessos, ${n(h.linhas?.['Relatorio Alarmes'])} alarmes<br><span class="path">${esc(h.arquivo)}</span>`
        : h.pulado ? `${esc(h.origem)} · pulado: ${esc(h.pulado)}` : `<b style="color:var(--bad)">✗ ${esc(h.origem)}</b> · ${esc(h.erro)}`}
      <span class="hint"> — ${esc(h.em)}</span></span></li>`).join('') || '<li><span></span><span>Nenhum relatório gerado ainda.</span></li>';
  } catch (err) {
    $('#relMsg').textContent = err.message;
  }
}

async function salvarRelatorioAgora() {
  const btn = $('#relSalvar');
  btn.disabled = true;
  $('#relMsg').textContent = `Gerando o relatório de ${dataHora(`${state.date} 00:00:00`).slice(0, 10)} a partir das ${state.inicio}… (pode levar alguns segundos)`;
  try {
    const r = await adminApi('/api/siport/relatorio/salvar', { date: state.date, inicio: state.inicio });
    $('#relMsg').textContent = r.pulado ? 'Nada para gerar: sem ingressos nem leituras nessa janela.' : `Salvo em ${r.arquivo}`;
  } catch (err) {
    if (err.auth) showCfgLogin(err);
    $('#relMsg').textContent = err.message;
  } finally {
    btn.disabled = false;
    loadRelStatus();
  }
}

function initConfig() {
  $('#perfisLivres').addEventListener('click', (e) => {
    const b = e.target.closest('[data-perfil]');
    if (b) addPerfilLinha(b.dataset.perfil);
  });
  $('#relSalvar').addEventListener('click', salvarRelatorioAgora);
  $('#cfgForm').elements.autenticacao.addEventListener('change', toggleAuth);
  $('#cfgTest').addEventListener('click', testConnection);
  $('#cfgForm').addEventListener('submit', saveSettings);
  $('#cfgLogin').addEventListener('submit', (e) => {
    e.preventDefault();
    try { sessionStorage.setItem(ADMIN_KEY, $('#cfgAdminSenha').value); } catch { /* sem storage */ }
    $('#cfgAdminSenha').value = '';
    loadSettings();
  });
}

// ====================== CICLO ======================
async function refresh() {
  try {
    if (state.tab === 'monitor') await refreshMonitor();
    else if (state.tab === 'alarmes') await loadAlarms();
    else if (state.tab === 'leituras') await loadReads();
    else if (state.tab === 'ingressos') await loadTickets();
    setConn(true, `atualizado ${new Date().toLocaleTimeString('pt-BR')}`);
  } catch (err) {
    setConn(false, 'falha na consulta');
    console.error(err);
    const link = /configur/i.test(err.message) ? ' <a href="#config">Abrir configuração</a>' : '';
    if (state.tab === 'monitor') $('#kpis').innerHTML = `<div class="error-box" style="grid-column:1/-1;margin:0">${esc(err.message)}${link}</div>`;
  }
}

function schedule() {
  clearInterval(state.timer);
  if (!state.paused) state.timer = setInterval(() => { if (!document.hidden) refresh(); }, state.cfg.refreshMs);
}

function setTab(tab) {
  state.tab = tab;
  $$('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === `tab-${tab}`));
  if (tab === 'consulta') { $('#q').focus(); $('#q').select(); } else if (!location.hash.startsWith(`#${tab}`)) history.replaceState(null, '', `#${tab}`);
  if (tab === 'config') loadSettings();
  else if (tab !== 'consulta') refresh();
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// Config publica do painel (modo, intervalo, dia padrao). Recarregada depois de salvar.
async function loadCfg() {
  const prevModo = state.cfg?.modo;
  state.cfg = await fetch('/api/siport/config').then((r) => r.json());
  if (!state.date || prevModo !== state.cfg.modo) state.date = state.cfg.defaultDate;
  // horario de inicio: padrao da configuracao, trocavel no topo (vale para esta aba)
  if (!state.inicioManual) state.inicio = state.cfg.horaInicio || '00:00';
  $('#date').value = state.date;
  $('#inicio').value = state.inicio;
  $('#local').textContent = `${state.cfg.local ? `${state.cfg.local} · ` : ''}SiPort`;
  $('#demoBadge').hidden = state.cfg.modo !== 'demo';
  const vsel = $('#tVersao');
  const vcur = vsel.value;
  vsel.innerHTML = '<option value="">Todas as versões</option>' + (state.cfg.versoes || []).map((v) => `<option value="${esc(v)}" ${v === vcur ? 'selected' : ''}>Versão ${esc(v)}</option>`).join('');
}

async function init() {
  await loadCfg();
  initConfig();

  $$('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#date').addEventListener('change', (e) => {
    state.date = e.target.value || state.cfg.defaultDate;
    state.seenReads.clear(); state.seenAlarms.clear();
    if (state.tab === 'consulta' && $('#q').value) doSearch($('#q').value); else refresh();
  });
  $('#inicio').addEventListener('change', (e) => {
    state.inicio = e.target.value || state.cfg.horaInicio || '00:00';
    state.inicioManual = state.inicio !== state.cfg.horaInicio;
    state.seenReads.clear(); state.seenAlarms.clear();
    if (state.tab === 'consulta' && $('#q').value) doSearch($('#q').value); else refresh();
  });
  $('#xlsx').addEventListener('click', (e) => {
    e.preventDefault();
    location.href = `/api/siport/relatorio.xlsx?${new URLSearchParams({ date: state.date, inicio: state.inicio })}`;
  });
  $('#pause').addEventListener('click', (e) => {
    state.paused = !state.paused;
    e.target.textContent = state.paused ? 'Pausado' : 'Ao vivo';
    e.target.classList.toggle('paused', state.paused);
    schedule();
  });
  $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); doSearch($('#q').value); });

  // qualquer codigo clicado abre a consulta do ingresso
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-code]');
    if (c) { setTab('consulta'); doSearch(c.dataset.code); return; }
    const b = e.target.closest('.bloco');
    if (b && !e.target.closest('.catracas')) {
      state.openBloco = state.openBloco === b.dataset.bloco ? null : b.dataset.bloco;
      if (state.lastSummary) renderBlocos(state.lastSummary);
    }
  });

  const reAlarms = debounce(() => loadAlarms().catch((err) => setConn(false, err.message)), 350);
  $('#aCatraca').addEventListener('input', reAlarms);
  $('#aCodigo').addEventListener('input', reAlarms);
  $('#aTipo').addEventListener('change', renderAlarms);
  $('#aPend').addEventListener('change', renderAlarms);
  $('#alarmForm').addEventListener('submit', (e) => e.preventDefault());
  $('#aCsv').addEventListener('click', () => csv('alarmes', ['Data/hora', 'Catraca', 'Tipo', 'Codigo', 'Categoria', 'Depois do alarme', 'Texto'],
    filteredAlarms().map((a) => [a.dt, a.catraca, a.tipo, a.codigo, a.categoria || '', resolucao(a).txt, a.texto])));

  const reTickets = debounce(() => { state.tOffset = 0; loadTickets().catch((err) => setConn(false, err.message)); }, 350);
  ['#tCodigo', '#tSetor'].forEach((s) => $(s).addEventListener('input', reTickets));
  ['#tVersao', '#tStatus', '#tOrdem'].forEach((s) => $(s).addEventListener('change', reTickets));
  $('#ticketForm').addEventListener('submit', (e) => e.preventDefault());
  $('#tPrev').addEventListener('click', () => { state.tOffset = Math.max(state.tOffset - TPAGE, 0); loadTickets().catch((err) => setConn(false, err.message)); });
  $('#tNext').addEventListener('click', () => { state.tOffset += TPAGE; loadTickets().catch((err) => setConn(false, err.message)); });
  $('#tCsv').addEventListener('click', exportTickets);

  const reReads = debounce(() => loadReads().catch((err) => setConn(false, err.message)), 350);
  ['#rCatraca', '#rSetor', '#rCodigo'].forEach((s) => $(s).addEventListener('input', reReads));
  $('#readForm').addEventListener('submit', (e) => e.preventDefault());
  $('#rCsv').addEventListener('click', () => csv('leituras', ['Data/hora', 'Catraca', 'Codigo', 'Setor', 'Info', 'Tipo'],
    state.reads.map((l) => [l.dt, l.catraca, l.codigo, l.setor, l.info, l.versao])));

  window.addEventListener('resize', debounce(() => state.lastSummary && renderChart(state.lastSummary), 200));

  // link direto: /#consulta=CODIGO abre a consulta daquele ingresso
  const fromHash = () => {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h.startsWith('consulta=')) {
      if (h.slice(9) !== $('#q').value || state.tab !== 'consulta') { setTab('consulta'); doSearch(h.slice(9)); }
      return true;
    }
    if (['alarmes', 'leituras', 'ingressos', 'consulta', 'monitor', 'config'].includes(h) && h !== state.tab) { setTab(h); return true; }
    return false;
  };
  window.addEventListener('hashchange', fromHash);
  if (!fromHash()) refresh();
  schedule();
}

init().catch((err) => setConn(false, err.message));
