import { Menu, MenuItem, clipboard, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron'
import type { TabId } from '../shared/contract'
import type { Ctx } from './context'
import type { Tab } from './tabs'

export function showPageMenu(ctx: Ctx, tab: Tab, params: ContextMenuParams): void {
  const { wc } = tab
  const nav = wc.navigationHistory
  const f = params.editFlags
  const items: MenuItemConstructorOptions[] = []
  const sep = () => {
    if (items.length && items.at(-1)?.type !== 'separator') items.push({ type: 'separator' })
  }

  if (params.linkURL) {
    items.push({ label: 'Open Link in New Tab', click: () => void ctx.tabs.create({ url: params.linkURL, activate: false, index: ctx.tabs.insertIndexAfterActive() }) })
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
  const extItems = ctx.ext.getContextMenuItems(wc, params)
  if (extItems.length) {
    menu.append(new MenuItem({ type: 'separator' }))
    for (const item of extItems) menu.append(item)
  }
  menu.popup({ window: ctx.win })
}

export function showTabMenu(ctx: Ctx, id: TabId): void {
  const { tabs } = ctx
  const tab = tabs.get(id)
  if (!tab) return
  const i = tabs.list.indexOf(tab)
  Menu.buildFromTemplate([
    { label: 'Reload', click: () => tab.wc.reload() },
    { label: 'Duplicate', click: () => tabs.duplicate(id) },
    { label: tab.muted ? 'Unmute Tab' : 'Mute Tab', click: () => tabs.toggleMute(id) },
    { type: 'separator' },
    { label: 'Close Other Tabs', enabled: tabs.list.length > 1, click: () => tabs.closeOthers(id) },
    { label: 'Close Tabs to the Right', enabled: i < tabs.list.length - 1, click: () => tabs.closeRight(id) },
    { type: 'separator' },
    { label: 'Close', click: () => tabs.close(id) },
  ]).popup({ window: ctx.win })
}
