import { app, dialog, type BrowserWindow, type Extension, type Session } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { join } from 'node:path'
import type { Ctx } from './context'
import { loadInstalled, startUpdates, type Confirm } from './web-store'

export interface InstalledExtension {
  id: string
  name: string
  version: string
}

export interface ActionPopup {
  anchorRect?: { x: number; y: number }
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
  ElectronChromeExtensions.handleCRXProtocol(ctx.ui.view.webContents.session)

  ext.on('browser-action-popup-created', (popup: ActionPopup) => {
    ctx.reveal.setPopupOpen(true)
    // The library places the popup from an anchor measured in the UI window but reads it as
    // relative to the page window; the right-hand sidebar's window is offset from that origin.
    const { x, y } = ctx.ui.origin
    if (popup.anchorRect) Object.assign(popup.anchorRect, { x: popup.anchorRect.x + x, y: popup.anchorRect.y + y })
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

/** Asks the user, in a sheet over the page window, before an extension is added or given more access. */
export function confirmFor(ctx: Ctx): Confirm {
  return async (req) => {
    const detail = req.access.length ? `It can access:\n${req.access.map((a) => `• ${a}`).join('\n')}` : 'It asks for no special permissions.'
    const { response } = await dialog.showMessageBox(ctx.win, {
      type: 'question',
      message: req.update ? `“${req.name}” ${req.version} wants more access` : `Add “${req.name}”?`,
      detail,
      buttons: req.update ? ['Allow', 'Not Now'] : ['Add Extension', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    })
    return response === 0
  }
}

export async function setupExtensionStore(ctx: Ctx): Promise<void> {
  const refresh = () => {
    if (ctx.quitting) return
    ctx.rebuildMenu()
    ctx.push()
  }
  ctx.session.extensions.on('extension-loaded', refresh)
  ctx.session.extensions.on('extension-unloaded', refresh)
  await loadInstalled(ctx.session)
  app.once('before-quit', startUpdates(ctx.session, confirmFor(ctx)))
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
