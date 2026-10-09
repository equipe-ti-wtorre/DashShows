'use strict';

function chavePerfis(value) {
  const src = Array.isArray(value) ? value : String(value == null ? '' : value).split(',');
  const codes = [];
  src.forEach(function (item) {
    const s = String(item == null ? '' : item).replace(/\s+/g, '').toUpperCase();
    if (!s || codes.indexOf(s) !== -1) return;
    codes.push(s);
  });
  codes.sort();
  return codes.join(',');
}

function rotulo(perfis, mapa) {
  const map = mapa && typeof mapa === 'object' ? mapa : {};
  const key = chavePerfis(perfis);
  if (!key) return 'SEM SETOR';
  if (map[key]) return String(map[key]);
  const names = [];
  key.split(',').forEach(function (code) {
    const nome = map[code];
    if (nome && names.indexOf(String(nome)) === -1) names.push(String(nome));
  });
  if (names.length) return names.join(' / ');
  const display = Array.isArray(perfis)
    ? perfis.map(function (item) { return String(item == null ? '' : item).trim(); }).filter(Boolean).join(',')
    : String(perfis == null ? '' : perfis).trim();
  return 'Perfil ' + (display || key);
}

function aplicarRotulo(setor, mapa) {
  const s = String(setor == null ? '' : setor).trim();
  if (s.indexOf('Perfil ') !== 0) return s;
  return rotulo(s.slice('Perfil '.length), mapa);
}

function normalizePerfisSetor(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.keys(raw).forEach(function (key) {
    const k = chavePerfis(key);
    const nome = String(raw[key] == null ? '' : raw[key]).trim().slice(0, 120);
    if (!k || !nome) return;
    out[k] = nome;
  });
  return out;
}

function parsePerfisSetorTexto(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const out = {};
  lines.forEach(function (line, index) {
    const raw = String(line).trim();
    if (!raw || raw.charAt(0) === '#') return;
    let cut = -1;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw.charAt(i);
      if (ch === '=' || ch === ':' || ch === '\t') {
        cut = i;
        break;
      }
    }
    const left = cut === -1 ? '' : raw.slice(0, cut).trim();
    const right = cut === -1 ? '' : raw.slice(cut + 1).trim();
    const key = chavePerfis(left);
    if (cut === -1 || !key || !right) {
      const err = new Error('Perfis → setor, linha ' + (index + 1) + ': use o formato "G080 = Nome do setor".');
      err.status = 400;
      throw err;
    }
    out[key] = right.slice(0, 120);
  });
  return out;
}

function setorNeedle(setor) {
  const s = String(setor || '').trim();
  if (/^camarotes$/i.test(s)) return 'CAMAROTE';
  if (/^lounges$/i.test(s)) return 'LOUNGE';
  return s;
}

function ticketCasaSetor(f4, perfis, filtroSetor, mapa) {
  const raw = String(filtroSetor || '').trim();
  if (!raw) return true;
  const needle = setorNeedle(raw).toLowerCase();
  const setor = String(f4 || '').trim();
  if (setor) return setor.toLowerCase().indexOf(needle) !== -1;
  const perf = String(perfis || '');
  if (perf.toLowerCase().indexOf(needle) !== -1) return true;
  const have = {};
  const key = chavePerfis(perf);
  if (key) key.split(',').forEach(function (code) { have[code] = true; });
  const map = mapa && typeof mapa === 'object' ? mapa : {};
  return Object.keys(map).some(function (mapKey) {
    const nome = String(map[mapKey] || '');
    if (nome.toLowerCase().indexOf(needle) === -1) return false;
    const need = mapKey.split(',').filter(Boolean);
    return need.length > 0 && need.every(function (code) { return !!have[code]; });
  });
}

module.exports = {
  chavePerfis: chavePerfis,
  rotulo: rotulo,
  aplicarRotulo: aplicarRotulo,
  normalizePerfisSetor: normalizePerfisSetor,
  parsePerfisSetorTexto: parsePerfisSetorTexto,
  setorNeedle: setorNeedle,
  ticketCasaSetor: ticketCasaSetor,
};
