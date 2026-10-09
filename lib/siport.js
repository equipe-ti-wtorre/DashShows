'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sql = require('mssql');
const demo = require('./siport-demo');
const queries = require('./siport-sql');
const zabbix = require('./zabbix');
const perfis = require('./siport-perfis');
const relatorio = require('./siport-relatorio');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'siport.json');

const DEFAULTS = {
  fonte: 'demo',
  intervaloSegundos: 15,
  inicioPadrao: '16:00',
  viradaHora: 6,
  local: 'Nubank Parque',
  demoArquivo: 'docs/siport-demo.json',
  db: {
    auth: 'sql',
    server: '',
    instance: '',
    port: 1433,
    database: 'SIPORTNTACC',
    domain: '',
    user: '',
    password: '',
    encrypt: false,
    trustServerCertificate: true,
  },
  admin: { salt: '', hash: '' },
  filtros: {
    versoes: ['10', '19', '14'],
    persField1: ['10', '19', '14', '25'],
    tenantIds: ['1070'],
    alarmesLike: [
      'In/Out Control',
      'Not went through',
      'obsolet',
      'wrong access level',
      'valid',
      'double',
      'unknow',
    ],
    catracasExcluir: ['B1', 'AZP', 'CCO', 'Broadcast', 'Sub', 'Data', 'BIL', 'GSH', 'NOC', 'Estoque', 'BRAVO'],
  },
  perfisSetor: {},
  relatorio: {
    automatico: true,
    hora: '23:50',
    pasta: '/var/dashshows/relatorios',
    agenda: '',
  },
  zabbix: {
    url: '',
    token: '',
    host: 'SRVAP-SIPORT01',
    cpuItem: 'CPU utilization',
    cpuTag: 'component:cpu',
    memoriaItem: 'Memory utilization',
    trustServerCertificate: true,
  },
};

const TIPO_REGRAS = [
  [/in\/out control/i, 'antipassback', 'Anti-passback (já dentro)'],
  [/wrong access level/i, 'perfil', 'Perfil sem acesso'],
  [/not went through/i, 'giro', 'Não passou (giro)'],
  [/unknow/i, 'desconhecido', 'Ingresso desconhecido'],
  [/obsolet/i, 'obsoleto', 'Ingresso obsoleto'],
  [/double/i, 'duplo', 'Acesso duplo bloqueado'],
  [/valid/i, 'validade', 'Fora da validade'],
];

let pool = null;
let poolPromise = null;
let poolKey = '';
const cache = new Map();

function pad2(n) {
  return String(n).padStart(2, '0');
}

function agoraLocal(date) {
  const d = date || new Date();
  return (
    d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
  );
}

function today() {
  return agoraLocal().slice(0, 10);
}

function addDays(iso, days) {
  const d = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function asList(value, fallback) {
  let src = value;
  if (typeof src === 'string') src = src.split(',');
  if (!Array.isArray(src)) return fallback.slice();
  const out = [];
  src.forEach(function (item) {
    const s = String(item == null ? '' : item).trim();
    if (!s || s.length > 80) return;
    out.push(s);
  });
  return out.length ? out : fallback.slice();
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function parseHm(value, fallback) {
  const parsed = parseHmStrict(value);
  return parsed || fallback;
}

function parseHmStrict(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return '';
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return '';
  return pad2(h) + ':' + pad2(min);
}

function normalizeRelatorio(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pasta = String(src.pasta == null ? '' : src.pasta).trim().slice(0, 400);
  return {
    automatico: src.automatico !== false,
    hora: parseHm(src.hora, '23:50'),
    pasta: pasta || '/var/dashshows/relatorios',
    agenda: String(src.agenda || '').trim().slice(0, 400),
  };
}

function parseDate(value, fallback) {
  const s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return fallback;
}

function viradaHoraOf(value, fallback) {
  const fb = typeof fallback === 'number' && isFinite(fallback) ? fallback : 6;
  if (value == null || value === '') return fb;
  if (typeof value === 'number' && isFinite(value)) {
    const h = Math.round(value);
    return h >= 0 && h <= 12 ? h : fb;
  }
  const s = String(value).trim();
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hm) {
    const h = Number(hm[1]);
    return h >= 0 && h <= 12 ? h : fb;
  }
  if (/^\d{1,2}$/.test(s)) {
    const h = Number(s);
    return h >= 0 && h <= 12 ? h : fb;
  }
  return fb;
}

function tenantIdsOf(filtros) {
  const src = filtros || {};
  if (src.tenantIds != null) return asList(src.tenantIds, DEFAULTS.filtros.tenantIds);
  if (src.zlogTenantIds != null) return asList(src.zlogTenantIds, DEFAULTS.filtros.tenantIds);
  if (src.tenantId != null && String(src.tenantId).trim() !== '') {
    return asList(String(src.tenantId), DEFAULTS.filtros.tenantIds);
  }
  return DEFAULTS.filtros.tenantIds.slice();
}

function forceDemoFlag() {
  return process.argv.indexOf('--demo') !== -1;
}

function effectiveFonte(cfg) {
  if (forceDemoFlag()) return 'demo';
  return cfg && cfg.fonte === 'banco' ? 'banco' : 'demo';
}

function modoOf(cfg) {
  return effectiveFonte(cfg) === 'banco' ? 'sql' : 'demo';
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function normalizeConfig(raw) {
  const base = cloneDefaults();
  const src = raw && typeof raw === 'object' ? raw : {};
  base.fonte = src.fonte === 'banco' ? 'banco' : 'demo';
  base.intervaloSegundos = clampInt(src.intervaloSegundos, 5, 300, 15);
  base.inicioPadrao = parseHm(src.inicioPadrao, '16:00');
  base.viradaHora = viradaHoraOf(src.viradaHora, 6);
  base.local = String(src.local == null ? base.local : src.local).trim().slice(0, 120);
  base.demoArquivo = cleanDemoRel(src.demoArquivo);
  const db = src.db && typeof src.db === 'object' ? src.db : {};
  base.db.auth = db.auth === 'ntlm' ? 'ntlm' : 'sql';
  base.db.server = String(db.server || '').trim().slice(0, 200);
  base.db.instance = String(db.instance || '').trim().slice(0, 80);
  base.db.port = clampInt(db.port, 1, 65535, 1433);
  base.db.database = String(db.database || 'SIPORTNTACC').trim().slice(0, 120);
  base.db.domain = String(db.domain || '').trim().slice(0, 80);
  base.db.user = String(db.user || '').trim().slice(0, 120);
  base.db.password = String(db.password || '');
  base.db.encrypt = db.encrypt === true;
  base.db.trustServerCertificate = db.trustServerCertificate !== false;
  const admin = src.admin && typeof src.admin === 'object' ? src.admin : {};
  base.admin.salt = String(admin.salt || '');
  base.admin.hash = String(admin.hash || '');
  const filtros = src.filtros && typeof src.filtros === 'object' ? src.filtros : {};
  base.filtros.versoes = asList(filtros.versoes, DEFAULTS.filtros.versoes);
  base.filtros.persField1 = asList(filtros.persField1, DEFAULTS.filtros.persField1);
  base.filtros.tenantIds = tenantIdsOf(filtros);
  base.filtros.alarmesLike = asList(filtros.alarmesLike, DEFAULTS.filtros.alarmesLike);
  base.filtros.catracasExcluir = asList(filtros.catracasExcluir, DEFAULTS.filtros.catracasExcluir);
  base.perfisSetor = perfis.normalizePerfisSetor(src.perfisSetor);
  base.relatorio = normalizeRelatorio(src.relatorio);
  base.zabbix = normalizeZabbix(src.zabbix);
  return base;
}

function normalizeZabbix(raw) {
  const z = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULTS.zabbix;
  const host = String(z.host == null || String(z.host).trim() === '' ? d.host : z.host).trim().slice(0, 120);
  const cpuItem = String(z.cpuItem == null || String(z.cpuItem).trim() === '' ? d.cpuItem : z.cpuItem).trim().slice(0, 120);
  const memoriaItem = String(z.memoriaItem == null || String(z.memoriaItem).trim() === '' ? d.memoriaItem : z.memoriaItem).trim().slice(0, 120);
  return {
    url: String(z.url || '').trim().slice(0, 400),
    token: String(z.token || ''),
    host: host || d.host,
    cpuItem: cpuItem || d.cpuItem,
    cpuTag: String(z.cpuTag == null ? d.cpuTag : z.cpuTag).trim().slice(0, 80),
    memoriaItem: memoriaItem || d.memoriaItem,
    trustServerCertificate: z.trustServerCertificate !== false,
  };
}

function readConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return cloneDefaults();
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (err) {
    const wrapped = new Error('Configuração do SiPort ilegível: ' + String(err.message || err));
    wrapped.status = 500;
    throw wrapped;
  }
}

function writeConfig(cfg) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFIG_PATH + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}

