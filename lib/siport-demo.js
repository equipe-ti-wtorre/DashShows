'use strict';

const fs = require('fs');
const perfis = require('./siport-perfis');

function keyOf(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatUtc(date) {
  return (
    date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate()) +
    ' ' + pad2(date.getUTCHours()) + ':' + pad2(date.getUTCMinutes()) + ':' + pad2(date.getUTCSeconds())
  );
}

function asLocalText(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number' && isFinite(value)) {
    const ms = Math.round((value - 25569) * 86400 * 1000);
    return formatUtc(new Date(ms));
  }
  const s = String(value).trim();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s);
  if (m) return m[1] + ' ' + m[2];
  const d = /^(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (d) return d[1] + ' 00:00:00';
  const br = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (br) {
    return br[3] + '-' + br[2] + '-' + br[1] + ' ' +
      (br[4] || '00') + ':' + (br[5] || '00') + ':' + (br[6] || '00');
  }
  return '';
}

function text(value) {
  if (value == null) return '';
  return String(value).trim();
}

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return isFinite(n) ? n : null;
}

function indexRow(row) {
  const out = {};
  if (!row || typeof row !== 'object') return out;
  Object.keys(row).forEach(function (key) {
    out[keyOf(key)] = row[key];
  });
  return out;
}

function pick(row, names) {
  for (let i = 0; i < names.length; i++) {
    const value = row[names[i]];
    if (value != null && String(value).trim() !== '') return value;
  }
  return '';
}

function inList(list, value) {
  const needle = text(value);
  if (!needle) return false;
  return list.some(function (item) { return text(item) === needle; });
}

function includesFold(hay, needle) {
  if (!needle) return false;
  return text(hay).toLowerCase().indexOf(String(needle).toLowerCase()) !== -1;
}

function normalizeBase(raw, index) {
  const row = indexRow(raw);
  const freedef = {};
  for (let i = 1; i <= 20; i++) {
    freedef[String(i)] = text(pick(row, ['datafreedef' + i, 'freedef' + i, 'data20freedef' + i]));
  }
  const codigo = text(pick(row, ['data20personnopn', 'personnopn', 'codigoingresso', 'cardnumber', 'codigo']));
  return {
    id: num(pick(row, ['dataautoid', 'id'])) || index + 1,
    codigo: codigo,
    versao: text(pick(row, ['data20versionvn', 'version', 'versao'])),
    validadeDe: asLocalText(pick(row, ['data20validford1', 'validfor', 'validadede', 'validadeinicio'])),
    validadeAte: asLocalText(pick(row, ['data20validtod2', 'validto', 'validadeate', 'validadefim'])),
    perfis: text(pick(row, ['stdprofiles', 'perfis', 'profiles', 'getstdprofiles'])),
    persStatus: text(pick(row, ['persstatus', 'statuspessoa'])),
    categoria: text(pick(row, ['data20namena', 'categoria', 'name'])),
    portao: text(pick(row, ['data20surnamena', 'portao', 'surname'])),
    posicao: num(pick(row, ['data20roomrn', 'posicao', 'room'])),
    tenantId: text(pick(row, ['tenantid'])),
    ident: text(pick(row, ['data20identnocn', 'ident', 'identificacao', 'identno'])),
    lockflag: text(pick(row, ['data20lockflagof', 'lockflag', 'bloqueio'])),
    setor: freedef['4'],
    codigoBarras: freedef['5'],
    freedef: freedef,
  };
}

