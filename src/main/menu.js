'use strict'
const { Menu } = require('electron')
const { execFile } = require('child_process')
const extensions = require('./extensions')

const SIZES = [
  [1280, 720],
  [1440, 900],
  [1600, 900],
  [1920, 1080],
]

function buildMenu(ctx) {
  const { tabs, reveal } = ctx
  const hidden = (accelerator, click) => ({ label: accelerator, accelerator, click, visible: false })
  const openInChrome = () => {
    const t = tabs.active
    if (t && t.url) execFile('open', ['-a', 'Google Chrome', t.url], () => {})
  }
  const withActive = (fn) => () => {
    const t = tabs.active
    if (t) fn(t.wc)
  }

  const extItems = extensions.installed(ctx).map((e) => ({
    label: `${e.name} ${e.version}`,
    submenu: [
      {
        label: 'Remove',
        click: async () => {
          await extensions.remove(ctx, e.id).catch((err) => console.error('[stage] remove failed', err.message))
          ctx.rebuildMenu()
        },
      },
    ],
  }))

  const template = [
    {
      label: 'Stage',
      submenu: [
        { role: 'about', label: 'About Stage' },
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
        {
          label: 'Open Location…',
          accelerator: 'CmdOrCtrl+L',
          click: () => reveal.openOverlay('edit', tabs.active ? tabs.active.url : ''),
        },
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
        {
          label: 'Pin Tab Bar',
          type: 'checkbox',
          checked: ctx.bar.pinned,
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => reveal.setPinned(!ctx.bar.pinned),
        },
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
              if (ctx.win.isFullScreen()) return
              ctx.win.setContentSize(w, h)
              ctx.win.center()
            },
          })),
        },
        { label: 'Enter Full Screen', accelerator: 'Ctrl+Command+F', click: () => ctx.win.setFullScreen(!ctx.win.isFullScreen()) },
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
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
          label: n === 9 ? 'Last Tab' : `Tab ${n}`,
          accelerator: `CmdOrCtrl+${n}`,
          click: () => tabs.goTo(n),
        })),
      ],
    },
    {
      label: 'Extensions',
      submenu: [
        { label: 'Open Chrome Web Store', click: () => tabs.create({ url: extensions.WEB_STORE_URL, index: tabs.insertIndexAfterActive() }) },
        {
          label: 'Hide Icons in Tab Bar',
          type: 'checkbox',
          checked: !!ctx.prefs.hideExtensionIcons,
          click: (item) => ctx.setHideExtensionIcons(item.checked),
        },
        { type: 'separator' },
        ...(extItems.length ? extItems : [{ label: 'No extensions installed', enabled: false }]),
      ],
    },
    { role: 'windowMenu' },
  ]
  return Menu.buildFromTemplate(template)
}

function installMenu(ctx) {
  ctx.rebuildMenu = () => Menu.setApplicationMenu(buildMenu(ctx))
  ctx.rebuildMenu()
}

module.exports = { installMenu, buildMenu }