function settingsPayload(cfg, req) {
  const db = cfg.db;
  return {
    local: isLocal(clientIp(req)),
    temSenhaAdmin: !!(cfg.admin.hash && cfg.admin.salt),
    forceDemo: forceDemoFlag(),
    temDemo: temDemoArquivo(cfg),
    modo: modoOf(cfg),
    refreshMs: cfg.intervaloSegundos * 1000,
    viradaHora: cfg.viradaHora,
    horaInicio: cfg.inicioPadrao,
    nomeLocal: cfg.local,
    db: {
      server: db.server,
      instanceName: db.instance,
      port: db.port,
      database: db.database,
      autenticacao: db.auth === 'ntlm' ? 'windows' : 'sql',
      user: db.user,
      domain: db.domain,
      temSenha: !!(db.password && String(db.password).length),
      encrypt: db.encrypt === true,
      trustServerCertificate: db.trustServerCertificate !== false,
    },
    filtros: {
      versoes: cfg.filtros.versoes.slice(),
      zlogPersField1: cfg.filtros.persField1.slice(),
      zlogTenantIds: cfg.filtros.tenantIds.slice(),
      alarmes: {
        incluir: cfg.filtros.alarmesLike.slice(),
        excluirCatracas: cfg.filtros.catracasExcluir.slice(),
      },
    },
    perfisSetor: Object.assign({}, cfg.perfisSetor || {}),
    relatorio: {
      automatico: !!(cfg.relatorio && cfg.relatorio.automatico),
      hora: cfg.relatorio.hora,
      pasta: cfg.relatorio.pasta,
      agenda: cfg.relatorio.agenda,
    },
    zabbix: {
      url: cfg.zabbix.url,
      host: cfg.zabbix.host,
      cpuItem: cfg.zabbix.cpuItem,
      cpuTag: cfg.zabbix.cpuTag,
      memoriaItem: cfg.zabbix.memoriaItem,
      trustServerCertificate: cfg.zabbix.trustServerCertificate !== false,
      temToken: !!(cfg.zabbix.token && String(cfg.zabbix.token).length),
    },
  };
}

function panelConfig(cfg) {
  return {
    modo: modoOf(cfg),
    refreshMs: cfg.intervaloSegundos * 1000,
    defaultDate: diaSugerido(cfg),
    viradaHora: cfg.viradaHora,
    horaInicio: cfg.inicioPadrao,
    local: cfg.local,
    versoes: (cfg.filtros.versoes || []).slice(),
    erro: null,
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt: salt, hash: hash };
}

function checkPassword(password, salt, hash) {
  try {
    if (!password || !salt || !hash) return false;
    const got = crypto.scryptSync(String(password), String(salt), 32);
    const exp = Buffer.from(String(hash), 'hex');
    if (got.length !== exp.length) return false;
    return crypto.timingSafeEqual(got, exp);
  } catch (_) {
    return false;
  }
}

function clientIp(req) {
  const raw = (req.socket && req.socket.remoteAddress) || '';
  return raw.indexOf('::ffff:') === 0 ? raw.slice(7) : raw;
}

function isLocal(ip) {
  return ip === '127.0.0.1' || ip === '::1';
}

function authorize(req, cfg) {
  if (isLocal(clientIp(req))) return { ok: true };
  if (!cfg.admin || !cfg.admin.hash || !cfg.admin.salt) {
    return { ok: false, status: 403, erro: 'Senha de administrador não definida' };
  }
  const senha = String(req.headers['x-admin-senha'] || '');
  if (!checkPassword(senha, cfg.admin.salt, cfg.admin.hash)) {
    return { ok: false, status: 401, erro: 'Senha de administrador inválida' };
  }
  return { ok: true };
}

const ROOT = path.join(__dirname, '..');

function cleanDemoRel(value) {
  const raw = String(value || 'docs/siport-demo.json').replace(/\\/g, '/').trim();
  const rel = raw.replace(/^\/+/, '');
  if (!rel || rel.indexOf('..') !== -1 || !/\.json$/i.test(rel)) return 'docs/siport-demo.json';
  return rel.slice(0, 200);
}

function resolveDemo(rel) {
  const full = path.resolve(ROOT, cleanDemoRel(rel));
  if (full !== ROOT && full.indexOf(ROOT + path.sep) !== 0) return '';
  return full;
}

function demoPath(cfg) {
  const candidates = [
    resolveDemo(cfg && cfg.demoArquivo),
    resolveDemo('docs/siport-demo.json'),
    resolveDemo('docs/demo.json'),
    resolveDemo('data/siport-demo.json'),
  ];
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i];
  }
  return candidates[0];
}

function loadDemoData(cfg) {
  const file = demoPath(cfg);
  if (!fs.existsSync(file)) {
    const err = new Error('Arquivo de demonstração não encontrado. Confira o arquivo na configuração.');
    err.status = 503;
    throw err;
  }
  return demo.loadDemo(file);
}

function temDemoArquivo(cfg) {
  const file = demoPath(cfg);
  return !!(file && fs.existsSync(file));
}

function diaSugerido(cfg) {
  if (effectiveFonte(cfg) !== 'demo') return today();
  try {
    const best = demo.diaComMaisLeituras(loadDemoData(cfg));
    return best || today();
  } catch (_) {
    return today();
  }
}

