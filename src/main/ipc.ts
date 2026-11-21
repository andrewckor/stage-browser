import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { channel, type UiCommands, type UiQueries } from '../shared/contract'
import type { Ctx } from './context'
import { showTabMenu } from './context-menu'
import { suggest } from './suggest'
import { resolveInput } from './url'
import { windowAction } from './window'

const BUTTONS = ['left', 'middle', 'right'] as const

type Commands = { [K in keyof UiCommands]: (...args: UiCommands[K]) => void }
type Queries = { [K in keyof UiQueries]: (...args: UiQueries[K]['args']) => UiQueries[K]['result'] }

// Wires the UI window's IPC to the main process.
export function setupIpc(ctx: Ctx): void {
  const { tabs, reveal, win, drag } = ctx
  const fromUI = (e: IpcMainEvent | IpcMainInvokeEvent) => e.sender === ctx.ui.view.webContents

  const queries: Queries = {
    getState: () => ctx.getState(),
    suggest: (query) => suggest(tabs.list, query),
  }

  const commands: Commands = {
    activateTab: (id) => tabs.activate(id),
    closeTab: (id) => tabs.close(id),
    moveTab: (id, toIndex) => tabs.move(id, toIndex),
    showTabMenu: (id) => showTabMenu(ctx, id),
    openOmnibox: (mode) => {
      const edit = mode === 'edit'
      reveal.openOverlay(edit ? 'edit' : 'new', edit ? (tabs.active?.url ?? '') : '')
    },
    closeOverlay: () => reveal.closeOverlay(),
    submitOmnibox: (input, options) => {
      const url = resolveInput(input)
      reveal.closeOverlay(false)
      if (url) tabs.open(url, { newTab: options.newTab })
      tabs.focusActive()
    },
    back: () => tabs.active?.wc.navigationHistory.goBack(),
    forward: () => tabs.active?.wc.navigationHistory.goForward(),
    reload: () => tabs.active?.wc.reload(),
    setBarHover: (hovering) => reveal.setHover(hovering),
    // A click the UI window caught in the transparent band under the floating bar, before it
    // started letting the mouse through there: hide the bar and give the click to the page.
    passClick: (x, y, button, clickCount) => {
      const tab = tabs.active
      if (!tab || tab.wc.isDestroyed() || !Number.isFinite(x) || !Number.isFinite(y)) return
      reveal.hideNow()
      const ev = {
        x: Math.round(x),
        y: Math.round(y),
        button: BUTTONS[button] ?? 'left',
        clickCount: Math.min(3, Math.max(1, clickCount || 1)),
      }
      win.focus()
      tab.wc.focus()
      tab.wc.sendInputEvent({ type: 'mouseDown', ...ev })
      tab.wc.sendInputEvent({ type: 'mouseUp', ...ev })
    },
    startWindowDrag: () => drag.start(),
    endWindowDrag: () => drag.end(),
    windowAction: (action) => windowAction(win, action),
  }

  for (const name of Object.keys(queries) as (keyof Queries)[]) {
    const fn = queries[name] as (...args: unknown[]) => unknown
    ipcMain.handle(channel(name), (e, ...args: unknown[]) => (fromUI(e) ? fn(...args) : null))
  }
  for (const name of Object.keys(commands) as (keyof Commands)[]) {
    const fn = commands[name] as (...args: unknown[]) => void
    ipcMain.on(channel(name), (e, ...args: unknown[]) => {
      if (fromUI(e)) fn(...args)
    })
  }
}
