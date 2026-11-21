'use strict'
// Scripted self-test: `npm run selftest`. No human input. Writes results.json + PNGs, exits 0/1.
const fs = require('fs')
const path = require('path')
const { app, BrowserWindow } = require('electron')
const { resolveInput } = require('./url')
const { parseArgs } = require('./cli-args')
const { suggest } = require('./suggest')
const extensions = require('./extensions')
const { NEWTAB_FILE } = require('./tabs')

const OUT = path.resolve(process.env.STAGE_SELFTEST_OUT || './selftest-out')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeout = 25000, step = 100) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error('timeout waiting for condition')
    await sleep(step)
  }
}

async function composite(layers, w, h) {
  // draw PNG layers on top of each other in a hidden window's canvas
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  try {
    await win.loadURL('about:blank')
    const urls = layers.map((img) => img.toDataURL())
    const dataUrl = await win.webContents.executeJavaScript(`(async () => {
      const urls = ${JSON.stringify(urls)};
      const imgs = await Promise.all(urls.map(u => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u })));
      const c = document.createElement('canvas'); c.width = imgs[0].width; c.height = imgs[0].height;
      const g = c.getContext('2d');
      imgs.forEach(i => g.drawImage(i, 0, 0));
      return c.toDataURL('image/png');
    })()`)
    return dataUrl.replace(/^data:image\/png;base64,/, '')
  } finally {
    win.destroy()
  }
}