function normalizeAcesso(raw, index) {
  const row = indexRow(raw);
  return {
    id: num(pick(row, ['id'])) || index + 1,
    hora: asLocalText(pick(row, ['uhrzeit', 'datahora', 'hora', 'datetime'])),
    catraca: text(pick(row, ['ort', 'catraca', 'ponto'])),
    codigo: text(pick(row, ['cardnumber', 'codigoingresso', 'codigo'])),
    info: text(pick(row, ['person', 'infoingresso', 'info'])),
    ticketeira: text(pick(row, ['persfield1', 'codigoticketeira', 'ticketeira'])),
    setor: text(pick(row, ['persfield5', 'freedef4', 'setor'])),
    tenantId: text(pick(row, ['tenantid'])),
    freedef1: text(pick(row, ['freedef1', 'persfield2'])),
    freedef2: text(pick(row, ['freedef2', 'persfield3'])),
    freedef3: text(pick(row, ['freedef3', 'persfield4'])),
    freedef4: text(pick(row, ['freedef4', 'persfield5'])),
    freedef5: text(pick(row, ['freedef5', 'persfield6'])),
    freddef6: text(pick(row, ['freddef6', 'persfield7'])),
    catracaRaw: pick(row, ['ort', 'catraca', 'ponto']) == null ? '' : String(pick(row, ['ort', 'catraca', 'ponto'])),
  };
}

function normalizeAlarme(raw, index) {
  const row = indexRow(raw);
  return {
    id: num(pick(row, ['id'])) || index + 1,
    hora: asLocalText(pick(row, ['uhrzeit', 'datahora', 'hora', 'datetime'])),
    catraca: text(pick(row, ['punktname', 'catraca', 'ort', 'ponto'])),
    texto: text(pick(row, ['alarmtext', 'alarme', 'texto', 'alarmetext'])),
    codigo: text(pick(row, ['cardnumber', 'codigoingresso', 'codigo'])),
  };
}

function rowsOf(node) {
  if (Array.isArray(node)) return node;
  if (node && Array.isArray(node.cols) && Array.isArray(node.rows)) {
    return node.rows.map(function (row) {
      const obj = {};
      node.cols.forEach(function (col, i) { obj[col] = row[i]; });
      return obj;
    });
  }
  return null;
}

function sheet(raw, names) {
  if (!raw || typeof raw !== 'object') return [];
  const indexed = indexRow(raw);
  for (let i = 0; i < names.length; i++) {
    const rows = rowsOf(indexed[names[i]]);
    if (rows) return rows;
  }
  return [];
}

function parseDemo(raw) {
  const root = raw && typeof raw === 'object' ? raw : {};
  return {
    base: sheet(root, ['pers', 'relatoriobasededados', 'base', 'basededados', 'ingressos']).map(normalizeBase),
    acessos: sheet(root, ['zlog', 'relatorioacessos', 'acessos', 'leituras']).map(normalizeAcesso),
    alarmes: sheet(root, ['alog', 'relatorioalarmes', 'alarmes']).map(normalizeAlarme),
  };
}

let cache = { path: '', mtime: 0, data: null };

function loadDemo(filePath) {
  const stat = fs.statSync(filePath);
  if (cache.path === filePath && cache.mtime === stat.mtimeMs && cache.data) return cache.data;
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const data = parseDemo(raw);
  cache = { path: filePath, mtime: stat.mtimeMs, data: data };
  return data;
}

function clearDemoCache() {
  cache = { path: '', mtime: 0, data: null };
}

function tenantIdsOf(cfg) {
  const filtros = cfg && cfg.filtros ? cfg.filtros : {};
  if (Array.isArray(filtros.tenantIds)) return filtros.tenantIds.map(text).filter(Boolean);
  if (filtros.tenantId) return [text(filtros.tenantId)].filter(Boolean);
  return [];
}

function zlogOk(row, cfg) {
  const fields = cfg.filtros.persField1 || [];
  const tenants = tenantIdsOf(cfg);
  if (!row.ticketeira && !row.tenantId) return true;
  if (!fields.length && !tenants.length) return true;
  const byField = fields.length && inList(fields, row.ticketeira);
  const byTenant = tenants.length && inList(tenants, row.tenantId);
  return byField || byTenant;
}