function buildWindow(query, cfg) {
  const suggested = diaSugerido(cfg);
  const date = parseDate(query.get('date'), suggested);
  const inicio = parseHm(query.get('inicio'), cfg.inicioPadrao);
  const ini = date + ' ' + inicio + ':00';
  const fim = addDays(date, 1) + ' ' + pad2(cfg.viradaHora) + ':00:00';
  return { date: date, inicio: inicio, ini: ini, fim: fim };
}

function poolKeyOf(db) {
  return JSON.stringify({
    auth: db.auth,
    server: db.server,
    instance: db.instance,
    port: db.instance ? '' : db.port,
    database: db.database,
    domain: db.domain,
    user: db.user,
    password: db.password,
    encrypt: db.encrypt,
    trust: db.trustServerCertificate,
  });
}

function buildPoolConfig(db) {
  const cfg = {
    server: db.server,
    database: db.database || 'SIPORTNTACC',
    connectionTimeout: 8000,
    requestTimeout: 60000,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    options: {
      useUTC: false,
      encrypt: db.encrypt === true,
      trustServerCertificate: db.trustServerCertificate !== false,
      enableArithAbort: true,
      appName: 'DashShows-SiPort',
      readOnlyIntent: true,
    },
  };
  if (db.instance) {
    cfg.options.instanceName = db.instance;
  } else {
    cfg.port = Number(db.port) || 1433;
  }
  if (db.auth === 'ntlm') {
    cfg.authentication = {
      type: 'ntlm',
      options: {
        domain: db.domain || '',
        userName: db.user || '',
        password: db.password || '',
      },
    };
  } else {
    cfg.user = db.user || '';
    cfg.password = db.password || '';
  }
  return cfg;
}

function resetPool() {
  const current = pool;
  pool = null;
  poolPromise = null;
  poolKey = '';
  cache.clear();
  demo.clearDemoCache();
  zabbix.clearCache();
  if (current) current.close().catch(function () {});
}

function getPool(cfg) {
  if (!cfg.db.server) {
    const err = new Error('Servidor do SQL não configurado');
    err.status = 503;
    throw err;
  }
  const key = poolKeyOf(cfg.db);
  if (pool && poolKey === key) return Promise.resolve(pool);
  if (poolPromise && poolKey === key) return poolPromise;
  resetPool();
  poolKey = key;
  const created = new sql.ConnectionPool(buildPoolConfig(cfg.db));
  created.on('error', function () {
    if (pool === created) {
      pool = null;
      poolPromise = null;
    }
  });
  poolPromise = created.connect().then(function () {
    if (poolKey !== key) {
      created.close().catch(function () {});
      return null;
    }
    pool = created;
    return created;
  }).catch(function (err) {
    if (poolPromise && poolKey === key) {
      poolPromise = null;
      pool = null;
      poolKey = '';
    }
    created.close().catch(function () {});
    throw err;
  });
  return poolPromise;
}

function grupoSetor(name) {
  const s = String(name || '').trim();
  if (!s) return 'Sem setor';
  if (/^camarote\b/i.test(s)) return 'CAMAROTES';
  if (/^lounge\b/i.test(s)) return 'LOUNGES';
  return s;
}

function setorAgrupado(name, mapa) {
  return grupoSetor(perfis.aplicarRotulo(name, mapa));
}

function blocoDe(catraca) {
  const s = String(catraca || '').trim();
  const base = s.replace(/\s+\d+$/, '').trim();
  return base || s || 'Outras';
}

function tipoDe(texto) {
  const s = String(texto || '');
  for (let i = 0; i < TIPO_REGRAS.length; i++) {
    if (TIPO_REGRAS[i][0].test(s)) return TIPO_REGRAS[i][2];
  }
  const idx = s.indexOf(': ');
  if (idx >= 0) {
    const rest = s.slice(idx + 2).trim();
    if (rest) return rest;
  }
  return s.trim() || 'Outro';
}

function nullText(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function cmpCatraca(a, b) {
  return String(a.catraca).localeCompare(String(b.catraca), 'pt', { numeric: true, sensitivity: 'base' });
}

function byTime(a, b) {
  const ha = a.hora || a.dt || '';
  const hb = b.hora || b.dt || '';
  if (ha === hb) return (Number(a.id) || 0) - (Number(b.id) || 0);
  return ha < hb ? -1 : 1;
}

function publicLeitura(row) {
  return {
    id: row.id,
    dt: row.hora || row.dt || null,
    catraca: String(row.catraca || '').trim(),
    codigo: String(row.codigo || '').trim(),
    setor: String(row.setor || '').trim(),
    info: row.info || '',
    versao: String(row.ticketeira != null ? row.ticketeira : (row.versao || '')).trim(),
  };
}

function categoriaComRotulo(value, mapa) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.indexOf('Perfil ') === 0) return nullText(perfis.aplicarRotulo(s, mapa));
  return s;
}

function publicAlarme(row, mapa) {
  return {
    id: row.id,
    dt: row.hora || row.dt || null,
    catraca: String(row.catraca || '').trim(),
    codigo: String(row.codigo || '').trim(),
    texto: row.texto || '',
    tipo: tipoDe(row.texto),
    categoria: categoriaComRotulo(row.categoria, mapa),
    primeiraLeitura: nullText(row.primeiraHora || row.primeiraLeitura),
    ultimaLeitura: nullText(row.ultimaHora || row.ultimaLeitura),
  };
}

function janelaDe(win) {
  return { date: win.date, inicio: win.inicio, ini: win.ini, fim: win.fim };
}

function pairsOf(map) {
  return Object.keys(map).map(function (key) {
    return [Number(key), map[key]];
  }).filter(function (pair) {
    return pair[1] > 0 && pair[0] >= 0;
  }).sort(function (a, b) {
    return a[0] - b[0];
  });
}

