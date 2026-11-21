import { BaseWindow, WebContentsView, session, type Rectangle } from 'electron'
import { join } from 'node:path'

// The tab bar, omnibox and traffic lights live in this borderless child window over the page
// window. Content protection is per window, so keeping them out of the page window is what lets
// the page stay capturable while they don't.
export class UiWindow {
  readonly win: BaseWindow
  readonly view: WebContentsView
  private readonly parent: BaseWindow
  private wanted = false
  private interactive = false
  // Relative to the parent's content area.
  private rect: Rectangle = { x: 0, y: 0, width: 0, height: 0 }

  constructor(parent: BaseWindow) {
    this.parent = parent
    // A child window rather than a panel: it moves with the parent natively (no lag during a drag)
    // and stays on the parent's Space, where a panel would float over every app and Space.
    this.win = new BaseWindow({
      parent,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Clicks on the bar shouldn't pull keyboard focus off the page. focus() allows it while the
      // omnibox is open.
      focusable: false,
    })
    this.win.excludedFromShownWindowsMenu = true
    // This is what hides the UI from a share. A capture of the page window includes its child
    // windows, and so does a full-display capture, but both skip a window whose sharingType is
    // none. Checked with ScreenCaptureKit and screencapture on macOS 26.
    this.win.setContentProtection(true)
    this.win.setIgnoreMouseEvents(true, { forward: true })

    this.view = new WebContentsView({
      webPreferences: {
        // Non-persistent: it only serves the local UI. Extension icons load over crx://.
        session: session.fromPartition('stage-ui'),
        preload: join(__dirname, '..', 'preload', 'ui-preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    })
    this.view.setBackgroundColor('#00000000')
    this.win.contentView.addChildView(this.view)

    const sync = () => this.sync()
    parent
      .on('move', sync)
      .on('resize', sync)
      .on('show', sync)
      .on('hide', sync)
      .on('minimize', sync)
      .on('restore', sync)
      .on('enter-full-screen', sync)
      .on('leave-full-screen', sync)
      .once('closed', () => this.destroy())
  }

  get shown(): boolean {
    return this.wanted
  }

  private get live(): boolean {
    return !this.win.isDestroyed() && !this.parent.isDestroyed()
  }

  setShown(shown: boolean): void {
    this.wanted = shown
    this.sync()
  }

  setBounds(rect: Rectangle): void {
    this.rect = rect
    this.sync()
  }

  // Off for the transparent shadow room under the floating bar, so the page gets those clicks.
  setInteractive(on: boolean): void {
    if (on === this.interactive || !this.live) return
    this.interactive = on
    // forward: mouse moves still reach the UI, so hover styles and mouseleave stay right.
    this.win.setIgnoreMouseEvents(!on, { forward: true })
  }

  // Keyboard focus for the omnibox.
  focus(): void {
    if (!this.live) return
    this.win.setFocusable(true)
    this.win.focus()
    this.view.webContents.focus()
  }

  // Hands keyboard focus back to the page window.
  release(): void {
    if (!this.live) return
    const had = this.win.isFocused()
    this.win.setFocusable(false)
    if (had) this.parent.focus()
  }

  // Shown only with its parent, at the parent's content origin. Child windows follow the parent on
  // their own when it moves; this keeps size and visibility in step.
  private sync(): void {
    if (!this.live) return
    const { parent, win, rect } = this
    const show = this.wanted && parent.isVisible() && !parent.isMinimized() && rect.width > 0 && rect.height > 0
    if (!show) {
      if (win.isVisible()) win.hide()
      return
    }
    const c = parent.getContentBounds()
    win.setBounds({ x: c.x + rect.x, y: c.y + rect.y, width: rect.width, height: rect.height })
    this.view.setBounds({ x: 0, y: 0, width: rect.width, height: rect.height })
    if (!win.isVisible()) win.showInactive()
  }

  private destroy(): void {
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close()
    if (!this.win.isDestroyed()) this.win.destroy()
  }
}