function alarmOk(row, cfg) {
  const likes = cfg.filtros.alarmesLike || [];
  const excl = cfg.filtros.catracasExcluir || [];
  if (row.texto && likes.length && !likes.some(function (item) { return includesFold(row.texto, item); })) return false;
  if (excl.some(function (item) { return includesFold(row.catraca, item); })) return false;
  return true;
}

function inWindow(hora, win) {
  return !!hora && hora >= win.ini && hora < win.fim;
}

function versionOk(row, cfg) {
  const list = cfg.filtros.versoes || [];
  if (!list.length || !row.versao) return true;
  return inList(list, row.versao);
}

function ticketValid(row, win, cfg) {
  if (!versionOk(row, cfg)) return false;
  if (!row.validadeAte || !row.validadeDe) return false;
  return row.validadeAte >= win.ini && row.validadeDe < win.fim;
}

function bucketOf(hora, ini) {
  const a = hora;
  const b = ini;
  if (!a || !b || a.length < 19 || b.length < 19) return 0;
  const da = Date.UTC(
    Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)),
    Number(a.slice(11, 13)), Number(a.slice(14, 16)), Number(a.slice(17, 19))
  );
  const db = Date.UTC(
    Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)),
    Number(b.slice(11, 13)), Number(b.slice(14, 16)), Number(b.slice(17, 19))
  );
  return Math.floor((da - db) / 60000 / 5);
}

function filteredAccess(data, cfg, win) {
  return data.acessos.filter(function (row) {
    return inWindow(row.hora, win) && zlogOk(row, cfg);
  });
}

function filteredAlarms(data, cfg, win) {
  return data.alarmes.filter(function (row) {
    return inWindow(row.hora, win) && alarmOk(row, cfg);
  });
}

function allAccess(data, win) {
  return data.acessos.filter(function (row) { return inWindow(row.hora, win); });
}

function allAlarms(data, win) {
  return data.alarmes.filter(function (row) { return inWindow(row.hora, win); });
}

function summary(data, cfg, win) {
  const acessos = filteredAccess(data, cfg, win);
  const alarmes = filteredAlarms(data, cfg, win);
  const lidosSet = {};
  let ultima = '';
  const serieL = {};
  const serieA = {};
  const porCatracaL = {};
  const porCatracaA = {};
  acessos.forEach(function (row) {
    if (row.codigo) lidosSet[row.codigo] = true;
    if (row.hora > ultima) ultima = row.hora;
    const b = bucketOf(row.hora, win.ini);
    serieL[b] = (serieL[b] || 0) + 1;
    const key = row.catraca || '—';
    if (!porCatracaL[key]) porCatracaL[key] = { catraca: key, leituras: 0, ultima: '' };
    porCatracaL[key].leituras += 1;
    if (row.hora > porCatracaL[key].ultima) porCatracaL[key].ultima = row.hora;
  });
  const cartoes = {};
  acessos.forEach(function (row) { if (row.codigo) cartoes[row.codigo] = true; });
  alarmes.forEach(function (row) {
    const b = bucketOf(row.hora, win.ini);
    serieA[b] = (serieA[b] || 0) + 1;
    const key = row.catraca || '—';
    if (!porCatracaA[key]) porCatracaA[key] = { catraca: key, alarmes: 0, ultima: '' };
    porCatracaA[key].alarmes += 1;
    if (row.hora > porCatracaA[key].ultima) porCatracaA[key].ultima = row.hora;
  });
  const textos = {};
  alarmes.forEach(function (row) {
    const t = row.texto || '';
    textos[t] = (textos[t] || 0) + 1;
  });
  let validos = 0;
  let lidos = 0;
  const setoresMap = {};
  data.base.forEach(function (row) {
    if (!ticketValid(row, win, cfg)) return;
    validos += 1;
    const leu = !!lidosSet[row.codigo];
    if (leu) lidos += 1;
    const setor = text(row.setor) || (text(row.perfis) ? ('Perfil ' + text(row.perfis)) : 'SEM SETOR');
    if (!setoresMap[setor]) setoresMap[setor] = { setor: setor, total: 0, lidos: 0 };
    setoresMap[setor].total += 1;
    if (leu) setoresMap[setor].lidos += 1;
  });
  return {
    validos: validos,
    lidos: lidos,
    passagens: acessos.length,
    cartoes: Object.keys(cartoes).length,
    ultima: ultima,
    alarmes: alarmes.length,
    setores: Object.keys(setoresMap).map(function (key) { return setoresMap[key]; }),
    catracasLeituras: Object.keys(porCatracaL).map(function (key) { return porCatracaL[key]; }),
    catracasAlarmes: Object.keys(porCatracaA).map(function (key) { return porCatracaA[key]; }),
    serieLeituras: Object.keys(serieL).map(function (key) { return { bucket: Number(key), n: serieL[key] }; }),
    serieAlarmes: Object.keys(serieA).map(function (key) { return { bucket: Number(key), n: serieA[key] }; }),
    textosAlarme: Object.keys(textos).map(function (key) { return { texto: key, n: textos[key] }; }),
  };
}