function shapeSummary(raw, cfg, win) {
  const setoresMap = {};
  (raw.setores || []).forEach(function (row) {
    const nome = setorAgrupado(row.setor, cfg && cfg.perfisSetor);
    if (!setoresMap[nome]) setoresMap[nome] = { setor: nome, total: 0, lidos: 0 };
    setoresMap[nome].total += Number(row.total) || 0;
    setoresMap[nome].lidos += Number(row.lidos) || 0;
  });
  const setores = Object.keys(setoresMap).map(function (key) {
    return setoresMap[key];
  }).sort(function (a, b) { return b.total - a.total; });

  const catracas = {};
  (raw.catracasLeituras || []).forEach(function (row) {
    const nome = row.catraca || '—';
    if (!catracas[nome]) catracas[nome] = { catraca: nome, bloco: blocoDe(nome), leituras: 0, alarmes: 0, ultima: '' };
    catracas[nome].leituras += Number(row.leituras) || 0;
    if (row.ultima > catracas[nome].ultima) catracas[nome].ultima = row.ultima;
  });
  (raw.catracasAlarmes || []).forEach(function (row) {
    const nome = row.catraca || '—';
    if (!catracas[nome]) catracas[nome] = { catraca: nome, bloco: blocoDe(nome), leituras: 0, alarmes: 0, ultima: '' };
    catracas[nome].alarmes += Number(row.alarmes) || 0;
  });
  const blocosMap = {};
  Object.keys(catracas).forEach(function (key) {
    const row = catracas[key];
    if (!blocosMap[row.bloco]) {
      blocosMap[row.bloco] = { bloco: row.bloco, leituras: 0, alarmes: 0, catracas: [] };
    }
    blocosMap[row.bloco].leituras += row.leituras;
    blocosMap[row.bloco].alarmes += row.alarmes;
    blocosMap[row.bloco].catracas.push({
      catraca: row.catraca,
      leituras: row.leituras,
      alarmes: row.alarmes,
      ultima: row.ultima || null,
    });
  });
  const blocos = Object.keys(blocosMap).map(function (key) {
    const bloco = blocosMap[key];
    bloco.catracas.sort(cmpCatraca);
    return bloco;
  }).sort(function (a, b) { return b.leituras - a.leituras; });

  const mapL = {};
  const mapA = {};
  (raw.serieLeituras || []).forEach(function (row) {
    const b = Number(row.bucket) || 0;
    if (b < 0) return;
    mapL[b] = (mapL[b] || 0) + (Number(row.n) || 0);
  });
  (raw.serieAlarmes || []).forEach(function (row) {
    const b = Number(row.bucket) || 0;
    if (b < 0) return;
    mapA[b] = (mapA[b] || 0) + (Number(row.n) || 0);
  });

  const tiposMap = {};
  (raw.textosAlarme || []).forEach(function (row) {
    const tipo = tipoDe(row.texto);
    if (!tiposMap[tipo]) tiposMap[tipo] = { tipo: tipo, n: 0 };
    tiposMap[tipo].n += Number(row.n) || 0;
  });
  const alarmesTipo = Object.keys(tiposMap).map(function (key) { return tiposMap[key]; })
    .sort(function (a, b) { return b.n - a.n; });

  const validos = Number(raw.validos) || 0;
  const lidos = Number(raw.lidos) || 0;
  return {
    janela: janelaDe(win),
    totais: {
      emitidos: validos,
      lidos: lidos,
      naoLidos: Math.max(0, validos - lidos),
      leituras: Number(raw.passagens) || 0,
      cartoesLidos: Number(raw.cartoes) || 0,
      alarmes: Number(raw.alarmes) || 0,
      ultimaLeitura: raw.ultima || null,
    },
    setores: setores,
    blocos: blocos,
    alarmesTipo: alarmesTipo,
    serie: { passoMin: 5, leituras: pairsOf(mapL), alarmes: pairsOf(mapA) },
  };
}

function splitPerfis(value) {
  const src = Array.isArray(value) ? value : String(value || '').split(',');
  const out = [];
  src.forEach(function (item) {
    const s = String(item == null ? '' : item).trim();
    if (s) out.push(s);
  });
  return out;
}

function rawStatus(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  return value;
}

function rawTenant(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

function freedefsDe(row) {
  const src = row.freedef || row.freedefs || {};
  const out = {};
  Object.keys(src).forEach(function (key) {
    const value = src[key];
    if (value == null || String(value).trim() === '') return;
    out[String(key)] = String(value);
  });
  return out;
}

function alarmesDoIngresso(alarms, reads, categoria, mapa) {
  const primeira = reads.length ? (reads[0].hora || reads[0].dt) : null;
  const ultima = reads.length ? (reads[reads.length - 1].hora || reads[reads.length - 1].dt) : null;
  return alarms.map(function (row) {
    const pub = publicAlarme(row, mapa);
    if (!pub.categoria) pub.categoria = categoriaComRotulo(categoria, mapa);
    if (!pub.primeiraLeitura) pub.primeiraLeitura = primeira || null;
    if (!pub.ultimaLeitura) pub.ultimaLeitura = ultima || null;
    return pub;
  });
}

function setorConsulta(row, mapa) {
  const f4 = String(row.setor || '').trim();
  if (!f4) return perfis.rotulo(row.perfis, mapa);
  if (f4.indexOf('Perfil ') === 0) return perfis.aplicarRotulo(f4, mapa);
  return f4;
}

function shapeSearch(raw, win, q, cfg) {
  const mapa = cfg && cfg.perfisSetor;
  const byCodeReads = {};
  const byCodeAlarms = {};
  (raw.leituras || []).forEach(function (row) {
    const key = row.codigo || '';
    if (!byCodeReads[key]) byCodeReads[key] = [];
    byCodeReads[key].push(row);
  });
  (raw.alarmes || []).forEach(function (row) {
    const key = row.codigo || '';
    if (!byCodeAlarms[key]) byCodeAlarms[key] = [];
    byCodeAlarms[key].push(row);
  });
  const ingressos = (raw.cadastros || []).map(function (row) {
    const reads = (byCodeReads[row.codigo] || []).slice().sort(byTime);
    const alarms = (byCodeAlarms[row.codigo] || []).slice().sort(byTime);
    const semSetor = !String(row.setor || '').trim();
    const categoriaAlarme = semSetor
      ? ('Perfil ' + (Array.isArray(row.perfis) ? row.perfis.join(',') : String(row.perfis || '')))
      : row.categoria;
    return {
      codigo: row.codigo,
      ident: row.ident || '',
      versao: row.versao == null ? '' : String(row.versao),
      validoDe: nullText(row.validadeDe || row.validoDe),
      validoAte: nullText(row.validadeAte || row.validoAte),
      perfis: splitPerfis(row.perfis),
      status: rawStatus(row.persStatus != null ? row.persStatus : row.status),
      categoria: nullText(row.categoria),
      portao: nullText(row.portao),
      zona: row.posicao == null || row.posicao === '' ? (row.zona == null || row.zona === '' ? null : row.zona) : row.posicao,
      tenant: rawTenant(row.tenantId != null ? row.tenantId : row.tenant),
      setor: setorConsulta(row, mapa),
      codigoBarras: row.codigoBarras || '',
      freedefs: freedefsDe(row),
      leituras: reads.map(publicLeitura),
      alarmes: alarmesDoIngresso(alarms, reads, categoriaAlarme, mapa),
    };
  });
  let avulsos = { leituras: [], alarmes: [] };
  if (!ingressos.length) {
    const reads = (raw.avulsoLeituras || []).slice().sort(byTime);
    const alarms = (raw.avulsoAlarmes || []).slice().sort(byTime);
    avulsos = {
      leituras: reads.map(publicLeitura),
      alarmes: alarmesDoIngresso(alarms, reads, null, mapa),
    };
  }
  return {
    q: q,
    janela: janelaDe(win),
    ingressos: ingressos,
    avulsos: avulsos,
  };
}

function cacheGet(key, ttl) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttl) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value: value });
  if (cache.size > 40) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

async function withSource(cfg, win, runner) {
  if (effectiveFonte(cfg) === 'demo') {
    return runner(null, loadDemoData(cfg));
  }
  const db = await getPool(cfg);
  return runner(db, null);
}

