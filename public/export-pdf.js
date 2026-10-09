/**
 * Shared PDF export via html2canvas + jsPDF.
 * - exportElementToPdf: print/screenshot of a DOM element (dashboards)
 * - exportHistoryDocument: composed report with title, KPIs and chart images
 */
(function (global) {
  'use strict';

  function slugify(text) {
    return String(text || 'export')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 60) || 'export';
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function stamp() {
    var d = new Date();
    return (
      d.getFullYear() +
      pad2(d.getMonth() + 1) +
      pad2(d.getDate()) +
      '-' +
      pad2(d.getHours()) +
      pad2(d.getMinutes())
    );
  }

  function resolveJsPdf() {
    if (typeof global.jspdf !== 'undefined' && global.jspdf.jsPDF) {
      return global.jspdf.jsPDF;
    }
    if (typeof global.jsPDF === 'function') return global.jsPDF;
    return null;
  }

  function waitFrames(n) {
    return new Promise(function (resolve) {
      function step(left) {
        if (left <= 0) return resolve();
        requestAnimationFrame(function () {
          step(left - 1);
        });
      }
      step(n || 2);
    });
  }

  function canvasToDataUrl(canvas, bg) {
    if (!canvas || !canvas.width) return null;
    var tmp = document.createElement('canvas');
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    var ctx = tmp.getContext('2d');
    ctx.fillStyle = bg || '#16121f';
    ctx.fillRect(0, 0, tmp.width, tmp.height);
    ctx.drawImage(canvas, 0, 0);
    return tmp.toDataURL('image/jpeg', 0.92);
  }

  /**
   * Screenshot-style PDF of a DOM element (event dashboards).
   */
  async function exportElementToPdf(el, filename, options) {
    options = options || {};
    if (!el) throw new Error('Elemento para exportação não encontrado');

    var html2canvasFn = global.html2canvas;
    var JsPDF = resolveJsPdf();
    if (typeof html2canvasFn !== 'function') {
      throw new Error('html2canvas não carregou. Recarregue a página.');
    }
    if (!JsPDF) {
      throw new Error('jsPDF não carregou. Recarregue a página.');
    }

    var hideSelectors = options.hideSelectors || ['.pdf-hide', '[data-pdf-hide]'];
    var hidden = [];
    hideSelectors.forEach(function (sel) {
      el.querySelectorAll(sel).forEach(function (node) {
        hidden.push({ node: node, display: node.style.display });
        node.style.display = 'none';
      });
      document.querySelectorAll(sel).forEach(function (node) {
        if (el.contains(node)) return;
        if (!node.classList.contains('pdf-hide') && !node.hasAttribute('data-pdf-hide')) return;
        hidden.push({ node: node, display: node.style.display });
        node.style.display = 'none';
      });
    });

    document.documentElement.classList.add('pdf-exporting');
    document.body.classList.add('pdf-exporting');
    prepareDocForCapture(document);

    try {
      await waitFrames(2);

      var bg =
        options.background ||
        getComputedStyle(document.body).backgroundColor ||
        '#0b0910';

      var canvas = await html2canvasFn(el, {
        scale: options.scale || 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: bg,
        logging: false,
        scrollX: 0,
        scrollY: -global.scrollY,
        windowWidth: document.documentElement.scrollWidth,
        windowHeight: el.scrollHeight,
      });

      var imgData = canvas.toDataURL('image/jpeg', 0.92);
      var imgW = canvas.width;
      var imgH = canvas.height;

      var orientation = options.orientation || 'auto';
      if (orientation === 'auto') {
        orientation = imgW >= imgH * 0.85 ? 'landscape' : 'portrait';
      }

      var pdf = new JsPDF({
        orientation: orientation,
        unit: 'mm',
        format: 'a4',
        compress: true,
      });

      var pageW = pdf.internal.pageSize.getWidth();
      var pageH = pdf.internal.pageSize.getHeight();
      var margin = 8;
      var usableW = pageW - margin * 2;
      var usableH = pageH - margin * 2;

      var renderW = usableW;
      var renderH = (imgH * renderW) / imgW;

      if (renderH <= usableH) {
        pdf.addImage(imgData, 'JPEG', margin, margin, renderW, renderH);
      } else {
        var pageCanvas = document.createElement('canvas');
        var pageCtx = pageCanvas.getContext('2d');
        var slicePxH = Math.floor((usableH / renderW) * imgW);
        var y = 0;
        var first = true;

        while (y < imgH) {
          var sliceH = Math.min(slicePxH, imgH - y);
          pageCanvas.width = imgW;
          pageCanvas.height = sliceH;
          pageCtx.fillStyle = bg;
          pageCtx.fillRect(0, 0, imgW, sliceH);
          pageCtx.drawImage(canvas, 0, y, imgW, sliceH, 0, 0, imgW, sliceH);

          var sliceData = pageCanvas.toDataURL('image/jpeg', 0.92);
          var sliceRenderH = (sliceH * renderW) / imgW;

          if (!first) pdf.addPage();
          pdf.addImage(sliceData, 'JPEG', margin, margin, renderW, sliceRenderH);
          first = false;
          y += sliceH;
        }
      }

      var safeName = String(filename || 'export-' + stamp() + '.pdf');
      if (!/\.pdf$/i.test(safeName)) safeName += '.pdf';
      pdf.save(safeName);
    } finally {
      hidden.forEach(function (item) {
        item.node.style.display = item.display;
      });
      document.documentElement.classList.remove('pdf-exporting');
      document.body.classList.remove('pdf-exporting');
    }
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function waitForDashboardReady(win, timeoutMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      function check() {
        try {
          var doc = win.document;
          var name = doc.getElementById('eventName');
          var footer = doc.getElementById('footerMeta');
          var text = (name && name.textContent) || '';
          var ready =
            text &&
            text !== 'Carregando…' &&
            text !== 'Carregando evento…' &&
            text !== '—';
          var hasUpdate =
            footer && /atualização|finalizado|Última/i.test(footer.textContent || '');
          if (ready && hasUpdate) {
            resolve(true);
            return;
          }
        } catch (e) {
          /* ignore cross-frame races */
        }
        if (Date.now() - start > (timeoutMs || 8000)) {
          resolve(false);
          return;
        }
        setTimeout(check, 250);
      }
      check();
    });
  }

  /**
   * html2canvas fails on background-clip:text (clock shows empty gold boxes).
   * Flatten those styles to solid colors before capture.
   */
  function prepareDocForCapture(doc) {
    if (!doc) return;
    doc.querySelectorAll('.pdf-hide, [data-pdf-hide]').forEach(function (node) {
      node.style.display = 'none';
    });

    if (doc.getElementById('dashshows-pdf-capture-fix')) return;
    var style = doc.createElement('style');
    style.id = 'dashshows-pdf-capture-fix';
    style.textContent = [
      '#clockDate, #clockTime, #countdownValue {',
      '  background: none !important;',
      '  -webkit-background-clip: border-box !important;',
      '  background-clip: border-box !important;',
      '  color: #f0c14d !important;',
      '  -webkit-text-fill-color: #f0c14d !important;',
      '}',
      '#countdownValue.is-open {',
      '  color: #3ed9a0 !important;',
      '  -webkit-text-fill-color: #3ed9a0 !important;',
      '}',
      '#countdownValue.is-closed {',
      '  color: #a49eb8 !important;',
      '  -webkit-text-fill-color: #a49eb8 !important;',
      '}',
    ].join('\n');
    (doc.head || doc.documentElement).appendChild(style);

    // Always stamp date/time for capture (iframe may lag before first tick)
    try {
      var now = new Date();
      var pad = function (n) {
        return String(n).padStart(2, '0');
      };
      var dateEl = doc.getElementById('clockDate');
      var timeEl = doc.getElementById('clockTime');
      if (dateEl) {
        dateEl.textContent =
          pad(now.getDate()) + '/' + pad(now.getMonth() + 1) + '/' + now.getFullYear();
      }
      if (timeEl) {
        timeEl.textContent =
          pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
      }
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Capture the live/finalized show dashboard via a hidden iframe.
   * @param {string} slug
   * @returns {Promise<string|null>} JPEG data URL
   */
  async function captureShowDashboard(slug) {
    var html2canvasFn = global.html2canvas;
    if (!slug || typeof html2canvasFn !== 'function') return null;

    var iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText =
      'position:fixed;left:-12000px;top:0;width:1440px;height:900px;border:0;opacity:0;pointer-events:none;';

    var loaded = new Promise(function (resolve, reject) {
      iframe.onload = function () {
        resolve();
      };
      iframe.onerror = function () {
        reject(new Error('Falha ao carregar dashboard do show'));
      };
    });

    document.body.appendChild(iframe);
    iframe.src = '/shows/' + encodeURIComponent(slug);

    try {
      await loaded;
      await waitForDashboardReady(iframe.contentWindow, 9000);
      await sleep(500);

      var idoc = iframe.contentDocument;
      if (!idoc) return null;
      var shell = idoc.getElementById('exportRoot') || idoc.querySelector('.shell');
      if (!shell) return null;

      prepareDocForCapture(idoc);
      await waitFrames(2);

      var bg =
        getComputedStyle(idoc.body).backgroundColor ||
        getComputedStyle(document.body).backgroundColor ||
        '#0b0910';

      var canvas = await html2canvasFn(shell, {
        scale: 1.5,
        useCORS: true,
        allowTaint: true,
        backgroundColor: bg,
        logging: false,
        width: shell.scrollWidth,
        height: shell.scrollHeight,
        windowWidth: 1440,
        windowHeight: Math.max(900, shell.scrollHeight),
      });

      return canvas.toDataURL('image/jpeg', 0.9);
    } catch (err) {
      console.error('[export-pdf] dashboard capture', err);
      return null;
    } finally {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }
  }

  function prepareChart(ch, chartBg) {
    if (!ch) return null;
    var dataUrl = ch.dataUrl || (ch.canvas ? canvasToDataUrl(ch.canvas, chartBg) : null);
    if (!dataUrl) return null;
    return { title: ch.title || 'Gráfico', dataUrl: dataUrl, span: ch.span || 'full' };
  }

  function drawChartBlock(pdf, ch, x, y, w, h, chartBg) {
    var titleH = 6;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.setTextColor(30, 25, 40);
    pdf.text(String(ch.title || 'Gráfico'), x, y + 4);

    var imgY = y + titleH;
    var imgH = h - titleH;
    var props = pdf.getImageProperties(ch.dataUrl);
    var renderW = w;
    var renderH = (props.height * renderW) / props.width;
    if (renderH > imgH) {
      renderH = imgH;
      renderW = (props.width * renderH) / props.height;
    }
    var imgX = x + (w - renderW) / 2;

    pdf.setFillColor(22, 18, 31);
    pdf.roundedRect(x, imgY, w, imgH, 2, 2, 'F');
    pdf.addImage(ch.dataUrl, 'JPEG', imgX, imgY + (imgH - renderH) / 2, renderW, renderH);
  }

  function drawFallbackCover(pdf, doc, margin, usableW) {
    var y = margin;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.setTextColor(120, 110, 140);
    pdf.text('DashShows · Relatório do evento', margin, y);
    y += 8;

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(18);
    pdf.setTextColor(30, 25, 40);
    var titleLines = pdf.splitTextToSize(doc.title || 'Evento', usableW);
    pdf.text(titleLines, margin, y);
    y += titleLines.length * 8 + 2;

    if (doc.subtitle) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(11);
      pdf.setTextColor(90, 85, 105);
      pdf.text(String(doc.subtitle), margin, y);
      y += 8;
    }

    (doc.meta || []).forEach(function (row) {
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.setTextColor(90, 85, 105);
      pdf.text(String(row.label || '') + ':', margin, y);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(30, 25, 40);
      pdf.text(String(row.value || '—'), margin + 32, y);
      y += 6;
    });

    var kpis = doc.kpis || [];
    if (!kpis.length) return;
    y += 6;
    var cols = Math.min(3, kpis.length);
    var gap = 4;
    var cardW = (usableW - gap * (cols - 1)) / cols;
    var cardH = 22;
    for (var i = 0; i < kpis.length; i++) {
      var col = i % cols;
      if (col === 0 && i > 0) y += cardH + gap;
      var x = margin + col * (cardW + gap);
      var k = kpis[i];
      pdf.setFillColor(245, 243, 250);
      pdf.setDrawColor(220, 215, 230);
      pdf.roundedRect(x, y, cardW, cardH, 2, 2, 'FD');
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(110, 100, 125);
      pdf.text(String(k.label || ''), x + 3, y + 6);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(13);
      pdf.setTextColor(30, 25, 40);
      pdf.text(String(k.value || '—'), x + 3, y + 13);
      if (k.sub) {
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(7.5);
        pdf.setTextColor(120, 110, 140);
        pdf.text(String(k.sub), x + 3, y + 18.5);
      }
    }
  }

  /**
   * History report:
   *  - page 1: show dashboard print (landscape)
   *  - next pages: charts packed (2 stacked or side-by-side)
   */
  async function exportHistoryDocument(doc) {
    doc = doc || {};
    var JsPDF = resolveJsPdf();
    if (!JsPDF) throw new Error('jsPDF não carregou. Recarregue a página.');

    await waitFrames(2);

    var chartBg = doc.chartBg || '#16121f';
    var dashboardUrl = doc.dashboardDataUrl || null;
    if (!dashboardUrl && doc.dashboardSlug) {
      dashboardUrl = await captureShowDashboard(doc.dashboardSlug);
    }

    var charts = (doc.charts || [])
      .map(function (ch) {
        return prepareChart(ch, chartBg);
      })
      .filter(Boolean);

    var pdf = new JsPDF({
      orientation: 'landscape',
      unit: 'mm',
      format: 'a4',
      compress: true,
    });

    var pageW = pdf.internal.pageSize.getWidth();
    var pageH = pdf.internal.pageSize.getHeight();
    var margin = 10;
    var usableW = pageW - margin * 2;
    var usableH = pageH - margin * 2;

    // —— Page 1: dashboard ——
    if (dashboardUrl) {
      try {
        var dashProps = pdf.getImageProperties(dashboardUrl);
        var dashW = usableW;
        var dashH = (dashProps.height * dashW) / dashProps.width;
        if (dashH > usableH) {
          dashH = usableH;
          dashW = (dashProps.width * dashH) / dashProps.height;
        }
        var dashX = margin + (usableW - dashW) / 2;
        var dashY = margin + (usableH - dashH) / 2;
        pdf.setFillColor(11, 9, 16);
        pdf.rect(0, 0, pageW, pageH, 'F');
        pdf.addImage(dashboardUrl, 'JPEG', dashX, dashY, dashW, dashH);
      } catch (e) {
        drawFallbackCover(pdf, doc, margin, usableW);
      }
    } else {
      drawFallbackCover(pdf, doc, margin, usableW);
    }

    // —— Chart pages: pack in planned groups ——
    // groups: [access, weather], [evo], [sector, gate]
    var byTitle = {};
    charts.forEach(function (ch) {
      byTitle[ch.title] = ch;
    });

    // Page 2: acessos | Page 3: setor + clima | Page 4: totais lado a lado
    var groups = [
      {
        layout: 'full',
        items: [byTitle['Evolução dos acessos']].filter(Boolean),
      },
      {
        layout: 'stack',
        items: [
          byTitle['Evolução das entradas por setor'],
          byTitle['Evolução do clima'],
        ].filter(Boolean),
      },
      {
        layout: 'row',
        items: [
          byTitle['Entradas por setor · total'],
          byTitle['Entradas por portão'],
        ].filter(Boolean),
      },
    ];

    // Any leftover charts not in the plan
    var used = {};
    groups.forEach(function (g) {
      g.items.forEach(function (ch) {
        used[ch.title] = true;
      });
    });
    var leftovers = charts.filter(function (ch) {
      return !used[ch.title];
    });
    for (var li = 0; li < leftovers.length; li += 2) {
      groups.push({
        layout: leftovers[li + 1] ? 'stack' : 'full',
        items: leftovers.slice(li, li + 2),
      });
    }

    groups.forEach(function (group) {
      if (!group.items.length) return;
      pdf.addPage('a4', 'landscape');
      pageW = pdf.internal.pageSize.getWidth();
      pageH = pdf.internal.pageSize.getHeight();
      usableW = pageW - margin * 2;
      usableH = pageH - margin * 2;

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(120, 110, 140);
      pdf.text('DashShows · Histórico — ' + (doc.title || 'Evento'), margin, margin - 2);

      var contentTop = margin + 2;
      var contentH = usableH - 2;
      var gap = 6;

      if (group.layout === 'stack' && group.items.length >= 2) {
        var halfH = (contentH - gap) / 2;
        drawChartBlock(pdf, group.items[0], margin, contentTop, usableW, halfH, chartBg);
        drawChartBlock(
          pdf,
          group.items[1],
          margin,
          contentTop + halfH + gap,
          usableW,
          halfH,
          chartBg
        );
      } else if (group.layout === 'row' && group.items.length >= 2) {
        var halfW = (usableW - gap) / 2;
        drawChartBlock(pdf, group.items[0], margin, contentTop, halfW, contentH, chartBg);
        drawChartBlock(
          pdf,
          group.items[1],
          margin + halfW + gap,
          contentTop,
          halfW,
          contentH,
          chartBg
        );
      } else {
        drawChartBlock(pdf, group.items[0], margin, contentTop, usableW, contentH, chartBg);
      }
    });

    var safeName = String(doc.filename || 'historico-' + stamp() + '.pdf');
    if (!/\.pdf$/i.test(safeName)) safeName += '.pdf';
    pdf.save(safeName);
  }

  function bindExportButton(btn, getEl, getFilename, options) {
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (btn.disabled || btn.dataset.pdfBusy === '1' || btn.hidden) return;
      var target = typeof getEl === 'function' ? getEl() : getEl;
      if (!target) return;

      var label = btn.textContent;
      btn.dataset.pdfBusy = '1';
      btn.disabled = true;
      btn.textContent = 'Gerando…';

      exportElementToPdf(target, getFilename(), options)
        .catch(function (err) {
          console.error('[export-pdf]', err);
          alert(err.message || 'Falha ao gerar PDF');
        })
        .then(function () {
          btn.dataset.pdfBusy = '';
          btn.textContent = label;
          btn.disabled = false;
        });
    });
  }

  /**
   * Wire a button to a custom async exporter (e.g. history document).
   * @param {HTMLButtonElement|null} btn
   * @param {() => Promise<void>} exportFn
   */
  function bindAsyncExportButton(btn, exportFn) {
    if (!btn || typeof exportFn !== 'function') return;
    btn.addEventListener('click', function () {
      if (btn.disabled || btn.dataset.pdfBusy === '1' || btn.hidden) return;
      var label = btn.textContent;
      btn.dataset.pdfBusy = '1';
      btn.disabled = true;
      btn.textContent = 'Gerando…';

      Promise.resolve()
        .then(function () {
          return exportFn();
        })
        .catch(function (err) {
          console.error('[export-pdf]', err);
          alert(err.message || 'Falha ao gerar PDF');
        })
        .then(function () {
          btn.dataset.pdfBusy = '';
          btn.textContent = label;
          btn.disabled = false;
        });
    });
  }

  global.DashShowsPdf = {
    exportElementToPdf: exportElementToPdf,
    exportHistoryDocument: exportHistoryDocument,
    captureShowDashboard: captureShowDashboard,
    bindExportButton: bindExportButton,
    bindAsyncExportButton: bindAsyncExportButton,
    slugify: slugify,
    stamp: stamp,
    canvasToDataUrl: canvasToDataUrl,
  };
})(typeof window !== 'undefined' ? window : this);
