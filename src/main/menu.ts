import { Menu, dialog, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import type { TabLayout } from '../shared/contract'
import type { Ctx } from './context'
import { confirmFor, installed } from './extensions'
import { WEB_STORE_URL, install, remove, webStoreId } from './web-store'

const SIZES: readonly (readonly [number, number])[] = [
  [1280, 720],
  [1440, 900],
  [1600, 900],
  [1920, 1080],
]

const LAYOUTS: readonly (readonly [TabLayout, string])[] = [
  ['top', 'Tabs on Top'],
  ['left', 'Tabs on Left'],
  ['right', 'Tabs on Right'],
]

const hidden = (accelerator: string, click: () => void): MenuItemConstructorOptions => ({ label: accelerator, accelerator, click, visible: false })

export function buildMenu(ctx: Ctx): Menu {
  const { tabs, reveal, win } = ctx
  const withActive = (fn: (wc: WebContents) => void) => () => {
    const t = tabs.active
    if (t) fn(t.wc)
  }
  const openInChrome = () => {
    const url = tabs.active?.url
    if (url) execFile('open', ['-a', 'Google Chrome', url], () => {})
  }

  const openStore = () => void tabs.create({ url: WEB_STORE_URL, index: tabs.insertIndexAfterActive() })
  const addFromPage = async () => {
    const id = webStoreId(tabs.active?.url)
    if (!id) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        message: 'Open an extension’s page in the Chrome Web Store, then choose this again.',
        buttons: ['Open Chrome Web Store', 'OK'],
        defaultId: 1,
        cancelId: 1,
      })
      if (response === 0) openStore()
      return
    }
    try {
      await install(ctx.session, id, confirmFor(ctx))
      ctx.rebuildMenu()
    } catch (err) {
      await dialog.showMessageBox(win, { type: 'warning', message: 'Couldn’t add the extension', detail: (err as Error).message })
    }
  }

  const extItems = installed(ctx.session).map<MenuItemConstructorOptions>((e) => ({
    label: `${e.name} ${e.version}`,
    submenu: [
      {
        label: 'Remove',
        click: async () => {
          await remove(ctx.session, e.id).catch((err: Error) => console.error('[stage] remove failed', err.message))
          ctx.rebuildMenu()
        },
      },
    ],
  }))

  const { available } = ctx.updates.state()

  return Menu.buildFromTemplate([
    {
      label: 'Stage',
      submenu: [
        { role: 'about', label: 'About Stage' },
        available
          ? { label: `Update to Stage ${available}…`, click: () => ctx.updates.open() }
          : { label: 'Check for Updates…', click: () => void ctx.updates.checkByHand() },
        {
          label: 'Check for Updates Automatically',
          type: 'checkbox',
          checked: ctx.prefs.checkForUpdates,
          click: (item) => ctx.setCheckForUpdates(item.checked),
        },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Stage' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Stage' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => reveal.openOverlay('new', '') },
        { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: () => reveal.openOverlay('edit', tabs.active?.url ?? '') },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => tabs.reopenClosed() },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => tabs.active && tabs.close(tabs.active.id) },
        { type: 'separator' },
        { label: 'Open in Google Chrome', accelerator: 'CmdOrCtrl+Shift+O', click: openInChrome },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: withActive((wc) => wc.reload()) },
        { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: withActive((wc) => wc.reloadIgnoringCache()) },
        { type: 'separator' },
        { label: 'Pin Tab Bar', type: 'checkbox', checked: ctx.bar.pinned, accelerator: 'CmdOrCtrl+Shift+B', click: () => reveal.setPinned(!ctx.bar.pinned) },
        { type: 'separator' },
        ...LAYOUTS.map<MenuItemConstructorOptions>(([layout, label]) => ({
          label,
          type: 'radio',
          checked: ctx.prefs.tabLayout === layout,
          click: () => ctx.setTabLayout(layout),
        })),
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => tabs.zoom(0.1) },
        hidden('CmdOrCtrl+Plus', () => tabs.zoom(0.1)),
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => tabs.zoom(-0.1) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => tabs.zoom(0) },
        { type: 'separator' },
        {
          label: 'Window Size',
          submenu: SIZES.map(([w, h]) => ({
            label: `${w} × ${h}`,
            click: () => {
              if (win.isFullScreen()) return
              win.setContentSize(w, h)
              win.center()
            },
          })),
        },
        { label: 'Enter Full Screen', accelerator: 'Ctrl+Command+F', click: () => win.setFullScreen(!win.isFullScreen()) },
        { type: 'separator' },
        {
          label: 'Developer Tools',
          accelerator: 'CmdOrCtrl+Alt+I',
          click: withActive((wc) => (wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'detach' }))),
        },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: withActive((wc) => wc.navigationHistory.goBack()) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: withActive((wc) => wc.navigationHistory.goForward()) },
      ],
    },
    {
      label: 'Tab',
      submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => tabs.step(1) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => tabs.step(-1) },
        hidden('CmdOrCtrl+Shift+]', () => tabs.step(1)),
        hidden('CmdOrCtrl+Shift+[', () => tabs.step(-1)),
        hidden('CmdOrCtrl+Alt+Right', () => tabs.step(1)),
        hidden('CmdOrCtrl+Alt+Left', () => tabs.step(-1)),
        { type: 'separator' },
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ label: n === 9 ? 'Last Tab' : `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`, click: () => tabs.goTo(n) })),
      ],
    },
    {
      label: 'Extensions',
      submenu: [
        { label: 'Open Chrome Web Store', click: openStore },
        { label: 'Add Extension from This Page', click: () => void addFromPage() },
        { label: 'Hide Icons in Tab Bar', type: 'checkbox', checked: ctx.prefs.hideExtensionIcons, click: (item) => ctx.setHideExtensionIcons(item.checked) },
        { type: 'separator' },
        ...(extItems.length ? extItems : [{ label: 'No extensions installed', enabled: false }]),
      ],
    },
    { role: 'windowMenu' },
  ])
}