function sortDesc(rows) {
  return rows.slice().sort(function (a, b) {
    if (a.id !== b.id) return b.id - a.id;
    return a.hora < b.hora ? 1 : -1;
  });
}

function leituraPublic(row) {
  return {
    id: row.id,
    hora: row.hora,
    catraca: row.catraca,
    codigo: row.codigo,
    info: row.info,
    ticketeira: row.ticketeira,
    setor: row.setor,
  };
}

function firstLast(reads) {
  if (!reads.length) return { primeiraHora: '', primeiraCatraca: '', ultimaHora: '', ultimaCatraca: '' };
  const ordered = reads.slice().sort(function (a, b) {
    if (a.hora === b.hora) return a.id - b.id;
    return a.hora < b.hora ? -1 : 1;
  });
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  return {
    primeiraHora: first.hora,
    primeiraCatraca: first.catraca,
    ultimaHora: last.hora,
    ultimaCatraca: last.catraca,
  };
}

function readsByCard(data, win) {
  const map = {};
  allAccess(data, win).forEach(function (row) {
    if (!row.codigo) return;
    if (!map[row.codigo]) map[row.codigo] = [];
    map[row.codigo].push(row);
  });
  return map;
}

function categoriaMap(data) {
  const map = {};
  data.base.forEach(function (row) {
    if (!row.codigo || map[row.codigo] != null) return;
    if (text(row.setor)) map[row.codigo] = row.categoria || '';
    else if (text(row.perfis)) map[row.codigo] = 'Perfil ' + text(row.perfis);
    else map[row.codigo] = '';
  });
  return map;
}

function alarmePublic(row, readsMap, cats) {
  const fl = firstLast(readsMap[row.codigo] || []);
  return {
    id: row.id,
    hora: row.hora,
    catraca: row.catraca,
    texto: row.texto,
    codigo: row.codigo,
    categoria: cats[row.codigo] || '',
    primeiraHora: fl.primeiraHora,
    primeiraCatraca: fl.primeiraCatraca,
    ultimaHora: fl.ultimaHora,
    ultimaCatraca: fl.ultimaCatraca,
  };
}

function feed(data, cfg, win, limit) {
  const acessos = sortDesc(filteredAccess(data, cfg, win)).slice(0, limit).map(leituraPublic);
  const readsMap = readsByCard(data, win);
  const cats = categoriaMap(data);
  const alarmes = sortDesc(filteredAlarms(data, cfg, win)).slice(0, limit).map(function (row) {
    return alarmePublic(row, readsMap, cats);
  });
  return { leituras: acessos, alarmes: alarmes };
}

function likeFold(hay, needle) {
  if (!needle) return true;
  return text(hay).toLowerCase().indexOf(String(needle).toLowerCase()) !== -1;
}

