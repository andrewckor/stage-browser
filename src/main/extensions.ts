import type { BrowserWindow, Extension, Session } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { installChromeWebStore, installExtension, uninstallExtension } from 'electron-chrome-web-store'
import { join } from 'node:path'
import type { Ctx } from './context'

export const WEB_STORE_URL = 'https://chromewebstore.google.com/'

export interface InstalledExtension {
  id: string
  name: string
  version: string
}

export interface ActionPopup {
  readonly browserWindow?: BrowserWindow
  destroy(): void
  isDestroyed(): boolean
  whenReady(): Promise<void>
}

type Manifest = { action?: unknown; browser_action?: unknown } | undefined

export function createExtensions(ctx: Ctx): ElectronChromeExtensions {
  const ext = new ElectronChromeExtensions({
    session: ctx.session,
    createTab: async (details) => {
      const tab = ctx.tabs.create({ url: details.url, activate: details.active !== false, index: ctx.tabs.insertIndexAfterActive() })
      return [tab.wc, ctx.win]
    },
    selectTab: (wc) => ctx.tabs.activate(wc.id),
    removeTab: (wc) => ctx.tabs.close(wc.id),
  })
  // Registered after the library's own preload, so it runs second and can fill in what the
  // library left out of the chrome.* objects.
  const compat = join(__dirname, '..', 'preload', 'extension-compat.js')
  ctx.session.registerPreloadScript({ id: 'stage-extension-compat-frame', type: 'frame', filePath: compat })
  ctx.session.registerPreloadScript({ id: 'stage-extension-compat-sw', type: 'service-worker', filePath: compat })
  ElectronChromeExtensions.handleCRXProtocol(ctx.uiView.webContents.session)

  ext.on('browser-action-popup-created', (popup: ActionPopup) => {
    ctx.reveal.setPopupOpen(true)
    if (!ctx.quitting) ctx.reveal.show()
    // The library's blur handling can miss focus moving to a BaseWindow.
    const onFocus = () => {
      if (!popup.isDestroyed()) popup.destroy()
    }
    const done = () => {
      ctx.reveal.setPopupOpen(false)
      if (!ctx.win.isDestroyed()) ctx.win.off('focus', onFocus)
    }
    ctx.win.on('focus', onFocus)
    if (popup.browserWindow) popup.browserWindow.once('closed', done)
    else done()
  })
  return ext
}

export async function setupWebStore(ctx: Ctx): Promise<void> {
  const refresh = () => {
    if (ctx.quitting) return
    ctx.rebuildMenu()
    ctx.push()
  }
  ctx.session.extensions.on('extension-loaded', refresh)
  ctx.session.extensions.on('extension-unloaded', refresh)
  await installChromeWebStore({ session: ctx.session })
}

const all = (session: Session): Extension[] => session.extensions.getAllExtensions()

export function installed(session: Session): InstalledExtension[] {
  return all(session).map(({ id, name, version }) => ({ id, name, version }))
}

export function actionCount(session: Session): number {
  return all(session).filter((e) => {
    const m = e.manifest as Manifest
    return Boolean(m?.action || m?.browser_action)
  }).length
}

export function install(session: Session, id: string): Promise<Extension> {
  return installExtension(id, { session })
}

export function remove(session: Session, id: string): Promise<void> {
  return uninstallExtension(id, { session })
}
