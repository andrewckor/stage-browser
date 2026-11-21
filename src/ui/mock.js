/* Mock window.stage for previewing the UI in a plain browser. Loaded by app.js only when
   window.stage is undefined (i.e. never inside Electron).

   URL params:
     scene     bar | single | many | loading | pinned | omnibox | omnibox-edit | newtab
     theme     dark | light            (sets <html data-theme>)
     backdrop  light | dark | 1        (paints a fake web page behind the transparent UI)
     anim      0                       (disable transitions/animations, for deterministic screenshots)
     visible   0                       (start with the bar hidden)
     selfcheck main | many             (run in-page interaction checks; results in #selfcheck)
*/
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var scene = params.get('scene') || 'bar';
  var root = document.documentElement;
  if (params.get('theme')) root.dataset.theme = params.get('theme');

  /* ---------- fake favicons (no network) ---------- */

  function fav(letter, bg, shape) {
    var inner = shape === 'circle'
      ? '<circle cx="8" cy="8" r="8" fill="' + bg + '"/>'
      : '<rect width="16" height="16" rx="4" fill="' + bg + '"/>';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' + inner +
      '<text x="8" y="11.6" font-family="-apple-system,Helvetica,Arial" font-size="10" font-weight="700" text-anchor="middle" fill="#fff">' + letter + '</text></svg>';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  var POOL = [
    { title: 'Workflow editor — Northwind', url: 'https://northwind.example/editor/2481', favicon: fav('N', '#2e6b5b') },
    { title: 'Pull request #482 · acme/stage', url: 'https://github.com/acme/stage/pull/482', favicon: fav('G', '#24292f', 'circle') },
    { title: 'Quarterly roadmap', url: 'https://notion.example.com/roadmap', favicon: null },
    { title: 'Design review — homepage v3', url: 'https://figma.example.com/file/abc', favicon: fav('F', '#7c3aed') },
    { title: 'Inbox (12)', url: 'https://mail.example.com/inbox', favicon: fav('M', '#2563eb') },
    { title: 'A very long page title that will certainly need to be truncated at the edge of the tab', url: 'https://docs.example.org/guides/long', favicon: null },
    { title: 'Webinar recording — lo-fi beats', url: 'https://music.example.com/live', favicon: fav('♪', '#db2777', 'circle'), audible: true },
    { title: 'Analytics — Overview', url: 'https://analytics.example.net/overview', favicon: null },
    { title: 'Customer interviews', url: 'https://sheets.example.com/d/1x', favicon: fav('S', '#16a34a') },
    { title: 'Staging — dashboard', url: 'https://staging.acme.dev/', favicon: null }
  ];

  var HISTORY = [
    { title: 'Northwind: Onboarding, automated', url: 'https://northwind.example/', favicon: fav('N', '#2e6b5b') },
    { title: 'Workflows — Northwind', url: 'https://northwind.example/app/workflows', favicon: fav('N', '#2e6b5b') },
    { title: 'Northwind docs', url: 'https://docs.northwind.example/', favicon: fav('N', '#2e6b5b') },
    { title: 'Electron — Build cross-platform apps', url: 'https://www.electronjs.org/', favicon: fav('E', '#2f3241', 'circle') },
    { title: 'Example Domain', url: 'https://example.com/', favicon: null },
    { title: 'Hacker News', url: 'https://news.ycombinator.com/', favicon: fav('Y', '#f26522') },
    { title: 'MDN Web Docs', url: 'https://developer.mozilla.org/', favicon: fav('M', '#111827') },
    { title: 'Calendar — this week', url: 'https://calendar.example.com/week', favicon: fav('C', '#0ea5e9') }
  ];

  var nextId = 100;
  function mk(p, extra) {
    var t = { id: nextId++, title: p.title, url: p.url, favicon: p.favicon || null, loading: false, audible: !!p.audible, muted: false };
    for (var k in extra) t[k] = extra[k];
    return t;
  }
  function blank() { return { id: nextId++, title: 'New Tab', url: '', favicon: null, loading: false, audible: false, muted: false }; }

  /* ---------- scenes ---------- */

  var st = {
    tabs: [], activeTabId: null, canGoBack: true, canGoForward: false, zoomFactor: 1,
    bar: { visible: params.get('visible') !== '0', pinned: false },
    extensionActions: 2,
    overlay: null, barHeight: 52, fullscreen: false
  };

  function pick(n, skipAudible) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var p = POOL[i % POOL.length];
      var t = mk(i < POOL.length ? p : { title: p.title.slice(0, 22) + ' ' + (Math.floor(i / POOL.length) + 1), url: p.url + '?p=' + i, favicon: p.favicon });
      if (skipAudible) t.audible = false;
      out.push(t);
    }
    return out;
  }

  switch (scene) {
    case 'single':
      st.tabs = pick(1, true); break;
    case 'newtab':
      st.tabs = [blank()]; break;
    case 'many':
      st.tabs = pick(18, true); st.tabs[6].audible = true; break;
    case 'loading':
      st.tabs = pick(6);
      st.tabs[0].loading = true; st.tabs[0].favicon = null;
      st.tabs[3].loading = true;
      st.tabs[5].audible = false;
      st.tabs[6 % 6].audible = false;
      st.tabs[4].audible = true; st.tabs[4].muted = true;
      st.tabs.push(mk(POOL[6]));
      break;
    case 'pinned':
      st.tabs = pick(5, true); st.bar.pinned = true; break;
    default:
      st.tabs = pick(5, true); st.tabs.push(blank());
  }
  var activeIdx = { many: 6, loading: 0, single: 0, newtab: 0, pinned: 1 }[scene];
  st.activeTabId = st.tabs[activeIdx == null ? 1 : activeIdx].id;
  if (scene === 'omnibox') st.overlay = { type: 'omnibox', mode: 'new', initial: 'zap' };
  if (scene === 'omnibox-edit') st.overlay = { type: 'omnibox', mode: 'edit', initial: st.tabs[1].url };

  /* ---------- the API ---------- */

  var listeners = [];
  var calls = [];
  function log(name, args) { calls.push([name].concat(args || [])); }
  function snapshot() { return JSON.parse(JSON.stringify(st)); }
  function emit() { var s = snapshot(); listeners.slice().forEach(function (cb) { cb(s); }); }
  function indexOf(id) { for (var i = 0; i < st.tabs.length; i++) if (st.tabs[i].id === id) return i; return -1; }
  function activeTab() { return st.tabs[indexOf(st.activeTabId)]; }

  function looksLikeUrl(v) { return !/\s/.test(v) && (/^[a-z]+:\/\//i.test(v) || /^[^\s/]+\.[a-z]{2,}(\/|$)/i.test(v)); }
  function normalize(v) { return /^[a-z]+:\/\//i.test(v) ? v : 'https://' + v; }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } }

  function makeSuggestions(q) {
    q = q.trim();
    var lq = q.toLowerCase(), out = [];
    if (q) {
      out.push(looksLikeUrl(q)
        ? { kind: 'url', title: q, url: normalize(q) }
        : { kind: 'search', title: 'Search Google for “' + q + '”', url: 'https://www.google.com/search?q=' + encodeURIComponent(q) });
    }
    st.tabs.forEach(function (t) {
      if (t.id === st.activeTabId && !q) return;
      if (!t.url) return;
      if (!q || t.title.toLowerCase().indexOf(lq) >= 0 || t.url.toLowerCase().indexOf(lq) >= 0)
        out.push({ kind: 'tab', title: t.title, url: t.url, tabId: t.id, favicon: t.favicon });
    });
    HISTORY.forEach(function (h) {
      if (!q || h.title.toLowerCase().indexOf(lq) >= 0 || h.url.toLowerCase().indexOf(lq) >= 0)
        out.push({ kind: 'history', title: h.title, url: h.url, favicon: h.favicon });
    });
    return out.slice(0, 8);
  }

  window.stage = {
    getState: function () { return Promise.resolve(snapshot()); },
    onState: function (cb) {
      listeners.push(cb);
      return function () { listeners = listeners.filter(function (l) { return l !== cb; }); };
    },
    activateTab: function (id) { log('activateTab', [id]); st.activeTabId = id; emit(); },
    closeTab: function (id) {
      log('closeTab', [id]);
      var i = indexOf(id);
      if (i < 0) return;
      st.tabs.splice(i, 1);
      if (!st.tabs.length) { var b = blank(); st.tabs.push(b); st.activeTabId = b.id; }
      else if (st.activeTabId === id) st.activeTabId = st.tabs[Math.min(i, st.tabs.length - 1)].id;
      emit();
    },
    moveTab: function (id, to) {
      log('moveTab', [id, to]);
      var i = indexOf(id);
      if (i < 0) return;
      var t = st.tabs.splice(i, 1)[0];
      st.tabs.splice(to, 0, t);
      emit();
    },
    showTabMenu: function (id) { log('showTabMenu', [id]); },
    openOmnibox: function (mode) {
      log('openOmnibox', [mode]);
      var t = activeTab();
      st.overlay = { type: 'omnibox', mode: mode, initial: mode === 'edit' && t ? t.url : '' };
      emit();
    },
    closeOverlay: function () { log('closeOverlay'); st.overlay = null; emit(); },
    suggest: function (q) {
      log('suggest', [q]);
      return new Promise(function (res) {
        setTimeout(function () { res(makeSuggestions(q)); }, q === 'sl' ? 160 : 20);
      });
    },
    submitOmnibox: function (input, opts) {
      log('submitOmnibox', [input, !!(opts && opts.newTab)]);
      var url = looksLikeUrl(input) ? normalize(input) : input;
      var title = hostOf(url);
      if (opts && opts.newTab) {
        var t = mk({ title: title, url: url });
        st.tabs.push(t); st.activeTabId = t.id;
      } else {
        var a = activeTab();
        if (a) { a.url = url; a.title = title; a.favicon = null; }
      }
      st.overlay = null;
      emit();
    },
    back: function () { log('back'); },
    forward: function () { log('forward'); },
    reload: function () { log('reload'); },
    setBarHover: function (h) { log('setBarHover', [h]); }
  };
  window.__stageMock = { calls: calls, state: st, emit: emit };

  /* ---------- fake page behind the transparent UI ---------- */

  var bd = params.get('backdrop');
  var mockCss = document.createElement('style');
  mockCss.textContent =
    'browser-action-list{display:flex}' +
    '.mock-action{width:24px;height:24px;margin:0 2px;border-radius:6px;display:grid;place-items:center;-webkit-app-region:no-drag}' +
    '.mock-action:hover{background:var(--hover)}' +
    '.mock-action i{width:16px;height:16px;border-radius:5px;background:linear-gradient(135deg,#8b5cf6,#6366f1);display:grid;place-items:center}' +
    '.mock-action svg{width:10px;height:10px}' +
    '#mock-page{position:fixed;inset:0;z-index:-1;overflow:hidden;font:15px/1.5 -apple-system,system-ui,sans-serif;-webkit-user-select:none}' +
    '#mock-page.light{background:#fff;color:#1a1a1a}#mock-page.dark{background:#0d1117;color:#e6edf3}' +
    '#mock-page nav{height:64px;display:flex;align-items:center;gap:28px;padding:0 32px;border-bottom:1px solid rgb(128 128 128/.2)}' +
    '#mock-page .logo{width:28px;height:28px;border-radius:8px;background:#ff4f00}' +
    '#mock-page.dark .logo{background:#2f81f7}' +
    '#mock-page nav b{font-weight:600}#mock-page nav span{opacity:.65;font-size:14px}' +
    '#mock-page nav .cta{margin-left:auto;padding:8px 16px;border-radius:8px;background:#ff4f00;color:#fff;font-weight:600;font-size:14px;opacity:1}' +
    '#mock-page.dark nav .cta{background:#238636}' +
    '#mock-page main{max-width:880px;margin:0 auto;padding:56px 32px}' +
    '#mock-page h1{font-size:44px;line-height:1.1;margin:0 0 16px;letter-spacing:-.03em}' +
    '#mock-page p{margin:0 0 12px;opacity:.72;max-width:640px}' +
    '#mock-page .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:32px}' +
    '#mock-page .card{border:1px solid rgb(128 128 128/.25);border-radius:12px;padding:16px;height:120px}' +
    '#mock-page .card i{display:block;height:8px;border-radius:4px;background:rgb(128 128 128/.28);margin-bottom:8px}' +
    '#mock-page pre{margin:24px 0 0;padding:16px;border-radius:10px;background:rgb(128 128 128/.12);font:13px/1.6 ui-monospace,Menlo,monospace;overflow:hidden}';
  if (params.get('anim') === '0') mockCss.textContent += '*,*::before,*::after{transition:none!important;animation:none!important}';
  document.head.appendChild(mockCss);

  if (bd) {
    var kind = bd === 'dark' ? 'dark' : 'light';
    var page = document.createElement('div');
    page.id = 'mock-page';
    page.className = kind;
    page.innerHTML =
      '<nav><div class="logo"></div><b>Acme Cloud</b><span>Products</span><span>Solutions</span><span>Docs</span><span>Pricing</span><span class="cta">Get started</span></nav>' +
      '<main><h1>Automate the busywork,<br>keep the craft.</h1>' +
      '<p>Connect the tools your team already uses and let workflows handle the handoffs. Start from a template or build your own in minutes.</p>' +
      '<p>Trusted by teams who present, ship, and iterate in public every week.</p>' +
      '<div class="cards"><div class="card"><i style="width:60%"></i><i></i><i style="width:80%"></i></div><div class="card"><i style="width:50%"></i><i></i><i style="width:70%"></i></div><div class="card"><i style="width:70%"></i><i></i><i style="width:40%"></i></div></div>' +
      '<pre>$ npx stage-browser https://example.com\n✔ opened 3 tabs\n✔ session restored</pre></main>';
    document.body.insertBefore(page, document.body.firstChild);
  }

  // stand-in for the <browser-action-list> icons
  var bal = document.querySelector('browser-action-list');
  if (bal) {
    bal.innerHTML =
      '<span class="mock-action"><i><svg viewBox="0 0 10 10"><path d="M6 0.5L2 5.6h2.4L3.8 9.5 8 4.2H5.5z" fill="#fff"/></svg></i></span>' +
      '<span class="mock-action"><i style="background:linear-gradient(135deg,#10b981,#059669)"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3" fill="none" stroke="#fff" stroke-width="1.6"/></svg></i></span>';
  }

  /* ---------- optional in-page self-check ---------- */

  var sc = params.get('selfcheck');
  if (sc) window.addEventListener('load', function () { setTimeout(function () { runSelfcheck(sc); }, 400); });

  function runSelfcheck(suite) {
    var results = [];
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function check(name, ok, info) { results.push({ name: name, ok: !!ok, info: ok ? '' : String(info == null ? '' : info) }); }
    function $(s) { return document.querySelector(s); }
    function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
    function live() { return $$('#tabs .tab:not(.closing)'); }
    function lastCall(name) { for (var i = calls.length - 1; i >= 0; i--) if (calls[i][0] === name) return calls[i]; return null; }
    function countCalls(name) { return calls.filter(function (c) { return c[0] === name; }).length; }
    function ptr(type, target, x, y, extra) {
      var e = new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 7, pointerType: 'mouse' }, extra || {}));
      target.dispatchEvent(e);
    }
    function center(n) { var r = n.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
    function clickTab(n) { var c = center(n); ptr('pointerdown', n, c[0], c[1]); ptr('pointerup', window, c[0], c[1]); }
    function key(target, k, extra) {
      target.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra || {})));
    }
    function type(v) { var i = $('#omni-input'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }
    function rows() { return $$('#omni-list .row'); }
    function omniOpen() { return !$('#omni').hidden; }

    function finish() {
      var pass = results.filter(function (r) { return r.ok; }).length;
      var fail = results.length - pass;
      var out = 'SELFCHECK ' + (fail ? 'FAIL' : 'PASS') + ' ' + pass + '/' + results.length + '\n' +
        results.map(function (r) { return (r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.info ? '  -> ' + r.info : ''); }).join('\n');
      console.log(out);
      var pre = document.createElement('pre');
      pre.id = 'selfcheck';
      pre.textContent = out;
      pre.style.cssText = 'position:fixed;left:0;bottom:0;margin:0;font:11px monospace;background:#fff;color:#000;z-index:99;display:none';
      document.body.appendChild(pre);
      document.title = 'selfcheck ' + (fail ? 'FAIL' : 'PASS');
    }

    (async function () {
      try {
        if (suite === 'many') {
          var tabs = $('#tabs');
          check('many: compact class set', tabs.classList.contains('compact'));
          check('many: tabs scroll horizontally when narrow', innerWidth > 900 || tabs.scrollWidth > tabs.clientWidth, tabs.scrollWidth + ' vs ' + tabs.clientWidth);
          check('many: capsule fits inside strip', $('#capsule').getBoundingClientRect().right <= innerWidth - 12 + 0.5 && $('#capsule').getBoundingClientRect().left >= 84 - 0.5,
            JSON.stringify($('#capsule').getBoundingClientRect()));
          var inact = $$('#tabs .tab:not(.active)')[0];
          check('many: inactive tabs are favicon-only (36px)', Math.abs(inact.getBoundingClientRect().width - 36) < 1, inact.getBoundingClientRect().width);
          var act = $('#tabs .tab.active');
          var ar = act.getBoundingClientRect(), tr = tabs.getBoundingClientRect();
          check('many: active tab scrolled into view', ar.left >= tr.left - 1 && ar.right <= tr.right + 1, ar.left + '..' + ar.right + ' in ' + tr.left + '..' + tr.right);
          finish();
          return;
        }

        await sleep(500);
        var n0 = st.tabs.length;
        check('renders one element per tab', live().length === n0, live().length + ' vs ' + n0);
        check('tablist/tab roles', $('#tabs').getAttribute('role') === 'tablist' && live().every(function (t) { return t.getAttribute('role') === 'tab'; }));
        check('exactly one aria-selected tab', live().filter(function (t) { return t.getAttribute('aria-selected') === 'true'; }).length === 1);
        check('bar is visible', document.documentElement.classList.contains('bar-visible'));
        check('capsule leaves 84px for traffic lights', $('#capsule').getBoundingClientRect().left >= 84 - 0.5, $('#capsule').getBoundingClientRect().left);
        check('capsule is 36px tall at top 8px', Math.abs($('#capsule').getBoundingClientRect().height - 36) < 0.5 && $('#capsule').offsetTop === 8, JSON.stringify($('#capsule').getBoundingClientRect()));

        // hover
        $('#capsule').dispatchEvent(new MouseEvent('mouseenter'));
        $('#capsule').dispatchEvent(new MouseEvent('mouseleave'));
        check('capsule hover reports setBarHover(true/false)', calls.filter(function (c) { return c[0] === 'setBarHover'; }).map(function (c) { return c[1]; }).join() === 'true,false');

        // context menu
        var t0 = live()[0];
        t0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
        check('right-click calls showTabMenu', (lastCall('showTabMenu') || [])[1] === +t0.dataset.id);

        // drag to reorder: move tab 0 past tab 2
        var ids = st.tabs.map(function (t) { return t.id; });
        var els = live();
        var a = center(els[0]), c = center(els[2]);
        ptr('pointerdown', els[0], a[0], a[1]);
        ptr('pointermove', window, a[0] + 8, a[1]);
        await sleep(30);
        ptr('pointermove', window, c[0] + 4, a[1]);
        await sleep(200);
        check('drag shifts the tabs it passes', els[1].style.transform.indexOf('translateX') >= 0 && els[2].style.transform.indexOf('translateX') >= 0, els[1].style.transform + '|' + els[2].style.transform);
        ptr('pointerup', window, c[0] + 4, a[1]);
        await sleep(400);
        var mv = lastCall('moveTab');
        check('drop calls moveTab(id, 2)', mv && mv[1] === ids[0] && mv[2] === 2, JSON.stringify(mv));
        check('DOM order matches state after drop', live().map(function (t) { return +t.dataset.id; }).join() === st.tabs.map(function (t) { return t.id; }).join());
        check('no leftover drag transforms', live().every(function (t) { return !t.style.transform; }));
        check('drag does not trigger omnibox/activation click', countCalls('openOmnibox') === 0);

        // activate an inactive tab, then click the active tab
        var inactive = live().filter(function (t) { return !t.classList.contains('active'); })[1];
        clickTab(inactive);
        await sleep(50);
        check('click inactive tab → activateTab', (lastCall('activateTab') || [])[1] === +inactive.dataset.id);
        check('tab becomes active (aria-selected)', inactive.getAttribute('aria-selected') === 'true' && inactive.classList.contains('active'));
        clickTab(inactive);
        await sleep(80);
        check('click active tab → openOmnibox("edit")', (lastCall('openOmnibox') || [])[1] === 'edit');
        check('omnibox visible, input focused', omniOpen() && document.activeElement === $('#omni-input'));
        var inp = $('#omni-input');
        check('initial value fully selected', inp.value === activeTab().url && inp.selectionStart === 0 && inp.selectionEnd === inp.value.length, inp.value + ' ' + inp.selectionStart + '-' + inp.selectionEnd);
        key(inp, 'Escape');
        await sleep(30);
        check('Esc → closeOverlay and hides', lastCall('closeOverlay') && !omniOpen());

        // + button, typing, suggestions
        $('#new-tab').click();
        await sleep(80);
        check('+ → openOmnibox("new") with empty field', (lastCall('openOmnibox') || [])[1] === 'new' && omniOpen() && $('#omni-input').value === '');
        type('northwind');
        await sleep(250);
        var r = rows();
        check('suggestions render (≤ 8)', r.length > 1 && r.length <= 8, r.length);
        check('first row highlighted by default', r[0] && r[0].classList.contains('sel'));
        key($('#omni-input'), 'ArrowDown');
        check('ArrowDown moves highlight', rows()[1].classList.contains('sel') && !rows()[0].classList.contains('sel'));
        key($('#omni-input'), 'ArrowUp');
        check('ArrowUp moves back', rows()[0].classList.contains('sel'));
        key($('#omni-input'), 'ArrowUp');
        check('ArrowUp wraps to last', rows()[rows().length - 1].classList.contains('sel'));
        rows()[1].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        check('hover moves highlight', rows()[1].classList.contains('sel'));

        // pick the tab suggestion
        var tabRowIdx = rows().findIndex(function (x) { return x.classList.contains('is-tab'); });
        check('a tab suggestion exists', tabRowIdx >= 0);
        if (tabRowIdx >= 0) {
          rows()[tabRowIdx].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
          check('tab row shows "Switch to tab" hint', /Switch to tab/.test(rows()[tabRowIdx].textContent));
          var before = countCalls('closeOverlay');
          key($('#omni-input'), 'Enter');
          await sleep(30);
          check('Enter on tab suggestion → activateTab + closeOverlay', lastCall('activateTab') && countCalls('closeOverlay') === before + 1 && !omniOpen());
        }

        // Enter on a url (mode new → newTab true)
        $('#new-tab').click(); await sleep(60);
        type('example.com'); await sleep(200);
        check('url-like input shows globe glyph', !!$('#omni-glyph svg circle') && !$('#omni-glyph svg path[d^="M13.2"]'));
        key($('#omni-input'), 'Enter'); await sleep(30);
        var sub = lastCall('submitOmnibox');
        check('mode new: Enter → submitOmnibox(url, newTab:true)', sub && /example\.com/.test(sub[1]) && sub[2] === true, JSON.stringify(sub));

        // edit mode: Enter navigates, Cmd+Enter opens a new tab
        window.stage.openOmnibox('edit'); await sleep(60);
        type('other.org'); await sleep(200);
        key($('#omni-input'), 'Enter'); await sleep(30);
        sub = lastCall('submitOmnibox');
        check('mode edit: Enter → newTab:false', sub && /other\.org/.test(sub[1]) && sub[2] === false, JSON.stringify(sub));
        window.stage.openOmnibox('edit'); await sleep(60);
        type('third.net'); await sleep(200);
        key($('#omni-input'), 'Enter', { metaKey: true }); await sleep(30);
        sub = lastCall('submitOmnibox');
        check('mode edit: Cmd+Enter → newTab:true', sub && /third\.net/.test(sub[1]) && sub[2] === true, JSON.stringify(sub));

        // stale responses are dropped ('sl' answers slowly)
        $('#new-tab').click(); await sleep(60);
        type('sl'); await sleep(90);
        type('slx'); await sleep(350);
        var first = rows()[0];
        check('stale suggest() response is dropped', first && /slx/.test(first.textContent) && !/“sl”/.test(first.textContent), first && first.textContent);

        // Enter before suggestions catch up submits the typed text
        type('quickly typed words');
        key($('#omni-input'), 'Enter'); await sleep(30);
        sub = lastCall('submitOmnibox');
        check('Enter before debounce submits raw input', sub && sub[1] === 'quickly typed words', JSON.stringify(sub));

        // backdrop click closes
        $('#new-tab').click(); await sleep(60);
        $('#omni-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await sleep(30);
        check('backdrop click → closeOverlay', !omniOpen());

        // middle click + close button
        var victim = live()[0], vid = +victim.dataset.id, before2 = live().length;
        victim.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
        await sleep(400);
        check('middle-click → closeTab', (lastCall('closeTab') || [])[1] === vid);
        check('closed tab leaves the DOM', live().length === before2 - 1 && !$$('#tabs .tab').some(function (t) { return +t.dataset.id === vid; }), live().length + ' ' + $$('#tabs .tab').length);
        var v2 = live()[1], v2id = +v2.dataset.id;
        v2.querySelector('.close').click();
        await sleep(400);
        check('close button → closeTab', (lastCall('closeTab') || [])[1] === v2id);

        finish();
      } catch (e) {
        check('selfcheck threw', false, e && e.stack || e);
        finish();
      }
    })();
  }
})();
