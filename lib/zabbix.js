'use strict';

const http = require('http');
const https = require('https');

const CACHE_MS = 4000;
const TIMEOUT_MS = 4000;

let cache = { key: '', at: 0, value: null };

function curto(err) {
  return String(err && err.message || err || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function postJson(url, token, body, trustCert) {
  return new Promise(function (resolve, reject) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      reject(new Error('URL do Zabbix inválida'));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('URL do Zabbix inválida'));
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: (parsed.pathname || '/') + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: 'Bearer ' + token,
      },
      timeout: TIMEOUT_MS,
      servername: parsed.hostname,
    };
    if (lib === https && trustCert !== false) options.rejectUnauthorized = false;
    const req = lib.request(options, function (res) {
      const chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try {
          data = JSON.parse(text);
        } catch (_) {
          reject(new Error('Resposta do Zabbix não é JSON'));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = data && data.error ? (data.error.data || data.error.message) : ('HTTP ' + res.statusCode);
          reject(new Error(curto(msg)));
          return;
        }
        resolve(data);
      });
    });
    req.on('error', function (err) { reject(err); });
    req.on('timeout', function () {
      req.destroy(new Error('Tempo esgotado ao consultar o Zabbix'));
    });
    req.write(payload);
    req.end();
  });
}

function tagFilter(cpuTag) {
  const raw = String(cpuTag || '').trim();
  const cut = raw.indexOf(':');
  if (!raw || cut <= 0) return null;
  return { tag: raw.slice(0, cut).trim(), value: raw.slice(cut + 1).trim(), operator: 1 };
}

function pickValue(items, name) {
  const list = Array.isArray(items) ? items : [];
  const needle = String(name || '').trim().toLowerCase();
  let chosen = null;
  for (let i = 0; i < list.length; i++) {
    if (String(list[i].name || '').trim().toLowerCase() === needle) {
      chosen = list[i];
      break;
    }
  }
  if (!chosen) chosen = list[0];
  if (!chosen || chosen.lastvalue == null || chosen.lastvalue === '') return null;
  const n = Number(chosen.lastvalue);
  return isFinite(n) ? Math.round(n) : null;
}

async function itemValue(zabbix, itemName, withTag) {
  const params = {
    output: ['itemid', 'name', 'lastvalue', 'units'],
    host: zabbix.host,
    search: { name: itemName },
    sortfield: 'name',
    limit: 20,
  };
  const tag = withTag ? tagFilter(zabbix.cpuTag) : null;
  if (tag && tag.tag && tag.value) params.tags = [tag];
  const data = await postJson(zabbix.url, zabbix.token, {
    jsonrpc: '2.0',
    method: 'item.get',
    params: params,
    id: 1,
  }, zabbix.trustServerCertificate);
  if (data && data.error) {
    const msg = data.error.data || data.error.message || 'Falha no Zabbix';
    throw new Error(curto(msg));
  }
  const items = data && data.result;
  if (withTag && (!items || !items.length)) return itemValue(zabbix, itemName, false);
  return pickValue(items, itemName);
}

function vazio(zabbix, erro) {
  return {
    nome: (zabbix && zabbix.host) || 'SRVAP-SIPORT01',
    cpu: null,
    memoria: null,
    erro: erro,
  };
}

async function loadHost(zabbix) {
  const cpu = await itemValue(zabbix, zabbix.cpuItem, true);
  const memoria = await itemValue(zabbix, zabbix.memoriaItem, false);
  let erro = null;
  if (cpu == null && memoria == null) erro = 'Itens de CPU e memória não encontrados no host ' + zabbix.host;
  else if (cpu == null) erro = 'Item de CPU não encontrado';
  else if (memoria == null) erro = 'Item de memória não encontrado';
  return { nome: zabbix.host, cpu: cpu, memoria: memoria, erro: erro };
}

async function hostMetrics(zabbix) {
  const z = zabbix || {};
  if (!String(z.url || '').trim() || !String(z.token || '').trim()) {
    return vazio(z, 'Zabbix não configurado');
  }
  const key = [z.url, z.token, z.host, z.cpuItem, z.cpuTag, z.memoriaItem, z.trustServerCertificate === false ? '0' : '1'].join('\n');
  if (cache.key === key && cache.value && (Date.now() - cache.at) < CACHE_MS) return cache.value;
  let value;
  try {
    value = await loadHost(z);
  } catch (err) {
    value = vazio(z, curto(err));
  }
  cache = { key: key, at: Date.now(), value: value };
  return value;
}

function clearCache() {
  cache = { key: '', at: 0, value: null };
}

module.exports = {
  hostMetrics: hostMetrics,
  clearCache: clearCache,
};
