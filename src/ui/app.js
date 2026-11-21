/* Stage UI: tab capsule + omnibox. Vanilla JS, no build step.
   Talks to the main process only through window.stage (see docs/CONTRACT.md).
   Outside Electron, window.stage is undefined and mock.js is loaded to fake it. */
(function () {
  'use strict';

  var STRIP_LEFT = 84;      // traffic lights
  var STRIP_RIGHT = 12;
  var CAPSULE_PAD = 8;      // 4px each side
  var TAB_MIN = 72;
  var TAB_COMPACT = 36;
  var TAB_GAP = 2;
  var DRAG_THRESHOLD = 4;
  var SUGGEST_DEBOUNCE = 60;

  if (window.stage) boot();
  else {
    var s = document.createElement('script');
    s.src = 'mock.js';
    s.onload = boot;
    document.head.appendChild(s);
  }

  /* ---------- helpers ---------- */

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }
  function hashHue(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  function prettyUrl(url) {
    return String(url || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  }
  function looksLikeUrl(v) {
    v = v.trim();
    if (!v || /\s/.test(v)) return false;
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^localhost(:\d+)?(\/|$)/i.test(v) || /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/|$|\?)/i.test(v);
  }

  var ICONS = {
    close: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3l6 6M9 3L3 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    newtab: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.2 2"/></svg>',
    speaker: '<svg class="on" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M2.5 5.5h2l3-2.5v8l-3-2.5h-2z" fill="currentColor"/><path d="M9.5 5a3 3 0 0 1 0 4M11 3.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
             '<svg class="off" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M2.5 5.5h2l3-2.5v8l-3-2.5h-2z" fill="currentColor"/><path d="M9.5 5.5l3 3M12.5 5.5l-3 3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    search: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13.2 13.2L17 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    globe: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 10h14M10 3c2.2 2.1 3.3 4.4 3.3 7s-1.1 4.9-3.3 7c-2.2-2.1-3.3-4.4-3.3-7S7.8 5.1 10 3z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    clock: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 6v4.2l2.8 1.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    tab: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="5" width="14" height="10.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 8.5h14" stroke="currentColor" stroke-width="1.5"/></svg>'
  };

  /* ---------- boot ---------- */

  function boot() {
    var stage = window.stage;
    var root = document.documentElement;
    var strip = $('#strip');
    var capsule = $('#capsule');
    var tabsEl = $('#tabs');
    var controlsEl = $('#controls');
    var newBtn = $('#new-tab');

    var state = null;
    var tabEls = new Map();      // id -> element
    var firstRender = true;
    var drag = null;

    /* ---- state plumbing ---- */

    stage.getState().then(apply);
    stage.onState(apply);

    // When the bar floats over the page, the view reaches 20px below the strip so the capsule's
    // shadow isn't clipped. Clicks landing in that transparent band belong to the page underneath.
    document.addEventListener('pointerdown', function (e) {
      if (e.target !== document.body && e.target !== document.documentElement) return;
      if (!state || state.overlay || !stage.passClick) return;
      if (e.clientY < (state.barHeight || 52)) return;
      e.preventDefault();
      stage.passClick(e.clientX, e.clientY, e.button, e.detail || 1);
    }, true);

    var applied = false;
    function apply(s) {
      if (!s) return;
      state = s;
      renderBar(s);
      renderOverlay(s);
      applied = true;
    }

    /* ---- bar ---- */

    function renderBar(s) {
      var visible = !!(s.bar && s.bar.visible);
      if (!applied) {
        // first state: paint hidden, then flip so the entrance transition runs
        if (visible) { void capsule.offsetWidth; root.classList.add('bar-visible'); }
      } else {
        root.classList.toggle('bar-visible', visible);
      }
      var pinned = !!(s.bar && s.bar.pinned);
      root.classList.toggle('bar-pinned', pinned);
      root.classList.toggle('hide-ext', !!s.hideExtensionIcons);
      // The divider only separates the + from extension icons, so it goes when no icons show.
      root.classList.toggle('no-ext', !s.extensionActions);
      renderTabs(s);
    }

    function liveTabEls() {
      var out = [];
      for (var c = tabsEl.firstElementChild; c; c = c.nextElementSibling) if (!c.classList.contains('closing')) out.push(c);
      return out;
    }

    function renderTabs(s) {
      var structural = !drag;
      if (structural) {
        var ids = new Set(s.tabs.map(function (t) { return t.id; }));
        tabEls.forEach(function (node, id) {
          if (!ids.has(id)) removeTab(id, node);
        });
      }
      var prev = null;
      s.tabs.forEach(function (t) {
        var node = tabEls.get(t.id);
        if (!node) {
          if (!structural) return;
          node = createTab(t, !firstRender);
          tabEls.set(t.id, node);
        }
        updateTab(node, t, t.id === s.activeTabId);
        if (structural) {
          var ref = prev ? prev.nextElementSibling : tabsEl.firstElementChild;
          while (ref && ref.classList.contains('closing')) ref = ref.nextElementSibling;
          if (ref !== node) tabsEl.insertBefore(node, ref);
          prev = node;
        }
      });
      firstRender = false;
      layoutTabs();
    }

    function createTab(t, animate) {
      var node = el('div', 'tab');
      node.setAttribute('role', 'tab');
      node.dataset.id = String(t.id);
      node.tabIndex = -1;
      node.innerHTML =
        '<span class="ico" data-k="blank"><img class="fav" alt="" draggable="false"><span class="mono" aria-hidden="true"></span><span class="spin" aria-hidden="true"></span><span class="blank">' + ICONS.newtab + '</span></span>' +
        '<span class="title"></span>' +
        '<span class="aud" aria-hidden="true">' + ICONS.speaker + '</span>' +
        '<button class="close" type="button" tabindex="-1" aria-label="Close tab">' + ICONS.close + '</button>';
      node._ref = {
        ico: node.firstChild,
        img: node.querySelector('.fav'),
        mono: node.querySelector('.mono'),
        title: node.querySelector('.title'),
        aud: node.querySelector('.aud')
      };
      node._ref.img.addEventListener('error', function () {
        node._favFailed = node._last && node._last.favicon;
        if (node._last) paintIcon(node, node._last);
      });
      node._last = {};
      if (animate) {
        node.classList.add('entering');
        node.addEventListener('animationend', function () { node.classList.remove('entering'); }, { once: true });
      }
      return node;
    }

    function paintIcon(node, t) {
      var r = node._ref;
      var kind;
      if (t.loading) kind = 'spin';
      else if (t.favicon && node._favFailed !== t.favicon) {
        kind = 'img';
        if (r.img.getAttribute('src') !== t.favicon) r.img.setAttribute('src', t.favicon);
      } else if (t.url) {
        kind = 'mono';
        var host = hostOf(t.url) || t.url;
        r.mono.textContent = (host.match(/[a-z0-9]/i) || ['•'])[0];
        r.mono.style.setProperty('--h', String(hashHue(host)));
      } else kind = 'blank';
      if (r.ico.dataset.k !== kind) r.ico.dataset.k = kind;
    }

    function updateTab(node, t, active) {
      var l = node._last, r = node._ref;
      if (l.title !== t.title || l.url !== t.url) {
        var label = t.title || prettyUrl(t.url) || 'New Tab';
        r.title.textContent = label;
        node.setAttribute('aria-label', label);
      }
      if (l.favicon !== t.favicon || l.loading !== t.loading || l.url !== t.url) paintIcon(node, t);
      if (l.audible !== t.audible || l.muted !== t.muted) {
        node.classList.toggle('has-aud', !!(t.audible || t.muted));
        r.aud.classList.toggle('is-muted', !!t.muted);
      }
      if (l.active !== active) {
        node.classList.toggle('active', active);
        node.setAttribute('aria-selected', String(active));
        node.tabIndex = active ? 0 : -1;
        if (active) keepInView(node);
      }
      node._last = { title: t.title, url: t.url, favicon: t.favicon, loading: t.loading, audible: t.audible, muted: t.muted, active: active };
    }

    function removeTab(id, node) {
      tabEls.delete(id);
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) { node.remove(); return; }
      node.classList.remove('entering');
      node.classList.add('closing');
      node.setAttribute('aria-hidden', 'true');
      var done = false;
      function finish() { if (done) return; done = true; node.remove(); layoutTabs(); }
      node.addEventListener('animationend', finish, { once: true });
      setTimeout(finish, 260);
    }

    function keepInView(node) {
      requestAnimationFrame(function () {
        var l = node.offsetLeft, r = l + node.offsetWidth;
        var vl = tabsEl.scrollLeft, vr = vl + tabsEl.clientWidth;
        if (l < vl + 8) tabsEl.scrollTo({ left: Math.max(0, l - 8), behavior: 'smooth' });
        else if (r > vr - 8) tabsEl.scrollTo({ left: r - tabsEl.clientWidth + 8, behavior: 'smooth' });
      });
    }

    /* ---- layout: compact mode + scroll fades ---- */

    var layoutQueued = false;
    function layoutTabs() {
      if (layoutQueued) return;
      layoutQueued = true;
      requestAnimationFrame(function () {
        layoutQueued = false;
        var n = tabEls.size;
        var fixed = CAPSULE_PAD + newBtn.offsetWidth + controlsEl.offsetWidth + TAB_GAP * 2;
        var avail = root.clientWidth - STRIP_LEFT - STRIP_RIGHT - fixed;
        var compact = n > 1 && n * TAB_MIN + (n - 1) * TAB_GAP > avail;
        tabsEl.classList.toggle('compact', compact);
        updateFades();
      });
    }
    function updateFades() {
      var max = tabsEl.scrollWidth - tabsEl.clientWidth;
      tabsEl.classList.toggle('fade-l', tabsEl.scrollLeft > 1);
      tabsEl.classList.toggle('fade-r', max > 1 && tabsEl.scrollLeft < max - 1);
    }
    tabsEl.addEventListener('scroll', updateFades, { passive: true });
    tabsEl.addEventListener('wheel', function (e) {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { tabsEl.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });
    window.addEventListener('resize', layoutTabs);
    if (window.ResizeObserver) new ResizeObserver(layoutTabs).observe(controlsEl);

    /* ---- tab interaction ---- */

    function tabFromEvent(e) {
      var node = e.target.closest && e.target.closest('.tab');
      return node && !node.classList.contains('closing') ? node : null;
    }

    tabsEl.addEventListener('mousedown', function (e) { if (e.button === 1) e.preventDefault(); });
    tabsEl.addEventListener('auxclick', function (e) {
      if (e.button !== 1) return;
      var node = tabFromEvent(e);
      if (node) { e.preventDefault(); stage.closeTab(+node.dataset.id); }
    });
    tabsEl.addEventListener('contextmenu', function (e) {
      var node = tabFromEvent(e);
      e.preventDefault();
      if (node) stage.showTabMenu(+node.dataset.id);
    });
    tabsEl.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.close');
      if (!btn) return;
      var node = tabFromEvent(e);
      if (node) { e.stopPropagation(); stage.closeTab(+node.dataset.id); }
    });
    tabsEl.addEventListener('keydown', function (e) {
      var node = tabFromEvent(e);
      if (!node) return;
      var id = +node.dataset.id;
      var tabs = liveTabEls(), i = tabs.indexOf(node);
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (node.classList.contains('active')) stage.openOmnibox('edit'); else stage.activateTab(id); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        var next = tabs[i + (e.key === 'ArrowRight' ? 1 : -1)];
        if (next) { e.preventDefault(); next.focus(); }
      } else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); stage.closeTab(id); }
    });

    tabsEl.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || drag) return;
      if (e.target.closest('.close')) return;
      var node = tabFromEvent(e);
      if (!node) return;
      var id = +node.dataset.id;
      var wasActive = state && id === state.activeTabId;
      if (!wasActive) stage.activateTab(id);
      drag = { id: id, node: node, startX: e.clientX, startScroll: tabsEl.scrollLeft, started: false, wasActive: wasActive, pointerId: e.pointerId };
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', onDragEnd);
      window.addEventListener('pointercancel', onDragCancel);
    });

    function beginDrag() {
      var d = drag;
      d.started = true;
      var nodes = liveTabEls();
      var base = nodes.length ? nodes[0].getBoundingClientRect().left : 0;
      d.items = nodes.map(function (n) {
        var r = n.getBoundingClientRect();
        return { node: n, left: r.left, width: r.width, center: r.left + r.width / 2 };
      });
      d.index = nodes.indexOf(d.node);
      d.target = d.index;
      d.me = d.items[d.index];
      var last = d.items[d.items.length - 1];
      d.minDx = base - d.me.left;
      d.maxDx = last.left + last.width - d.me.width - d.me.left;
      d.node.classList.add('dragging');
      try { d.node.setPointerCapture(d.pointerId); } catch (e) { /* synthetic pointer */ }
      document.body.style.cursor = 'grabbing';
    }

    function slotShift(d, target) {
      // how far the dragged tab travels to sit in `target`, and which others shift by its width
      var w = d.me.width + TAB_GAP, dx = 0;
      if (target > d.index) for (var i = d.index + 1; i <= target; i++) dx += d.items[i].width + TAB_GAP;
      else if (target < d.index) for (var j = target; j < d.index; j++) dx -= d.items[j].width + TAB_GAP;
      return { dx: dx, w: w };
    }

    function onDragMove(e) {
      var d = drag;
      if (!d) return;
      var dx = e.clientX - d.startX + (tabsEl.scrollLeft - d.startScroll);
      if (!d.started) {
        if (Math.abs(dx) < DRAG_THRESHOLD) return;
        beginDrag();
      }
      dx = Math.max(d.minDx, Math.min(d.maxDx, dx));
      d.dx = dx;
      d.node.style.transform = 'translateX(' + dx + 'px)';
      var center = d.me.center + dx, target = 0;
      d.items.forEach(function (it, i) { if (i !== d.index && it.center < center) target++; });
      // `target` counts the other tabs left of the dragged centre, which is its new index
      if (target !== d.target) {
        d.target = target;
        var w = d.me.width + TAB_GAP;
        d.items.forEach(function (it, i) {
          if (i === d.index) return;
          var shift = 0;
          if (target > d.index && i > d.index && i <= target) shift = -w;
          else if (target < d.index && i >= target && i < d.index) shift = w;
          it.node.style.transform = shift ? 'translateX(' + shift + 'px)' : '';
        });
      }
    }

    function endDrag() {
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragEnd);
      window.removeEventListener('pointercancel', onDragCancel);
      document.body.style.cursor = '';
    }

    function onDragEnd() {
      var d = drag;
      if (!d) return;
      endDrag();
      if (!d.started) {
        drag = null;
        if (d.wasActive) stage.openOmnibox('edit');   // clicking the active tab edits its address
        return;
      }
      // settle into the slot, then commit the new order in one frame
      var fin = slotShift(d, d.target);
      d.node.style.transition = 'transform 140ms var(--ease-out), background-color 140ms ease, box-shadow 140ms ease';
      d.node.style.transform = 'translateX(' + fin.dx + 'px)';
      setTimeout(function () { commitDrag(d); }, 150);
    }

    function commitDrag(d) {
      tabsEl.classList.add('no-anim');
      var others = d.items.filter(function (it, i) { return i !== d.index; });
      var before = others[d.target] ? others[d.target].node : null;
      // closing tabs may be interleaved, so insert relative to a live node
      tabsEl.insertBefore(d.node, before);
      d.items.forEach(function (it) { it.node.style.transform = ''; it.node.style.transition = ''; });
      d.node.classList.remove('dragging');
      void tabsEl.offsetWidth;
      tabsEl.classList.remove('no-anim');
      var moved = d.target !== d.index;
      drag = null;
      if (moved) stage.moveTab(d.id, d.target);
      if (state) renderTabs(state);
    }

    function onDragCancel() {
      var d = drag;
      if (!d) return;
      endDrag();
      if (d.started) {
        d.items.forEach(function (it) { it.node.style.transform = ''; it.node.style.transition = ''; });
        d.node.classList.remove('dragging');
      }
      drag = null;
      if (state) renderTabs(state);
    }

    /* ---- trailing controls ---- */

    newBtn.addEventListener('click', function () { stage.openOmnibox('new'); });
    capsule.addEventListener('mouseenter', function () { stage.setBarHover(true); });
    capsule.addEventListener('mouseleave', function () { stage.setBarHover(false); });

    /* ---------- omnibox ---------- */

    var omni = $('#omni');
    var panel = $('#omni-panel');
    var input = $('#omni-input');
    var list = $('#omni-list');
    var glyph = $('#omni-glyph');
    var ob = { open: false, mode: 'new', initial: '', nonce: null, items: [], sel: 0, seq: 0, timer: 0, answered: null };

    function renderOverlay(s) {
      var o = s.overlay && s.overlay.type === 'omnibox' ? s.overlay : null;
      if (!o) { if (ob.open) closeOmnibox(); return; }
      if (!ob.open || ob.mode !== o.mode || ob.initial !== (o.initial || '') || ob.nonce !== o.nonce) openOmnibox(o);
    }

    function openOmnibox(o) {
      var wasOpen = ob.open;
      ob.open = true;
      ob.mode = o.mode;
      ob.initial = o.initial || '';
      ob.nonce = o.nonce;
      ob.items = [];
      ob.sel = 0;
      ob.answered = null;
      omni.hidden = false;
      if (!wasOpen) { // replay the entrance animations
        [panel, $('#omni-backdrop')].forEach(function (n) { n.style.animation = 'none'; void n.offsetWidth; n.style.animation = ''; });
      }
      input.value = ob.initial;
      updateGlyph();
      renderList();
      input.focus();
      input.select();
      requestSuggest(ob.initial, true);
    }

    function closeOmnibox() {
      ob.open = false;
      ob.seq++;
      clearTimeout(ob.timer);
      ob.items = [];
      omni.hidden = true;
      omni.classList.remove('cmd');
      list.textContent = '';
      input.blur();
    }

    function updateGlyph() {
      glyph.innerHTML = looksLikeUrl(input.value) ? ICONS.globe : ICONS.search;
    }

    function requestSuggest(q, immediate) {
      clearTimeout(ob.timer);
      var mine = ++ob.seq;           // anything already in flight is now stale
      function run() {
        Promise.resolve(stage.suggest(q)).then(function (res) {
          if (mine !== ob.seq || !ob.open) return;
          ob.items = (res || []).slice(0, 8);
          ob.answered = q;
          ob.sel = 0;
          renderList();
        }, function () {});
      }
      if (immediate) run(); else ob.timer = setTimeout(run, SUGGEST_DEBOUNCE);
    }

    function iconFor(item) {
      if (item.favicon) return '<img alt="" draggable="false" src="' + item.favicon.replace(/"/g, '&quot;') + '">';
      return ICONS[item.kind === 'search' ? 'search' : item.kind === 'tab' ? 'tab' : item.kind === 'history' ? 'clock' : 'globe'];
    }

    function renderList() {
      list.textContent = '';
      input.setAttribute('aria-expanded', String(ob.items.length > 0));
      ob.items.forEach(function (item, i) {
        var row = el('div', 'row' + (item.kind === 'tab' ? ' is-tab' : ''));
        row.id = 'omni-row-' + i;
        row.setAttribute('role', 'option');
        var url = item.kind === 'search' ? '' : prettyUrl(item.url);
        var title = item.title || url;
        if (url === title) url = '';
        row.innerHTML = '<span class="r-ico">' + iconFor(item) + '</span><span class="r-title"></span><span class="r-url"></span>' +
          '<span class="hint">' + (item.kind === 'tab'
            ? '<span>Switch to tab</span><kbd>↵</kbd>'
            : '<span class="h-ret"><kbd>↵</kbd></span><span class="h-cmd"><span>New tab</span><kbd>⌘↵</kbd></span>') + '</span>';
        row.children[1].textContent = title;
        row.children[2].textContent = url;
        var img = row.querySelector('.r-ico img');
        if (img) img.addEventListener('error', function () { img.parentNode.innerHTML = ICONS[item.kind === 'tab' ? 'tab' : 'globe']; });
        row.addEventListener('mousedown', function (e) { e.preventDefault(); });
        row.addEventListener('mousemove', function () { if (ob.sel !== i) select(i, false); });
        row.addEventListener('click', function (e) { commit(item, e.metaKey); });
        list.appendChild(row);
      });
      paintSelection(false);
    }

    function paintSelection(scroll) {
      var rows = list.children;
      for (var i = 0; i < rows.length; i++) {
        var on = i === ob.sel;
        rows[i].classList.toggle('sel', on);
        rows[i].setAttribute('aria-selected', String(on));
        if (on) {
          input.setAttribute('aria-activedescendant', rows[i].id);
          if (scroll) rows[i].scrollIntoView({ block: 'nearest' });
        }
      }
      if (!rows.length) input.removeAttribute('aria-activedescendant');
    }

    function select(i, scroll) {
      var n = ob.items.length;
      if (!n) return;
      ob.sel = (i + n) % n;
      paintSelection(scroll !== false);
    }

    function commit(item, cmd) {
      if (item && item.kind === 'tab' && item.tabId != null) {
        stage.activateTab(item.tabId);
        stage.closeOverlay();
        return;
      }
      var text = item ? item.url : input.value;
      if (!text) { stage.closeOverlay(); return; }
      stage.submitOmnibox(text, { newTab: ob.mode === 'new' || !!cmd });
    }

    input.addEventListener('input', function () {
      updateGlyph();
      requestSuggest(input.value, false);
    });

    input.addEventListener('keydown', function (e) {
      if (e.isComposing) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); select(ob.sel + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); select(ob.sel - 1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        // suggestions for older text are stale: submit exactly what is typed
        var fresh = ob.answered === input.value && ob.items.length;
        var item = fresh ? ob.items[ob.sel] : null;
        if (!item && !input.value.trim()) { stage.closeOverlay(); return; }
        commit(item, e.metaKey);
      } else if (e.key === 'Escape') { e.preventDefault(); stage.closeOverlay(); }
      else if (e.key === 'Home' || e.key === 'End') { /* default caret movement */ }
      if (e.key === 'Meta') omni.classList.add('cmd');
    });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Meta' && ob.open) omni.classList.add('cmd');
      if (e.key === 'Escape' && ob.open && e.target !== input) stage.closeOverlay();
    });
    window.addEventListener('keyup', function (e) { if (e.key === 'Meta') omni.classList.remove('cmd'); });
    window.addEventListener('blur', function () { omni.classList.remove('cmd'); });

    $('#omni-backdrop').addEventListener('mousedown', function () { stage.closeOverlay(); });
    omni.addEventListener('mousedown', function (e) {
      // keep the caret in the field when clicking inside the panel's chrome
      if (e.target !== input && panel.contains(e.target)) e.preventDefault();
    });
    window.addEventListener('focus', function () { if (ob.open) input.focus(); });

    // Expose a tiny hook for the mock's self-check; harmless in production.
    window.__stageUI = { renderTabs: function () { if (state) renderTabs(state); } };
  }
})();