function setorCombina(row, setor) {
  if (!setor) return true;
  const valor = text(row.setor);
  if (setor === 'CAMAROTES' && /^camarote/i.test(valor)) return true;
  if (setor === 'LOUNGES' && /^lounge/i.test(valor)) return true;
  return likeFold(valor, setor);
}

function alarms(data, cfg, win, filtro) {
  const readsMap = readsByCard(data, win);
  const cats = categoriaMap(data);
  return sortDesc(filteredAlarms(data, cfg, win)).filter(function (row) {
    if (filtro.catraca && !likeFold(row.catraca, filtro.catraca)) return false;
    if (filtro.codigo && !likeFold(row.codigo, filtro.codigo)) return false;
    return true;
  }).slice(0, filtro.limit).map(function (row) {
    return alarmePublic(row, readsMap, cats);
  });
}

function reads(data, cfg, win, filtro) {
  return sortDesc(filteredAccess(data, cfg, win)).filter(function (row) {
    if (filtro.catraca && !likeFold(row.catraca, filtro.catraca)) return false;
    if (filtro.codigo && !likeFold(row.codigo, filtro.codigo)) return false;
    if (!setorCombina(row, filtro.setor)) return false;
    return true;
  }).slice(0, filtro.limit).map(leituraPublic);
}

function cardFromBarcode(q) {
  if (q.length !== 24) return '';
  return q.substring(1, 15);
}

function findIds(data, q) {
  const exact = [];
  data.base.forEach(function (row) {
    if (row.codigo === q || row.codigoBarras === q) exact.push(row);
  });
  if (exact.length) return exact.slice(0, 20);
  if (q.length === 24) {
    const card = cardFromBarcode(q);
    const byCard = data.base.filter(function (row) { return row.codigo === card; });
    if (byCard.length) return byCard.slice(0, 20);
  }
  if (q.length >= 6 && q.length <= 13) {
    return data.base.filter(function (row) { return row.codigo.indexOf(q) === 0; }).slice(0, 20);
  }
  return [];
}

function search(data, win, q) {
  const cadastros = findIds(data, q);
  const codes = {};
  cadastros.forEach(function (row) { codes[row.codigo] = true; });
  const leituras = allAccess(data, win).filter(function (row) { return codes[row.codigo]; })
    .sort(function (a, b) { return a.hora < b.hora ? -1 : 1; })
    .map(leituraPublic);
  const alarmes = allAlarms(data, win).filter(function (row) { return codes[row.codigo]; })
    .sort(function (a, b) { return a.hora < b.hora ? -1 : 1; })
    .map(function (row) {
      return {
        id: row.id,
        hora: row.hora,
        catraca: row.catraca,
        texto: row.texto,
        codigo: row.codigo,
      };
    });
  const card = cardFromBarcode(q);
  const avulsoLeituras = allAccess(data, win).filter(function (row) {
    return row.codigo === q || (card && row.codigo === card);
  }).map(leituraPublic);
  const avulsoAlarmes = allAlarms(data, win).filter(function (row) {
    return row.codigo === q || (card && row.codigo === card) || includesFold(row.texto, q);
  }).map(function (row) {
    return {
      id: row.id,
      hora: row.hora,
      catraca: row.catraca,
      texto: row.texto,
      codigo: row.codigo,
    };
  });
  return {
    cadastros: cadastros,
    leituras: leituras,
    alarmes: alarmes,
    avulsoLeituras: avulsoLeituras,
    avulsoAlarmes: avulsoAlarmes,
  };
}