async function run(ctx) {
  fs.mkdirSync(OUT, { recursive: true })
  const results = []
  const uncaught = []
  ctx.holdQuit = true // keep the app alive after the close-window check so results get written
  process.on('uncaughtException', (e) => {
    uncaught.push(String((e && e.stack) || e))
    console.error('[selftest] uncaughtException', e)
  })
  const check = async (name, fn) => {
    let pass = false
    let detail = ''
    try {
      const r = await fn()
      pass = r === undefined || r === true || (r && r.pass !== false)
      detail = r && typeof r === 'object' ? r.detail || '' : typeof r === 'string' ? r : ''
      if (typeof r === 'string') pass = true
    } catch (e) {
      detail = 'threw: ' + (e && e.message)
    }
    results.push({ name, pass, detail })
    console.log(`[selftest] ${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`)
  }
  const save = (name, buf) => fs.writeFileSync(path.join(OUT, name), buf)
  const loaded = (t) => !t.loading && t.url && t.title
  const { tabs, reveal } = ctx

  await check('window and UI view exist; new tab page present when empty', async () => {
    tabs.create({})
    return { pass: tabs.list.length === 1 && tabs.list[0].newTab, detail: `newtab.html exists=${fs.existsSync(NEWTAB_FILE)}` }
  })
  tabs.close(tabs.list[0].id)

  let t1, t2
  await check('launch with two URLs: both load with title', async () => {
    t1 = tabs.create({ url: 'https://example.com', activate: true })
    t2 = tabs.create({ url: 'https://en.wikipedia.org/wiki/Web_browser', activate: false })
    await waitFor(() => loaded(t1) && loaded(t2))
    return { pass: /Example Domain/.test(t1.title) && /Web browser/i.test(t2.title), detail: `${t1.title} | ${t2.title}` }
  })
  // the empty tab we closed first was replaced by a fresh one; drop it
  for (const t of [...tabs.list]) if (t !== t1 && t !== t2) tabs.close(t.id)

  await check('favicon and state pushed (wikipedia)', async () => {
    await waitFor(() => t2.favicon, 15000).catch(() => {})
    const s = ctx.getState()
    const w = s.tabs.find((t) => t.id === t2.id)
    return { pass: !!(w && w.favicon && w.title && w.url), detail: `favicon=${w && w.favicon}` }
  })

  await check('user agent has no Electron/Stage token', async () => {
    const ua = await t1.wc.executeJavaScript('navigator.userAgent')
    const hdr = ctx.session.getUserAgent()
    const bad = /Electron|stage-browser|Stage\//i
    return { pass: !bad.test(ua) && !bad.test(hdr), detail: ua }
  })

  await check('url.js resolution cases', async () => {
    const cases = [
      ['https://a.com/x', 'https://a.com/x'],
      ['example.com', 'https://example.com'],
      ['example.com/path?q=1', 'https://example.com/path?q=1'],
      ['localhost:3000', 'http://localhost:3000'],
      ['127.0.0.1:8080/a', 'http://127.0.0.1:8080/a'],
      ['localhost', 'http://localhost'],
      ['about:blank', 'about:blank'],
      ['hello world', 'https://www.google.com/search?q=hello%20world'],
      ['stage', 'https://www.google.com/search?q=stage'],
      ['what is 3.5', 'https://www.google.com/search?q=what%20is%203.5'],
      ['zoommtg://x', 'zoommtg://x'],
    ]
    const bad = cases.filter(([i, o]) => resolveInput(i) !== o).map(([i, o]) => `${i} -> ${resolveInput(i)} (want ${o})`)
    return { pass: bad.length === 0, detail: bad.join('; ') }
  })

  await check('cli-args parsing', async () => {
    const a = parseArgs(['electron', '.', '--inspect=1', '--size', '1280x720', 'a.com', '--pin', '--fresh', 'hello world'])
    return { pass: a.pin && a.fresh && a.size.width === 1280 && a.size.height === 720 && a.urls.join('|') === 'a.com|hello world', detail: JSON.stringify(a) }
  })

  await check('activate / close / reopen closed tab', async () => {
    tabs.activate(t1.id)
    const ok1 = ctx.getState().activeTabId === t1.id && t1.view.getVisible() && !t2.view.getVisible()
    const url2 = t2.url
    tabs.close(t2.id)
    const ok2 = tabs.list.length === 1
    tabs.reopenClosed()
    await sleep(200)
    const t = tabs.active
    t2 = tabs.list.find((x) => x.id !== t1.id)
    const ok3 = tabs.list.length === 2 && t.id === t2.id
    await waitFor(() => loaded(t2))
    return { pass: ok1 && ok2 && ok3 && t2.url === url2, detail: `visibleOnlyActive=${ok1} closed=${ok2} reopened=${ok3} url=${t2.url}` }
  })

  await check('closing the last tab leaves a new-tab page', async () => {
    const t = tabs.create({ url: 'about:blank' })
    for (const x of [...tabs.list]) if (x !== t) tabs.close(x.id)
    await sleep(100)
    const ok = tabs.list.length === 1
    tabs.close(t.id)
    await sleep(300)
    const nt = tabs.list.length === 1 && tabs.list[0].newTab
    // restore the working set
    t1 = tabs.create({ url: 'https://example.com' })
    t2 = tabs.create({ url: 'https://en.wikipedia.org/wiki/Web_browser', activate: false })
    tabs.close(tabs.list[0].id)
    await waitFor(() => loaded(t1) && loaded(t2))
    tabs.activate(t1.id)
    return { pass: ok && nt, detail: `single=${ok} newtab=${nt}` }
  })

  await check("suggest('wiki') returns open tab + history", async () => {
    const t3 = tabs.create({ url: 'https://en.wikipedia.org/wiki/Google_Chrome', activate: false })
    await waitFor(() => loaded(t3))
    tabs.close(t3.id)
    const s = suggest(ctx, 'wiki')
    const kinds = s.map((x) => x.kind)
    const okTab = s.some((x) => x.kind === 'tab' && x.tabId === t2.id)
    const okHist = s.some((x) => x.kind === 'history' && /Google_Chrome/.test(x.url))
    return { pass: s[0].kind === 'search' && okTab && okHist && s.length <= 8, detail: JSON.stringify(s.map((x) => [x.kind, x.url])) }
  })

  await check('suggest: url and search first items', async () => {
    const a = suggest(ctx, 'example.org')[0]
    const b = suggest(ctx, 'two words')[0]
    return { pass: a.kind === 'url' && a.url === 'https://example.org' && b.kind === 'search', detail: `${a.kind} ${b.kind}` }
  })

  const shot = async (name) => {
    const page = await tabs.active.wc.capturePage()
    const ui = await ctx.uiView.webContents.capturePage()
    save(`${name.replace('composite', 'page')}.png`, page.toPNG())
    save(`${name.replace('composite', 'ui')}.png`, ui.toPNG())
    const b64 = await composite([page, ui])
    save(`${name}.png`, Buffer.from(b64, 'base64'))
    return { page: page.getSize(), ui: ui.getSize() }
  }

  await check('reveal bar: state pushed visible, view shown, composite captured', async () => {
    reveal.setHover(true) // the real cursor is elsewhere; keep the poller from hiding the bar
    reveal.show()
    await sleep(1200)
    const sizes = await shot('bar-composite')
    reveal.setHover(false)
    return { pass: ctx.bar.visible && ctx.uiView.getVisible() && sizes.ui.height > 0, detail: JSON.stringify(sizes) }
  })

  await check('omnibox overlay: full-size UI view, composite captured', async () => {
    reveal.openOverlay('new', '')
    await sleep(800)
    await ctx.uiView.webContents.executeJavaScript(`(() => { const i = document.querySelector('input'); if (i) { i.focus(); i.value = 'wiki'; i.dispatchEvent(new Event('input', { bubbles: true })) } return !!i })()`).catch(() => {})
    await sleep(900)
    const [w, h] = ctx.win.getContentSize()
    const b = ctx.uiView.getBounds()
    const sizes = await shot('omnibox-composite')
    reveal.closeOverlay()
    return { pass: b.width === w && b.height === h && !ctx.overlay, detail: JSON.stringify({ b, sizes }) }
  })

  await check('pin: tab view bounds start at y=52; unpin: y=0', async () => {
    reveal.setPinned(true)
    const y1 = tabs.active.view.getBounds().y
    const h1 = tabs.active.view.getBounds().height
    const [, ch] = ctx.win.getContentSize()
    reveal.setPinned(false)
    const y2 = tabs.active.view.getBounds().y
    return { pass: y1 === 52 && h1 === ch - 52 && y2 === 0, detail: `pinned y=${y1} h=${h1}/${ch}, unpinned y=${y2}` }
  })

  await check('hide: state false, UI view invisible after timeout', async () => {
    reveal.hide()
    const stateFalse = !ctx.bar.visible
    await sleep(500)
    return { pass: stateFalse && !ctx.uiView.getVisible(), detail: `uiVisible=${ctx.uiView.getVisible()}` }
  })

  await check('floating bar has room for its shadow; clicks under the strip reach the page', async () => {
    const page = 'data:text/html,' + encodeURIComponent('<body style="margin:0"><button style="position:absolute;left:300px;top:55px;width:240px;height:14px" onclick="window.clicked=(window.clicked||0)+1">x</button></body>')
    reveal.closeOverlay() // start clean even if an earlier check left the omnibox open
    if (ctx.bar.pinned) reveal.setPinned(false)
    const tab = tabs.create({ url: page, activate: true })
    await waitFor(() => !tab.loading && tab.url.startsWith('data:'))
    reveal.show()
    await sleep(400)
    const floatH = ctx.uiView.getBounds().height
    for (const type of ['mouseDown', 'mouseUp']) ctx.uiView.webContents.sendInputEvent({ type, x: 420, y: 62, button: 'left', clickCount: 1 })
    const clicked = await waitFor(() => tab.wc.executeJavaScript('window.clicked || 0'), 3000).catch(() => 0)
    const hidden = !ctx.bar.visible && !ctx.uiView.getVisible()
    reveal.setPinned(true)
    await sleep(100)
    const pinnedH = ctx.uiView.getBounds().height
    reveal.setPinned(false)
    reveal.hide()
    tabs.close(tab.id)
    return { pass: floatH === 72 && clicked === 1 && hidden && pinnedH === 52, detail: JSON.stringify({ floatH, clicked, hidden, pinnedH }) }
  })

  await check('extension icons: shown with a button extension, hidden by the menu option, gone with none installed', async () => {
    const { Menu } = require('electron')
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'stage-action-ext-'))
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Stage action probe', version: '1.0', action: { default_title: 'Probe' } }))
    const probe = await ctx.session.extensions.loadExtension(dir)
    reveal.show()
    const controlsShown = () => ctx.uiView.webContents.executeJavaScript("document.getElementById('controls').checkVisibility()")
    await sleep(400)
    const withExt = await controlsShown()
    ctx.setHideExtensionIcons(true)
    await sleep(250)
    const hiddenByOption = !(await controlsShown())
    const ext = Menu.getApplicationMenu().items.find((i) => i.label === 'Extensions')
    const item = ext && ext.submenu.items.find((i) => i.label === 'Hide Icons in Tab Bar')
    const checked = !!(item && item.checked)
    const saved = require('./store').readJson('prefs.json', {}).hideExtensionIcons === true
    ctx.setHideExtensionIcons(false)
    await sleep(250)
    const back = await controlsShown()
    ctx.session.extensions.removeExtension(probe.id)
    await sleep(400)
    const goneWithNone = !(await controlsShown())
    const noPinButton = await ctx.uiView.webContents.executeJavaScript("!document.getElementById('pin')")
    reveal.hide()
    const r = { withExt, hiddenByOption, checked, saved, back, goneWithNone, noPinButton }
    return { pass: Object.values(r).every(Boolean), detail: JSON.stringify(r) }
  })

  await check('UI view stays topmost after adding tabs', async () => {
    tabs.create({ url: 'about:blank', activate: false })
    const kids = ctx.win.contentView.children
    return { pass: kids[kids.length - 1] === ctx.uiView, detail: `children=${kids.length}` }
  })

  await check('content size 1280x720 sets and centers', async () => {
    ctx.win.setContentSize(1280, 720)
    ctx.win.center()
    const [w, h] = ctx.win.getContentSize()
    return { pass: w === 1280 && h === 720, detail: `${w}x${h}` }
  })

  await check('external scheme from page opens via shell, not in tab', async () => {
    const orig = require('electron').shell.openExternal
    let called = ''
    require('electron').shell.openExternal = async (u) => { called = u }
    const r = tabs.openHandler({ url: 'zoommtg://zoom.us/join?x=1', disposition: 'foreground-tab', features: '' })
    require('electron').shell.openExternal = orig
    return { pass: r.action === 'deny' && called.startsWith('zoommtg:'), detail: called }
  })

  // Real clicks, so Electron's own window-open path runs (not just openHandler's return value).
  const LINKS_PAGE =
    'data:text/html,' +
    encodeURIComponent(
      '<a id="blank" target="_blank" href="https://example.com/?from=blank">blank</a>' +
        '<script>window.openWithOpener = () => { const w = window.open("about:blank"); return !!w && !w.closed && w.opener === window }</script>'
    )

  await check('target=_blank link opens the URL in a new active tab', async () => {
    const errorsBefore = uncaught.length
    const src = tabs.create({ url: LINKS_PAGE, activate: true })
    await waitFor(() => !src.loading && src.url.startsWith('data:'))
    const before = tabs.list.length
    await src.wc.executeJavaScript('document.getElementById("blank").click()', true)
    const t = await waitFor(() => tabs.list.length === before + 1 && tabs.list.find((x) => x.url.includes('from=blank')), 15000)
    const ok = tabs.activeId === t.id && uncaught.length === errorsBefore
    tabs.close(t.id)
    tabs.close(src.id)
    return { pass: ok, detail: t.url }
  })

  await check('window.open() opens a tab that keeps window.opener', async () => {
    const errorsBefore = uncaught.length
    const src = tabs.create({ url: LINKS_PAGE, activate: true })
    await waitFor(() => !src.loading && src.url.startsWith('data:'))
    const before = tabs.list.length
    const hasOpener = await src.wc.executeJavaScript('window.openWithOpener()', true)
    await waitFor(() => tabs.list.length === before + 1, 5000)
    const t = tabs.list.find((x) => x.id !== src.id && x.id === tabs.activeId)
    if (t) tabs.close(t.id)
    tabs.close(src.id)
    const clean = uncaught.length === errorsBefore
    return { pass: hasOpener === true && !!t && clean, detail: `opener=${hasOpener} tabs=${tabs.list.length} uncaught=${!clean}` }
  })

  // Opt-in compatibility suite against a real, widely used extension from the Web Store.
  // The app itself installs nothing; people add extensions through the Chrome Web Store.
  // STAGE_SELFTEST_EXT_ID=<web store id> runs the same suite against any other extension.
  const OKTA_ID = 'glnpjglilkicbckjpbgcfkogebgllemb'
  const EXT_ID = process.env.STAGE_SELFTEST_EXT_ID || OKTA_ID
  if (process.env.STAGE_SELFTEST_OKTA || process.env.STAGE_SELFTEST_EXT_ID) {
    // Diagnostics for extension popups: console output from every web view and from service
    // workers, recorded from before the install so startup errors are caught.
    const diag = { pageConsole: [], swConsole: [], swRunning: null, popupDom: null }
    app.on('web-contents-created', (_e, wc) => {
      wc.on('console-message', (ev) => {
        const url = wc.isDestroyed() ? '' : wc.getURL()
        if (url.startsWith('chrome-extension://')) diag.pageConsole.push(`[${ev.level}] ${url.split('/').slice(3).join('/')}: ${ev.message} (${ev.sourceId}:${ev.lineNumber})`)
      })
    })
    ctx.session.serviceWorkers.on('console-message', (_e, d) => {
      diag.swConsole.push(`[${d.level}] ${d.message} (${d.sourceUrl}:${d.lineNumber})`)
    })
    await check(`extension ${EXT_ID} installs from the Web Store`, async () => {
      await extensions.install(ctx, EXT_ID)
      const list = extensions.installed(ctx)
      return { pass: list.some((e) => e.id === EXT_ID), detail: JSON.stringify(list) }
    })
    await check('extension responds to its toolbar button (popup or page)', async () => {
      tabs.activate(t1.id)
      reveal.setHover(true)
      reveal.show()
      await sleep(2500)
      const desc = await ctx.uiView.webContents.executeJavaScript(`(() => {
        const l = document.querySelector('browser-action-list'); if (!l) return 'no element';
        const r = l.shadowRoot; const btns = r ? r.querySelectorAll('button, .action, [part]') : [];
        return 'buttons=' + btns.length + ' html=' + (r ? r.innerHTML.slice(0, 300) : 'no shadow')
      })()`)
      await shot('ext-bar-composite').catch(() => {}) // screenshots need an awake display; the check doesn't
      let popupInfo = 'not attempted'
      const tabsBefore = new Set(tabs.list.map((t) => t.id))
      const popupP = new Promise((res) => ctx.ext.once('browser-action-popup-created', res))
      await ctx.uiView.webContents.executeJavaScript(`(() => {
        const l = document.querySelector('browser-action-list'); const b = l && l.shadowRoot && l.shadowRoot.querySelector('button, .action');
        if (b) b.click(); return !!b })()`)
      const popup = await Promise.race([popupP, sleep(6000).then(() => null)])
      let opened = false
      if (popup) {
        await popup.whenReady().catch(() => {})
        await sleep(4000)
        const bw = popup.browserWindow
        if (bw && !bw.isDestroyed()) {
          opened = true
          diag.popupDom = await bw.webContents
            .executeJavaScript(`(() => {
              const t = (o) => typeof o
              const c = window.chrome || {}
              return {
                readyState: document.readyState,
                contentHtmlLength: (document.getElementById('content') || {}).innerHTML?.length,
                bodyText: document.body.innerText.slice(0, 300),
                apis: {
                  'runtime.sendMessage': t(c.runtime && c.runtime.sendMessage), 'storage.local': t(c.storage && c.storage.local),
                  'storage.session': t(c.storage && c.storage.session), 'tabs.query': t(c.tabs && c.tabs.query),
                  scripting: t(c.scripting), declarativeNetRequest: t(c.declarativeNetRequest), webRequest: t(c.webRequest),
                  cookies: t(c.cookies), i18n: t(c.i18n), permissions: t(c.permissions), privacy: t(c.privacy),
                  windows: t(c.windows), action: t(c.action), alarms: t(c.alarms), idle: t(c.idle), management: t(c.management),
                  downloads: t(c.downloads), offscreen: t(c.offscreen), contextMenus: t(c.contextMenus), notifications: t(c.notifications),
                  'runtime.connectNative': t(c.runtime && c.runtime.connectNative), 'runtime.sendNativeMessage': t(c.runtime && c.runtime.sendNativeMessage),
                  identity: t(c.identity), commands: t(c.commands), sidePanel: t(c.sidePanel), 'privacy.services': t(c.privacy && c.privacy.services),
                },
              }
            })()`)
            .catch((e) => 'executeJavaScript failed: ' + e.message)
          diag.swRunning = Object.values(ctx.session.serviceWorkers.getAllRunning()).map((w) => w.scriptUrl)
          await bw.webContents.capturePage().then((img) => save('ext-popup.png', img.toPNG())).catch(() => {})
          popupInfo = 'popup url=' + bw.webContents.getURL() + ' revealHeld=' + ctx.popupOpen
          popup.destroy()
        }
      }
      // An extension may answer a click by opening a page instead (1Password does on first run).
      await sleep(popup ? 0 : 3000)
      const newTabs = tabs.list.filter((t) => !tabsBefore.has(t.id))
      diag.newTabsAfterClick = newTabs.map((t) => (t.wc.isDestroyed() ? '' : t.wc.getURL()))
      for (const t of newTabs) {
        await waitFor(() => !t.loading, 10000).catch(() => {})
        await t.wc.capturePage().then((img) => save('ext-click-tab.png', img.toPNG())).catch(() => {})
        diag.newTabText = await t.wc.executeJavaScript('document.body ? document.body.innerText.slice(0, 300) : ""').catch(() => '')
      }
      save('ext-diag.json', JSON.stringify(diag, null, 2))
      const popupText = diag.popupDom && diag.popupDom.bodyText
      const respondedWithPage = newTabs.length > 0 && !!diag.newTabText
      return {
        pass: (opened && !!popupText) || respondedWithPage,
        detail: desc.slice(0, 40) + ' | ' + popupInfo + ' | popup text: ' + JSON.stringify(popupText) + ' | new tabs: ' + JSON.stringify(diag.newTabsAfterClick) + ' ' + JSON.stringify((diag.newTabText || '').slice(0, 80)),
      }
    })

    // Okta injects its autofill scripts with chrome.scripting.executeScript from its service worker.
    // A throwaway extension proves that path works end to end in Stage.
    await check('extension service worker can inject a script into the active tab', async () => {
      const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'stage-probe-ext-'))
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: 'Stage probe', version: '1.0',
        permissions: ['scripting', 'tabs'], host_permissions: ['<all_urls>'],
        background: { service_worker: 'sw.js' },
      }))
      fs.writeFileSync(path.join(dir, 'sw.js'), `
        chrome.tabs.query({ active: true }).then(([tab]) =>
          chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => 'PROBE:' + document.title })
        ).then((r) => console.log(r[0].result)).catch((e) => console.log('PROBE-ERR:' + e.message))`)
      tabs.activate(t1.id)
      await ctx.session.extensions.loadExtension(dir)
      const line = await waitFor(() => diag.swConsole.find((l) => l.includes('PROBE')), 10000).catch(() => null)
      return { pass: !!line && line.includes('PROBE:Example Domain'), detail: line || 'no probe output' }
    })

    // Regression: a tracker iframe whose URL contains a UUID made Okta take over the tab and show
    // its "Sign in Error" page, because webNavigation URL filters were ignored.
    const UUID_IFRAME_PAGE =
      'data:text/html,' + encodeURIComponent('<h1>host</h1><iframe src="https://example.com/?id=11111111-2222-4333-8444-555555555555"></iframe>')

    await check('webNavigation URL filters: listeners hear only matching URLs', async () => {
      const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'stage-navfilter-ext-'))
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: 'Stage nav filter probe', version: '1.0',
        permissions: ['webNavigation'], host_permissions: ['<all_urls>'],
        background: { service_worker: 'sw.js' },
      }))
      fs.writeFileSync(path.join(dir, 'sw.js'), `
        const oktaLike = '^https://personal\\\\.okta\\\\.com/okta-personal-app/([0-9a-f-]{36})/launch'
        chrome.webNavigation.onBeforeNavigate.addListener((d) => console.log('NAVOKTA:' + d.url), { url: [{ urlMatches: oktaLike }] })
        chrome.webNavigation.onBeforeNavigate.addListener((d) => console.log('NAVORG:' + d.url), { url: [{ hostEquals: 'example.org' }] })
        chrome.webNavigation.onBeforeNavigate.addListener((d) => { if (d.url.includes('11111111-2222')) console.log('NAVALL:' + d.url) })`)
      await ctx.session.extensions.loadExtension(dir)
      await sleep(1000)
      const tab = tabs.create({ url: UUID_IFRAME_PAGE, activate: true })
      await waitFor(() => diag.swConsole.some((l) => l.includes('NAVALL:')), 10000).catch(() => {})
      tab.wc.loadURL('https://example.org/').catch(() => {})
      await waitFor(() => diag.swConsole.some((l) => l.includes('NAVORG:')), 10000).catch(() => {})
      const heard = (p) => diag.swConsole.filter((l) => l.includes(p)).length
      tabs.close(tab.id)
      const ok = heard('NAVALL:') > 0 && heard('NAVOKTA:') === 0 && heard('NAVORG:') > 0 && !diag.swConsole.some((l) => l.includes('NAVORG:https://example.com'))
      return { pass: ok, detail: `unfiltered=${heard('NAVALL:')} oktaPattern=${heard('NAVOKTA:')} example.org=${heard('NAVORG:')}` }
    })

    await check('Okta does not take over a tab when an iframe URL contains a UUID', async () => {
      const tab = tabs.create({ url: UUID_IFRAME_PAGE, activate: true })
      await waitFor(() => !tab.loading && tab.url.startsWith('data:'), 10000).catch(() => {})
      await sleep(4000) // Okta's takeover ran within ~1s of the iframe navigating
      const url = tab.wc.isDestroyed() ? '(destroyed)' : tab.wc.getURL()
      const hijacked = url.startsWith('chrome-extension://')
      tabs.close(tab.id)
      return { pass: !hijacked, detail: url.slice(0, 120) }
    })
  }

  await check('closing the window with a push pending does not throw', async () => {
    ctx.push()
    ctx.win.close()
    await sleep(800) // let the 16ms push timer, poller, save timer and hide timer all get a chance to fire
    return { pass: uncaught.length === 0 && ctx.quitting && ctx.win.isDestroyed(), detail: uncaught.join(' | ').slice(0, 400) }
  })

  const failed = results.filter((r) => !r.pass).length
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ passed: results.length - failed, failed, results }, null, 2))
  console.log(`[selftest] ${results.length - failed}/${results.length} passed -> ${OUT}`)
  ctx.quitting = true
  app.exit(failed ? 1 : 0)
}

module.exports = { run }
