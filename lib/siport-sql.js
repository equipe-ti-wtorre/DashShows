'use strict';

const sql = require('mssql');
const perfisLib = require('./siport-perfis');

const PREAMBLE = 'SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;';

function nvar(value) {
  return "N'" + String(value).replace(/'/g, "''") + "'";
}

function likeNeedle(value) {
  const escaped = String(value)
    .replace(/'/g, "''")
    .replace(/[[\]%_]/g, function (ch) { return '[' + ch + ']'; });
  return "N'%" + escaped + "%'";
}

function cleanList(list) {
  const src = Array.isArray(list) ? list : [];
  const out = [];
  src.forEach(function (item) {
    const s = String(item == null ? '' : item).trim();
    if (!s || s.length > 80) return;
    out.push(s);
  });
  return out;
}

function col(alias, name) {
  return alias ? alias + '.' + name : name;
}

function zlogPredicate(cfg, alias) {
  const parts = [];
  const fields = cleanList(cfg.filtros.persField1);
  if (fields.length) {
    parts.push('LTRIM(RTRIM(' + col(alias, 'PersField1') + ')) IN (' + fields.map(function (v) {
      return nvar(v.trim());
    }).join(', ') + ')');
  }
  const tenants = cleanList(cfg.filtros.tenantIds || (cfg.filtros.tenantId ? [cfg.filtros.tenantId] : []));
  if (tenants.length) {
    parts.push(col(alias, 'TenantID') + ' IN (' + tenants.map(function (v) {
      return nvar(v.trim());
    }).join(', ') + ')');
  }
  if (!parts.length) return '1 = 1';
  return '(' + parts.join(' OR ') + ')';
}

function versionPredicate(cfg, alias) {
  const fields = cleanList(cfg.filtros.versoes);
  if (!fields.length) return '1 = 1';
  return col(alias, 'DATA_20_Version_VN') + ' IN (' + fields.map(nvar).join(', ') + ')';
}

function alarmPredicate(cfg, alias) {
  const likes = cleanList(cfg.filtros.alarmesLike).map(function (item) {
    return col(alias, 'Alarmtext') + ' LIKE ' + likeNeedle(item);
  });
  const excl = cleanList(cfg.filtros.catracasExcluir).map(function (item) {
    return col(alias, 'Punktname') + ' NOT LIKE ' + likeNeedle(item);
  });
  const parts = [];
  if (likes.length) parts.push('(' + likes.join(' OR ') + ')');
  parts.push.apply(parts, excl);
  return parts.join(' AND ') || '1 = 1';
}

function windowDecl() {
  return (
    'DECLARE @dini datetime = CONVERT(datetime, @ini, 120);' +
    'DECLARE @dfim datetime = CONVERT(datetime, @fim, 120);'
  );
}

function bindWindow(request, win) {
  request.input('ini', sql.VarChar(19), win.ini);
  request.input('fim', sql.VarChar(19), win.fim);
}

function lidosCte(cfg) {
  return (
    'lidos AS (' +
    'SELECT DISTINCT Z.CardNumber AS CardNumber ' +
    'FROM dbo.SIST_ZLOG Z ' +
    'WHERE Z.Uhrzeit >= @dini AND Z.Uhrzeit < @dfim AND ' + zlogPredicate(cfg, 'Z') +
    ')'
  );
}

function validWhere() {
  return (
    'P.DATA_20_Validto_D2 >= @dini AND P.DATA_20_Validfor_D1 < @dfim'
  );
}

function likeBind(value) {
  return String(value || '').replace(/[[\]%_]/g, function (ch) { return '[' + ch + ']'; });
}

function num(value) {
  const n = Number(value);
  return isFinite(n) ? n : 0;
}

function text(value) {
  if (value == null) return '';
  return String(value).trim();
}

async function querySummary(pool, cfg, win) {
  const request = pool.request();
  bindWindow(request, win);
  const batch = [
    PREAMBLE,
    windowDecl(),
    'WITH ' + lidosCte(cfg) +
      ' SELECT COUNT(*) AS validos,' +
      ' SUM(CASE WHEN L.CardNumber IS NOT NULL THEN 1 ELSE 0 END) AS lidos' +
      ' FROM dbo.SIST_Pers P' +
      ' LEFT JOIN lidos L ON L.CardNumber = P.DATA_20_Person_no_PN' +
      ' WHERE ' + versionPredicate(cfg, 'P') + ' AND ' + validWhere() + ';',
    'SELECT COUNT(*) AS passagens, COUNT(DISTINCT Z.CardNumber) AS cartoes,' +
      ' CONVERT(varchar(19), MAX(Z.Uhrzeit), 120) AS ultima' +
      ' FROM dbo.SIST_ZLOG Z' +
      ' WHERE Z.Uhrzeit >= @dini AND Z.Uhrzeit < @dfim AND ' + zlogPredicate(cfg, 'Z') + ';',
    'SELECT COUNT(*) AS alarmes FROM dbo.SIST_ALOG A' +
      ' WHERE A.Uhrzeit >= @dini AND A.Uhrzeit < @dfim AND ' + alarmPredicate(cfg, 'A') + ';',
    'WITH ' + lidosCte(cfg) + ', comSetor AS (' +
      ' SELECT CASE' +
      '   WHEN NULLIF(LTRIM(RTRIM(F.val)), N\'\') IS NOT NULL THEN LTRIM(RTRIM(F.val))' +
      '   ELSE COALESCE(N\'Perfil \' + NULLIF(dbo.GetStdProfiles(P.Data_Auto_ID), N\'\'), N\'SEM SETOR\')' +
      ' END AS setor,' +
      ' CASE WHEN L.CardNumber IS NOT NULL THEN 1 ELSE 0 END AS leu' +
      ' FROM dbo.SIST_Pers P' +
      ' LEFT JOIN dbo.SIST_PersFreeDef F ON F.IDPers = P.Data_Auto_ID AND F.IDXFREEDEF = 4' +
      ' LEFT JOIN lidos L ON L.CardNumber = P.DATA_20_Person_no_PN' +
      ' WHERE ' + versionPredicate(cfg, 'P') + ' AND ' + validWhere() +
      ') SELECT setor, COUNT(*) AS total, SUM(leu) AS lidos FROM comSetor GROUP BY setor;',
    'SELECT RTRIM(Z.Ort) AS catraca, COUNT(*) AS leituras,' +
      ' CONVERT(varchar(19), MAX(Z.Uhrzeit), 120) AS ultima' +
      ' FROM dbo.SIST_ZLOG Z' +
      ' WHERE Z.Uhrzeit >= @dini AND Z.Uhrzeit < @dfim AND ' + zlogPredicate(cfg, 'Z') +
      ' GROUP BY RTRIM(Z.Ort);',
    'SELECT RTRIM(A.Punktname) AS catraca, COUNT(*) AS alarmes,' +
      ' CONVERT(varchar(19), MAX(A.Uhrzeit), 120) AS ultima' +
      ' FROM dbo.SIST_ALOG A' +
      ' WHERE A.Uhrzeit >= @dini AND A.Uhrzeit < @dfim AND ' + alarmPredicate(cfg, 'A') +
      ' GROUP BY RTRIM(A.Punktname);',
    'SELECT DATEDIFF(minute, @dini, Z.Uhrzeit) / 5 AS bucket, COUNT(*) AS n' +
      ' FROM dbo.SIST_ZLOG Z' +
      ' WHERE Z.Uhrzeit >= @dini AND Z.Uhrzeit < @dfim AND ' + zlogPredicate(cfg, 'Z') +
      ' GROUP BY DATEDIFF(minute, @dini, Z.Uhrzeit) / 5;',
    'SELECT DATEDIFF(minute, @dini, A.Uhrzeit) / 5 AS bucket, COUNT(*) AS n' +
      ' FROM dbo.SIST_ALOG A' +
      ' WHERE A.Uhrzeit >= @dini AND A.Uhrzeit < @dfim AND ' + alarmPredicate(cfg, 'A') +
      ' GROUP BY DATEDIFF(minute, @dini, A.Uhrzeit) / 5;',
    'SELECT A.Alarmtext AS texto, COUNT(*) AS n' +
      ' FROM dbo.SIST_ALOG A' +
      ' WHERE A.Uhrzeit >= @dini AND A.Uhrzeit < @dfim AND ' + alarmPredicate(cfg, 'A') +
      ' GROUP BY A.Alarmtext;',
  ].join('\n');

  const result = await request.query(batch);
  const sets = result.recordsets || [];
  const tot = (sets[0] && sets[0][0]) || {};
  const pass = (sets[1] && sets[1][0]) || {};
  const alm = (sets[2] && sets[2][0]) || {};
  return {
    validos: num(tot.validos),
    lidos: num(tot.lidos),
    passagens: num(pass.passagens),
    cartoes: num(pass.cartoes),
    ultima: text(pass.ultima),
    alarmes: num(alm.alarmes),
    setores: (sets[3] || []).map(function (row) {
      return { setor: text(row.setor), total: num(row.total), lidos: num(row.lidos) };
    }),
    catracasLeituras: (sets[4] || []).map(function (row) {
      return { catraca: text(row.catraca), leituras: num(row.leituras), ultima: text(row.ultima) };
    }),
    catracasAlarmes: (sets[5] || []).map(function (row) {
      return { catraca: text(row.catraca), alarmes: num(row.alarmes), ultima: text(row.ultima) };
    }),
    serieLeituras: (sets[6] || []).map(function (row) {
      return { bucket: num(row.bucket), n: num(row.n) };
    }),
    serieAlarmes: (sets[7] || []).map(function (row) {
      return { bucket: num(row.bucket), n: num(row.n) };
    }),
    textosAlarme: (sets[8] || []).map(function (row) {
      return { texto: text(row.texto), n: num(row.n) };
    }),
  };
}

function categoriaApply() {
  return (
    ' OUTER APPLY (' +
    '   SELECT TOP 1 CASE' +
    '     WHEN NULLIF(LTRIM(RTRIM(F4.val)), N\'\') IS NOT NULL THEN P.DATA_20_Name_NA' +
    '     ELSE N\'Perfil \' + NULLIF(dbo.GetStdProfiles(P.Data_Auto_ID), N\'\')' +
    '   END AS categoria' +
    '   FROM dbo.SIST_Pers P' +
    '   LEFT JOIN dbo.SIST_PersFreeDef F4 ON F4.IDPers = P.Data_Auto_ID AND F4.IDXFREEDEF = 4' +
    '   WHERE P.DATA_20_Person_no_PN = A.CardNumber' +
    ' ) CAT'
  );
}

function leituraSelect(alias) {
  const a = alias;
  return (
    a + '.ID AS id, CONVERT(varchar(19), ' + a + '.Uhrzeit, 120) AS hora, RTRIM(' + a + '.Ort) AS catraca,' +
    ' ' + a + '.CardNumber AS codigo, ' + a + '.Person AS info,' +
    ' LTRIM(RTRIM(' + a + '.PersField1)) AS ticketeira, LTRIM(RTRIM(' + a + '.PersField5)) AS setor'
  );
}

async function queryFeed(pool, cfg, win, limit) {
  const request = pool.request();
  bindWindow(request, win);
  request.input('limite', sql.Int, limit);
  const batch = [
    PREAMBLE,
    windowDecl(),
    'SELECT TOP (@limite) ' + leituraSelect('Z') +
      ' FROM dbo.SIST_ZLOG Z' +
      ' WHERE Z.Uhrzeit >= @dini AND Z.Uhrzeit < @dfim AND ' + zlogPredicate(cfg, 'Z') +
      ' ORDER BY Z.ID DESC;',
    'SELECT TOP (@limite) A.ID AS id, CONVERT(varchar(19), A.Uhrzeit, 120) AS hora,' +
      ' RTRIM(A.Punktname) AS catraca, A.Alarmtext AS texto, A.CardNumber AS codigo,' +
      ' CAT.categoria AS categoria,' +
      ' PRIM.hora AS primeiraHora, PRIM.catraca AS primeiraCatraca,' +
      ' ULT.hora AS ultimaHora, ULT.catraca AS ultimaCatraca' +
      ' FROM dbo.SIST_ALOG A' +
      ' OUTER APPLY (' +
      '   SELECT TOP 1 CONVERT(varchar(19), Z.Uhrzeit, 120) AS hora, RTRIM(Z.Ort) AS catraca' +
      '   FROM dbo.SIST_ZLOG Z' +
      '   WHERE Z.CardNumber = A.CardNumber AND Z.Uhrzeit >= @dini AND Z.Uhrzeit < @dfim' +
      '   ORDER BY Z.Uhrzeit ASC, Z.ID ASC' +
      ' ) PRIM' +
      ' OUTER APPLY (' +
      '   SELECT TOP 1 CONVERT(varchar(19), Z.Uhrzeit, 120) AS hora, RTRIM(Z.Ort) AS catraca' +
      '   FROM dbo.SIST_ZLOG Z' +
      '   WHERE Z.CardNumber = A.CardNumber AND Z.Uhrzeit >= @dini AND Z.Uhrzeit < @dfim' +
      '   ORDER BY Z.Uhrzeit DESC, Z.ID DESC' +
      ' ) ULT' +
      categoriaApply() +
      ' WHERE A.Uhrzeit >= @dini AND A.Uhrzeit < @dfim AND ' + alarmPredicate(cfg, 'A') +
      ' ORDER BY A.ID DESC;',
  ].join('\n');
  const result = await request.query(batch);
  const sets = result.recordsets || [];
  return {
    leituras: (sets[0] || []).map(mapLeitura),
    alarmes: (sets[1] || []).map(mapAlarme),
  };
}

function mapLeitura(row) {
  return {
    id: num(row.id),
    hora: text(row.hora),
    catraca: text(row.catraca),
    codigo: text(row.codigo),
    info: text(row.info),
    ticketeira: text(row.ticketeira),
    setor: text(row.setor),
  };
}

function mapAlarme(row) {
  return {
    id: num(row.id),
    hora: text(row.hora),
    catraca: text(row.catraca),
    texto: text(row.texto),
    codigo: text(row.codigo),
    categoria: text(row.categoria),
    primeiraHora: text(row.primeiraHora),
    primeiraCatraca: text(row.primeiraCatraca),
    ultimaHora: text(row.ultimaHora),
    ultimaCatraca: text(row.ultimaCatraca),
  };
}

async function queryAlarms(pool, cfg, win, filtro) {
  const request = pool.request();
  bindWindow(request, win);
  request.input('limite', sql.Int, filtro.limit);
  request.input('catraca', sql.NVarChar(160), likeBind(filtro.catraca));
  request.input('codigo', sql.NVarChar(160), likeBind(filtro.codigo));
  const batch = [
    PREAMBLE,
    windowDecl(),
    'SELECT TOP (@limite) A.ID AS id, CONVERT(varchar(19), A.Uhrzeit, 120) AS hora,' +
      ' RTRIM(A.Punktname) AS catraca, A.Alarmtext AS texto, A.CardNumber AS codigo,' +
      ' CAT.categoria AS categoria,' +
      ' PRIM.hora AS primeiraHora, PRIM.catraca AS primeiraCatraca,' +
      ' ULT.hora AS ultimaHora, ULT.catraca AS ultimaCatraca' +
      ' FROM dbo.SIST_ALOG A' +
      ' OUTER APPLY (' +
      '   SELECT TOP 1 CONVERT(varchar(19), Z.Uhrzeit, 120) AS hora, RTRIM(Z.Ort) AS catraca' +
      '   FROM dbo.SIST_ZLOG Z' +
      '   WHERE Z.CardNumber = A.CardNumber AND Z.Uhrzeit >= @dini AND Z.Uhrzeit < @dfim' +
      '   ORDER BY Z.Uhrzeit ASC, Z.ID ASC' +
      ' ) PRIM' +
      ' OUTER APPLY (' +
      '   SELECT TOP 1 CONVERT(varchar(19), Z.Uhrzeit, 120) AS hora, RTRIM(Z.Ort) AS catraca' +
      '   FROM dbo.SIST_ZLOG Z' +
      '   WHERE Z.CardNumber = A.CardNumber AND Z.Uhrzeit >= @dini AND Z.Uhrzeit < @dfim' +
      '   ORDER BY Z.Uhrzeit DESC, Z.ID DESC' +
      ' ) ULT' +
      categoriaApply() +
      ' WHERE A.Uhrzeit >= @dini AND A.Uhrzeit < @dfim AND ' + alarmPredicate(cfg, 'A') +
      ' AND (@catraca = N\'\' OR RTRIM(A.Punktname) LIKE N\'%\' + @catraca + N\'%\')' +
      ' AND (@codigo = N\'\' OR A.CardNumber LIKE N\'%\' + @codigo + N\'%\')' +
      ' ORDER BY A.ID DESC;',
  ].join('\n');
  const result = await request.query(batch);
  return (result.recordset || []).map(mapAlarme);
}

async function queryReads(pool, cfg, win, filtro) {
  const request = pool.request();
  bindWindow(request, win);
  request.input('limite', sql.Int, filtro.limit);
  request.input('catraca', sql.NVarChar(160), likeBind(filtro.catraca));
  request.input('codigo', sql.NVarChar(160), likeBind(filtro.codigo));
  request.input('setor', sql.NVarChar(160), likeBind(filtro.setor));
  const batch = [
    PREAMBLE,
    windowDecl(),
    'SELECT TOP (@limite) ' + leituraSelect('Z') +
      ' FROM dbo.SIST_ZLOG Z' +
      ' WHERE Z.Uhrzeit >= @dini AND Z.Uhrzeit < @dfim AND ' + zlogPredicate(cfg, 'Z') +
      ' AND (@catraca = N\'\' OR RTRIM(Z.Ort) LIKE N\'%\' + @catraca + N\'%\')' +
      ' AND (@codigo = N\'\' OR Z.CardNumber LIKE N\'%\' + @codigo + N\'%\')' +
      ' AND (@setor = N\'\' OR LTRIM(RTRIM(Z.PersField5)) LIKE N\'%\' + @setor + N\'%\'' +
      '   OR (@setor = N\'CAMAROTES\' AND LTRIM(RTRIM(Z.PersField5)) LIKE N\'CAMAROTE%\')' +
      '   OR (@setor = N\'LOUNGES\' AND LTRIM(RTRIM(Z.PersField5)) LIKE N\'LOUNGE%\'))' +
      ' ORDER BY Z.ID DESC;',
  ].join('\n');
  const result = await request.query(batch);
  return (result.recordset || []).map(mapLeitura);
}

function idsCte() {
  return (
    'WITH exatos AS (' +
    ' SELECT TOP (20) d.Data_Auto_ID, 1 AS prio FROM (' +
    '   SELECT DISTINCT P.Data_Auto_ID' +
    '   FROM dbo.SIST_Pers P' +
    '   LEFT JOIN dbo.SIST_PersFreeDef F5 ON F5.IDPers = P.Data_Auto_ID AND F5.IDXFREEDEF = 5' +
    '   WHERE P.DATA_20_Person_no_PN = @q OR F5.val = @q' +
    ' ) d ORDER BY d.Data_Auto_ID' +
    '), porCodigo AS (' +
    ' SELECT TOP (20) P.Data_Auto_ID, 2 AS prio' +
    ' FROM dbo.SIST_Pers P' +
    ' WHERE LEN(@q) = 24 AND NOT EXISTS (SELECT 1 FROM exatos)' +
    '   AND P.DATA_20_Person_no_PN = SUBSTRING(@q, 2, 14)' +
    ' ORDER BY P.Data_Auto_ID' +
    '), porPrefixo AS (' +
    ' SELECT TOP (20) P.Data_Auto_ID, 3 AS prio' +
    ' FROM dbo.SIST_Pers P' +
    ' WHERE LEN(@q) BETWEEN 6 AND 13' +
    '   AND NOT EXISTS (SELECT 1 FROM exatos)' +
    '   AND NOT EXISTS (SELECT 1 FROM porCodigo)' +
    '   AND P.DATA_20_Person_no_PN LIKE @q + \'%\'' +
    ' ORDER BY P.Data_Auto_ID' +
    '), ids AS (' +
    ' SELECT TOP (20) u.Data_Auto_ID FROM (' +
    '   SELECT Data_Auto_ID, prio FROM exatos' +
    '   UNION ALL SELECT Data_Auto_ID, prio FROM porCodigo' +
    '   UNION ALL SELECT Data_Auto_ID, prio FROM porPrefixo' +
    ' ) u ORDER BY u.prio, u.Data_Auto_ID' +
    ')'
  );
}

function freedefCols() {
  const parts = [];
  for (let i = 1; i <= 20; i++) {
    parts.push('MAX(CASE WHEN F.IDXFREEDEF = ' + i + ' THEN F.val END) AS DATA_FREEDEF' + i);
  }
  return parts.join(', ');
}

function mapCadastro(row) {
  const freedef = {};
  for (let i = 1; i <= 20; i++) {
    freedef[String(i)] = text(row['DATA_FREEDEF' + i]);
  }
  return {
    id: num(row.id),
    codigo: text(row.codigo),
    versao: text(row.versao),
    validadeDe: text(row.validadeDe),
    validadeAte: text(row.validadeAte),
    perfis: text(row.perfis),
    persStatus: text(row.persStatus),
    categoria: text(row.categoria),
    portao: text(row.portao),
    posicao: row.posicao == null || row.posicao === '' ? null : num(row.posicao),
    tenantId: text(row.tenantId),
    ident: text(row.ident),
    setor: freedef['4'] || '',
    codigoBarras: freedef['5'] || '',
    freedef: freedef,
  };
}

async function querySearch(pool, cfg, win, q) {
  const request = pool.request();
  bindWindow(request, win);
  request.input('q', sql.VarChar(64), q);
  const cadastroSql =
    idsCte() +
    ' SELECT P.Data_Auto_ID AS id,' +
    ' P.DATA_20_Person_no_PN AS codigo,' +
    ' P.DATA_20_Version_VN AS versao,' +
    ' CONVERT(varchar(19), P.DATA_20_Validfor_D1, 120) AS validadeDe,' +
    ' CONVERT(varchar(19), P.DATA_20_Validto_D2, 120) AS validadeAte,' +
    ' dbo.GetStdProfiles(P.Data_Auto_ID) AS perfis,' +
    ' dbo.PersStatus(P.DATA_20_Lockflag_OF, P.DATA_20_Validto_D2, P.DATA_20_Validfor_D1, P.DATA_NOT_SYNC, GETDATE()) AS persStatus,' +
    ' P.DATA_20_Name_NA AS categoria,' +
    ' P.DATA_20_Surname_NA AS portao,' +
    ' P.DATA_20_Room_RN AS posicao,' +
    ' P.TenantID AS tenantId,' +
    ' P.DATA_20_Ident_no_CN AS ident,' +
    ' X.DATA_FREEDEF1, X.DATA_FREEDEF2, X.DATA_FREEDEF3, X.DATA_FREEDEF4, X.DATA_FREEDEF5,' +
    ' X.DATA_FREEDEF6, X.DATA_FREEDEF7, X.DATA_FREEDEF8, X.DATA_FREEDEF9, X.DATA_FREEDEF10,' +
    ' X.DATA_FREEDEF11, X.DATA_FREEDEF12, X.DATA_FREEDEF13, X.DATA_FREEDEF14, X.DATA_FREEDEF15,' +
    ' X.DATA_FREEDEF16, X.DATA_FREEDEF17, X.DATA_FREEDEF18, X.DATA_FREEDEF19, X.DATA_FREEDEF20' +
    ' FROM dbo.SIST_Pers P' +
    ' INNER JOIN ids I ON I.Data_Auto_ID = P.Data_Auto_ID' +
    ' LEFT JOIN (' +
    '   SELECT F.IDPers, ' + freedefCols() +
    '   FROM dbo.SIST_PersFreeDef F' +
    '   INNER JOIN ids I2 ON I2.Data_Auto_ID = F.IDPers' +
    '   GROUP BY F.IDPers' +
    ' ) X ON X.IDPers = P.Data_Auto_ID;';

  const readsSql =
    idsCte() +
    ' SELECT ' + leituraSelect('Z') +
    ' FROM dbo.SIST_ZLOG Z' +
    ' WHERE Z.Uhrzeit >= @dini AND Z.Uhrzeit < @dfim' +
    ' AND Z.CardNumber IN (SELECT P.DATA_20_Person_no_PN FROM dbo.SIST_Pers P INNER JOIN ids I ON I.Data_Auto_ID = P.Data_Auto_ID)' +
    ' ORDER BY Z.Uhrzeit ASC, Z.ID ASC;';

  const alarmsSql =
    idsCte() +
    ' SELECT A.ID AS id, CONVERT(varchar(19), A.Uhrzeit, 120) AS hora,' +
    ' RTRIM(A.Punktname) AS catraca, A.Alarmtext AS texto, A.CardNumber AS codigo' +
    ' FROM dbo.SIST_ALOG A' +
    ' WHERE A.Uhrzeit >= @dini AND A.Uhrzeit < @dfim' +
    ' AND A.CardNumber IN (SELECT P.DATA_20_Person_no_PN FROM dbo.SIST_Pers P INNER JOIN ids I ON I.Data_Auto_ID = P.Data_Auto_ID)' +
    ' ORDER BY A.Uhrzeit ASC, A.ID ASC;';

  const avulsoReads =
    'SELECT ' + leituraSelect('Z') +
    ' FROM dbo.SIST_ZLOG Z' +
    ' WHERE Z.Uhrzeit >= @dini AND Z.Uhrzeit < @dfim' +
    ' AND (Z.CardNumber = @q OR (LEN(@q) = 24 AND Z.CardNumber = SUBSTRING(@q, 2, 14)))' +
    ' ORDER BY Z.Uhrzeit ASC, Z.ID ASC;';

  const avulsoAlarms =
    'SELECT A.ID AS id, CONVERT(varchar(19), A.Uhrzeit, 120) AS hora,' +
    ' RTRIM(A.Punktname) AS catraca, A.Alarmtext AS texto, A.CardNumber AS codigo' +
    ' FROM dbo.SIST_ALOG A' +
    ' WHERE A.Uhrzeit >= @dini AND A.Uhrzeit < @dfim' +
    ' AND (A.CardNumber = @q OR (LEN(@q) = 24 AND A.CardNumber = SUBSTRING(@q, 2, 14))' +
    '   OR A.Alarmtext LIKE N\'%\' + @q + N\'%\')' +
    ' ORDER BY A.Uhrzeit ASC, A.ID ASC;';

  const batch = [PREAMBLE, windowDecl(), cadastroSql, readsSql, alarmsSql, avulsoReads, avulsoAlarms].join('\n');
  const result = await request.query(batch);
  const sets = result.recordsets || [];
  return {
    cadastros: (sets[0] || []).map(mapCadastro),
    leituras: (sets[1] || []).map(mapLeitura),
    alarmes: (sets[2] || []).map(mapAlarme),
    avulsoLeituras: (sets[3] || []).map(mapLeitura),
    avulsoAlarmes: (sets[4] || []).map(mapAlarme),
  };
}

const CHECKS = [
  { nome: 'SIST_ZLOG', objeto: 'dbo.SIST_ZLOG', permissao: 'SELECT' },
  { nome: 'SIST_Pers', objeto: 'dbo.SIST_Pers', permissao: 'SELECT' },
  { nome: 'SIST_PersFreeDef', objeto: 'dbo.SIST_PersFreeDef', permissao: 'SELECT' },
  { nome: 'SIST_ALOG', objeto: 'dbo.SIST_ALOG', permissao: 'SELECT' },
  { nome: 'GetStdProfiles', objeto: 'dbo.GetStdProfiles', permissao: 'EXECUTE' },
  { nome: 'PersStatus', objeto: 'dbo.PersStatus', permissao: 'EXECUTE' },
];

async function probeConnection(pool) {
  const info = await pool.request().query(
    PREAMBLE +
    ' SELECT CONVERT(varchar(128), @@SERVERNAME) AS servidor,' +
    ' DB_NAME() AS banco,' +
    ' SUSER_SNAME() AS usuario,' +
    ' CONVERT(varchar(300), @@VERSION) AS versao,' +
    ' CONVERT(varchar(19), GETDATE(), 120) AS hora;'
  );
  const cols = CHECKS.map(function (item, index) {
    return (
      'OBJECT_ID(N\'' + item.objeto + '\') AS id' + index +
      ', HAS_PERMS_BY_NAME(N\'' + item.objeto + '\', N\'OBJECT\', N\'' + item.permissao + '\') AS perm' + index
    );
  }).join(', ');
  const perm = await pool.request().query(PREAMBLE + ' SELECT ' + cols + ';');
  const row = (info.recordset && info.recordset[0]) || {};
  const prow = (perm.recordset && perm.recordset[0]) || {};
  return {
    servidor: text(row.servidor),
    banco: text(row.banco),
    usuario: text(row.usuario),
    versao: text(row.versao).replace(/\s+/g, ' ').trim(),
    hora: text(row.hora),
    checklist: CHECKS.map(function (item, index) {
      const id = prow['id' + index];
      const okPerm = Number(prow['perm' + index]) === 1;
      const existe = id != null && id !== '';
      return {
        nome: item.nome,
        objeto: item.objeto,
        permissao: item.permissao,
        existe: existe,
        permitido: okPerm,
        ok: existe && okPerm,
      };
    }),
  };
}

function versoesSql(versions) {
  const src = Array.isArray(versions) ? versions : [];
  const out = [];
  src.forEach(function (item) {
    const s = String(item == null ? '' : item).trim();
    if (!/^[0-9A-Za-z._-]{1,32}$/.test(s)) return;
    if (out.indexOf(s) === -1) out.push(s);
  });
  if (!out.length) out.push('10');
  return out;
}

function erroCurto(err) {
  return String(err && err.message || err || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function attemptQuery(pool, sqlText) {
  return pool.request().query(PREAMBLE + '\n' + sqlText).then(function (result) {
    return { ok: true, rows: result.recordset || [] };
  }, function (err) {
    return { ok: false, erro: erroCurto(err) };
  });
}

async function queryImportacao(pool, versions) {
  const list = versoesSql(versions);
  const inn = list.map(nvar).join(', ');
  const where = 'DATA_20_Version_VN IN (' + inn + ')';
  const erros = { kernel: null, fila: null, totais: null, perfis: null };

  const kernelSql = 'SELECT COUNT(ID) AS kernel FROM dbo.KernelSynchro';
  const totaisSql =
    'SELECT COUNT(DATA_20_Ident_no_CN) AS total,' +
    ' SUM(CASE WHEN DATA_20_Lockflag_OF <> N\'\' THEN 1 ELSE 0 END) AS bloqueados,' +
    ' SUM(CASE WHEN DATA_20_Lockflag_OF = N\'\' THEN 1 ELSE 0 END) AS ativos' +
    ' FROM dbo.SIST_Pers WHERE ' + where;
  const filaSql = 'SELECT COUNT(ID) AS fila FROM dbo.SIST_Pers_Import WHERE ' + where;
  const perfisSql =
    'WITH Base AS (' +
    ' SELECT dbo.GetStdProfiles(Data_Auto_ID) AS STD_PROFILES,' +
    ' DATA_20_Ident_no_CN,' +
    ' CASE WHEN DATA_20_Lockflag_OF <> N\'\' THEN 1 ELSE 0 END AS IS_BLOQUEADO' +
    ' FROM dbo.SIST_Pers WHERE ' + where +
    ') SELECT STD_PROFILES, COUNT(DATA_20_Ident_no_CN) AS ATIVOS, SUM(IS_BLOQUEADO) AS BLOQUEADOS' +
    ' FROM Base GROUP BY STD_PROFILES';

  const parts = await Promise.all([
    attemptQuery(pool, kernelSql),
    attemptQuery(pool, totaisSql),
    attemptQuery(pool, filaSql),
    attemptQuery(pool, perfisSql),
  ]);

  const kernelPart = parts[0];
  const totaisPart = parts[1];
  const filaPart = parts[2];
  const perfisPart = parts[3];

  if (!kernelPart.ok) erros.kernel = kernelPart.erro;
  if (!totaisPart.ok) erros.totais = totaisPart.erro;
  if (!filaPart.ok) erros.fila = filaPart.erro;
  if (!perfisPart.ok) erros.perfis = perfisPart.erro;

  const totaisRow = totaisPart.ok ? (totaisPart.rows[0] || {}) : {};
  const filaRow = filaPart.ok ? (filaPart.rows[0] || {}) : {};
  const perfis = perfisPart.ok ? perfisPart.rows.map(function (row) {
    const nome = text(row.STD_PROFILES);
    return {
      perfil: nome || 'SEM PROFILE',
      ativos: num(row.ATIVOS),
      bloqueados: num(row.BLOQUEADOS),
    };
  }) : [];
  perfis.sort(function (a, b) {
    return b.ativos - a.ativos || String(a.perfil).localeCompare(String(b.perfil));
  });

  return {
    kernel: kernelPart.ok ? num(kernelPart.rows[0] && kernelPart.rows[0].kernel) : null,
    totais: {
      total: totaisPart.ok ? num(totaisRow.total) : null,
      fila: filaPart.ok ? num(filaRow.fila) : null,
      bloqueados: totaisPart.ok ? num(totaisRow.bloqueados) : null,
      ativos: totaisPart.ok ? num(totaisRow.ativos) : null,
    },
    perfis: perfis,
    erros: erros,
  };
}

function orderTickets(ordem) {
  if (ordem === 'setor') return 'b.setor, b.codigo';
  if (ordem === 'leitura') return 'CASE WHEN b.primeira IS NULL THEN 1 ELSE 0 END, b.primeira DESC, b.codigo';
  if (ordem === 'naolidos') return 'CASE WHEN b.primeira IS NULL THEN 0 ELSE 1 END, b.setor, b.codigo';
  return 'b.codigo';
}

function mapProfileSql(cfg, setorTexto) {
  const needle = perfisLib.setorNeedle(setorTexto).toLowerCase();
  if (!needle) return '';
  const map = cfg.perfisSetor || {};
  const parts = [];
  Object.keys(map).forEach(function (key) {
    if (!/^[A-Z0-9]+(,[A-Z0-9]+)*$/.test(key)) return;
    const nome = String(map[key] || '');
    if (nome.toLowerCase().indexOf(needle) === -1) return;
    const checks = key.split(',').map(function (code) {
      return 'CHARINDEX(N\',' + code + ',\', N\',\' + REPLACE(UPPER(ISNULL(dbo.GetStdProfiles(P.Data_Auto_ID), N\'\')), N\' \', N\'\') + N\',\') > 0';
    });
    parts.push('(' + checks.join(' AND ') + ')');
  });
  return parts.join(' OR ');
}

function setorWhere(cfg, filtro) {
  if (!filtro.setor) return '';
  const mapSql = mapProfileSql(cfg, filtro.setor);
  return (
    ' AND (' +
    ' LTRIM(RTRIM(ISNULL(F4.val, N\'\'))) LIKE N\'%\' + @setor + N\'%\'' +
    ' OR (NULLIF(LTRIM(RTRIM(ISNULL(F4.val, N\'\'))), N\'\') IS NULL AND (' +
    ' ISNULL(dbo.GetStdProfiles(P.Data_Auto_ID), N\'\') LIKE N\'%\' + @setor + N\'%\'' +
    (mapSql ? ' OR ' + mapSql : '') +
    ')))'
  );
}

function lidosAgg(cfg) {
  return (
    'lidos AS (' +
    ' SELECT z.CardNumber, MIN(z.Uhrzeit) AS primeira, MAX(z.Uhrzeit) AS ultima, COUNT(*) AS n' +
    ' FROM dbo.SIST_ZLOG z' +
    ' WHERE z.Uhrzeit >= @dini AND z.Uhrzeit < @dfim AND ' + zlogPredicate(cfg, 'z') +
    ' GROUP BY z.CardNumber)'
  );
}

function ticketsCte(cfg, filtro) {
  const versaoSql = filtro.versao
    ? ' AND LTRIM(RTRIM(CONVERT(nvarchar(32), P.DATA_20_Version_VN))) = @versao'
    : '';
  return (
    'WITH ' + lidosAgg(cfg) + ', b AS (' +
    ' SELECT P.Data_Auto_ID AS id, P.DATA_20_Person_no_PN AS codigo,' +
    ' CONVERT(nvarchar(32), P.DATA_20_Version_VN) AS versao,' +
    ' P.DATA_20_Name_NA AS categoria, P.DATA_20_Surname_NA AS portao,' +
    ' CONVERT(varchar(19), P.DATA_20_Validfor_D1, 120) AS validoDe,' +
    ' CONVERT(varchar(19), P.DATA_20_Validto_D2, 120) AS validoAte,' +
    ' P.DATA_20_Ident_no_CN AS ident,' +
    ' F4.val AS setor, F5.val AS codigoBarras,' +
    ' CONVERT(varchar(19), l.primeira, 120) AS primeira,' +
    ' CONVERT(varchar(19), l.ultima, 120) AS ultima,' +
    ' ISNULL(l.n, 0) AS leituras' +
    ' FROM dbo.SIST_Pers P' +
    ' LEFT JOIN dbo.SIST_PersFreeDef F4 ON F4.IDPers = P.Data_Auto_ID AND F4.IDXFREEDEF = 4' +
    ' LEFT JOIN dbo.SIST_PersFreeDef F5 ON F5.IDPers = P.Data_Auto_ID AND F5.IDXFREEDEF = 5' +
    ' LEFT JOIN lidos l ON l.CardNumber = P.DATA_20_Person_no_PN' +
    ' WHERE ' + versionPredicate(cfg, 'P') + ' AND ' + validWhere() + versaoSql +
    ' AND (@codigo = N\'\' OR P.DATA_20_Person_no_PN LIKE N\'%\' + @codigo + N\'%\' OR F5.val LIKE N\'%\' + @codigo + N\'%\')' +
    ' AND (@status = N\'\' OR (@status = N\'lidos\' AND l.primeira IS NOT NULL) OR (@status = N\'naolidos\' AND l.primeira IS NULL))' +
    setorWhere(cfg, filtro) +
    ')'
  );
}

function mapTicket(row) {
  return {
    codigo: text(row.codigo),
    versao: text(row.versao),
    codigoBarras: text(row.codigoBarras),
    ident: text(row.ident),
    setor: text(row.setor),
    categoria: text(row.categoria),
    portao: text(row.portao),
    perfis: text(row.perfis),
    validoDe: text(row.validoDe),
    validoAte: text(row.validoAte),
    leituras: num(row.leituras),
    primeira: text(row.primeira),
    primeiraCatraca: text(row.primeiraCatraca),
    ultima: text(row.ultima),
  };
}

async function queryTickets(pool, cfg, win, filtro) {
  const request = pool.request();
  request.timeout = 180000;
  bindWindow(request, win);
  request.input('off', sql.Int, filtro.offset);
  request.input('n', sql.Int, filtro.limit);
  request.input('codigo', sql.NVarChar(160), likeBind(filtro.codigo));
  request.input('setor', sql.NVarChar(160), likeBind(perfisLib.setorNeedle(filtro.setor)));
  request.input('status', sql.NVarChar(16), filtro.status || '');
  request.input('versao', sql.NVarChar(32), filtro.versao || '');
  const cte = ticketsCte(cfg, filtro);
  const batch = [
    PREAMBLE,
    windowDecl(),
    cte + ' SELECT COUNT(*) AS total, SUM(CASE WHEN b.primeira IS NULL THEN 0 ELSE 1 END) AS lidos FROM b;',
    cte + ' SELECT b.*, dbo.GetStdProfiles(b.id) AS perfis, fz.catraca AS primeiraCatraca FROM b' +
      ' OUTER APPLY (SELECT TOP 1 RTRIM(z.Ort) AS catraca FROM dbo.SIST_ZLOG z' +
      ' WHERE z.CardNumber = b.codigo AND z.Uhrzeit >= @dini AND z.Uhrzeit < @dfim ORDER BY z.Uhrzeit) fz' +
      ' ORDER BY ' + orderTickets(filtro.ordem) +
      ' OFFSET @off ROWS FETCH NEXT @n ROWS ONLY;',
  ].join('\n');
  const result = await request.query(batch);
  const sets = result.recordsets || [];
  const tot = (sets[0] && sets[0][0]) || {};
  return {
    total: num(tot.total),
    lidos: num(tot.lidos),
    rows: (sets[1] || []).map(mapTicket),
  };
}

function reportRequest(pool, win) {
  const request = pool.request();
  request.timeout = 600000;
  bindWindow(request, win);
  return request;
}

async function queryRelatorioBase(pool, cfg, win) {
  const request = reportRequest(pool, win);
  const cols = [];
  for (let i = 1; i <= 20; i++) cols.push('X.DATA_FREEDEF' + i);
  const sqlText = [
    PREAMBLE,
    windowDecl(),
    'SELECT P.DATA_20_Person_no_PN, P.DATA_20_Version_VN,' +
      ' CONVERT(varchar(19), P.DATA_20_Validfor_D1, 120) AS DATA_20_Validfor_D1,' +
      ' CONVERT(varchar(19), P.DATA_20_Validto_D2, 120) AS DATA_20_Validto_D2,' +
      ' dbo.GetStdProfiles(P.Data_Auto_ID) AS STD_PROFILES,' +
      ' dbo.PersStatus(P.DATA_20_Lockflag_OF, P.DATA_20_Validto_D2, P.DATA_20_Validfor_D1, P.DATA_NOT_SYNC, GETDATE()) AS PersStatus,' +
      ' P.DATA_20_Name_NA, P.DATA_20_Surname_NA, P.DATA_20_Room_RN, ' + cols.join(', ') + ',' +
      ' P.TenantID AS Expr2, P.DATA_20_Ident_no_CN' +
      ' FROM dbo.SIST_Pers P' +
      ' LEFT JOIN (' +
      '   SELECT F.IDPers, ' + freedefCols() +
      '   FROM dbo.SIST_PersFreeDef F' +
      '   WHERE F.IDPers IN (SELECT P2.Data_Auto_ID FROM dbo.SIST_Pers P2 WHERE ' +
      versionPredicate(cfg, 'P2') + ' AND P2.DATA_20_Validto_D2 >= @dini AND P2.DATA_20_Validfor_D1 < @dfim)' +
      '   GROUP BY F.IDPers' +
      ' ) X ON X.IDPers = P.Data_Auto_ID' +
      ' WHERE ' + versionPredicate(cfg, 'P') + ' AND ' + validWhere() + ';',
  ].join('\n');
  const result = await request.query(sqlText);
  return result.recordset || [];
}

async function queryRelatorioAlarmes(pool, cfg, win) {
  const request = reportRequest(pool, win);
  const sqlText = [
    PREAMBLE,
    windowDecl(),
    'SELECT CONVERT(varchar(19), A.Uhrzeit, 120) AS Uhrzeit, A.Punktname, A.Alarmtext, A.CardNumber, A.ID' +
      ' FROM dbo.SIST_ALOG A' +
      ' WHERE A.Uhrzeit >= @dini AND A.Uhrzeit < @dfim AND ' + alarmPredicate(cfg, 'A') +
      ' ORDER BY A.Uhrzeit DESC;',
  ].join('\n');
  const result = await request.query(sqlText);
  return result.recordset || [];
}

async function queryRelatorioAcessos(pool, cfg, win) {
  const request = reportRequest(pool, win);
  const sqlText = [
    PREAMBLE,
    windowDecl(),
    'SELECT CONVERT(varchar(19), Z.Uhrzeit, 120) AS Data_hora, Z.Ort AS Catraca,' +
      ' Z.Person AS Info_ingresso, Z.CardNumber AS Codigo_Ingresso,' +
      ' Z.PersField1 AS Codigo_ticketeira, Z.PersField2 AS Freedef1, Z.PersField3 AS Freedef2,' +
      ' Z.PersField4 AS Freedef3, Z.PersField5 AS Freedef4, Z.PersField6 AS Freedef5,' +
      ' Z.PersField7 AS Freddef6, Z.ID' +
      ' FROM dbo.SIST_ZLOG Z' +
      ' WHERE Z.Uhrzeit >= @dini AND Z.Uhrzeit < @dfim AND ' + zlogPredicate(cfg, 'Z') +
      ' ORDER BY Z.Uhrzeit DESC;',
  ].join('\n');
  const result = await request.query(sqlText);
  return result.recordset || [];
}

module.exports = {
  querySummary: querySummary,
  queryFeed: queryFeed,
  queryAlarms: queryAlarms,
  queryReads: queryReads,
  querySearch: querySearch,
  queryTickets: queryTickets,
  queryRelatorioBase: queryRelatorioBase,
  queryRelatorioAlarmes: queryRelatorioAlarmes,
  queryRelatorioAcessos: queryRelatorioAcessos,
  queryImportacao: queryImportacao,
  probeConnection: probeConnection,
};