async function runSummary(cfg, win) {
  const ttl = Math.max(1000, (cfg.intervaloSegundos * 1000) / 2);
  const key = 'summary|' + effectiveFonte(cfg) + '|' + win.ini + '|' + win.fim + '|' + JSON.stringify(cfg.perfisSetor || {});
  const hit = cacheGet(key, ttl);
  if (hit) return hit;
  const raw = await withSource(cfg, win, function (db, data) {
    if (data) return demo.summary(data, cfg, win);
    return queries.querySummary(db, cfg, win);
  });
  const shaped = shapeSummary(raw, cfg, win);
  cacheSet(key, shaped);
  return shaped;
}

async function runFeed(cfg, win, limit) {
  const ttl = Math.max(1000, (cfg.intervaloSegundos * 1000) / 2);
  const key = 'feed|' + effectiveFonte(cfg) + '|' + win.ini + '|' + win.fim + '|' + limit + '|' + JSON.stringify(cfg.perfisSetor || {});
  const hit = cacheGet(key, ttl);
  if (hit) return hit;
  const raw = await withSource(cfg, win, function (db, data) {
    if (data) return demo.feed(data, cfg, win, limit);
    return queries.queryFeed(db, cfg, win, limit);
  });
  const shaped = {
    leituras: (raw.leituras || []).map(publicLeitura),
    alarmes: (raw.alarmes || []).map(function (row) { return publicAlarme(row, cfg.perfisSetor); }),
  };
  cacheSet(key, shaped);
  return shaped;
}

async function runAlarms(cfg, win, filtro) {
  const raw = await withSource(cfg, win, function (db, data) {
    if (data) return demo.alarms(data, cfg, win, filtro);
    return queries.queryAlarms(db, cfg, win, filtro);
  });
  return (raw || []).map(function (row) { return publicAlarme(row, cfg.perfisSetor); });
}

async function runReads(cfg, win, filtro) {
  const raw = await withSource(cfg, win, function (db, data) {
    if (data) return demo.reads(data, cfg, win, filtro);
    return queries.queryReads(db, cfg, win, filtro);
  });
  return (raw || []).map(publicLeitura);
}

async function runSearch(cfg, win, q) {
  const raw = await withSource(cfg, win, function (db, data) {
    if (data) return demo.search(data, win, q);
    return queries.querySearch(db, cfg, win, q);
  });
  return shapeSearch(raw, win, q, cfg);
}

function shapeTicket(row, mapa) {
  const f4 = String(row.setor || '').trim();
  const sem = !f4;
  let setor = f4;
  if (sem) setor = perfis.rotulo(row.perfis, mapa);
  else if (f4.indexOf('Perfil ') === 0) setor = perfis.aplicarRotulo(f4, mapa);
  const leu = !!nullText(row.primeira);
  return {
    codigo: row.codigo || '',
    versao: row.versao == null ? '' : String(row.versao).trim(),
    codigoBarras: row.codigoBarras || '',
    ident: row.ident || '',
    setor: setor || '',
    categoria: sem ? '' : (row.categoria || ''),
    portao: sem ? '' : (row.portao || ''),
    perfis: splitPerfis(row.perfis),
    validoDe: nullText(row.validoDe),
    validoAte: nullText(row.validoAte),
    leituras: Number(row.leituras) || 0,
    primeiraLeitura: leu ? nullText(row.primeira) : null,
    primeiraCatraca: leu ? String(row.primeiraCatraca || '').trim() : '',
    ultimaLeitura: leu ? nullText(row.ultima) : null,
  };
}

function shapeTickets(raw, cfg, filtro) {
  const mapa = cfg.perfisSetor;
  const ingressos = (raw.rows || []).map(function (row) { return shapeTicket(row, mapa); });
  const total = Number(raw.total) || 0;
  const lidos = Number(raw.lidos) || 0;
  return {
    total: total,
    lidos: lidos,
    naoLidos: Math.max(0, total - lidos),
    offset: filtro.offset,
    limit: filtro.limit,
    ingressos: ingressos,
  };
}

async function runTickets(cfg, win, filtro) {
  const ttl = Math.max(1000, (cfg.intervaloSegundos * 1000) / 2);
  const key = [
    'tickets', effectiveFonte(cfg), win.ini, win.fim,
    filtro.codigo, filtro.setor, filtro.versao, filtro.status, filtro.ordem,
    filtro.offset, filtro.limit, JSON.stringify(cfg.perfisSetor || {}),
  ].join('|');
  const hit = cacheGet(key, ttl);
  if (hit) return hit;
  const raw = await withSource(cfg, win, function (db, data) {
    if (data) return demo.tickets(data, cfg, win, filtro);
    return queries.queryTickets(db, cfg, win, filtro);
  });
  const shaped = shapeTickets(raw, cfg, filtro);
  cacheSet(key, shaped);
  return shaped;
}

let gerando = null;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function loadRelatorioRows(cfg, win) {
  if (effectiveFonte(cfg) === 'demo') return demo.relatorio(loadDemoData(cfg), cfg, win);
  const db = await getPool(cfg);
  const base = await queries.queryRelatorioBase(db, cfg, win);
  const alarmes = await queries.queryRelatorioAlarmes(db, cfg, win);
  const acessos = await queries.queryRelatorioAcessos(db, cfg, win);
  return { base: base, alarmes: alarmes, acessos: acessos };
}

function linhasDe(rows) {
  return {
    Relatorio_BasedeDados: (rows.base || []).length,
    'Relatorio Alarmes': (rows.alarmes || []).length,
    'Relatorio Acessos': (rows.acessos || []).length,
  };
}