function importacao(data, versions) {
  const want = {};
  (versions || []).forEach(function (item) { want[text(item)] = true; });
  const map = {};
  let total = 0;
  let bloqueados = 0;
  let ativos = 0;
  (data.base || []).forEach(function (row) {
    if (!want[text(row.versao)]) return;
    total += 1;
    const locked = text(row.lockflag) !== '';
    if (locked) bloqueados += 1;
    else ativos += 1;
    const perfil = text(row.perfis) || 'SEM PROFILE';
    if (!map[perfil]) map[perfil] = { perfil: perfil, ativos: 0, bloqueados: 0 };
    map[perfil].ativos += 1;
    if (locked) map[perfil].bloqueados += 1;
  });
  const perfis = Object.keys(map).map(function (key) { return map[key]; });
  perfis.sort(function (a, b) {
    return b.ativos - a.ativos || String(a.perfil).localeCompare(String(b.perfil));
  });
  return {
    kernel: 0,
    totais: { total: total, fila: 0, bloqueados: bloqueados, ativos: ativos },
    perfis: perfis,
    erros: { kernel: null, fila: null, totais: null, perfis: null },
  };
}

function cmpTickets(a, b, ordem) {
  if (ordem === 'setor') {
    const s = text(a.setor).localeCompare(text(b.setor), 'pt');
    if (s) return s;
    return text(a.codigo).localeCompare(text(b.codigo));
  }
  if (ordem === 'leitura') {
    const al = a.primeira ? 0 : 1;
    const bl = b.primeira ? 0 : 1;
    if (al !== bl) return al - bl;
    if (a.primeira !== b.primeira) return a.primeira < b.primeira ? 1 : -1;
    return text(a.codigo).localeCompare(text(b.codigo));
  }
  if (ordem === 'naolidos') {
    const al = a.primeira ? 1 : 0;
    const bl = b.primeira ? 1 : 0;
    if (al !== bl) return al - bl;
    const s = text(a.setor).localeCompare(text(b.setor), 'pt');
    if (s) return s;
    return text(a.codigo).localeCompare(text(b.codigo));
  }
  return text(a.codigo).localeCompare(text(b.codigo));
}

function leituraDoCartao(data, win, cfg) {
  const filtrados = filteredAccess(data, cfg, win);
  const todos = allAccess(data, win);
  const lidos = {};
  filtrados.forEach(function (row) {
    if (!row.codigo) return;
    if (!lidos[row.codigo]) lidos[row.codigo] = { primeira: row.hora, ultima: row.hora, n: 0 };
    const item = lidos[row.codigo];
    item.n += 1;
    if (row.hora < item.primeira) item.primeira = row.hora;
    if (row.hora > item.ultima) item.ultima = row.hora;
  });
  const cat = {};
  todos.forEach(function (row) {
    if (!row.codigo) return;
    const prev = cat[row.codigo];
    if (!prev || row.hora < prev.hora || (row.hora === prev.hora && row.id < prev.id)) cat[row.codigo] = row;
  });
  return { lidos: lidos, cat: cat };
}

function tickets(data, cfg, win, filtro) {
  const idx = leituraDoCartao(data, win, cfg);
  const items = [];
  (data.base || []).forEach(function (row) {
    if (!ticketValid(row, win, cfg)) return;
    if (filtro.versao && text(row.versao) !== text(filtro.versao)) return;
    if (filtro.codigo) {
      const q = String(filtro.codigo).toLowerCase();
      const ok = text(row.codigo).toLowerCase().indexOf(q) !== -1 || text(row.codigoBarras).toLowerCase().indexOf(q) !== -1;
      if (!ok) return;
    }
    if (!perfis.ticketCasaSetor(row.setor, row.perfis, filtro.setor, cfg.perfisSetor)) return;
    const leu = idx.lidos[row.codigo];
    if (filtro.status === 'lidos' && !leu) return;
    if (filtro.status === 'naolidos' && leu) return;
    const primeira = idx.cat[row.codigo];
    items.push({
      codigo: row.codigo,
      versao: text(row.versao),
      codigoBarras: row.codigoBarras || '',
      ident: row.ident || '',
      setor: row.setor || '',
      categoria: row.categoria || '',
      portao: row.portao || '',
      perfis: row.perfis || '',
      validoDe: row.validadeDe || '',
      validoAte: row.validadeAte || '',
      leituras: leu ? leu.n : 0,
      primeira: leu ? leu.primeira : '',
      primeiraCatraca: primeira ? primeira.catraca : '',
      ultima: leu ? leu.ultima : '',
    });
  });
  items.sort(function (a, b) { return cmpTickets(a, b, filtro.ordem); });
  const lidosN = items.reduce(function (n, row) { return n + (row.primeira ? 1 : 0); }, 0);
  const offset = filtro.offset || 0;
  const limit = filtro.limit || 500;
  return { total: items.length, lidos: lidosN, rows: items.slice(offset, offset + limit) };
}

