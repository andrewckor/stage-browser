import type { BaseWindow, Rectangle, Session } from 'electron'
import type { ElectronChromeExtensions } from 'electron-chrome-extensions'
import type { Overlay, StageState, TabLayout } from '../shared/contract'
import type { Reveal } from './reveal'
import type { Prefs } from './store'
import type { Tabs } from './tabs'
import type { UiWindow } from './ui-window'
import type { Updates } from './updates'
import type { WindowDrag } from './window'

export interface BarFlags {
  visible: boolean
  pinned: boolean
  hover: boolean
}

// What the main-process modules share. Implemented by Stage in main.ts.
export interface Ctx {
  readonly session: Session
  readonly win: BaseWindow
  readonly ui: UiWindow
  readonly drag: WindowDrag
  readonly tabs: Tabs
  readonly reveal: Reveal
  readonly ext: ElectronChromeExtensions
  readonly bar: BarFlags
  readonly prefs: Prefs
  readonly updates: Updates
  overlay: Overlay | null
  popupOpen: boolean
  quitting: boolean
  holdQuit: boolean
  tabBounds(): Rectangle
  layout(): void
  push(): void
  flush(): void
  saveSession(): void
  rebuildMenu(): void
  getState(): StageState
  setHideExtensionIcons(hide: boolean): void
  setTabLayout(layout: TabLayout): void
  setCheckForUpdates(check: boolean): void
}
