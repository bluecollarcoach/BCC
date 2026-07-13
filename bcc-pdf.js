/*
 * bcc-pdf.js — In-app "Adobe-like" PDF editor (split / organize / merge / sign / fill).
 *
 * Entirely client-side: the file bytes never leave the browser except when the
 * user explicitly saves the result back to a store they chose. Uses two vendored
 * libraries (no runtime CDN):
 *   - pdf.js  (/lib/pdf.min.js + /lib/pdf.worker.min.js) — renders page thumbnails
 *     and the signing canvas, and gives us viewport.convertToPdfPoint() for exact
 *     screen->PDF coordinate mapping (correct under any page /Rotate).
 *   - pdf-lib (/lib/pdf-lib.min.js) — copies/reorders/rotates/deletes pages, merges
 *     documents, and draws signatures / text / dates onto pages.
 *
 * Public API (window.bccPdfEditor):
 *   .canEdit(name, mime) -> boolean            // is this a PDF we can open?
 *   .open({ bytes, name, saveTargets, onSaved })
 *       bytes:       ArrayBuffer | Uint8Array of the initial PDF (optional; if
 *                    omitted the editor opens empty and prompts to add a file).
 *       name:        original filename (used to suggest the export name).
 *       saveTargets: [{ label, icon?, handler(blob, filename) -> Promise }]
 *                    extra "Save to …" buttons (Download is always offered).
 *       onSaved:     optional () invoked after a saveTargets handler resolves.
 */