async function gerarSalvar(cfg, win, opts) {
  const options = opts || {};
  if (gerando) throw httpError(409, 'Já existe um relatório sendo gerado');
  gerando = win.date;
  let tmp = '';
  try {
    const rows = await loadRelatorioRows(cfg, win);
    const linhas = linhasDe(rows);
    const auto = options.origem === 'automático';
    if (auto && linhas['Relatorio Acessos'] === 0) {
      relatorio.saveEntry(win.date, {
        date: win.date,
        origem: options.origem,
        pulado: 'nenhuma leitura de catraca no dia',
        inicio: win.inicio,
        em: agoraLocal(),
      });
      return { pulado: true };
    }
    if (!auto && linhas.Relatorio_BasedeDados === 0 && linhas['Relatorio Acessos'] === 0) {
      return { pulado: true };
    }
    const show = relatorio.nomeShow(cfg.relatorio.agenda, win.date, options.nome);
    const dest = relatorio.destino(cfg.relatorio.pasta, win.date, show);
    if (!fs.existsSync(dest.dir)) fs.mkdirSync(dest.dir, { recursive: true });
    tmp = dest.tmp;
    await relatorio.escrever(tmp, rows);
    fs.renameSync(tmp, dest.arquivo);
    tmp = '';
    relatorio.saveEntry(win.date, {
      date: win.date,
      origem: options.origem || 'manual',
      arquivo: dest.arquivo,
      linhas: linhas,
      inicio: win.inicio,
      em: agoraLocal(),
    });
    return { arquivo: dest.arquivo, linhas: linhas, nome: dest.nome };
  } catch (err) {
    if (tmp) {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    if (options.origem) {
      try {
        relatorio.saveEntry(win.date, {
          date: win.date,
          origem: options.origem,
          erro: String(err && err.message || err).replace(/\s+/g, ' ').trim().slice(0, 500),
          inicio: win.inicio,
          em: agoraLocal(),
        });
      } catch (_) {}
    }
    throw err;
  } finally {
    gerando = null;
  }
}

async function gerarDownload(cfg, win, nome) {
  if (gerando) throw httpError(409, 'Já existe um relatório sendo gerado');
  gerando = win.date;
  const os = require('os');
  const tmp = path.join(os.tmpdir(), 'siport-relatorio-' + process.pid + '-' + Date.now() + '.xlsx');
  try {
    const rows = await loadRelatorioRows(cfg, win);
    await relatorio.escrever(tmp, rows);
    const show = relatorio.nomeShow(cfg.relatorio.agenda, win.date, nome);
    return { file: tmp, nome: relatorio.nomeArquivo(win.date, show), linhas: linhasDe(rows) };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  } finally {
    gerando = null;
  }
}

function statusRelatorio(cfg, date) {
  const hist = relatorio.readHistory();
  return {
    automatico: !!(cfg.relatorio && cfg.relatorio.automatico),
    hora: cfg.relatorio.hora,
    pasta: cfg.relatorio.pasta,
    agenda: cfg.relatorio.agenda,
    gerando: gerando,
    nomeSugerido: relatorio.nomeShow(cfg.relatorio.agenda, date, ''),
    historico: relatorio.historicoRecente(hist, 10),
  };
}

function janelaEvento(date, inicio, cfg) {
  return {
    date: date,
    inicio: inicio,
    ini: date + ' ' + inicio + ':00',
    fim: addDays(date, 1) + ' ' + pad2(cfg.viradaHora) + ':00:00',
  };
}

async function tickRelatorio() {
  if (gerando) return;
  let cfg;
  try { cfg = readConfig(); } catch (_) { return; }
  if (effectiveFonte(cfg) !== 'banco') return;
  if (!cfg.relatorio || cfg.relatorio.automatico === false) return;
  const parts = String(cfg.relatorio.hora || '').split(':');
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (!isFinite(hh) || !isFinite(mm)) return;
  const now = new Date();
  const eventDate = hh < cfg.viradaHora ? addDays(today(), -1) : today();
  const scheduled = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  if (now.getTime() < scheduled.getTime()) return;
  if (now.getTime() - scheduled.getTime() > 12 * 3600 * 1000) return;
  const prev = relatorio.readHistory()[eventDate];
  if (prev && (prev.arquivo || prev.pulado)) return;
  const win = janelaEvento(eventDate, cfg.inicioPadrao, cfg);
  try {
    await gerarSalvar(cfg, win, { origem: 'automático' });
  } catch (err) {
    console.error('SiPort relatório:', err && err.message || err);
  }
}

let autoTimer = null;

function startScheduler() {
  if (autoTimer) return;
  autoTimer = setInterval(function () {
    tickRelatorio().catch(function (err) {
      console.error('SiPort relatório:', err && err.message || err);
    });
  }, 60 * 1000);
  if (autoTimer.unref) autoTimer.unref();
  setTimeout(function () {
    tickRelatorio().catch(function () {});
  }, 5000).unref();
}

const VERSOES_IMPORT = ['18', '10', '14', '51', '19'];

function versoesImportacao(query) {
  const raw = query.get('versoes');
  const src = raw == null || String(raw).trim() === '' ? ['10'] : String(raw).split(',');
  const out = [];
  src.forEach(function (item) {
    const s = String(item == null ? '' : item).trim();
    if (!/^[0-9A-Za-z._-]{1,32}$/.test(s)) return;
    if (out.indexOf(s) === -1) out.push(s);
  });
  return out.length ? out : ['10'];
}

function opcoesVersao(cfg) {
  const out = [];
  VERSOES_IMPORT.concat((cfg.filtros && cfg.filtros.versoes) || []).forEach(function (item) {
    const s = String(item == null ? '' : item).trim();
    if (!s || out.indexOf(s) !== -1) return;
    out.push(s);
  });
  return out;
}

async function runImportacao(cfg, versoes) {
  const ttl = 2000;
  const key = 'importacao|' + effectiveFonte(cfg) + '|' + versoes.join(',');
  const hit = cacheGet(key, ttl);
  if (hit) return hit;
  const raw = await withSource(cfg, { ini: '', fim: '' }, function (db, data) {
    if (data) return demo.importacao(data, versoes);
    return queries.queryImportacao(db, versoes);
  });
  const host = await zabbix.hostMetrics(cfg.zabbix);
  const shaped = {
    versoes: versoes,
    opcoesVersao: opcoesVersao(cfg),
    local: cfg.local,
    kernel: raw.kernel,
    totais: raw.totais,
    perfis: raw.perfis || [],
    erros: raw.erros || { kernel: null, fila: null, totais: null, perfis: null },
    host: host,
    modo: modoOf(cfg),
  };
  cacheSet(key, shaped);
  return shaped;
}

function mergeSettings(current, body, req) {
  const next = normalizeConfig(current);
  const src = body && typeof body === 'object' ? body : {};
  if (src.modo != null) next.fonte = src.modo === 'sql' ? 'banco' : 'demo';
  else if (src.fonte != null) next.fonte = src.fonte === 'banco' ? 'banco' : 'demo';
  if (forceDemoFlag()) next.fonte = 'demo';
  if (src.refreshMs != null) next.intervaloSegundos = clampInt(Number(src.refreshMs) / 1000, 5, 300, next.intervaloSegundos);
  else if (src.intervaloSegundos != null) next.intervaloSegundos = clampInt(src.intervaloSegundos, 5, 300, next.intervaloSegundos);
  if (src.horaInicio != null) next.inicioPadrao = parseHm(src.horaInicio, next.inicioPadrao);
  else if (src.inicioPadrao != null) next.inicioPadrao = parseHm(src.inicioPadrao, next.inicioPadrao);
  if (src.viradaHora != null) next.viradaHora = viradaHoraOf(src.viradaHora, next.viradaHora);
  if (src.nomeLocal != null) next.local = String(src.nomeLocal).trim().slice(0, 120);
  else if (typeof src.local === 'string') next.local = String(src.local).trim().slice(0, 120);
  if (src.db && typeof src.db === 'object') {
    const db = src.db;
    const auth = db.autenticacao != null ? db.autenticacao : db.auth;
    if (auth != null) next.db.auth = (auth === 'windows' || auth === 'ntlm') ? 'ntlm' : 'sql';
    if (db.server != null) next.db.server = String(db.server).trim().slice(0, 200);
    const instance = db.instanceName != null ? db.instanceName : db.instance;
    if (instance != null) next.db.instance = String(instance).trim().slice(0, 80);
    if (db.port != null) next.db.port = clampInt(db.port, 1, 65535, next.db.port);
    if (db.database != null) next.db.database = String(db.database).trim().slice(0, 120) || 'SIPORTNTACC';
    if (db.domain != null) next.db.domain = String(db.domain).trim().slice(0, 80);
    if (db.user != null) next.db.user = String(db.user).trim().slice(0, 120);
    const senha = db.password != null ? db.password : db.senha;
    if (senha != null && String(senha).length) next.db.password = String(senha);
    if (db.encrypt != null) next.db.encrypt = db.encrypt === true || db.encrypt === 'true';
    if (db.trustServerCertificate != null) {
      next.db.trustServerCertificate = db.trustServerCertificate === true || db.trustServerCertificate === 'true';
    }
  }
  const nova = src.novaSenhaAdmin != null ? String(src.novaSenhaAdmin) : (src.senhaAdmin != null ? String(src.senhaAdmin) : '');
  if (nova.length >= 6) {
    const hashed = hashPassword(nova);
    next.admin.salt = hashed.salt;
    next.admin.hash = hashed.hash;
  } else if (src.removerSenhaAdmin === true && req && isLocal(clientIp(req))) {
    next.admin.salt = '';
    next.admin.hash = '';
  }
  if (src.filtros && typeof src.filtros === 'object') {
    const filtros = src.filtros;
    if (filtros.versoes != null) next.filtros.versoes = asList(filtros.versoes, next.filtros.versoes);
    if (filtros.zlogPersField1 != null) next.filtros.persField1 = asList(filtros.zlogPersField1, next.filtros.persField1);
    else if (filtros.persField1 != null) next.filtros.persField1 = asList(filtros.persField1, next.filtros.persField1);
    if (filtros.zlogTenantIds != null) next.filtros.tenantIds = asList(filtros.zlogTenantIds, next.filtros.tenantIds);
    else if (filtros.tenantIds != null) next.filtros.tenantIds = asList(filtros.tenantIds, next.filtros.tenantIds);
    else if (filtros.tenantId != null) next.filtros.tenantIds = asList(String(filtros.tenantId), next.filtros.tenantIds);
    const alarmes = filtros.alarmes;
    if (alarmes && typeof alarmes === 'object') {
      if (alarmes.incluir != null) next.filtros.alarmesLike = asList(alarmes.incluir, next.filtros.alarmesLike);
      if (alarmes.excluirCatracas != null) next.filtros.catracasExcluir = asList(alarmes.excluirCatracas, next.filtros.catracasExcluir);
    }
    if (filtros.alarmesLike != null) next.filtros.alarmesLike = asList(filtros.alarmesLike, next.filtros.alarmesLike);
    if (filtros.catracasExcluir != null) next.filtros.catracasExcluir = asList(filtros.catracasExcluir, next.filtros.catracasExcluir);
  }
  if (src.perfisSetor != null) {
    next.perfisSetor = typeof src.perfisSetor === 'string'
      ? perfis.parsePerfisSetorTexto(src.perfisSetor)
      : perfis.normalizePerfisSetor(src.perfisSetor);
  }
  if (src.relatorio && typeof src.relatorio === 'object') {
    const rel = src.relatorio;
    if (rel.automatico != null) next.relatorio.automatico = rel.automatico === true || rel.automatico === 'true';
    if (rel.hora != null) {
      const hora = parseHmStrict(rel.hora);
      if (!hora) {
        const err = new Error('Horário do relatório inválido');
        err.status = 400;
        throw err;
      }
      next.relatorio.hora = hora;
    }
    if (rel.pasta != null) next.relatorio.pasta = String(rel.pasta).trim().slice(0, 400);
    if (rel.agenda != null) next.relatorio.agenda = String(rel.agenda).trim().slice(0, 400);
  }
  if (src.zabbix && typeof src.zabbix === 'object') {
    const z = src.zabbix;
    if (z.url != null) next.zabbix.url = String(z.url).trim().slice(0, 400);
    if (z.host != null) next.zabbix.host = String(z.host).trim().slice(0, 120);
    if (z.cpuItem != null) next.zabbix.cpuItem = String(z.cpuItem).trim().slice(0, 120);
    if (z.cpuTag != null) next.zabbix.cpuTag = String(z.cpuTag).trim().slice(0, 80);
    if (z.memoriaItem != null) next.zabbix.memoriaItem = String(z.memoriaItem).trim().slice(0, 120);
    if (z.trustServerCertificate != null) {
      next.zabbix.trustServerCertificate = z.trustServerCertificate === true || z.trustServerCertificate === 'true';
    }
    const token = z.token != null ? z.token : z.senha;
    if (token != null && String(token).length) next.zabbix.token = String(token).slice(0, 500);
  }
  return normalizeConfig(next);
}

function shapeProbe(info, ms) {
  const checklist = info.checklist || [];
  const objetos = checklist.map(function (item) {
    return { nome: item.objeto || item.nome, ok: !!item.ok };
  });
  const selects = checklist.filter(function (item) { return item.permissao === 'SELECT'; });
  const execs = checklist.filter(function (item) { return item.permissao === 'EXECUTE'; });
  const podeLer = selects.length > 0 && selects.every(function (item) { return item.ok; });
  const podeExecutar = execs.length > 0 && execs.every(function (item) { return item.ok; });
  let versao = String(info.versao || '');
  const match = /(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(versao);
  if (match) versao = match[1];
  return {
    ok: podeLer && podeExecutar,
    ms: ms,
    servidor: info.servidor || '',
    banco: info.banco || '',
    usuario: info.usuario || '',
    versao: versao,
    agora: info.hora || info.agora || null,
    objetos: objetos,
    podeLer: podeLer,
    podeExecutar: podeExecutar,
  };
}

function dbFromBody(body, current) {
  const merged = mergeSettings(current, body || {});
  return merged.db;
}

function filtroTexto(value, max) {
  return String(value || '').trim().slice(0, max || 80);
}

function ticketFiltro(query, cfg) {
  const status = String(query.get('status') || '').trim();
  if (status && status !== 'lidos' && status !== 'naolidos') throw httpError(400, 'Status inválido');
  const ordemRaw = String(query.get('ordem') || '').trim();
  if (ordemRaw && ordemRaw !== 'codigo' && ordemRaw !== 'setor' && ordemRaw !== 'leitura' && ordemRaw !== 'naolidos') {
    throw httpError(400, 'Ordem inválida');
  }
  const versao = String(query.get('versao') || '').trim();
  if (versao && (cfg.filtros.versoes || []).indexOf(versao) === -1) throw httpError(400, 'Versão não permitida');
  return {
    codigo: filtroTexto(query.get('codigo'), 40),
    setor: filtroTexto(query.get('setor')),
    versao: versao,
    status: status,
    ordem: ordemRaw || 'codigo',
    offset: clampInt(query.get('offset'), 0, 10000000, 0),
    limit: clampInt(query.get('limit'), 1, 5000, 500),
  };
}

function listFiltro(query, fallback, max) {
  return clampInt(query.get('limit'), 1, max || 50000, fallback);
}

function handle(req, res, parsed, ctx) {
  const send = ctx.sendJson;
  const method = req.method || 'GET';
  let route = parsed.pathname.replace(/\/+$/, '');
  if (route.indexOf('/api/siport') === 0) route = route.slice('/api/siport'.length).replace(/^\//, '');

  function fail(err) {
    if (res.headersSent) return;
    const status = err && err.status ? err.status : 502;
    send(res, status, { error: String(err && err.message || err) });
  }

  if (route === 'config' && method === 'GET') {
    let cfg;
    try { cfg = readConfig(); } catch (err) { fail(err); return; }
    send(res, 200, panelConfig(cfg));
    return;
  }

  if (route === 'settings' && method === 'GET') {
    let cfg;
    try { cfg = readConfig(); } catch (err) { fail(err); return; }
    const auth = authorize(req, cfg);
    if (!auth.ok) {
      send(res, auth.status, { error: auth.erro });
      return;
    }
    send(res, 200, settingsPayload(cfg, req));
    return;
  }

  if (route === 'settings/test' && method === 'POST') {
    let cfg;
    try { cfg = readConfig(); } catch (err) { fail(err); return; }
    const auth = authorize(req, cfg);
    if (!auth.ok) {
      send(res, auth.status, { error: auth.erro });
      return;
    }
    ctx.parseJsonBody(req, function (err, body) {
      if (err) {
        send(res, 400, { error: String(err.message || err) });
        return;
      }
      const db = dbFromBody(body, cfg);
      if (!db.server) {
        send(res, 200, { ok: false, erro: 'Informe o servidor' });
        return;
      }
      const started = Date.now();
      const created = new sql.ConnectionPool(buildPoolConfig(db));
      created.connect()
        .then(function () { return queries.probeConnection(created); })
        .then(function (info) {
          send(res, 200, shapeProbe(info, Date.now() - started));
        })
        .catch(function (e) {
          send(res, 200, { ok: false, erro: String(e.message || e) });
        })
        .then(function () {
          created.close().catch(function () {});
        });
    });
    return;
  }

  if (route === 'settings' && method === 'POST') {
    let cfg;
    try { cfg = readConfig(); } catch (err) { fail(err); return; }
    const auth = authorize(req, cfg);
    if (!auth.ok) {
      send(res, auth.status, { error: auth.erro });
      return;
    }
    ctx.parseJsonBody(req, function (err, body) {
      if (err) {
        send(res, 400, { error: String(err.message || err) });
        return;
      }
      const nova = body && body.novaSenhaAdmin != null ? String(body.novaSenhaAdmin) : '';
      if (nova && nova.length < 6) {
        send(res, 400, { error: 'A senha de administrador precisa ter ao menos 6 caracteres' });
        return;
      }
      try {
        const next = mergeSettings(cfg, body, req);
        writeConfig(next);
        resetPool();
        cache.clear();
        const aviso = forceDemoFlag() && body && body.modo === 'sql'
          ? 'Servidor iniciado com --demo: a fonte de dados fica em demonstração até reiniciar sem o parâmetro.'
          : null;
        send(res, 200, { ok: true, modo: modoOf(next), erro: aviso, settings: settingsPayload(next, req) });
      } catch (e) {
        fail(e);
      }
    });
    return;
  }

  if (route === 'relatorio/salvar' && method === 'POST') {
    let cfg;
    try { cfg = readConfig(); } catch (err) { fail(err); return; }
    const auth = authorize(req, cfg);
    if (!auth.ok) {
      send(res, auth.status, { error: auth.erro });
      return;
    }
    ctx.parseJsonBody(req, function (err, body) {
      if (err) {
        send(res, 400, { error: String(err.message || err) });
        return;
      }
      const src = body && typeof body === 'object' ? body : {};
      const date = parseDate(src.date, '');
      const inicio = parseHmStrict(src.inicio || cfg.inicioPadrao);
      if (!date || !inicio) {
        send(res, 400, { error: 'Informe a data e o horário de início' });
        return;
      }
      const win = janelaEvento(date, inicio, cfg);
      gerarSalvar(cfg, win, { origem: 'manual', nome: src.nome }).then(function (payload) {
        send(res, 200, payload.pulado ? { pulado: true } : { arquivo: payload.arquivo, linhas: payload.linhas });
      }).catch(fail);
    });
    return;
  }

  if (method !== 'GET') {
    send(res, 405, { error: 'Método não permitido' });
    return;
  }

  let cfg;
  try { cfg = readConfig(); } catch (err) { fail(err); return; }
  const win = buildWindow(parsed.searchParams, cfg);

  if (route === 'summary') {
    runSummary(cfg, win).then(function (payload) { send(res, 200, payload); }).catch(fail);
    return;
  }
  if (route === 'feed') {
    const limit = listFiltro(parsed.searchParams, 40, 200);
    runFeed(cfg, win, limit).then(function (payload) { send(res, 200, payload); }).catch(fail);
    return;
  }
  if (route === 'alarms') {
    const filtro = {
      limit: listFiltro(parsed.searchParams, 500, 50000),
      catraca: filtroTexto(parsed.searchParams.get('catraca')),
      codigo: filtroTexto(parsed.searchParams.get('codigo'), 40),
    };
    runAlarms(cfg, win, filtro).then(function (payload) { send(res, 200, payload); }).catch(fail);
    return;
  }
  if (route === 'reads') {
    const filtro = {
      limit: listFiltro(parsed.searchParams, 500, 50000),
      catraca: filtroTexto(parsed.searchParams.get('catraca')),
      codigo: filtroTexto(parsed.searchParams.get('codigo'), 40),
      setor: filtroTexto(parsed.searchParams.get('setor')),
    };
    runReads(cfg, win, filtro).then(function (payload) { send(res, 200, payload); }).catch(fail);
    return;
  }
  if (route === 'tickets') {
    let filtro;
    try { filtro = ticketFiltro(parsed.searchParams, cfg); } catch (err) { fail(err); return; }
    runTickets(cfg, win, filtro).then(function (payload) { send(res, 200, payload); }).catch(fail);
    return;
  }
  if (route === 'relatorio/status') {
    send(res, 200, statusRelatorio(cfg, win.date));
    return;
  }
  if (route === 'relatorio.xlsx') {
    const nome = filtroTexto(parsed.searchParams.get('nome'), 120);
    gerarDownload(cfg, win, nome).then(function (payload) {
      const encoded = encodeURIComponent(payload.nome);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="relatorio.xlsx"; filename*=UTF-8\'\'' + encoded,
        'Cache-Control': 'no-store',
      });
      const stream = fs.createReadStream(payload.file);
      stream.on('error', function () {
        if (!res.headersSent) fail(httpError(500, 'Falha ao ler o relatório'));
        else res.destroy();
      });
      stream.on('close', function () {
        fs.unlink(payload.file, function () {});
      });
      stream.pipe(res);
    }).catch(fail);
    return;
  }
  if (route === 'search') {
    const q = String(parsed.searchParams.get('q') || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 64);
    if (q.length < 4) {
      send(res, 400, { error: 'Informe ao menos 4 caracteres' });
      return;
    }
    runSearch(cfg, win, q).then(function (payload) { send(res, 200, payload); }).catch(fail);
    return;
  }
  if (route === 'importacao') {
    const versoes = versoesImportacao(parsed.searchParams);
    runImportacao(cfg, versoes).then(function (payload) { send(res, 200, payload); }).catch(fail);
    return;
  }

  send(res, 404, { error: 'Rota não encontrada' });
}

module.exports = {
  handle: handle,
  startScheduler: startScheduler,
};
