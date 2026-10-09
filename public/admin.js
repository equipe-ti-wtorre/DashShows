(function () {
  'use strict';

  var DEFAULT_WEATHER_LAT = '-23.5274';
  var DEFAULT_WEATHER_LON = '-46.6794';
  var DEFAULT_LOGO_URL = '/logo-nubank-parque.png';
  var BEPASS_AUTH_URL = 'https://authsso.bepass.app/realms/bepass/protocol/openid-connect/token';

  var state = {
    shows: [],
    activeShowId: null,
    selectedId: null,
    mode: 'create',
    defaultSectorNames: {},
    db: null,
    historyMysql: null,
    sectorRows: [],
    savedSectorNames: {},
    theme: 'default',
    savedTheme: 'default',
    filter: 'all',
    search: '',
    snapshot: '',
    filling: false,
    currentTab: 'geral',
  };

  var el = {};

  function bindEls() {
    var ids = [
      'loginView', 'appView', 'loginForm', 'loginPassword', 'loginError', 'loginBtn',
      'logoutBtn', 'envBadge', 'btnSettings', 'lnkSettings', 'btnBack',
      'showSearch', 'showFilters', 'showsList', 'newShowBtn',
      'showForm', 'viewEditor', 'viewSettings', 'formTitle', 'urlBox',
      'publicUrlText', 'copyUrlBtn', 'openUrlBtn', 'showState',
      'showId', 'showType', 'title', 'slug', 'eventName', 'eventDate',
      'venueName', 'venueCity', 'gateOpenTime', 'coordManual',
      'coordLatField', 'coordLonField', 'weatherLat', 'weatherLon',
      'boletiusFields', 'ccoFields', 'bepassFields',
      'eventId', 'showIdBoletius', 'apiKey',
      'bepassEventId', 'companyId', 'authUser', 'authPassword', 'authUrl', 'clientId', 'bepassAdvanced',
      'version', 'mockData',
      'loadSectorsBtn', 'addSectorBtn', 'sectorsList', 'sectorsMsg', 'sectorsCount',
      'sectorsHint', 'sectorsCcoBox', 'sectorsEmpty',
      'logoUrl', 'logoFile', 'logoThumb', 'logoName', 'logoMeta', 'changeLogoBtn', 'clearLogoBtn',
      'artFile', 'showArtUrl', 'artPreview', 'artPreviewImg', 'artPreviewEmpty',
      'artThumb', 'artName', 'artMeta', 'changeArtBtn', 'clearArtBtn',
      'artFitControls', 'artZoom', 'artX', 'artY', 'artZoomVal', 'artXVal', 'artYVal', 'artFitReset',
      'showTheme', 'showThemeOptions',
      'historyEnabledShow', 'historyIntervalSecShow',
      'dirtyLabel', 'dirtyText', 'discardBtn', 'saveBtn', 'formMsg',
      'publishBtn', 'setHomeBtn', 'duplicateBtn',
      'finalizeBtn', 'reopenBtn', 'deleteBtn',
      'dbForm', 'dbHost', 'dbPort', 'dbDatabase', 'dbUser', 'dbPassword', 'dbEncrypt',
      'dbSaveBtn', 'dbTestBtn', 'dbMsg', 'dbStatus',
      'historyForm', 'historyEnabled', 'historyHost', 'historyPort', 'historyDatabase',
      'historyUser', 'historyPassword', 'historyIntervalSec',
      'historySaveBtn', 'historyTestBtn', 'historyMsg', 'historyStatus',
      'themeOptions', 'themeSaveBtn', 'themeMsg',
    ];
    for (var i = 0; i < ids.length; i++) {
      el[ids[i]] = document.getElementById(ids[i]);
    }
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function parseGateOpenTime(value) {
    var parts = String(value || '').split(':');
    var hour = Number(parts[0]);
    var minute = Number(parts[1]);
    if (isNaN(hour) || hour < 0 || hour > 23) hour = 16;
    if (isNaN(minute) || minute < 0 || minute > 59) minute = 0;
    return { hour: hour, minute: minute };
  }

  function formatGateOpenTime(hour, minute) {
    var h = Number(hour);
    var m = Number(minute);
    if (isNaN(h) || h < 0 || h > 23) h = 16;
    if (isNaN(m) || m < 0 || m > 59) m = 0;
    return pad2(h) + ':' + pad2(m);
  }

  function formatShortDate(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
    if (!m) return '';
    var months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    return Number(m[3]) + ' ' + months[Number(m[2]) - 1];
  }

  function typeLabel(type) {
    if (type === 'cco') return 'SiPort';
    if (type === 'bepass') return 'BePass';
    return 'Boletus';
  }

  function showLifecycle(show) {
    if (show && show.isFinalized) return 'done';
    if (show && show.published) return 'live';
    return 'draft';
  }

  function api(path, options) {
    var opts = options || {};
    return fetch(path, Object.assign({
      credentials: 'same-origin',
      cache: 'no-store',
    }, opts)).then(function (res) {
      return res.json().catch(function () {
        return {};
      }).then(function (body) {
        if (!res.ok) {
          throw new Error((body && body.error) || ('HTTP ' + res.status));
        }
        return body;
      });
    });
  }

  function setMsg(text, isError) {
    if (!el.formMsg) return;
    el.formMsg.textContent = text || '';
    el.formMsg.classList.toggle('is-error', !!isError);
  }

  function setDbMsg(text, isError) {
    el.dbMsg.textContent = text || '';
    el.dbMsg.classList.toggle('is-error', !!isError);
  }

  function setHistoryMsg(text, isError) {
    el.historyMsg.textContent = text || '';
    el.historyMsg.classList.toggle('is-error', !!isError);
  }

  function setThemeMsg(text, isError) {
    el.themeMsg.textContent = text || '';
    el.themeMsg.classList.toggle('is-error', !!isError);
  }

  function setSectorsMsg(text, isError) {
    el.sectorsMsg.textContent = text || '';
    el.sectorsMsg.classList.toggle('is-error', !!isError);
  }

  function setStatusLine(node, text, kind) {
    if (!node) return;
    node.classList.toggle('is-ok', kind === 'ok');
    node.classList.toggle('is-err', kind === 'err');
    node.innerHTML = '<span class="dot ' + (kind === 'ok' ? 'live' : 'draft') + '"></span>' + escapeHtml(text);
  }

  function formatRecords(n) {
    if (n == null || isNaN(n)) return '';
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace('.', ',') + ' mi de registros';
    if (n >= 1000) return Math.round(n / 100) / 10 + ' mil registros';
    return n + ' registro' + (n === 1 ? '' : 's');
  }

  function normalizeTheme(value) {
    return value === 'nubank-parque' ? 'nubank-parque' : 'default';
  }

  function syncPaletteGroup(root, value) {
    if (!root) return;
    var cards = root.querySelectorAll('.pal');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var theme = card.getAttribute('data-theme') || '';
      card.setAttribute('aria-pressed', theme === String(value || '') ? 'true' : 'false');
    }
  }

  function fileNameFromUrl(url) {
    if (!url) return 'Nenhum arquivo';
    try {
      return decodeURIComponent(String(url).split('/').pop() || url);
    } catch (_) {
      return String(url).split('/').pop() || url;
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, '&#39;');
  }

  function collectSectorNamesFromDom() {
    var out = {};
    if (!el.sectorsList) return out;
    var rows = el.sectorsList.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
      var codeInput = rows[i].querySelector('[data-sector-code-edit]');
      var nameInput = rows[i].querySelector('[data-sector-name]');
      var code = codeInput
        ? codeInput.value.trim()
        : (nameInput && nameInput.getAttribute('data-sector-code')) || '';
      if (!code || !nameInput) continue;
      out[code] = nameInput.value.trim() || code;
    }
    return out;
  }

  function renderSectorsEditor(sectors, nameHints) {
    var hints = nameHints || {};
    var current = collectSectorNamesFromDom();
    var rows = Array.isArray(sectors) ? sectors : [];
    state.sectorRows = rows;

    if (!el.sectorsList) return;
    if (!rows.length) {
      el.sectorsList.innerHTML =
        '<tr><td colspan="4" class="empty-list">Nenhum setor. Carregue do SiPort ou adicione manualmente.</td></tr>';
      updateSectorsCount();
      return;
    }

    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var code = rows[i].code;
      var name =
        current[code] ||
        state.savedSectorNames[code] ||
        hints[code] ||
        state.defaultSectorNames[code] ||
        code;
      var total = rows[i].total != null ? rows[i].total : '—';
      var editable = !!rows[i].manual;
      html +=
        '<tr>' +
          '<td>' + (editable
            ? '<input type="text" class="mono" data-sector-code-edit maxlength="64" value="' + escapeAttr(code) + '" />'
            : '<span class="code">' + escapeHtml(code) + '</span>') +
          '</td>' +
          '<td><input type="text" data-sector-name data-sector-code="' + escapeAttr(code) + '" value="' + escapeAttr(name) + '" maxlength="80" /></td>' +
          '<td class="num">' + escapeHtml(String(total)) + '</td>' +
          '<td><button type="button" class="rowbtn" data-remove-sector aria-label="Remover setor">✕</button></td>' +
        '</tr>';
    }
    el.sectorsList.innerHTML = html;
    updateSectorsCount();
  }

  function renderSectorsFromSavedMap(map) {
    var names = map || {};
    var codes = Object.keys(names);
    var rows = codes.map(function (code) {
      return { code: code, total: null };
    });
    state.savedSectorNames = Object.assign({}, names);
    renderSectorsEditor(rows, names);
  }

  function updateSectorsCount() {
    var n = (state.sectorRows || []).length;
    if (el.sectorsCount) {
      el.sectorsCount.textContent = n ? String(n) : '';
    }
  }

  function loadSectorsFromSiport() {
    var version = el.version.value.trim() || '10';
    el.loadSectorsBtn.disabled = true;
    setSectorsMsg('Carregando setores…');
    return api('/api/admin/cco/sectors?version=' + encodeURIComponent(version))
      .then(function (data) {
        var edited = collectSectorNamesFromDom();
        state.savedSectorNames = Object.assign({}, state.savedSectorNames, edited);
        renderSectorsEditor(data.sectors || [], Object.assign({}, data.names || {}, state.savedSectorNames));
        var n = (data.sectors || []).length;
        setSectorsMsg(n + ' setor' + (n === 1 ? '' : 'es') + ' carregado' + (n === 1 ? '' : 's') + '.');
        markDirty();
      })
      .catch(function (err) {
        setSectorsMsg(err.message || 'Falha ao carregar setores', true);
      })
      .then(function () {
        el.loadSectorsBtn.disabled = false;
      });
  }

  function addManualSector() {
    var current = collectSectorNamesFromDom();
    state.savedSectorNames = Object.assign({}, state.savedSectorNames, current);
    var rows = (state.sectorRows || []).slice();
    rows.push({ code: '', total: null, manual: true });
    renderSectorsEditor(rows, state.savedSectorNames);
    markDirty();
  }

  function showLogin() {
    el.loginView.classList.remove('hidden');
    el.appView.classList.add('hidden');
  }

  function showApp() {
    el.loginView.classList.add('hidden');
    el.appView.classList.remove('hidden');
    if (el.envBadge) el.envBadge.textContent = location.hostname || 'localhost';
  }

  function openSettings() {
    el.showForm.hidden = true;
    el.viewSettings.hidden = false;
  }

  function closeSettings() {
    el.viewSettings.hidden = true;
    el.showForm.hidden = false;
  }

  function slugifyPreview(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 80);
  }

  function clampArt(value, min, max, fallback) {
    var n = Number(value);
    if (isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function readArtFit() {
    return {
      zoom: clampArt(el.artZoom && el.artZoom.value, 0.5, 3, 1),
      x: clampArt(el.artX && el.artX.value, 0, 100, 50),
      y: clampArt(el.artY && el.artY.value, 0, 100, 50),
    };
  }

  function setArtFitInputs(zoom, x, y) {
    zoom = clampArt(zoom, 0.5, 3, 1);
    x = clampArt(x, 0, 100, 50);
    y = clampArt(y, 0, 100, 50);
    if (el.artZoom) el.artZoom.value = String(zoom);
    if (el.artX) el.artX.value = String(x);
    if (el.artY) el.artY.value = String(y);
    if (el.artZoomVal) el.artZoomVal.textContent = zoom.toFixed(2) + 'x';
    if (el.artXVal) el.artXVal.textContent = Math.round(x) + '%';
    if (el.artYVal) el.artYVal.textContent = Math.round(y) + '%';
  }

  function applyArtFitStyles(img, zoom, x, y, frame) {
    if (!img) return;
    zoom = clampArt(zoom, 0.5, 3, 1);
    x = clampArt(x, 0, 100, 50);
    y = clampArt(y, 0, 100, 50);
    img.style.objectPosition = x + '% ' + y + '%';
    img.style.transformOrigin = x + '% ' + y + '%';
    img.style.width = '100%';
    img.style.height = '100%';
    if (zoom >= 1) {
      img.style.objectFit = 'cover';
      img.style.transform = zoom === 1 ? 'none' : 'scale(' + zoom + ')';
    } else {
      img.style.objectFit = 'contain';
      img.style.transform = 'none';
    }
    if (frame) {
      frame.style.backgroundImage = '';
      frame.style.backgroundSize = '';
      frame.style.backgroundPosition = '';
    }
  }

  function posterRatioForType(type) {
    return (type === 'cco' || type === 'bepass') ? 'portrait' : 'square';
  }

  function previewLayoutForType(type) {
    return type === 'boletius' ? 'boletius' : 'cco';
  }

  function syncPosterRatio() {
    var type = el.showType ? el.showType.value : 'cco';
    var ratio = posterRatioForType(type);
    var layout = previewLayoutForType(type);
    var roots = document.querySelectorAll('[data-pv-root]');
    for (var i = 0; i < roots.length; i++) {
      roots[i].setAttribute('data-pv-ratio', ratio);
      roots[i].setAttribute('data-pv-layout', layout);
    }
    if (el.artPreview) el.artPreview.classList.toggle('is-portrait', ratio === 'portrait');
    var caps = document.querySelectorAll('.pv-cap');
    var capText = layout === 'boletius'
      ? 'Prévia do cartaz do dashboard'
      : 'Prévia no tamanho do cartaz do dashboard';
    for (var c = 0; c < caps.length; c++) caps[c].textContent = capText;
  }

  function applyArtFitPreview() {
    var fit = readArtFit();
    if (el.artPreviewImg) {
      applyArtFitStyles(el.artPreviewImg, fit.zoom, fit.x, fit.y, el.artPreview);
    }
    setArtFitInputs(fit.zoom, fit.x, fit.y);
    updateLivePreview();
  }

  function setArtPreview(url, fit) {
    var hasUrl = !!url;
    if (el.artPreviewImg) {
      if (hasUrl) {
        el.artPreviewImg.hidden = false;
        el.artPreviewImg.onload = applyArtFitPreview;
        el.artPreviewImg.src = url;
      } else {
        el.artPreviewImg.removeAttribute('src');
        el.artPreviewImg.hidden = true;
      }
    }
    if (el.artPreviewEmpty) el.artPreviewEmpty.hidden = hasUrl;
    if (el.artPreview) el.artPreview.classList.toggle('has-image', hasUrl);
    if (el.artFitControls) el.artFitControls.hidden = !hasUrl;
    if (el.artThumb) {
      el.artThumb.style.backgroundImage = hasUrl ? 'url("' + url + '")' : '';
      el.artThumb.textContent = hasUrl ? '' : 'arte';
    }
    if (el.artName) el.artName.textContent = hasUrl ? fileNameFromUrl(url) : 'Nenhum arquivo';
    if (el.artMeta) el.artMeta.textContent = hasUrl ? 'Imagem enviada' : 'PNG ou JPG';
    if (fit) setArtFitInputs(fit.zoom, fit.x, fit.y);
    else if (!hasUrl) setArtFitInputs(1, 50, 50);
    applyArtFitPreview();
  }

  function setLogoPreview(url) {
    var hasUrl = !!url;
    if (el.logoThumb) {
      el.logoThumb.style.backgroundImage = hasUrl ? 'url("' + url + '")' : '';
      el.logoThumb.textContent = hasUrl ? '' : 'logo';
    }
    if (el.logoName) el.logoName.textContent = hasUrl ? fileNameFromUrl(url) : 'Nenhum arquivo';
    if (el.logoMeta) el.logoMeta.textContent = hasUrl ? 'Imagem enviada' : 'PNG ou JPG';
    updateLivePreview();
  }

  function buildPublicUrl(slug) {
    var clean = String(slug || '').replace(/^\/+|\/+$/g, '');
    if (!clean) return '';
    return location.origin + '/shows/' + clean;
  }

  function setPublicUrl(slug) {
    var path = slug ? '/shows/' + String(slug).replace(/^\/+|\/+$/g, '') : '';
    var url = buildPublicUrl(slug);
    el.publicUrlText.textContent = path || '—';
    if (url) {
      el.publicUrlText.setAttribute('data-url', url);
      el.publicUrlText.setAttribute('title', url);
    } else {
      el.publicUrlText.removeAttribute('data-url');
      el.publicUrlText.removeAttribute('title');
    }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      document.body.removeChild(ta);
      if (ok) resolve();
      else reject(new Error('copy failed'));
    });
  }

  function syncTypeFields() {
    var type = el.showType.value;
    var isCco = type === 'cco';
    var isBepass = type === 'bepass';
    var isBoletius = type === 'boletius';
    el.boletiusFields.classList.toggle('hidden', !isBoletius);
    el.ccoFields.classList.toggle('hidden', !isCco);
    el.bepassFields.classList.toggle('hidden', !isBepass);
    if (el.sectorsCcoBox) el.sectorsCcoBox.hidden = !isCco;
    if (el.sectorsEmpty) el.sectorsEmpty.hidden = isCco;
    if (el.sectorsHint) {
      el.sectorsHint.hidden = !isCco;
    }
    el.eventId.required = isBoletius;
    el.showIdBoletius.required = isBoletius;
    el.apiKey.required = isBoletius;
    if (el.authUser) el.authUser.required = isBepass;
    updateSectorsCount();
    syncPosterRatio();
    updateLivePreview();
  }

  function syncCoordFields() {
    var on = !!(el.coordManual && el.coordManual.checked);
    if (el.coordLatField) el.coordLatField.hidden = !on;
    if (el.coordLonField) el.coordLonField.hidden = !on;
  }

  function fillDbForm(db) {
    state.db = db || null;
    el.dbHost.value = (db && db.host) || '';
    el.dbPort.value = String((db && db.port) || 1433);
    el.dbDatabase.value = (db && db.database) || 'SIPORTNTACC';
    el.dbUser.value = (db && db.user) || '';
    el.dbPassword.value = '';
    el.dbPassword.placeholder = db && db.hasPassword ? '•••••••• (deixe vazio para manter)' : 'deixe vazio para manter';
    el.dbEncrypt.checked = !!(db && db.encrypt);
  }

  function fillHistoryForm(cfg) {
    state.historyMysql = cfg || null;
    el.historyEnabled.checked = !!(cfg && cfg.enabled);
    el.historyHost.value = (cfg && cfg.host) || '';
    el.historyPort.value = String((cfg && cfg.port) || 3306);
    el.historyDatabase.value = (cfg && cfg.database) || 'dashshows';
    el.historyUser.value = (cfg && cfg.user) || '';
    el.historyPassword.value = '';
    el.historyPassword.placeholder = cfg && cfg.hasPassword
      ? '•••••••• (deixe vazio para manter)'
      : 'deixe vazio para manter';
    var sec = cfg && cfg.intervalMs != null ? Math.round(Number(cfg.intervalMs) / 1000) : 60;
    if (isNaN(sec) || sec < 15) sec = 60;
    if (sec > 3600) sec = 3600;
    el.historyIntervalSec.value = String(sec);
  }

  function currentShow() {
    return state.shows.find(function (s) { return s.id === state.selectedId; }) || null;
  }

  function setShowState(show) {
    var life = showLifecycle(show);
    el.showState.classList.remove('live', 'done');
    if (life === 'live') {
      el.showState.textContent = show && show.isActive ? 'No ar · show da home' : 'No ar';
      el.showState.classList.add('live');
    } else if (life === 'done') {
      el.showState.textContent = 'Finalizado';
      el.showState.classList.add('done');
    } else {
      el.showState.textContent = 'Rascunho · não publicado';
    }
  }

  function syncMenu(show) {
    var editing = !!(show && show.id);
    var buttons = [
      el.publishBtn, el.setHomeBtn, el.duplicateBtn,
      el.finalizeBtn, el.reopenBtn, el.deleteBtn,
    ];
    for (var i = 0; i < buttons.length; i++) {
      if (!buttons[i]) continue;
      buttons[i].hidden = false;
      buttons[i].disabled = !editing;
    }
    if (el.discardBtn) el.discardBtn.hidden = false;
  }

  function collectPayload() {
    var type = el.showType.value;
    var gateTime = parseGateOpenTime(el.gateOpenTime.value);
    var artFit = readArtFit();
    var intervalSec = Number(el.historyIntervalSecShow.value);
    var payload = {
      type: type,
      title: el.title.value.trim(),
      slug: el.slug.value.trim(),
      eventName: el.eventName.value.trim() || el.title.value.trim(),
      eventDate: el.eventDate.value.trim(),
      venueName: el.venueName.value.trim(),
      venueCity: el.venueCity.value.trim(),
      gateOpenHour: gateTime.hour,
      gateOpenMinute: gateTime.minute,
      logoUrl: el.logoUrl.value.trim(),
      showArtUrl: el.showArtUrl.value.trim(),
      showArtZoom: artFit.zoom,
      showArtX: artFit.x,
      showArtY: artFit.y,
      theme: el.showTheme.value || '',
      historyEnabled: !!(el.historyEnabledShow && el.historyEnabledShow.checked),
    };

    if (!isNaN(intervalSec) && intervalSec >= 15) {
      payload.historyIntervalSec = Math.min(3600, intervalSec);
    }

    if (el.coordManual && el.coordManual.checked) {
      var lat = el.weatherLat.value.trim();
      var lon = el.weatherLon.value.trim();
      payload.weather = lat && lon ? { lat: Number(lat), lon: Number(lon) } : null;
    } else {
      payload.weather = null;
    }

    if (type === 'cco') {
      var fromDom = collectSectorNamesFromDom();
      payload.version = el.version.value.trim();
      payload.mockData = el.mockData.checked;
      payload.sectorNames = Object.keys(fromDom).length
        ? fromDom
        : Object.assign({}, state.savedSectorNames || {});
    } else if (type === 'bepass') {
      payload.eventId = el.bepassEventId ? el.bepassEventId.value.trim() : '';
      payload.companyId = el.companyId ? el.companyId.value.trim() : '';
      payload.authUser = el.authUser ? el.authUser.value.trim() : '';
      payload.authUrl = el.authUrl ? el.authUrl.value.trim() : '';
      payload.clientId = el.clientId ? el.clientId.value.trim() : '';
      if (el.authPassword && el.authPassword.value.trim()) {
        payload.authPassword = el.authPassword.value.trim();
      }
    } else {
      payload.eventId = el.eventId.value.trim();
      payload.showId = el.showIdBoletius.value.trim();
      payload.apiKey = el.apiKey.value.trim();
    }

    return payload;
  }

  function snapshotKey() {
    try {
      return JSON.stringify(collectPayload());
    } catch (_) {
      return '';
    }
  }

  function countChanges() {
    if (!state.snapshot) return 0;
    var now;
    try { now = collectPayload(); } catch (_) { return 1; }
    var prev;
    try { prev = JSON.parse(state.snapshot); } catch (_) { return 1; }
    var keys = {};
    Object.keys(prev).forEach(function (k) { keys[k] = true; });
    Object.keys(now).forEach(function (k) { keys[k] = true; });
    var n = 0;
    Object.keys(keys).forEach(function (k) {
      if (JSON.stringify(prev[k]) !== JSON.stringify(now[k])) n += 1;
    });
    return n;
  }

  function markDirty() {
    if (state.filling) return;
    var n = countChanges();
    var dirty = n > 0;
    if (el.dirtyLabel) el.dirtyLabel.hidden = !dirty;
    if (el.dirtyText) {
      el.dirtyText.textContent = n === 1
        ? '1 alteração não salva'
        : n + ' alterações não salvas';
    }
  }

  function rememberSnapshot() {
    state.snapshot = snapshotKey();
    markDirty();
  }

  function updateLivePreview() {
    var venue = el.venueName.value.trim() || 'Local';
    var event = (el.eventName.value.trim() || el.title.value.trim() || '—').toUpperCase();
    var time = el.gateOpenTime.value || '16:00';
    var city = el.venueCity.value.trim();
    var parts = [];
    if (venue) parts.push(venue);
    if (city) parts.push(city);
    parts.push('portões ' + time);
    var sub = parts.join(' · ');
    var logo = el.logoUrl.value.trim();
    var art = el.showArtUrl ? el.showArtUrl.value.trim() : '';
    var fit = readArtFit();
    syncPosterRatio();

    var logos = document.querySelectorAll('[data-pv-logo-img]');
    for (var i = 0; i < logos.length; i++) {
      logos[i].src = logo || DEFAULT_LOGO_URL;
      logos[i].alt = venue;
      logos[i].classList.add('is-on');
      logos[i].classList.toggle('is-default', !logo);
    }
    var evs = document.querySelectorAll('[data-pv-event]');
    for (var k = 0; k < evs.length; k++) evs[k].textContent = event;
    var subs = document.querySelectorAll('[data-pv-sub]');
    for (var s = 0; s < subs.length; s++) subs[s].textContent = sub || '—';

    var frames = document.querySelectorAll('[data-pv-art-frame]');
    for (var f = 0; f < frames.length; f++) {
      var frame = frames[f];
      var img = frame.querySelector('[data-pv-art-img]');
      frame.classList.toggle('has-image', !!art);
      if (!img) continue;
      if (art) {
        if (img.getAttribute('src') !== art) img.src = art;
        applyArtFitStyles(img, fit.zoom, fit.x, fit.y, frame);
      } else {
        img.removeAttribute('src');
        frame.style.backgroundImage = '';
      }
    }
  }

  function resetForm() {
    state.filling = true;
    state.mode = 'create';
    state.selectedId = null;
    el.formTitle.textContent = 'Novo show';
    el.showId.value = '';
    el.showType.value = 'cco';
    el.title.value = '';
    el.slug.value = '';
    delete el.slug.dataset.manual;
    el.eventName.value = '';
    el.eventDate.value = '';
    el.eventId.value = '';
    el.showIdBoletius.value = '';
    el.apiKey.value = '';
    if (el.bepassEventId) el.bepassEventId.value = '';
    if (el.companyId) el.companyId.value = '';
    if (el.authUser) el.authUser.value = '';
    if (el.authPassword) {
      el.authPassword.value = '';
      el.authPassword.placeholder = 'deixe vazio para manter';
    }
    if (el.authUrl) el.authUrl.value = BEPASS_AUTH_URL;
    if (el.clientId) el.clientId.value = 'app-graph';
    if (el.bepassAdvanced) el.bepassAdvanced.open = false;
    el.version.value = '10';
    el.mockData.checked = true;
    el.coordManual.checked = false;
    el.weatherLat.value = DEFAULT_WEATHER_LAT;
    el.weatherLon.value = DEFAULT_WEATHER_LON;
    state.savedSectorNames = {};
    renderSectorsFromSavedMap({});
    setSectorsMsg('');
    el.venueName.value = '';
    el.venueCity.value = '';
    el.gateOpenTime.value = '16:00';
    el.logoUrl.value = '';
    el.showArtUrl.value = '';
    if (el.logoFile) el.logoFile.value = '';
    if (el.artFile) el.artFile.value = '';
    el.showTheme.value = '';
    el.historyEnabledShow.checked = true;
    el.historyIntervalSecShow.value = '60';
    setLogoPreview('');
    setArtPreview('', { zoom: 1, x: 50, y: 50 });
    el.urlBox.hidden = true;
    setShowState(null);
    syncMenu(null);
    setMsg('');
    syncTypeFields();
    syncCoordFields();
    syncPaletteGroup(el.showThemeOptions, '');
    renderList();
    updateLivePreview();
    state.filling = false;
    rememberSnapshot();
  }

  function fillForm(show) {
    state.filling = true;
    state.mode = 'edit';
    state.selectedId = show.id;
    el.formTitle.textContent = show.title || 'Editar show';
    el.showId.value = show.id;
    el.showType.value = show.type || 'boletius';
    el.title.value = show.title || '';
    el.slug.value = show.slug || '';
    delete el.slug.dataset.manual;
    el.eventName.value = show.eventName || show.title || '';
    el.eventDate.value = show.eventDate || '';
    el.eventId.value = show.type === 'bepass' ? '' : (show.eventId || '');
    el.showIdBoletius.value = show.showId || '';
    el.apiKey.value = show.apiKey || '';
    if (el.bepassEventId) el.bepassEventId.value = show.type === 'bepass' ? (show.eventId || '') : '';
    if (el.companyId) el.companyId.value = show.companyId || '';
    if (el.authUser) el.authUser.value = show.authUser || '';
    if (el.authPassword) {
      el.authPassword.value = '';
      el.authPassword.placeholder = show.hasAuthPassword
        ? '•••••••• (deixe vazio para manter)'
        : 'deixe vazio para manter';
    }
    if (el.authUrl) el.authUrl.value = show.authUrl || BEPASS_AUTH_URL;
    if (el.clientId) el.clientId.value = show.clientId || 'app-graph';
    if (el.bepassAdvanced) {
      var authUrl = show.authUrl || BEPASS_AUTH_URL;
      var clientId = show.clientId || 'app-graph';
      el.bepassAdvanced.open = clientId !== 'app-graph' || authUrl !== BEPASS_AUTH_URL;
    }
    el.version.value = Array.isArray(show.version) ? show.version.join(',') : (show.version || '10');
    el.mockData.checked = show.mockData === true;
    var hasWeather = !!(show.weather && show.weather.lat != null && show.weather.lon != null);
    el.coordManual.checked = hasWeather;
    el.weatherLat.value = hasWeather ? String(show.weather.lat) : DEFAULT_WEATHER_LAT;
    el.weatherLon.value = hasWeather ? String(show.weather.lon) : DEFAULT_WEATHER_LON;
    state.savedSectorNames = Object.assign({}, show.sectorNames || {});
    renderSectorsFromSavedMap(state.savedSectorNames);
    setSectorsMsg('');
    el.venueName.value = show.venueName || '';
    el.venueCity.value = show.venueCity || '';
    el.gateOpenTime.value = formatGateOpenTime(show.gateOpenHour, show.gateOpenMinute);
    el.logoUrl.value = show.logoUrl || '';
    el.showArtUrl.value = show.showArtUrl || '';
    if (el.logoFile) el.logoFile.value = '';
    if (el.artFile) el.artFile.value = '';
    el.showTheme.value = show.theme || '';
    el.historyEnabledShow.checked = show.historyEnabled !== false;
    var histSec = show.historyIntervalMs != null ? Math.round(Number(show.historyIntervalMs) / 1000) : 60;
    if (isNaN(histSec) || histSec < 15) histSec = 60;
    el.historyIntervalSecShow.value = String(histSec);
    setLogoPreview(show.logoUrl || '');
    setArtPreview(show.showArtUrl || '', {
      zoom: show.showArtZoom,
      x: show.showArtX,
      y: show.showArtY,
    });
    setPublicUrl(show.slug);
    el.urlBox.hidden = false;
    setShowState(show);
    syncMenu(show);
    setMsg('');
    syncTypeFields();
    syncCoordFields();
    syncPaletteGroup(el.showThemeOptions, show.theme || '');
    renderList();
    updateLivePreview();
    state.filling = false;
    rememberSnapshot();
  }

  function confirmIfDirty() {
    if (countChanges() <= 0) return true;
    return window.confirm('Há alterações não salvas. Descartar e continuar?');
  }

  function selectShow(id) {
    if (state.selectedId === id) return;
    if (!confirmIfDirty()) return;
    var show = state.shows.find(function (s) { return s.id === id; });
    if (show) fillForm(show);
  }

  function renderList() {
    if (!el.showsList) return;
    var q = String(state.search || '').trim().toLowerCase();
    var groups = { live: [], draft: [], done: [] };

    for (var i = 0; i < state.shows.length; i++) {
      var show = state.shows[i];
      var life = showLifecycle(show);
      if (state.filter === 'live' && life !== 'live') continue;
      if (state.filter === 'done' && life !== 'done') continue;
      if (q) {
        var hay = ((show.title || '') + ' ' + (show.slug || '') + ' ' + (show.eventName || '')).toLowerCase();
        if (hay.indexOf(q) === -1) continue;
      }
      groups[life].push(show);
    }

    function itemHtml(show) {
      var life = showLifecycle(show);
      var meta = life === 'done'
        ? formatShortDate(show.eventDate || (show.finalizedAt || '').slice(0, 10))
        : (show.eventDate ? formatShortDate(show.eventDate) : '/' + show.slug);
      return (
        '<button type="button" class="show-item" data-id="' + escapeAttr(show.id) + '"' +
          (show.id === state.selectedId ? ' aria-current="true"' : '') + '>' +
          '<div class="name"><span class="dot ' + life + '"></span>' + escapeHtml(show.title || 'Sem título') + '</div>' +
          '<div class="meta"><span class="kind">' + escapeHtml(typeLabel(show.type)) + '</span>' +
            '<span' + (life !== 'done' ? ' class="mono"' : '') + '>' + escapeHtml(meta || '—') + '</span></div>' +
        '</button>'
      );
    }

    var html = '';
    if (state.filter !== 'done' && groups.live.length) {
      html += '<div class="group">No ar</div>';
      groups.live.forEach(function (s) { html += itemHtml(s); });
    }
    if (state.filter === 'all' && groups.draft.length) {
      html += '<div class="group">Rascunhos</div>';
      groups.draft.forEach(function (s) { html += itemHtml(s); });
    }
    if (state.filter !== 'live' && groups.done.length) {
      html += '<div class="group">Finalizados <span>' + groups.done.length + '</span></div>';
      groups.done.forEach(function (s) { html += itemHtml(s); });
    }
    if (!html) {
      html = '<div class="empty-list">Nenhum show nesta lista.</div>';
    }
    el.showsList.innerHTML = html;
  }

  function activateShow(id) {
    return api('/api/admin/shows/' + encodeURIComponent(id) + '/activate', {
      method: 'POST',
    }).then(function (data) {
      state.activeShowId = data.activeShowId;
      state.shows.forEach(function (s) {
        s.isActive = s.id === state.activeShowId;
        if (s.id === id) s.published = true;
      });
      renderList();
      var current = currentShow();
      if (current) {
        setShowState(current);
        syncMenu(current);
      }
      setMsg('Show definido como home.');
    });
  }

  function loadShows() {
    return api('/api/admin/shows').then(function (data) {
      state.shows = data.shows || [];
      state.activeShowId = data.activeShowId;
      state.defaultSectorNames = data.defaultSectorNames || {};
      fillDbForm(data.db);
      fillHistoryForm(data.historyMysql);
      state.theme = normalizeTheme(data.theme);
      state.savedTheme = state.theme;
      syncPaletteGroup(el.themeOptions, state.theme);
      if (el.themeSaveBtn) el.themeSaveBtn.disabled = true;
      if (state.selectedId) {
        var current = state.shows.find(function (s) { return s.id === state.selectedId; });
        if (current) fillForm(current);
        else resetForm();
      } else if (state.shows.length) {
        fillForm(state.shows[0]);
      } else {
        resetForm();
      }
    });
  }

  function uploadFile(file, field) {
    var fd = new FormData();
    fd.append('file', file);
    fd.append('field', field);
    return api('/api/admin/upload', {
      method: 'POST',
      body: fd,
    }).then(function (data) {
      return data.url;
    });
  }

  function switchTab(name) {
    state.currentTab = name;
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].setAttribute('aria-selected', tabs[i].getAttribute('data-tab') === name ? 'true' : 'false');
    }
    var panels = document.querySelectorAll('[data-panel]');
    for (var j = 0; j < panels.length; j++) {
      panels[j].hidden = panels[j].getAttribute('data-panel') !== name;
    }
  }

  function saveShow() {
    var payload;
    try {
      payload = collectPayload();
    } catch (err) {
      setMsg(err.message || 'Dados inválidos', true);
      return;
    }

    if (!payload.title) {
      setMsg('Preencha o título administrativo.', true);
      return;
    }
    if (payload.type === 'boletius' && (!payload.eventId || !payload.showId || !payload.apiKey)) {
      setMsg('Preencha eventId, showId e apiKey.', true);
      switchTab('fonte');
      return;
    }
    if (payload.type === 'bepass' && !payload.authUser) {
      setMsg('Preencha o usuário BePass.', true);
      switchTab('fonte');
      return;
    }
    if (payload.type === 'bepass' && state.mode !== 'edit' && !payload.authPassword) {
      setMsg('Preencha a senha BePass.', true);
      switchTab('fonte');
      return;
    }

    el.saveBtn.disabled = true;
    setMsg('Salvando…');

    var req;
    if (state.mode === 'edit' && el.showId.value) {
      req = api('/api/admin/shows/' + encodeURIComponent(el.showId.value), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      req = api('/api/admin/shows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    req
      .then(function (data) {
        state.selectedId = data.show && data.show.id;
        return loadShows();
      })
      .then(function () {
        setMsg('Show salvo com sucesso.');
      })
      .catch(function (err) {
        setMsg(err.message || 'Falha ao salvar', true);
      })
      .then(function () {
        el.saveBtn.disabled = false;
      });
  }

  function discardChanges() {
    if (state.mode === 'edit' && state.selectedId) {
      var show = currentShow();
      if (show) fillForm(show);
    } else {
      resetForm();
    }
    setMsg('Alterações descartadas.');
  }

  function bootstrap() {
    api('/api/admin/me')
      .then(function () {
        showApp();
        return loadShows();
      })
      .catch(function () {
        showLogin();
      });
  }

  bindEls();

  el.loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    el.loginError.textContent = '';
    el.loginBtn.disabled = true;
    api('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: el.loginPassword.value }),
    })
      .then(function () {
        el.loginPassword.value = '';
        showApp();
        return loadShows();
      })
      .catch(function (err) {
        el.loginError.textContent = err.message || 'Falha no login';
      })
      .then(function () {
        el.loginBtn.disabled = false;
      });
  });

  el.logoutBtn.addEventListener('click', function () {
    api('/api/admin/logout', { method: 'POST' })
      .catch(function () {})
      .then(function () {
        showLogin();
      });
  });

  el.btnSettings.addEventListener('click', openSettings);
  if (el.lnkSettings) el.lnkSettings.addEventListener('click', openSettings);
  el.btnBack.addEventListener('click', closeSettings);

  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      switchTab(tab.getAttribute('data-tab'));
    });
  });

  el.newShowBtn.addEventListener('click', function () {
    if (!confirmIfDirty()) return;
    resetForm();
    closeSettings();
  });

  el.showType.addEventListener('change', function () {
    syncTypeFields();
    markDirty();
  });

  el.coordManual.addEventListener('change', function () {
    syncCoordFields();
    markDirty();
  });

  el.loadSectorsBtn.addEventListener('click', loadSectorsFromSiport);
  el.addSectorBtn.addEventListener('click', addManualSector);

  el.sectorsList.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-remove-sector]');
    if (!btn) return;
    var row = btn.closest('tr');
    if (!row) return;
    row.parentNode.removeChild(row);
    state.savedSectorNames = collectSectorNamesFromDom();
    state.sectorRows = Object.keys(state.savedSectorNames).map(function (code) {
      return { code: code, total: null };
    });
    updateSectorsCount();
    markDirty();
  });

  el.sectorsList.addEventListener('input', markDirty);

  el.showsList.addEventListener('click', function (e) {
    var item = e.target.closest('[data-id]');
    if (!item) return;
    closeSettings();
    selectShow(item.getAttribute('data-id'));
  });

  el.showFilters.addEventListener('click', function (e) {
    var chip = e.target.closest('[data-filter]');
    if (!chip) return;
    state.filter = chip.getAttribute('data-filter') || 'all';
    var chips = el.showFilters.querySelectorAll('.chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].setAttribute('aria-pressed', chips[i] === chip ? 'true' : 'false');
    }
    renderList();
  });

  el.showSearch.addEventListener('input', function () {
    state.search = el.showSearch.value;
    renderList();
  });

  el.title.addEventListener('input', function () {
    if (state.mode === 'create' && !el.slug.dataset.manual) {
      el.slug.value = slugifyPreview(el.title.value);
      setPublicUrl(el.slug.value);
    }
    if (!el.eventName.value.trim() || el.eventName.dataset.linked === '1') {
      el.eventName.value = el.title.value;
      el.eventName.dataset.linked = '1';
    }
    updateLivePreview();
  });

  el.eventName.addEventListener('input', function () {
    el.eventName.dataset.linked = '0';
    updateLivePreview();
  });

  el.slug.addEventListener('input', function () {
    el.slug.dataset.manual = '1';
    setPublicUrl(el.slug.value);
  });

  ['eventDate', 'gateOpenTime', 'venueName', 'venueCity'].forEach(function (id) {
    el[id].addEventListener('input', updateLivePreview);
  });

  el.showForm.addEventListener('input', markDirty);
  el.showForm.addEventListener('change', markDirty);

  el.changeLogoBtn.addEventListener('click', function () { el.logoFile.click(); });
  el.changeArtBtn.addEventListener('click', function () { el.artFile.click(); });

  el.logoFile.addEventListener('change', function () {
    var file = el.logoFile.files && el.logoFile.files[0];
    if (!file) return;
    setMsg('Enviando logo…');
    uploadFile(file, 'logo')
      .then(function (url) {
        el.logoUrl.value = url;
        setLogoPreview(url);
        setMsg('Logo enviado.');
        markDirty();
      })
      .catch(function (err) {
        setMsg(err.message || 'Falha no upload', true);
      });
  });

  el.clearLogoBtn.addEventListener('click', function () {
    el.logoUrl.value = '';
    el.logoFile.value = '';
    setLogoPreview('');
    markDirty();
  });

  el.artFile.addEventListener('change', function () {
    var file = el.artFile.files && el.artFile.files[0];
    if (!file) return;
    setMsg('Enviando imagem…');
    uploadFile(file, 'art')
      .then(function (url) {
        el.showArtUrl.value = url;
        setArtPreview(url, readArtFit());
        setMsg('Imagem enviada.');
        markDirty();
      })
      .catch(function (err) {
        setMsg(err.message || 'Falha no upload', true);
      });
  });

  el.clearArtBtn.addEventListener('click', function () {
    el.showArtUrl.value = '';
    el.artFile.value = '';
    setArtPreview('', { zoom: 1, x: 50, y: 50 });
    markDirty();
  });

  function onArtFitInput() {
    applyArtFitPreview();
    markDirty();
  }
  el.artZoom.addEventListener('input', onArtFitInput);
  el.artX.addEventListener('input', onArtFitInput);
  el.artY.addEventListener('input', onArtFitInput);
  el.artFitReset.addEventListener('click', function () {
    setArtFitInputs(1, 50, 50);
    applyArtFitPreview();
    markDirty();
  });

  var artDrag = null;
  el.artPreview.addEventListener('pointerdown', function (e) {
    if (!el.showArtUrl.value) return;
    var fit = readArtFit();
    var rect = el.artPreview.getBoundingClientRect();
    artDrag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      artX: fit.x,
      artY: fit.y,
      width: rect.width || 1,
      height: rect.height || 1,
    };
    el.artPreview.classList.add('is-dragging');
    try { el.artPreview.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  el.artPreview.addEventListener('pointermove', function (e) {
    if (!artDrag || e.pointerId !== artDrag.pointerId) return;
    var nextX = clampArt(artDrag.artX - ((e.clientX - artDrag.startX) / artDrag.width) * 100, 0, 100, 50);
    var nextY = clampArt(artDrag.artY - ((e.clientY - artDrag.startY) / artDrag.height) * 100, 0, 100, 50);
    setArtFitInputs(readArtFit().zoom, nextX, nextY);
    applyArtFitPreview();
  });
  function endArtDrag(e) {
    if (!artDrag || (e && e.pointerId !== artDrag.pointerId)) return;
    artDrag = null;
    el.artPreview.classList.remove('is-dragging');
    markDirty();
  }
  el.artPreview.addEventListener('pointerup', endArtDrag);
  el.artPreview.addEventListener('pointercancel', endArtDrag);

  el.showThemeOptions.addEventListener('click', function (e) {
    var pal = e.target.closest('.pal');
    if (!pal) return;
    el.showTheme.value = pal.getAttribute('data-theme') || '';
    syncPaletteGroup(el.showThemeOptions, el.showTheme.value);
    markDirty();
  });

  el.copyUrlBtn.addEventListener('click', function () {
    var text = el.publicUrlText.getAttribute('data-url') || '';
    if (!text) return;
    copyText(text).then(function () {
      setMsg('Link copiado.');
    }).catch(function () {
      setMsg('Não foi possível copiar o link', true);
    });
  });

  el.openUrlBtn.addEventListener('click', function () {
    var text = el.publicUrlText.getAttribute('data-url');
    if (text) window.open(text, '_blank', 'noopener');
  });

  el.showForm.addEventListener('submit', function (e) {
    e.preventDefault();
    saveShow();
  });

  el.discardBtn.addEventListener('click', discardChanges);

  el.publishBtn.addEventListener('click', function () {
    if (!el.showId.value) return;
    api('/api/admin/shows/' + encodeURIComponent(el.showId.value) + '/publish', {
      method: 'POST',
    })
      .then(function (data) {
        if (data && data.show) state.selectedId = data.show.id;
        return loadShows();
      })
      .then(function () {
        setMsg('Show publicado.');
      })
      .catch(function (err) {
        setMsg(err.message || 'Falha ao publicar', true);
      });
  });

  el.setHomeBtn.addEventListener('click', function () {
    if (!el.showId.value) return;
    activateShow(el.showId.value).catch(function (err) {
      setMsg(err.message || 'Falha ao definir home', true);
    });
  });

  el.duplicateBtn.addEventListener('click', function () {
    if (!el.showId.value) return;
    if (countChanges() > 0 && !window.confirm('Há alterações não salvas. Duplicar o show salvo?')) return;
    api('/api/admin/shows/' + encodeURIComponent(el.showId.value) + '/duplicate', {
      method: 'POST',
    })
      .then(function (data) {
        state.selectedId = data.show && data.show.id;
        return loadShows();
      })
      .then(function () {
        setMsg('Cópia criada como rascunho.');
      })
      .catch(function (err) {
        setMsg(err.message || 'Falha ao duplicar', true);
      });
  });

  el.deleteBtn.addEventListener('click', function () {
    if (!el.showId.value) return;
    if (!confirm('Excluir este show? Esta ação não pode ser desfeita.')) return;
    el.deleteBtn.disabled = true;
    api('/api/admin/shows/' + encodeURIComponent(el.showId.value), { method: 'DELETE' })
      .then(function () {
        state.selectedId = null;
        return loadShows();
      })
      .then(function () {
        setMsg('Show excluído.');
      })
      .catch(function (err) {
        setMsg(err.message || 'Falha ao excluir', true);
      })
      .then(function () {
        el.deleteBtn.disabled = false;
      });
  });

  el.finalizeBtn.addEventListener('click', function () {
    if (!el.showId.value) return;
    if (!confirm('Finalizar este evento? As gravações de acesso serão interrompidas e o dashboard manterá os últimos dados.')) {
      return;
    }
    el.finalizeBtn.disabled = true;
    api('/api/admin/shows/' + encodeURIComponent(el.showId.value) + '/finalize', { method: 'POST' })
      .then(function (data) {
        if (data && data.show) state.selectedId = data.show.id;
        return loadShows();
      })
      .then(function () {
        setMsg('Evento finalizado.');
      })
      .catch(function (err) {
        setMsg(err.message || 'Falha ao finalizar evento', true);
      })
      .then(function () {
        el.finalizeBtn.disabled = false;
      });
  });

  el.reopenBtn.addEventListener('click', function () {
    if (!el.showId.value) return;
    if (!confirm('Reabrir este evento? As gravações de acesso serão retomadas.')) return;
    el.reopenBtn.disabled = true;
    api('/api/admin/shows/' + encodeURIComponent(el.showId.value) + '/reopen', { method: 'POST' })
      .then(function (data) {
        if (data && data.show) state.selectedId = data.show.id;
        return loadShows();
      })
      .then(function () {
        setMsg('Evento reaberto.');
      })
      .catch(function (err) {
        setMsg(err.message || 'Falha ao reabrir evento', true);
      })
      .then(function () {
        el.reopenBtn.disabled = false;
      });
  });

  el.themeOptions.addEventListener('click', function (e) {
    var pal = e.target.closest('.pal');
    if (!pal) return;
    state.theme = normalizeTheme(pal.getAttribute('data-theme'));
    syncPaletteGroup(el.themeOptions, state.theme);
    el.themeSaveBtn.disabled = state.theme === state.savedTheme;
    setThemeMsg('');
  });

  el.themeSaveBtn.addEventListener('click', function () {
    el.themeSaveBtn.disabled = true;
    setThemeMsg('Salvando…');
    api('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: state.theme }),
    })
      .then(function (data) {
        state.theme = normalizeTheme(data.theme);
        state.savedTheme = state.theme;
        syncPaletteGroup(el.themeOptions, state.theme);
        setThemeMsg('Paleta salva.');
      })
      .catch(function (err) {
        setThemeMsg(err.message || 'Falha ao salvar paleta', true);
        syncPaletteGroup(el.themeOptions, state.theme);
        el.themeSaveBtn.disabled = state.theme === state.savedTheme;
      });
  });

  el.dbForm.addEventListener('submit', function (e) {
    e.preventDefault();
    el.dbSaveBtn.disabled = true;
    setDbMsg('Salvando…');
    var body = {
      db: {
        host: el.dbHost.value.trim(),
        port: Number(el.dbPort.value),
        database: el.dbDatabase.value.trim(),
        user: el.dbUser.value.trim(),
        encrypt: el.dbEncrypt.checked,
      },
    };
    if (el.dbPassword.value) body.db.password = el.dbPassword.value;
    api('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (data) {
        fillDbForm(data.db);
        setDbMsg('Banco salvo.');
      })
      .catch(function (err) {
        setDbMsg(err.message || 'Falha ao salvar banco', true);
      })
      .then(function () {
        el.dbSaveBtn.disabled = false;
      });
  });

  el.dbTestBtn.addEventListener('click', function () {
    el.dbTestBtn.disabled = true;
    setStatusLine(el.dbStatus, 'Testando…', '');
    var body = {
      db: {
        host: el.dbHost.value.trim(),
        port: Number(el.dbPort.value),
        database: el.dbDatabase.value.trim(),
        user: el.dbUser.value.trim(),
        encrypt: el.dbEncrypt.checked,
      },
    };
    if (el.dbPassword.value) body.db.password = el.dbPassword.value;
    api('/api/admin/settings/test-db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (data) {
        setStatusLine(el.dbStatus, 'Conectado · resposta em ' + data.ms + ' ms', 'ok');
        setDbMsg('');
      })
      .catch(function (err) {
        setStatusLine(el.dbStatus, err.message || 'Falha na conexão', 'err');
      })
      .then(function () {
        el.dbTestBtn.disabled = false;
      });
  });

  el.historyForm.addEventListener('submit', function (e) {
    e.preventDefault();
    el.historySaveBtn.disabled = true;
    setHistoryMsg('Salvando…');
    var intervalSec = Number(el.historyIntervalSec.value);
    if (isNaN(intervalSec) || intervalSec < 15) intervalSec = 15;
    if (intervalSec > 3600) intervalSec = 3600;
    var body = {
      historyMysql: {
        enabled: el.historyEnabled.checked,
        host: el.historyHost.value.trim(),
        port: Number(el.historyPort.value),
        database: el.historyDatabase.value.trim(),
        user: el.historyUser.value.trim(),
        intervalMs: Math.round(intervalSec * 1000),
      },
    };
    if (el.historyPassword.value) body.historyMysql.password = el.historyPassword.value;
    api('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (data) {
        fillHistoryForm(data.historyMysql);
        setHistoryMsg('Histórico MySQL salvo.');
      })
      .catch(function (err) {
        setHistoryMsg(err.message || 'Falha ao salvar histórico', true);
      })
      .then(function () {
        el.historySaveBtn.disabled = false;
      });
  });

  el.historyTestBtn.addEventListener('click', function () {
    el.historyTestBtn.disabled = true;
    setStatusLine(el.historyStatus, 'Testando…', '');
    var body = {
      historyMysql: {
        host: el.historyHost.value.trim(),
        port: Number(el.historyPort.value),
        database: el.historyDatabase.value.trim(),
        user: el.historyUser.value.trim(),
      },
    };
    if (el.historyPassword.value) body.historyMysql.password = el.historyPassword.value;
    api('/api/admin/settings/test-mysql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (data) {
        var extra = data.records != null ? ' · ' + formatRecords(data.records) : '';
        setStatusLine(el.historyStatus, 'Conectado · ' + data.ms + ' ms' + extra, 'ok');
        setHistoryMsg('');
      })
      .catch(function (err) {
        setStatusLine(el.historyStatus, err.message || 'Falha na conexão', 'err');
      })
      .then(function () {
        el.historyTestBtn.disabled = false;
      });
  });

  syncTypeFields();
  syncCoordFields();
  bootstrap();
})();