(function () {
  'use strict';

  /* ---------- lazy library loading ---------- */
  var LIBS_READY = null;
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function ensureLibs() {
    if (LIBS_READY) return LIBS_READY;
    LIBS_READY = (async function () {
      if (!window.PDFLib) await loadScript('/lib/pdf-lib.min.js');
      if (!window.pdfjsLib) await loadScript('/lib/pdf.min.js');
      if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/lib/pdf.worker.min.js';
      }
      if (!window.PDFLib || !window.pdfjsLib) throw new Error('PDF tools failed to load.');
      return { PDFLib: window.PDFLib, pdfjsLib: window.pdfjsLib };
    })();
    // If loading fails, let the next open() retry from scratch.
    LIBS_READY.catch(function () { LIBS_READY = null; });
    return LIBS_READY;
  }

  /* ---------- small helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, kind, ms) {
    if (window.bccNotify) window.bccNotify(msg, kind || 'info', ms || 4000);
    else if (kind === 'error') alert(msg);
  }
  function toU8(buf) {
    if (buf instanceof Uint8Array) return buf;
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
    return new Uint8Array(buf || []);
  }
  function baseName(name) { return String(name || 'document.pdf').replace(/\.[^.]+$/, ''); }
  function uid() { return 'p' + (uid._n = (uid._n || 0) + 1); }
  function canEdit(name, mime) {
    var ext = /\.([a-z0-9]+)$/i.exec(name || ''); ext = ext ? ext[1].toLowerCase() : '';
    return ext === 'pdf' || String(mime || '').toLowerCase() === 'application/pdf';
  }

  /* ---------- styles (injected once) ---------- */
  function injectStyles() {
    if (document.getElementById('bpdf-styles')) return;
    var css = [
      '.bpdf-ov{position:fixed;inset:0;background:rgba(28,24,20,.62);z-index:12000;display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;}',
      '.bpdf-modal{background:var(--paper,#fbfaf7);color:var(--ink,#241f1b);width:min(1120px,100%);height:min(92vh,960px);border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.42);display:flex;flex-direction:column;overflow:hidden;font:inherit;}',
      '.bpdf-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--chrome-mute,#e6e5e1);background:var(--gold-fade,#faf6ec);}',
      '.bpdf-title{font-weight:800;font-size:15px;flex:0 0 auto;}',
      '.bpdf-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted,#7a726a);font-size:13px;}',
      '.bpdf-x{border:0;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:var(--muted,#7a726a);width:34px;height:34px;border-radius:8px;}',
      '.bpdf-x:hover{background:rgba(0,0,0,.06);}',
      '.bpdf-tabs{display:flex;gap:4px;padding:8px 14px 0;background:var(--gold-fade,#faf6ec);border-bottom:1px solid var(--chrome-mute,#e6e5e1);}',
      '.bpdf-tab{border:0;background:transparent;padding:8px 14px;font:inherit;font-weight:700;font-size:13px;color:var(--muted,#7a726a);border-radius:8px 8px 0 0;cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-1px;}',
      '.bpdf-tab.on{color:var(--ink,#241f1b);border-bottom-color:var(--gold-deep,#b8860b);background:var(--paper,#fbfaf7);}',
      '.bpdf-body{flex:1;min-height:0;overflow:auto;padding:14px 16px;}',
      '.bpdf-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px;}',
      '.bpdf-btn{border:1px solid var(--chrome-mute,#d9d6cf);background:#fff;color:var(--ink,#241f1b);border-radius:8px;padding:7px 12px;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px;min-height:34px;}',
      '.bpdf-btn:hover:not(:disabled){border-color:var(--gold-deep,#b8860b);}',
      '.bpdf-btn:disabled{opacity:.45;cursor:default;}',
      '.bpdf-btn.primary{background:var(--gold-deep,#b8860b);border-color:var(--gold-deep,#b8860b);color:#fff;}',
      '.bpdf-btn.danger{color:var(--burgundy,#7a1f2b);border-color:#e3c6ca;}',
      '.bpdf-sep{width:1px;align-self:stretch;background:var(--chrome-mute,#e6e5e1);margin:0 2px;}',
      '.bpdf-hint{font-size:12px;color:var(--muted,#7a726a);margin-left:auto;}',
      '.bpdf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px;}',
      '.bpdf-card{border:1px solid var(--chrome-mute,#e6e5e1);border-radius:10px;background:#fff;padding:8px;display:flex;flex-direction:column;gap:6px;position:relative;transition:box-shadow .12s,border-color .12s;}',
      '.bpdf-card.sel{border-color:var(--gold-deep,#b8860b);box-shadow:0 0 0 2px rgba(184,134,11,.22);}',
      '.bpdf-card.drag{opacity:.4;}',
      '.bpdf-card.over{border-color:var(--gold-deep,#b8860b);border-style:dashed;}',
      '.bpdf-thumbwrap{position:relative;background:#f1eee8;border-radius:6px;overflow:hidden;min-height:120px;display:flex;align-items:center;justify-content:center;cursor:grab;}',
      '.bpdf-thumbwrap canvas,.bpdf-thumbwrap img{max-width:100%;height:auto;display:block;box-shadow:0 1px 4px rgba(0,0,0,.14);}',
      '.bpdf-pageno{position:absolute;top:6px;left:6px;background:rgba(28,24,20,.72);color:#fff;font-size:11px;font-weight:700;border-radius:6px;padding:1px 7px;}',
      '.bpdf-annbadge{position:absolute;bottom:6px;right:6px;background:var(--gold-deep,#b8860b);color:#fff;font-size:10px;font-weight:700;border-radius:6px;padding:1px 6px;}',
      '.bpdf-cardbar{display:flex;align-items:center;gap:4px;justify-content:space-between;}',
      '.bpdf-chk{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--muted,#7a726a);cursor:pointer;}',
      '.bpdf-icobtns{display:flex;gap:2px;}',
      '.bpdf-ico{border:0;background:transparent;cursor:pointer;font-size:14px;width:26px;height:26px;border-radius:6px;color:var(--muted,#7a726a);}',
      '.bpdf-ico:hover{background:rgba(0,0,0,.07);color:var(--ink,#241f1b);}',
      '.bpdf-empty{text-align:center;color:var(--muted,#7a726a);padding:48px 20px;font-size:14px;}',
      /* signing view */
      '.bpdf-signwrap{display:flex;gap:14px;align-items:flex-start;}',
      '.bpdf-signstage{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:10px;}',
      '.bpdf-canvaswrap{position:relative;line-height:0;box-shadow:0 2px 12px rgba(0,0,0,.18);border-radius:4px;overflow:hidden;background:#fff;max-width:100%;}',
      '.bpdf-canvaswrap canvas{display:block;max-width:100%;height:auto;}',
      '.bpdf-side{flex:0 0 190px;display:flex;flex-direction:column;gap:8px;}',
      '.bpdf-ann{position:absolute;border:1px dashed rgba(184,134,11,.9);background:rgba(184,134,11,.05);cursor:move;box-sizing:border-box;touch-action:none;}',
      '.bpdf-ann img{width:100%;height:100%;object-fit:contain;pointer-events:none;-webkit-user-drag:none;}',
      '.bpdf-ann .bpdf-anntext{width:100%;height:100%;outline:none;overflow:hidden;white-space:pre;line-height:1;color:#0a2a5e;font-family:Helvetica,Arial,sans-serif;}',
      '.bpdf-ann .bpdf-del{position:absolute;top:-11px;right:-11px;width:22px;height:22px;border-radius:50%;background:var(--burgundy,#7a1f2b);color:#fff;border:2px solid #fff;font-size:12px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;}',
      '.bpdf-ann .bpdf-rs{position:absolute;right:-8px;bottom:-8px;width:16px;height:16px;border-radius:50%;background:var(--gold-deep,#b8860b);border:2px solid #fff;cursor:nwse-resize;}',
      '.bpdf-pagepick{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted,#7a726a);}',
      '.bpdf-pagepick select{font:inherit;padding:4px 8px;border-radius:7px;border:1px solid var(--chrome-mute,#d9d6cf);}',
      /* signature pad modal */
      '.bpdf-pad-ov{position:fixed;inset:0;background:rgba(28,24,20,.5);z-index:12100;display:flex;align-items:center;justify-content:center;padding:16px;}',
      '.bpdf-pad{background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.4);width:min(520px,100%);overflow:hidden;}',
      '.bpdf-pad-head{padding:12px 16px;border-bottom:1px solid var(--chrome-mute,#e6e5e1);font-weight:800;font-size:14px;}',
      '.bpdf-pad-body{padding:16px;}',
      '.bpdf-pad-tabs{display:flex;gap:6px;margin-bottom:12px;}',
      '.bpdf-padcanvas{border:1px solid var(--chrome-mute,#d9d6cf);border-radius:8px;width:100%;height:180px;touch-action:none;background:#fff;cursor:crosshair;display:block;}',
      '.bpdf-typed{width:100%;box-sizing:border-box;font-size:38px;padding:18px 10px;border:1px solid var(--chrome-mute,#d9d6cf);border-radius:8px;text-align:center;}',
      '.bpdf-pad-foot{display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;border-top:1px solid var(--chrome-mute,#e6e5e1);}',
      '.bpdf-spin{display:inline-block;width:15px;height:15px;border:2px solid rgba(0,0,0,.18);border-top-color:var(--gold-deep,#b8860b);border-radius:50%;animation:bpdfspin .7s linear infinite;vertical-align:-2px;}',
      '@keyframes bpdfspin{to{transform:rotate(360deg);}}',
      '.bpdf-load{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100%;color:var(--muted,#7a726a);font-size:14px;}',
      '@media (max-width:720px){.bpdf-signwrap{flex-direction:column;}.bpdf-side{flex:1 1 auto;width:100%;flex-direction:row;flex-wrap:wrap;}}'
    ].join('');
    var st = document.createElement('style');
    st.id = 'bpdf-styles'; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ============================================================= *
   *  Editor
   * ============================================================= */
  var OPEN = false;

  async function open(opts) {
    opts = opts || {};
    if (OPEN) { toast('The PDF editor is already open.', 'warn'); return; }
    injectStyles();
    OPEN = true;

    var ov = document.createElement('div');
    ov.className = 'bpdf-ov';
    ov.innerHTML =
      '<div class="bpdf-modal" role="dialog" aria-label="PDF editor">' +
        '<div class="bpdf-head">' +
          '<span class="bpdf-title">📄 PDF tools</span>' +
          '<span class="bpdf-name" id="bpdf-name"></span>' +
          '<button class="bpdf-x" id="bpdf-x" title="Close" aria-label="Close">×</button>' +
        '</div>' +
        '<div class="bpdf-tabs">' +
          '<button class="bpdf-tab on" data-tab="pages">✂️ Organize &amp; split</button>' +
          '<button class="bpdf-tab" data-tab="sign">✍️ Sign &amp; fill</button>' +
        '</div>' +
        '<div class="bpdf-body" id="bpdf-body"><div class="bpdf-load"><span class="bpdf-spin"></span> Loading PDF tools…</div></div>' +
      '</div>';
    document.body.appendChild(ov);

    var ST = {
      ov: ov,
      libs: null,
      name: opts.name || 'document.pdf',
      saveTargets: Array.isArray(opts.saveTargets) ? opts.saveTargets : [],
      onSaved: typeof opts.onSaved === 'function' ? opts.onSaved : null,
      sources: {},        // id -> { bytes:Uint8Array, pjs:pdfjsDoc }
      order: [],          // [{ key, srcId, srcIndex, base, rot, sel, ann:[] }]
      tab: 'pages',
      signPageKey: null,
      dirty: false,
      closed: false
    };

    function setName() {
      var n = document.getElementById('bpdf-name');
      if (n) n.textContent = ST.name + (ST.dirty ? ' • edited' : '');
    }
    setName();

    function destroy() {
      ST.closed = true;
      // release pdf.js docs AND drop the raw bytes — client documents must not
      // stay reachable in memory after the editor closes.
      Object.keys(ST.sources).forEach(function (id) {
        try { ST.sources[id].pjs && ST.sources[id].pjs.destroy && ST.sources[id].pjs.destroy(); } catch (e) {}
      });
      ST.sources = {}; ST.order = [];
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      document.removeEventListener('keydown', onKey);
      OPEN = false;
    }
    function tryClose() {
      if (ST.dirty && !confirm('Close the editor? Unsaved changes will be lost.')) return;
      destroy();
    }
    function onKey(e) { if (e.key === 'Escape' && !document.querySelector('.bpdf-pad-ov')) tryClose(); }
    document.getElementById('bpdf-x').onclick = tryClose;
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) tryClose(); });
    document.addEventListener('keydown', onKey);

    ov.querySelectorAll('.bpdf-tab').forEach(function (t) {
      t.onclick = function () {
        var next = t.getAttribute('data-tab');
        if (ST.tab === next) return;
        if (ST.tab === 'sign') captureSignOverlays(ST); // leaving the sign tab: persist placed overlays first
        ov.querySelectorAll('.bpdf-tab').forEach(function (x) { x.classList.remove('on'); });
        t.classList.add('on');
        ST.tab = next;
        render(ST);
      };
    });

    // ---- load libs + initial file ----
    try {
      ST.libs = await ensureLibs();
      if (ST.closed) return;
      if (opts.bytes) {
        await addSource(ST, toU8(opts.bytes), ST.name);
      }
      if (ST.closed) return;
      render(ST);
    } catch (e) {
      // Tear the modal down and surface the error as a toast — leaving the errored
      // modal up kept OPEN=true, so clicking Edit/Sign again could never retry.
      destroy();
      toast('Could not open the PDF: ' + (e && e.message || e), 'error', 8000);
      return;
    }

    // expose a couple of state handles for delegated handlers
    ST._destroy = destroy;
    ST._tryClose = tryClose;
    ST._setName = setName;
    ST.render = function () { render(ST); };
  }

  /* ---------- sources & pages ---------- */
  async function addSource(ST, bytes, name) {
    var pjsLib = ST.libs.pdfjsLib;
    var id = uid();
    // pdf.js may detach the buffer it's given — hand it a copy, keep our own for pdf-lib.
    var doc = await pjsLib.getDocument({ data: bytes.slice(), disableAutoFetch: true, isEvalSupported: false }).promise;
    ST.sources[id] = { bytes: bytes, pjs: doc, name: name };
    for (var i = 0; i < doc.numPages; i++) {
      var pg = await doc.getPage(i + 1);
      var base = ((pg.rotate || 0) % 360 + 360) % 360;
      ST.order.push({ key: uid(), srcId: id, srcIndex: i, base: base, rot: 0, sel: false, ann: [] });
    }
    return id;
  }

  function entryPjsPage(ST, entry) { return ST.sources[entry.srcId].pjs.getPage(entry.srcIndex + 1); }

  /* ============================================================= *
   *  Render dispatch
   * ============================================================= */
  function render(ST) {
    if (ST.closed) return;
    if (ST.tab === 'pages') renderPages(ST);
    else renderSign(ST);
    if (ST._setName) ST._setName();
  }

  /* ---------- Organize & split ---------- */
  function renderPages(ST) {
    var body = document.getElementById('bpdf-body'); if (!body) return;
    var selCount = ST.order.filter(function (e) { return e.sel; }).length;
    var toolbar =
      '<div class="bpdf-toolbar">' +
        '<button class="bpdf-btn" data-act="add">➕ Add / merge PDF</button>' +
        '<span class="bpdf-sep"></span>' +
        '<button class="bpdf-btn" data-act="rotateSel" ' + (selCount ? '' : 'disabled') + '>⟳ Rotate</button>' +
        '<button class="bpdf-btn danger" data-act="delSel" ' + (selCount ? '' : 'disabled') + '>🗑 Delete</button>' +
        '<button class="bpdf-btn" data-act="extractSel" ' + (selCount ? '' : 'disabled') + '>✂️ Extract to new PDF</button>' +
        '<span class="bpdf-sep"></span>' +
        '<button class="bpdf-btn" data-act="selAll">' + (selCount === ST.order.length && ST.order.length ? 'Clear selection' : 'Select all') + '</button>' +
        '<span class="bpdf-hint">' + (selCount ? (selCount + ' selected · ') : '') + ST.order.length + ' page' + (ST.order.length === 1 ? '' : 's') + ' · drag to reorder</span>' +
      '</div>';

    if (!ST.order.length) {
      body.innerHTML = toolbar + '<div class="bpdf-empty">No pages yet.<br><button class="bpdf-btn primary" data-act="add" style="margin-top:12px;">➕ Add a PDF</button></div>';
      wirePagesToolbar(ST, body);
      return;
    }
    var cards = ST.order.map(function (e, idx) {
      return '<div class="bpdf-card' + (e.sel ? ' sel' : '') + '" data-key="' + e.key + '" draggable="true">' +
        '<div class="bpdf-thumbwrap" data-key="' + e.key + '"><div class="bpdf-pageno">' + (idx + 1) + '</div>' +
          (e.ann && e.ann.length ? '<div class="bpdf-annbadge" title="Has signatures / marks">✍ ' + e.ann.length + '</div>' : '') +
        '</div>' +
        '<div class="bpdf-cardbar">' +
          '<label class="bpdf-chk"><input type="checkbox" data-sel="' + e.key + '" ' + (e.sel ? 'checked' : '') + '/> select</label>' +
          '<div class="bpdf-icobtns">' +
            '<button class="bpdf-ico" data-rot="' + e.key + '" title="Rotate 90°">⟳</button>' +
            '<button class="bpdf-ico" data-del="' + e.key + '" title="Delete page">🗑</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
    body.innerHTML = toolbar + '<div class="bpdf-grid" id="bpdf-grid">' + cards + '</div>';
    wirePagesToolbar(ST, body);
    // render thumbnails (lazy)
    var grid = document.getElementById('bpdf-grid');
    ST.order.forEach(function (e) {
      var wrap = grid.querySelector('.bpdf-thumbwrap[data-key="' + e.key + '"]');
      if (wrap) queueThumb(ST, e, wrap);
    });
    wireDnd(ST, grid);
  }

  function wirePagesToolbar(ST, body) {
    body.querySelectorAll('[data-act]').forEach(function (b) {
      b.onclick = function () { pagesAction(ST, b.getAttribute('data-act')); };
    });
    body.querySelectorAll('[data-sel]').forEach(function (cb) {
      cb.onchange = function () {
        var e = findEntry(ST, cb.getAttribute('data-sel')); if (e) e.sel = cb.checked;
        renderPages(ST);
      };
    });
    body.querySelectorAll('[data-rot]').forEach(function (b) {
      b.onclick = function () { var e = findEntry(ST, b.getAttribute('data-rot')); if (e) { e.rot = (e.rot + 90) % 360; ST.dirty = true; renderPages(ST); } };
    });
    body.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = function () { deleteKeys(ST, [b.getAttribute('data-del')]); };
    });
    // footer save bar (shared)
    ensureSaveBar(ST);
  }

  function findEntry(ST, key) { for (var i = 0; i < ST.order.length; i++) if (ST.order[i].key === key) return ST.order[i]; return null; }

  function deleteKeys(ST, keys) {
    var set = {}; keys.forEach(function (k) { set[k] = 1; });
    var removed = ST.order.filter(function (e) { return set[e.key]; });
    if (removed.length === ST.order.length && ST.order.length) {
      if (!confirm('Delete all pages?')) return;
    }
    ST.order = ST.order.filter(function (e) { return !set[e.key]; });
    ST.dirty = true;
    renderPages(ST);
  }

  function pagesAction(ST, act) {
    if (act === 'add') { pickFile(function (f) { readFileBytes(f).then(function (u8) { addSource(ST, u8, f.name).then(function () { ST.dirty = true; renderPages(ST); toast('Added ' + f.name, 'success'); }).catch(function (e) { toast('Could not add: ' + e.message, 'error'); }); }); }); return; }
    if (act === 'selAll') {
      var allSel = ST.order.every(function (e) { return e.sel; }) && ST.order.length;
      ST.order.forEach(function (e) { e.sel = !allSel; });
      renderPages(ST); return;
    }
    var sel = ST.order.filter(function (e) { return e.sel; });
    if (act === 'rotateSel') { sel.forEach(function (e) { e.rot = (e.rot + 90) % 360; }); ST.dirty = true; renderPages(ST); return; }
    if (act === 'delSel') { deleteKeys(ST, sel.map(function (e) { return e.key; })); return; }
    if (act === 'extractSel') { extractSelected(ST, sel); return; }
  }

  async function extractSelected(ST, sel) {
    if (!sel.length) return;
    try {
      var bytes = await buildPdf(ST, sel);
      var fn = baseName(ST.name) + '-extract-' + sel.length + 'p.pdf';
      downloadBytes(bytes, fn);
      toast('Extracted ' + sel.length + ' page' + (sel.length === 1 ? '' : 's') + '.', 'success');
    } catch (e) { toast('Extract failed: ' + e.message, 'error', 7000); }
  }

  /* ---------- drag & drop reorder ---------- */
  function wireDnd(ST, grid) {
    var dragKey = null;
    grid.querySelectorAll('.bpdf-card').forEach(function (card) {
      card.addEventListener('dragstart', function (e) {
        dragKey = card.getAttribute('data-key');
        card.classList.add('drag');
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragKey); } catch (_) {}
      });
      card.addEventListener('dragend', function () { dragKey = null; card.classList.remove('drag'); grid.querySelectorAll('.over').forEach(function (c) { c.classList.remove('over'); }); });
      card.addEventListener('dragover', function (e) { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch (_) {} card.classList.add('over'); });
      card.addEventListener('dragleave', function () { card.classList.remove('over'); });
      card.addEventListener('drop', function (e) {
        e.preventDefault(); card.classList.remove('over');
        var from = dragKey || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
        var to = card.getAttribute('data-key');
        if (!from || from === to) return;
        moveEntry(ST, from, to);
      });
    });
  }
  function moveEntry(ST, fromKey, toKey) {
    var fi = ST.order.findIndex(function (e) { return e.key === fromKey; });
    var ti = ST.order.findIndex(function (e) { return e.key === toKey; });
    if (fi < 0 || ti < 0) return;
    var it = ST.order.splice(fi, 1)[0];
    ST.order.splice(ti, 0, it);
    ST.dirty = true;
    renderPages(ST);
  }

  /* ---------- thumbnail render queue (cached per page+rotation) ---------- */
  function queueThumb(ST, entry, wrap) {
    var rotation = (entry.base + entry.rot) % 360;
    // Cache hit: reuse the last rendered bitmap instead of a full pdf.js render —
    // renderPages() rebuilds ALL cards on every click (select, rotate, reorder…),
    // and re-rendering every page each time makes large PDFs unusable.
    if (entry._thumb && entry._thumb.rot === rotation) {
      var img = document.createElement('img');
      img.src = entry._thumb.url; img.alt = '';
      wrap.appendChild(img);
      return;
    }
    ST._thumbQ = ST._thumbQ || [];
    ST._thumbQ.push({ entry: entry, wrap: wrap });
    if (!ST._thumbBusy) drainThumbs(ST);
  }
  async function drainThumbs(ST) {
    ST._thumbBusy = true;
    while (ST._thumbQ && ST._thumbQ.length) {
      var job = ST._thumbQ.shift();
      if (ST.closed) break;
      if (!job.wrap.isConnected) continue;
      try {
        var page = await entryPjsPage(ST, job.entry);
        var rotation = (job.entry.base + job.entry.rot) % 360;
        var vp0 = page.getViewport({ scale: 1, rotation: rotation });
        var scale = Math.min(1.2, 150 / vp0.width);
        var vp = page.getViewport({ scale: scale, rotation: rotation });
        var canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        try { job.entry._thumb = { rot: rotation, url: canvas.toDataURL('image/png') }; } catch (e) {}
        if (job.wrap.isConnected) {
          // canvas is normal-flow; the page-number / badge divs are absolute and paint over it
          job.wrap.appendChild(canvas);
        }
      } catch (e) { /* leave placeholder */ }
    }
    ST._thumbBusy = false;
  }

  /* ============================================================= *
   *  Sign & fill
   * ============================================================= */
  function renderSign(ST) {
    var body = document.getElementById('bpdf-body'); if (!body) return;
    // Invalidate the sign handles NOW: the innerHTML replacement below detaches the
    // old canvas, and a stale (non-null, detached) handle would let addAnnotation
    // place a stamp into the loading wrap — wiped when the async render finishes.
    ST._signCanvas = ST._signVp = ST._signEntry = null;
    if (!ST.order.length) { body.innerHTML = '<div class="bpdf-empty">Add a PDF first (Organize &amp; split tab).</div>'; ensureSaveBar(ST); return; }
    if (!findEntry(ST, ST.signPageKey)) ST.signPageKey = ST.order[0].key;

    var opts = ST.order.map(function (e, i) {
      return '<option value="' + e.key + '"' + (e.key === ST.signPageKey ? ' selected' : '') + '>Page ' + (i + 1) + (e.ann.length ? ' ✍' : '') + '</option>';
    }).join('');

    body.innerHTML =
      '<div class="bpdf-toolbar">' +
        '<span class="bpdf-pagepick">Page: <select id="bpdf-signpage">' + opts + '</select></span>' +
        '<span class="bpdf-sep"></span>' +
        '<button class="bpdf-btn" data-sign="sig">✍️ Signature</button>' +
        '<button class="bpdf-btn" data-sign="text">🅰 Text</button>' +
        '<button class="bpdf-btn" data-sign="date">📅 Date</button>' +
        '<button class="bpdf-btn" data-sign="check">✔ Check</button>' +
        '<span class="bpdf-hint">Click a tool, then drag the box where you want it. Drag corner to resize.</span>' +
      '</div>' +
      '<div class="bpdf-signwrap">' +
        '<div class="bpdf-signstage"><div class="bpdf-canvaswrap" id="bpdf-cwrap"><div class="bpdf-load" style="height:300px;"><span class="bpdf-spin"></span> Rendering page…</div></div></div>' +
      '</div>';

    document.getElementById('bpdf-signpage').onchange = function () {
      captureSignOverlays(ST);
      ST.signPageKey = this.value;
      renderSign(ST);
    };
    body.querySelectorAll('[data-sign]').forEach(function (b) {
      b.onclick = function () { addAnnotation(ST, b.getAttribute('data-sign')); };
    });
    ensureSaveBar(ST);
    renderSignPage(ST);
  }

  async function renderSignPage(ST) {
    var wrap = document.getElementById('bpdf-cwrap'); if (!wrap) return;
    var entry = findEntry(ST, ST.signPageKey); if (!entry) return;
    try {
      var page = await entryPjsPage(ST, entry);
      var rotation = (entry.base + entry.rot) % 360;
      var vp0 = page.getViewport({ scale: 1, rotation: rotation });
      // pick a scale that fits the available width but stays crisp
      var avail = Math.max(320, Math.min(720, (wrap.parentNode.clientWidth || 700)));
      var scale = Math.min(2, avail / vp0.width);
      var vp = page.getViewport({ scale: scale, rotation: rotation });
      var canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      if (!wrap.isConnected) return;
      wrap.innerHTML = '';
      wrap.appendChild(canvas);
      // store the viewport used, for coordinate mapping on capture
      ST._signVp = vp; ST._signCanvas = canvas; ST._signEntry = entry;
      // re-attach existing annotations for this page as editable overlays
      entry.ann.forEach(function (a) { addOverlayFromAnn(ST, wrap, canvas, vp, a); });
    } catch (e) {
      ST._signCanvas = ST._signVp = ST._signEntry = null; // no live canvas — block placements
      wrap.innerHTML = '<div class="bpdf-empty" style="color:var(--burgundy,#7a1f2b);">Could not render this page.</div>';
    }
  }

  /* place a new annotation: prompt for content, then drop a draggable box */
  function addAnnotation(ST, kind) {
    var wrap = document.getElementById('bpdf-cwrap');
    var canvas = ST._signCanvas;
    // The canvas must be the LIVE one inside the current wrap — a detached handle
    // means a page render is still in flight and the stamp would be wiped.
    if (!wrap || !canvas || !canvas.isConnected || canvas.parentNode !== wrap) { toast('Page is still rendering…', 'warn'); return; }
    if (kind === 'sig') {
      openSignaturePad(function (res) {
        if (!res) return;
        dropOverlay(ST, wrap, canvas, { type: 'sig', src: res.dataUrl, aspect: res.w / res.h });
      });
      return;
    }
    if (kind === 'date') {
      var d = new Date();
      var txt = (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
      dropOverlay(ST, wrap, canvas, { type: 'text', text: txt });
      return;
    }
    if (kind === 'check') { dropOverlay(ST, wrap, canvas, { type: 'text', text: '✔', check: true }); return; }
    // text
    var t = prompt('Text to add:'); if (t == null) return; t = String(t).trim(); if (!t) return;
    dropOverlay(ST, wrap, canvas, { type: 'text', text: t });
  }

  /* measure how wide a text box must be to show the whole string (px, at box height h) */
  var _measCtx = null;
  function measureTextW(text, boxH) {
    if (!_measCtx) _measCtx = document.createElement('canvas').getContext('2d');
    _measCtx.font = Math.round(boxH * 0.82) + 'px Helvetica, Arial, sans-serif';
    return Math.max(boxH * 0.6, _measCtx.measureText(String(text || '')).width + boxH * 0.3);
  }

  /* create the visual overlay element (fresh placement, centered) */
  function dropOverlay(ST, wrap, canvas, spec) {
    var cw = canvas.clientWidth || canvas.width;
    var defW, defH;
    if (spec.type === 'sig') { defW = Math.min(cw * 0.34, 240); defH = defW / (spec.aspect || 3); }
    else {
      // Size the box to FIT the text (measured), and lock its aspect — what you see
      // on screen is exactly what drawText produces; nothing is clipped or overflows.
      defH = Math.max(20, Math.min(cw * 0.05, 34));
      defW = measureTextW(spec.text, defH);
      if (defW > cw * 0.9) { defH = Math.max(10, defH * (cw * 0.9) / defW); defW = cw * 0.9; }
      spec.aspect = defW / defH;
    }
    var left = (cw - defW) / 2, top = (canvas.clientHeight || canvas.height) * 0.4;
    var el = buildOverlayEl(ST, wrap, canvas, spec, left, top, defW, defH);
    wrap.appendChild(el);
    ST.dirty = true;
  }

  function buildOverlayEl(ST, wrap, canvas, spec, left, top, w, h) {
    var el = document.createElement('div');
    el.className = 'bpdf-ann';
    el.style.left = left + 'px'; el.style.top = top + 'px';
    el.style.width = w + 'px'; el.style.height = h + 'px';
    el._spec = spec;
    var inner = '';
    if (spec.type === 'sig') inner = '<img src="' + esc(spec.src) + '" alt="signature" />';
    else inner = '<div class="bpdf-anntext" style="font-size:' + Math.round(h * 0.82) + 'px;">' + esc(spec.text) + '</div>';
    el.innerHTML = inner +
      '<button class="bpdf-del" title="Remove" type="button">×</button>' +
      '<span class="bpdf-rs" title="Resize"></span>';
    el.querySelector('.bpdf-del').onclick = function (ev) { ev.stopPropagation(); el.remove(); ST.dirty = true; };
    var textEl = el.querySelector('.bpdf-anntext');
    if (textEl) {
      // double-click to edit text; the box re-fits the new string so screen == PDF
      el.addEventListener('dblclick', function () {
        var nt = prompt('Edit text:', spec.text); if (nt == null) return; spec.text = String(nt); textEl.textContent = spec.text;
        var hNow = parseFloat(el.style.height) || 20;
        var wFit = measureTextW(spec.text, hNow);
        var maxW = (canvas.clientWidth || canvas.width) - (parseFloat(el.style.left) || 0);
        if (wFit > maxW) { hNow = Math.max(10, hNow * maxW / wFit); wFit = maxW; el.style.height = hNow + 'px'; textEl.style.fontSize = Math.round(hNow * 0.82) + 'px'; }
        el.style.width = wFit + 'px'; spec.aspect = wFit / hNow;
        ST.dirty = true;
      });
    }
    makeDraggable(el, wrap, canvas, textEl, ST);
    return el;
  }

  function addOverlayFromAnn(ST, wrap, canvas, vp, a) {
    // convert stored PDF geometry back to on-screen CSS px box
    var box = pdfBoxToCss(vp, canvas, a);
    var spec = a.type === 'sig'
      ? { type: 'sig', src: a.src, aspect: a.aspect }
      : { type: 'text', text: a.text, check: a.check, aspect: (a.w && a.h) ? a.w / a.h : undefined };
    var el = buildOverlayEl(ST, wrap, canvas, spec, box.left, box.top, box.w, box.h);
    wrap.appendChild(el);
  }

  function makeDraggable(el, wrap, canvas, textEl, ST) {
    var mode = null, sx, sy, ox, oy, ow, oh;
    function down(e) {
      if (e.target.classList.contains('bpdf-del')) return;
      var resize = e.target.classList.contains('bpdf-rs');
      mode = resize ? 'resize' : 'move';
      var p = pt(e); sx = p.x; sy = p.y;
      ox = parseFloat(el.style.left); oy = parseFloat(el.style.top);
      ow = parseFloat(el.style.width); oh = parseFloat(el.style.height);
      e.preventDefault(); e.stopPropagation();
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      window.addEventListener('touchmove', move, { passive: false }); window.addEventListener('touchend', up);
    }
    function move(e) {
      if (!mode) return; e.preventDefault();
      var p = pt(e); var dx = p.x - sx, dy = p.y - sy;
      var maxW = canvas.clientWidth, maxH = canvas.clientHeight;
      if (mode === 'move') {
        var nl = Math.max(0, Math.min(maxW - ow, ox + dx));
        var nt = Math.max(0, Math.min(maxH - oh, oy + dy));
        el.style.left = nl + 'px'; el.style.top = nt + 'px';
      } else {
        var nw = Math.max(24, Math.min(maxW - ox, ow + dx));
        var nh;
        if (el._spec.aspect) {
          // Aspect-locked (signatures + text). If the aspect-correct height hits the
          // page bottom, clamp it AND re-derive the width, or the export stretches.
          nh = nw / el._spec.aspect;
          if (nh > maxH - oy) { nh = maxH - oy; nw = nh * el._spec.aspect; }
        } else {
          nh = Math.max(12, Math.min(maxH - oy, oh + dy));
        }
        el.style.width = nw + 'px'; el.style.height = nh + 'px';
        if (textEl) textEl.style.fontSize = Math.round(nh * 0.82) + 'px';
      }
      ST.dirty = true;
    }
    function up() {
      mode = null;
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      window.removeEventListener('touchmove', move); window.removeEventListener('touchend', up);
    }
    function pt(e) { var t = e.touches && e.touches[0]; return { x: (t ? t.clientX : e.clientX), y: (t ? t.clientY : e.clientY) }; }
    el.addEventListener('mousedown', down);
    el.addEventListener('touchstart', down, { passive: false });
  }

  /* capture the current page's overlays back into entry.ann (PDF geometry) */
  function captureSignOverlays(ST) {
    var wrap = document.getElementById('bpdf-cwrap');
    var entry = ST._signEntry, vp = ST._signVp, canvas = ST._signCanvas;
    if (!wrap || !entry || !vp || !canvas) return;
    // Guard: if the sign canvas isn't laid out (detached / display:none / zero width),
    // clientWidth is 0 and the mapping would be garbage — keep the already-stored anns.
    if (!canvas.isConnected || !canvas.clientWidth) return;
    var factor = vp.width / canvas.clientWidth; // CSS px -> viewport px
    var anns = [];
    wrap.querySelectorAll('.bpdf-ann').forEach(function (el) {
      var spec = el._spec || {};
      var left = parseFloat(el.style.left), top = parseFloat(el.style.top);
      var w = parseFloat(el.style.width), h = parseFloat(el.style.height);
      // viewport-pixel corners
      var vx0 = left * factor, vy0 = top * factor, vw = w * factor, vh = h * factor;
      var TL = vp.convertToPdfPoint(vx0, vy0);
      var TR = vp.convertToPdfPoint(vx0 + vw, vy0);
      var BL = vp.convertToPdfPoint(vx0, vy0 + vh);
      var wPdf = Math.hypot(TR[0] - TL[0], TR[1] - TL[1]);
      var hPdf = Math.hypot(TL[0] - BL[0], TL[1] - BL[1]);
      var theta = Math.atan2(TR[1] - TL[1], TR[0] - TL[0]); // radians, PDF space (y up)
      var a = { type: spec.type, blX: BL[0], blY: BL[1], w: wPdf, h: hPdf, theta: theta };
      if (spec.type === 'sig') { a.src = spec.src; a.aspect = spec.aspect; }
      else { a.text = spec.text; a.check = spec.check; }
      anns.push(a);
    });
    entry.ann = anns;
  }

  /* stored PDF geometry -> CSS px box for re-display. Reconstructs the four PDF-space
     corners from (bl,w,h,theta) and maps them back through the viewport, so it is exact
     under any page rotation (the on-screen box is axis-aligned by construction). */
  function pdfBoxToCss(vp, canvas, a) {
    var factor = vp.width / (canvas.clientWidth || vp.width);
    var th = a.theta || 0, rU = [Math.cos(th), Math.sin(th)], uU = [-Math.sin(th), Math.cos(th)];
    var bl = [a.blX, a.blY];
    var tl = [bl[0] + a.h * uU[0], bl[1] + a.h * uU[1]];
    var tr = [bl[0] + a.w * rU[0] + a.h * uU[0], bl[1] + a.w * rU[1] + a.h * uU[1]];
    var br = [bl[0] + a.w * rU[0], bl[1] + a.w * rU[1]];
    var pts = [bl, tl, tr, br].map(function (p) { return vp.convertToViewportPoint(p[0], p[1]); });
    var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
    var leftVp = Math.min.apply(null, xs), topVp = Math.min.apply(null, ys);
    var wVp = Math.max.apply(null, xs) - leftVp, hVp = Math.max.apply(null, ys) - topVp;
    return { left: leftVp / factor, top: topVp / factor, w: wVp / factor, h: hVp / factor };
  }

  /* ---------- signature pad modal ---------- */
  function openSignaturePad(cb) {
    var ov = document.createElement('div');
    ov.className = 'bpdf-pad-ov';
    ov.innerHTML =
      '<div class="bpdf-pad">' +
        '<div class="bpdf-pad-head">✍️ Add your signature</div>' +
        '<div class="bpdf-pad-body">' +
          '<div class="bpdf-pad-tabs">' +
            '<button class="bpdf-btn primary" data-pt="draw">✏️ Draw</button>' +
            '<button class="bpdf-btn" data-pt="type">⌨️ Type</button>' +
          '</div>' +
          '<div id="bpdf-pad-draw"><canvas class="bpdf-padcanvas" id="bpdf-padcanvas"></canvas><div style="font-size:12px;color:var(--muted,#7a726a);margin-top:6px;">Draw above with your mouse or finger.</div></div>' +
          '<div id="bpdf-pad-type" style="display:none;"><input class="bpdf-typed" id="bpdf-typed" placeholder="Type your name" style="font-family:\'Segoe Script\',\'Bradley Hand\',\'Brush Script MT\',cursive;" /></div>' +
        '</div>' +
        '<div class="bpdf-pad-foot">' +
          '<button class="bpdf-btn" data-pd="clear">Clear</button>' +
          '<button class="bpdf-btn" data-pd="cancel">Cancel</button>' +
          '<button class="bpdf-btn primary" data-pd="use">Use signature</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    var mode = 'draw';
    var canvas = ov.querySelector('#bpdf-padcanvas');
    var typed = ov.querySelector('#bpdf-typed');
    // size the canvas to its displayed box for crisp lines
    function sizeCanvas() {
      var r = canvas.getBoundingClientRect();
      // Setting width/height resets the canvas bitmap — any prior ink is gone,
      // so the "has ink" flag must reset with it or "Use" exports a blank PNG.
      canvas.width = Math.max(300, Math.round(r.width)); canvas.height = Math.max(120, Math.round(r.height));
      hasInk = false;
      var ctx = canvas.getContext('2d'); ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0a2a5e';
    }
    sizeCanvas();
    var drawing = false, last = null, hasInk = false;
    function cpt(e) { var r = canvas.getBoundingClientRect(); var t = e.touches && e.touches[0]; return { x: (t ? t.clientX : e.clientX) - r.left, y: (t ? t.clientY : e.clientY) - r.top }; }
    function start(e) { drawing = true; last = cpt(e); e.preventDefault(); }
    function moved(e) { if (!drawing) return; var p = cpt(e); var ctx = canvas.getContext('2d'); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; hasInk = true; e.preventDefault(); }
    function end() { drawing = false; }
    canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', moved); window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false }); canvas.addEventListener('touchmove', moved, { passive: false }); window.addEventListener('touchend', end);

    ov.querySelectorAll('[data-pt]').forEach(function (b) {
      b.onclick = function () {
        mode = b.getAttribute('data-pt');
        ov.querySelectorAll('[data-pt]').forEach(function (x) { x.classList.toggle('primary', x === b); });
        ov.querySelector('#bpdf-pad-draw').style.display = mode === 'draw' ? '' : 'none';
        ov.querySelector('#bpdf-pad-type').style.display = mode === 'type' ? '' : 'none';
        if (mode === 'draw') sizeCanvas();
        else typed.focus();
      };
    });

    function cleanup() { window.removeEventListener('mouseup', end); window.removeEventListener('touchend', end); if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.querySelector('[data-pd="cancel"]').onclick = function () { cleanup(); cb(null); };
    ov.querySelector('[data-pd="clear"]').onclick = function () {
      if (mode === 'draw') { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); hasInk = false; } else typed.value = '';
    };
    ov.querySelector('[data-pd="use"]').onclick = function () {
      var out = null;
      if (mode === 'draw') {
        if (!hasInk) { toast('Draw your signature first.', 'warn'); return; }
        out = trimCanvas(canvas);
      } else {
        var name = (typed.value || '').trim();
        if (!name) { toast('Type your name first.', 'warn'); return; }
        out = renderTypedSignature(name);
      }
      cleanup(); cb(out);
    };
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) { cleanup(); cb(null); } });
  }

  // trim transparent margins from the drawn signature; returns {dataUrl,w,h}
  function trimCanvas(canvas) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    var data;
    try { data = ctx.getImageData(0, 0, W, H).data; } catch (e) { return { dataUrl: canvas.toDataURL('image/png'), w: W, h: H }; }
    var minX = W, minY = H, maxX = 0, maxY = 0, found = false;
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 8) { found = true; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (!found) return { dataUrl: canvas.toDataURL('image/png'), w: W, h: H };
    var pad = 6; minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad); maxX = Math.min(W - 1, maxX + pad); maxY = Math.min(H - 1, maxY + pad);
    var w = maxX - minX + 1, h = maxY - minY + 1;
    var out = document.createElement('canvas'); out.width = w; out.height = h;
    out.getContext('2d').drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
    return { dataUrl: out.toDataURL('image/png'), w: w, h: h };
  }

  function renderTypedSignature(name) {
    var pad = 20, fs = 64;
    var meas = document.createElement('canvas').getContext('2d');
    var font = 'italic ' + fs + 'px "Segoe Script","Bradley Hand","Brush Script MT",cursive';
    meas.font = font;
    var w = Math.ceil(meas.measureText(name).width) + pad * 2;
    var h = Math.ceil(fs * 1.5);
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.font = font; ctx.fillStyle = '#0a2a5e'; ctx.textBaseline = 'middle';
    ctx.fillText(name, pad, h / 2);
    return { dataUrl: c.toDataURL('image/png'), w: w, h: h };
  }

  /* ============================================================= *
   *  Build (pdf-lib) + save
   * ============================================================= */
  async function buildPdf(ST, subset) {
    // Make sure the on-screen page (sign tab) is captured before we build.
    captureSignOverlays(ST);
    var PDFLib = ST.libs.PDFLib;
    var entries = subset || ST.order;
    if (!entries.length) throw new Error('No pages to export.');
    var out = await PDFLib.PDFDocument.create();
    var srcDocs = {};
    var helv = null, ding = null;
    async function getSrc(id) {
      if (!srcDocs[id]) srcDocs[id] = await PDFLib.PDFDocument.load(ST.sources[id].bytes, { ignoreEncryption: true });
      return srcDocs[id];
    }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var pg;
      try {
        var src = await getSrc(e.srcId);
        var copied = await out.copyPages(src, [e.srcIndex]);
        pg = copied[0];
        pg.setRotation(PDFLib.degrees(((e.base || 0) + e.rot) % 360));
        out.addPage(pg);
      } catch (err) {
        // Name the offending source so a multi-file merge failure is actionable —
        // and abort rather than silently dropping pages from a financial document.
        var srcName = (ST.sources[e.srcId] && ST.sources[e.srcId].name) || 'source PDF';
        throw new Error('Page ' + (i + 1) + ' (from "' + srcName + '") could not be processed: ' + (err && err.message || err));
      }
      for (var j = 0; j < e.ann.length; j++) {
        var a = e.ann[j];
        if (a.type === 'sig') {
          try {
            var png = await out.embedPng(a.src);
            pg.drawImage(png, { x: a.blX, y: a.blY, width: a.w, height: a.h, rotate: PDFLib.radians(a.theta || 0) });
          } catch (err) { /* skip a broken image rather than fail the whole save */ }
        } else {
          try {
            // Check marks use ZapfDingbats — Helvetica's WinAnsi encoding has no
            // U+2714 and drawText would throw, aborting the whole save.
            var font;
            if (a.check) { if (!ding) ding = await out.embedFont(PDFLib.StandardFonts.ZapfDingbats); font = ding; }
            else { if (!helv) helv = await out.embedFont(PDFLib.StandardFonts.Helvetica); font = helv; }
            var size = Math.max(4, a.h * 0.82);
            var txt = String(a.text == null ? '' : a.text);
            // baseline sits ~descent above the box bottom
            var dopts = {
              x: a.blX, y: a.blY + a.h * 0.18, size: size, font: font,
              color: PDFLib.rgb(0.04, 0.16, 0.37), rotate: PDFLib.radians(a.theta || 0)
            };
            try { pg.drawText(txt, dopts); }
            catch (encErr) {
              // Character(s) outside the font's encoding — degrade to WinAnsi-safe
              // text ('?' placeholders) instead of aborting the save.
              if (!helv) helv = await out.embedFont(PDFLib.StandardFonts.Helvetica);
              dopts.font = helv;
              pg.drawText(txt.replace(/[^\x20-\x7E\xA0-\xFF‘’“”–—•…€™]/g, '?'), dopts);
            }
          } catch (err) { /* never abort the whole save for one stamp */ }
        }
      }
    }
    return await out.save();
  }

  /* ---------- shared footer save bar ---------- */
  function ensureSaveBar(ST) {
    var modal = ST.ov.querySelector('.bpdf-modal');
    var old = modal.querySelector('.bpdf-savebar');
    if (old) old.remove();
    var bar = document.createElement('div');
    bar.className = 'bpdf-head bpdf-savebar';
    bar.style.borderTop = '1px solid var(--chrome-mute,#e6e5e1)';
    bar.style.borderBottom = '0';
    bar.style.marginTop = 'auto';
    var targets = ST.saveTargets.map(function (t, i) {
      return '<button class="bpdf-btn primary" data-save="' + i + '">' + esc(t.icon || '💾') + ' ' + esc(t.label) + '</button>';
    }).join('');
    bar.innerHTML =
      '<button class="bpdf-btn" data-dl="1">⬇ Download</button>' +
      targets +
      '<span class="bpdf-hint" id="bpdf-savemsg"></span>';
    modal.appendChild(bar);
    bar.querySelector('[data-dl]').onclick = function () { doDownload(ST); };
    bar.querySelectorAll('[data-save]').forEach(function (b) {
      b.onclick = function () { doSaveTarget(ST, ST.saveTargets[+b.getAttribute('data-save')], b); };
    });
  }

  function exportName(ST) {
    var edited = ST.dirty || ST.order.some(function (e) { return e.rot || e.ann.length; });
    return baseName(ST.name) + (edited ? '-edited' : '') + '.pdf';
  }

  async function doDownload(ST) {
    var msg = document.getElementById('bpdf-savemsg');
    if (msg) msg.innerHTML = '<span class="bpdf-spin"></span> Preparing…';
    try {
      var bytes = await buildPdf(ST);
      downloadBytes(bytes, exportName(ST));
      if (msg) msg.textContent = 'Downloaded.';
    } catch (e) { if (msg) msg.textContent = ''; toast('Could not build PDF: ' + e.message, 'error', 7000); }
  }

  async function doSaveTarget(ST, target, btn) {
    if (!target) return;
    var msg = document.getElementById('bpdf-savemsg');
    var suggested = window.prompt('Save as (file name):', exportName(ST));
    if (suggested == null) return;
    suggested = suggested.trim() || exportName(ST);
    if (!/\.pdf$/i.test(suggested)) suggested += '.pdf';
    btn.disabled = true;
    if (msg) msg.innerHTML = '<span class="bpdf-spin"></span> Saving…';
    try {
      var bytes = await buildPdf(ST);
      var blob = new Blob([bytes], { type: 'application/pdf' });
      await target.handler(blob, suggested);
      if (msg) msg.textContent = 'Saved: ' + suggested;
      ST.dirty = false; if (ST._setName) ST._setName();
      if (ST.onSaved) { try { ST.onSaved(suggested); } catch (e) {} }
    } catch (e) {
      if (msg) msg.textContent = '';
      toast('Save failed: ' + (e && e.message || e), 'error', 7000);
    } finally { btn.disabled = false; }
  }

  /* ---------- file / blob utilities ---------- */
  function pickFile(cb) {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/pdf,.pdf';
    inp.onchange = function () { var f = inp.files && inp.files[0]; if (f) cb(f); };
    inp.click();
  }
  function readFileBytes(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(new Uint8Array(r.result)); };
      r.onerror = function () { reject(new Error('Could not read file')); };
      r.readAsArrayBuffer(file);
    });
  }
  function downloadBytes(bytes, filename) {
    var blob = new Blob([bytes], { type: 'application/pdf' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
  }

  window.bccPdfEditor = {
    open: open,
    canEdit: canEdit,
    // Standalone signature pad (draw or type) — used by e.g. certified payroll.
    // cb receives { dataUrl, w, h } or null on cancel.
    signaturePad: function (cb) { injectStyles(); openSignaturePad(cb); }
  };
})();
