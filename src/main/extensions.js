'use strict'
const path = require('path')
const { ElectronChromeExtensions } = require('electron-chrome-extensions')
const { installChromeWebStore, installExtension, uninstallExtension } = require('electron-chrome-web-store')

const WEB_STORE_URL = 'https://chromewebstore.google.com/'

function createExtensions(ctx) {
  const ext = new ElectronChromeExtensions({
    session: ctx.session,
    createTab: async (details) => {
      const tab = ctx.tabs.create({ url: details.url, activate: details.active !== false, index: ctx.tabs.insertIndexAfterActive() })
      return [tab.wc, ctx.win]
    },
    selectTab: (wc) => ctx.tabs.activate(wc.id),
    removeTab: (wc) => ctx.tabs.close(wc.id),
  })
  // Registered after the library's preload (which the constructor above registers), so it runs
  // second and can fill in constants on the chrome.* objects the library created.
  const compat = path.join(__dirname, '..', 'preload', 'extension-compat.js')
  ctx.session.registerPreloadScript({ id: 'stage-extension-compat-frame', type: 'frame', filePath: compat })
  ctx.session.registerPreloadScript({ id: 'stage-extension-compat-sw', type: 'service-worker', filePath: compat })
  // <browser-action-list> in the UI view loads icons over crx://
  ElectronChromeExtensions.handleCRXProtocol(ctx.uiView.webContents.session)

  ext.on('browser-action-popup-created', (popup) => {
    const bw = popup.browserWindow
    ctx.reveal.setPopupOpen(true)
    if (!ctx.quitting) ctx.reveal.show()
    const done = () => {
      ctx.reveal.setPopupOpen(false)
      if (!ctx.win.isDestroyed()) ctx.win.off('focus', onFocus)
    }
    // the library's own blur handling can miss when focus moves to a BaseWindow
    const onFocus = () => !popup.isDestroyed() && popup.destroy()
    ctx.win.on('focus', onFocus)
    if (bw) bw.once('closed', done)
    else done()
  })
  return ext
}

async function setupWebStore(ctx) {
  // Keep the Extensions menu's list current when someone clicks "Add to Chrome" or removes one.
  const source = ctx.session.extensions || ctx.session
  const refresh = () => {
    if (ctx.quitting) return
    ctx.rebuildMenu && ctx.rebuildMenu()
    ctx.push && ctx.push() // the bar shows its divider only when some extension has a button
  }
  source.on('extension-loaded', refresh)
  source.on('extension-unloaded', refresh)
  await installChromeWebStore({ session: ctx.session })
}

function installed(ctx) {
  const exts = ctx.session.extensions ? ctx.session.extensions.getAllExtensions() : ctx.session.getAllExtensions()
  return exts.map((e) => ({ id: e.id, name: e.name, version: e.version }))
}

// Extensions that put a button in the tab bar (manifest `action` or `browser_action`).
function actionCount(ctx) {
  const exts = ctx.session.extensions ? ctx.session.extensions.getAllExtensions() : ctx.session.getAllExtensions()
  return exts.filter((e) => e.manifest && (e.manifest.action || e.manifest.browser_action)).length
}

function install(ctx, id) {
  return installExtension(id, { session: ctx.session })
}

function remove(ctx, id) {
  return uninstallExtension(id, { session: ctx.session })
}

module.exports = { createExtensions, setupWebStore, installed, actionCount, install, remove, WEB_STORE_URL }
