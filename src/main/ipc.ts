import { ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { channel, type UiCommands, type UiQueries } from '../shared/contract'
import type { Ctx } from './context'
import { showTabMenu } from './context-menu'
import { suggest } from './suggest'
import { resolveInput } from './url'

const BUTTONS = ['left', 'middle', 'right'] as const
const DRAG_TICK_MS = 8
const DRAG_MAX_MS = 60_000

type Commands = { [K in keyof UiCommands]: (...args: UiCommands[K]) => void }
type Queries = { [K in keyof UiQueries]: (...args: UiQueries[K]['args']) => UiQueries[K]['result'] }

// Wires the UI view's IPC to the main process. Returns a function that stops a window drag.
export function setupIpc(ctx: Ctx): () => void {
  const { tabs, reveal, win } = ctx
  const fromUI = (e: IpcMainEvent | IpcMainInvokeEvent) => e.sender === ctx.uiView.webContents

  let drag: ReturnType<typeof setInterval> | undefined
  const endDrag = () => {
    clearInterval(drag)
    drag = undefined
  }

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
    // A click in the transparent band under the floating bar: hide the bar and give it to the page.
    passClick: (x, y, button, clickCount) => {
      const tab = tabs.active
      if (!tab || tab.wc.isDestroyed() || !Number.isFinite(x) || !Number.isFinite(y)) return
      reveal.hideNow()
      const ev = {
        x: Math.round(x),
        y: Math.round(y - ctx.tabBounds().y),
        button: BUTTONS[button] ?? 'left',
        clickCount: Math.min(3, Math.max(1, clickCount || 1)),
      }
      tab.wc.focus()
      tab.wc.sendInputEvent({ type: 'mouseDown', ...ev })
      tab.wc.sendInputEvent({ type: 'mouseUp', ...ev })
    },
    // Fallback window drag: follow the cursor while the UI holds the mouse down.
    startWindowDrag: () => {
      if (drag || win.isFullScreen()) return
      const p0 = screen.getCursorScreenPoint()
      const [x0 = 0, y0 = 0] = win.getPosition()
      const started = Date.now()
      drag = setInterval(() => {
        if (Date.now() - started > DRAG_MAX_MS || win.isDestroyed()) return endDrag()
        const p = screen.getCursorScreenPoint()
        win.setPosition(x0 + p.x - p0.x, y0 + p.y - p0.y)
      }, DRAG_TICK_MS)
    },
    endWindowDrag: endDrag,
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
  return endDrag
}