function numOrText(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value;
  if (/^-?\d+$/.test(String(value).trim())) return Number(value);
  return value;
}

function relatorio(data, cfg, win) {
  const base = [];
  (data.base || []).forEach(function (row) {
    if (!ticketValid(row, win, cfg)) return;
    const o = {
      DATA_20_Person_no_PN: row.codigo,
      DATA_20_Version_VN: numOrText(row.versao),
      DATA_20_Validfor_D1: row.validadeDe,
      DATA_20_Validto_D2: row.validadeAte,
      STD_PROFILES: row.perfis,
      PersStatus: numOrText(row.persStatus),
      DATA_20_Name_NA: row.categoria,
      DATA_20_Surname_NA: row.portao,
      DATA_20_Room_RN: row.posicao,
    };
    for (let i = 1; i <= 20; i++) {
      const value = row.freedef && row.freedef[String(i)];
      o['DATA_FREEDEF' + i] = value ? value : null;
    }
    o.Expr2 = numOrText(row.tenantId);
    o.DATA_20_Ident_no_CN = row.ident;
    base.push(o);
  });
  const alarmes = filteredAlarms(data, cfg, win).slice().sort(function (a, b) {
    if (a.hora !== b.hora) return a.hora < b.hora ? 1 : -1;
    return b.id - a.id;
  }).map(function (row) {
    return {
      Uhrzeit: row.hora,
      Punktname: row.catraca,
      Alarmtext: row.texto,
      CardNumber: row.codigo,
      ID: row.id,
    };
  });
  const acessos = filteredAccess(data, cfg, win).slice().sort(function (a, b) {
    if (a.hora !== b.hora) return a.hora < b.hora ? 1 : -1;
    return b.id - a.id;
  }).map(function (row) {
    return {
      Data_hora: row.hora,
      Catraca: row.catracaRaw != null && String(row.catracaRaw) !== '' ? row.catracaRaw : row.catraca,
      Info_ingresso: row.info,
      Codigo_Ingresso: row.codigo,
      Codigo_ticketeira: row.ticketeira,
      Freedef1: row.freedef1 || null,
      Freedef2: row.freedef2 || null,
      Freedef3: row.freedef3 || null,
      Freedef4: row.freedef4 || null,
      Freedef5: row.freedef5 || null,
      Freddef6: row.freddef6 || null,
      ID: row.id,
    };
  });
  return { base: base, alarmes: alarmes, acessos: acessos };
}

function diaComMaisLeituras(data) {
  const counts = {};
  data.acessos.forEach(function (row) {
    if (!row.hora || row.hora.length < 10) return;
    const day = row.hora.slice(0, 10);
    counts[day] = (counts[day] || 0) + 1;
  });
  let best = '';
  let bestN = -1;
  Object.keys(counts).forEach(function (day) {
    if (counts[day] > bestN) {
      best = day;
      bestN = counts[day];
    }
  });
  return best;
}

module.exports = {
  loadDemo: loadDemo,
  clearDemoCache: clearDemoCache,
  parseDemo: parseDemo,
  summary: summary,
  feed: feed,
  alarms: alarms,
  reads: reads,
  search: search,
  tickets: tickets,
  relatorio: relatorio,
  importacao: importacao,
  diaComMaisLeituras: diaComMaisLeituras,
};
