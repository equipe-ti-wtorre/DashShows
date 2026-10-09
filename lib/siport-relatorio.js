'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const HIST_PATH = path.join(__dirname, '..', 'data', 'siport-relatorios.json');

const COLS = {
  base: [
    'DATA_20_Person_no_PN', 'DATA_20_Version_VN', 'DATA_20_Validfor_D1', 'DATA_20_Validto_D2',
    'STD_PROFILES', 'PersStatus', 'DATA_20_Name_NA', 'DATA_20_Surname_NA', 'DATA_20_Room_RN',
    'DATA_FREEDEF1', 'DATA_FREEDEF2', 'DATA_FREEDEF3', 'DATA_FREEDEF4', 'DATA_FREEDEF5',
    'DATA_FREEDEF6', 'DATA_FREEDEF7', 'DATA_FREEDEF8', 'DATA_FREEDEF9', 'DATA_FREEDEF10',
    'DATA_FREEDEF11', 'DATA_FREEDEF12', 'DATA_FREEDEF13', 'DATA_FREEDEF14', 'DATA_FREEDEF15',
    'DATA_FREEDEF16', 'DATA_FREEDEF17', 'DATA_FREEDEF18', 'DATA_FREEDEF19', 'DATA_FREEDEF20',
    'Expr2', 'DATA_20_Ident_no_CN',
  ],
  alarmes: ['Uhrzeit', 'Punktname', 'Alarmtext', 'CardNumber', 'ID'],
  acessos: [
    'Data_hora', 'Catraca', 'Info_ingresso', 'Codigo_Ingresso', 'Codigo_ticketeira',
    'Freedef1', 'Freedef2', 'Freedef3', 'Freedef4', 'Freedef5', 'Freddef6', 'ID',
  ],
};

const DATES = {
  base: { DATA_20_Validfor_D1: true, DATA_20_Validto_D2: true },
  alarmes: { Uhrzeit: true },
  acessos: { Data_hora: true },
};

const SHEETS = [
  { key: 'base', name: 'Relatorio_BasedeDados' },
  { key: 'alarmes', name: 'Relatorio Alarmes' },
  { key: 'acessos', name: 'Relatorio Acessos' },
];

function colLetter(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function excelDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !isNaN(value.getTime())) {
    return new Date(Date.UTC(
      value.getFullYear(), value.getMonth(), value.getDate(),
      value.getHours(), value.getMinutes(), value.getSeconds()
    ));
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value).trim());
  if (!m) return value === '' ? null : value;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
}

function cellValue(value, isDate) {
  if (isDate) return excelDate(value);
  if (value == null || value === '') return null;
  return value;
}

async function escrever(filename, rows) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filename, useStyles: true });
  for (let s = 0; s < SHEETS.length; s++) {
    const spec = SHEETS[s];
    const cols = COLS[spec.key];
    const dates = DATES[spec.key];
    const ws = wb.addWorksheet(spec.name, {
      views: [{ state: 'frozen', ySplit: 1 }],
      autoFilter: 'A1:' + colLetter(cols.length) + '1',
    });
    ws.columns = cols.map(function (name) {
      return { width: Math.min(32, Math.max(12, name.length + 2)) };
    });
    const header = ws.addRow(cols);
    header.font = { bold: true };
    header.commit();
    const list = (rows && rows[spec.key]) || [];
    for (let i = 0; i < list.length; i++) {
      const src = list[i] || {};
      const values = cols.map(function (name) { return cellValue(src[name], !!dates[name]); });
      const added = ws.addRow(values);
      cols.forEach(function (name, idx) {
        if (!dates[name]) return;
        const cell = added.getCell(idx + 1);
        if (cell.value instanceof Date) cell.numFmt = 'dd/mm/yyyy hh:mm:ss';
      });
      added.commit();
    }
    ws.commit();
  }
  await wb.commit();
}

function tituloCase(name) {
  return String(name || '').trim().split(/\s+/).filter(Boolean).map(function (word) {
    const lower = word.toLocaleLowerCase('pt-BR');
    return lower.charAt(0).toLocaleUpperCase('pt-BR') + lower.slice(1);
  }).join(' ');
}

function sanitizarShow(name) {
  const s = String(name || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  return s || 'Evento';
}

function tituloDaAgenda(agendaPath, date) {
  const file = String(agendaPath || '').trim();
  if (!file) return '';
  try {
    if (!fs.existsSync(file)) return '';
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const events = raw && Array.isArray(raw.events) ? raw.events : (Array.isArray(raw) ? raw : []);
    for (let i = 0; i < events.length; i++) {
      const item = events[i];
      if (item && String(item.date || '') === date && item.title) return String(item.title);
    }
    return '';
  } catch (_) {
    return '';
  }
}

function nomeShow(agendaPath, date, override) {
  const custom = String(override || '').trim();
  if (custom) return sanitizarShow(tituloCase(custom));
  const title = tituloDaAgenda(agendaPath, date);
  return sanitizarShow(title ? tituloCase(title) : 'Evento');
}

function nomeArquivo(date, show) {
  const d = date.slice(8, 10);
  const m = date.slice(5, 7);
  const aa = date.slice(2, 4);
  return show + ' ' + d + '.' + m + '.' + aa + '.xlsx';
}

function destino(pasta, date, show) {
  const y = date.slice(0, 4);
  const m = date.slice(5, 7);
  const d = date.slice(8, 10);
  const aa = date.slice(2, 4);
  const dir = path.join(String(pasta || '').trim() || '/var/dashshows/relatorios', y, m + '.' + y, d + ' - ' + show);
  const base = show + ' ' + d + '.' + m + '.' + aa;
  let n = 1;
  let arquivo = path.join(dir, base + '.xlsx');
  while (fs.existsSync(arquivo)) {
    n += 1;
    arquivo = path.join(dir, base + ' (' + n + ').xlsx');
  }
  return { dir: dir, arquivo: arquivo, tmp: arquivo + '.tmp', nome: path.basename(arquivo) };
}

function readHistory() {
  try {
    if (!fs.existsSync(HIST_PATH)) return {};
    const raw = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (_) {
    return {};
  }
}

function writeHistory(all) {
  const dir = path.dirname(HIST_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = HIST_PATH + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
  fs.renameSync(tmp, HIST_PATH);
}

function saveEntry(date, entry) {
  const all = readHistory();
  all[date] = entry;
  writeHistory(all);
  return all;
}

function historicoRecente(all, limit) {
  const src = all || {};
  return Object.keys(src).map(function (key) {
    const item = src[key] || {};
    return {
      date: item.date || key,
      origem: item.origem || '',
      arquivo: item.arquivo || undefined,
      linhas: item.linhas || undefined,
      inicio: item.inicio || undefined,
      pulado: item.pulado || undefined,
      erro: item.erro || undefined,
      em: item.em || '',
    };
  }).sort(function (a, b) {
    return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0);
  }).slice(0, limit || 10);
}

module.exports = {
  COLS: COLS,
  SHEETS: SHEETS,
  escrever: escrever,
  nomeShow: nomeShow,
  nomeArquivo: nomeArquivo,
  destino: destino,
  readHistory: readHistory,
  saveEntry: saveEntry,
  historicoRecente: historicoRecente,
  tituloCase: tituloCase,
};
