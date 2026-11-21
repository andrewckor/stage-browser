import { screen } from 'electron'
import type { OmniboxMode } from '../shared/contract'
import type { Ctx } from './context'
import { BAR_HEIGHT } from './window'

const POLL_MS = 60
const REVEAL_PX = 6
const HIDE_BELOW = BAR_HEIGHT + 24
const HIDE_DELAY = 350
const VIEW_HIDE_DELAY = 180

// Shows the tab bar when the cursor touches the top edge and hides it once the cursor leaves.
export class Reveal {
  private readonly ctx: Ctx
  private timer: ReturnType<typeof setInterval> | undefined
  private viewTimer: ReturnType<typeof setTimeout> | undefined
  private awaySince: number | null = null

  constructor(ctx: Ctx) {
    this.ctx = ctx
    const sync = () => this.syncPolling()
    ctx.win.on('show', sync)
    ctx.win.on('hide', sync)
    ctx.win.on('minimize', sync)
    ctx.win.on('restore', sync)
  }

  private get live(): boolean {
    return !this.ctx.quitting && !this.ctx.win.isDestroyed()
  }

  syncPolling(): void {
    const { win } = this.ctx
    const should = this.live && win.isVisible() && !win.isMinimized()
    if (should && !this.timer) this.timer = setInterval(() => this.tick(), POLL_MS)
    else if (!should && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private keepOpen(): boolean {
    const { bar, overlay, popupOpen } = this.ctx
    return bar.pinned || overlay !== null || bar.hover || popupOpen
  }

  private tick(): void {
    const { ctx } = this
    if (!this.live) return this.stop()
    const pt = screen.getCursorScreenPoint()
    const b = ctx.win.getContentBounds()
    const insideX = pt.x >= b.x && pt.x < b.x + b.width
    const dy = pt.y - b.y
    this.syncPointer(insideX && dy >= 0 && dy < BAR_HEIGHT)
    if (insideX && dy >= 0 && dy <= REVEAL_PX) {
      this.awaySince = null
      return this.show()
    }
    if (!ctx.bar.visible) return
    const away = !insideX || dy < 0 || dy > HIDE_BELOW
    if (this.keepOpen() || !away) {
      this.awaySince = null
      return
    }
    if (this.awaySince === null) this.awaySince = Date.now()
    else if (Date.now() - this.awaySince >= HIDE_DELAY) this.hide()
  }

  // The UI window takes the mouse over the strip and lets it through to the page below it. The
  // window can't tell the two apart itself, so this follows the polled cursor; a click that lands
  // in the shadow room before the next tick is passed on by the UI (passClick).
  private syncPointer(overStrip: boolean): void {
    const { ctx } = this
    ctx.ui.setInteractive(ctx.overlay !== null || ctx.drag.active || overStrip)
  }

  private cancelViewHide(): void {
    clearTimeout(this.viewTimer)
    this.viewTimer = undefined
  }

  show(): void {
    const { ctx } = this
    if (!this.live) return
    this.cancelViewHide()
    if (ctx.bar.visible && ctx.ui.shown) return
    ctx.bar.visible = true
    ctx.layout()
    ctx.flush() // state first, then the window
    ctx.ui.setShown(true)
  }

  hide(): void {
    const { ctx } = this
    if (!this.live || !ctx.bar.visible) return
    this.awaySince = null
    ctx.bar.visible = false
    ctx.flush()
    this.cancelViewHide()
    this.viewTimer = setTimeout(() => {
      this.viewTimer = undefined
      if (this.live && !ctx.bar.visible && !ctx.overlay) this.hideWindow()
    }, VIEW_HIDE_DELAY)
  }

  // Hide without the exit animation, so the next mouse events go straight to the page.
  hideNow(): void {
    const { ctx } = this
    if (!this.live || ctx.overlay || ctx.bar.pinned) return
    this.hide()
    this.cancelViewHide()
    this.hideWindow()
  }

  private hideWindow(): void {
    const { ctx } = this
    ctx.ui.setShown(false)
    // No mouseleave arrives once the window is gone.
    ctx.bar.hover = false
  }

  setPinned(pinned: boolean): void {
    const { ctx } = this
    if (ctx.bar.pinned === pinned) return
    ctx.bar.pinned = pinned
    if (pinned) this.show()
    ctx.layout()
    ctx.push()
    ctx.saveSession()
    ctx.rebuildMenu()
  }

  setHover(hovering: boolean): void {
    this.ctx.bar.hover = hovering
    if (hovering) this.awaySince = null
  }

  setPopupOpen(open: boolean): void {
    this.ctx.popupOpen = open
    this.awaySince = null
  }

  openOverlay(mode: OmniboxMode, initial: string): void {
    const { ctx } = this
    if (!this.live) return
    ctx.overlay = { type: 'omnibox', mode, initial, nonce: Date.now() }
    this.show()
    ctx.layout()
    ctx.flush()
    ctx.ui.setShown(true)
    ctx.ui.setInteractive(true)
    ctx.ui.focus()
  }

  closeOverlay(refocus = true): void {
    const { ctx } = this
    if (!ctx.overlay) return
    ctx.overlay = null
    ctx.layout()
    ctx.flush()
    ctx.ui.release()
    this.syncPointer(false)
    if (refocus) ctx.tabs.focusActive()
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
    this.cancelViewHide()
  }
}
