'use strict'
const { Menu, MenuItem, clipboard } = require('electron')

function showPageMenu(ctx, tab, params) {
  const wc = tab.wc
  const nav = wc.navigationHistory
  const f = params.editFlags
  const items = []
  const sep = () => items.length && items[items.length - 1].type !== 'separator' && items.push({ type: 'separator' })

  if (params.linkURL) {
    items.push({ label: 'Open Link in New Tab', click: () => ctx.tabs.create({ url: params.linkURL, activate: false, index: ctx.tabs.insertIndexAfterActive() }) })
    items.push({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) })
    sep()
  }
  if (params.mediaType === 'image') {
    items.push({ label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) })
    sep()
  }
  if (params.isEditable || params.selectionText) {
    if (params.isEditable) items.push({ label: 'Cut', enabled: f.canCut, role: 'cut' })
    items.push({ label: 'Copy', enabled: f.canCopy, role: 'copy' })
    if (params.isEditable) items.push({ label: 'Paste', enabled: f.canPaste, role: 'paste' })
    items.push({ label: 'Select All', enabled: f.canSelectAll, role: 'selectAll' })
    sep()
  }
  if (!params.isEditable) {
    items.push({ label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() })
    items.push({ label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() })
    items.push({ label: 'Reload', click: () => wc.reload() })
    sep()
    if (!params.selectionText) items.push({ label: 'Select All', enabled: f.canSelectAll, role: 'selectAll' })
  }
  sep()
  items.push({ label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) })

  const menu = Menu.buildFromTemplate(items)
  if (ctx.ext) {
    const extItems = ctx.ext.getContextMenuItems(wc, params)
    if (extItems.length) {
      menu.append(new MenuItem({ type: 'separator' }))
      for (const i of extItems) menu.append(i)
    }
  }
  menu.popup({ window: ctx.win })
}

function showTabMenu(ctx, id) {
  const tab = ctx.tabs.get(id)
  if (!tab) return
  const i = ctx.tabs.list.indexOf(tab)
  Menu.buildFromTemplate([
    { label: 'Reload', click: () => tab.wc.reload() },
    { label: 'Duplicate', click: () => ctx.tabs.duplicate(id) },
    { label: tab.muted ? 'Unmute Tab' : 'Mute Tab', click: () => ctx.tabs.toggleMute(id) },
    { type: 'separator' },
    { label: 'Close Other Tabs', enabled: ctx.tabs.list.length > 1, click: () => ctx.tabs.closeOthers(id) },
    { label: 'Close Tabs to the Right', enabled: i < ctx.tabs.list.length - 1, click: () => ctx.tabs.closeRight(id) },
    { type: 'separator' },
    { label: 'Close', click: () => ctx.tabs.close(id) },
  ]).popup({ window: ctx.win })
}

module.exports = { showPageMenu, showTabMenu }
