// The interface between the main process and the UI window. See docs/CONTRACT.md.

export type TabId = number

export interface TabSnapshot {
  id: TabId
  title: string
  url: string
  favicon: string | null
  loading: boolean
  audible: boolean
  muted: boolean
}

export type OmniboxMode = 'new' | 'edit'

export interface OmniboxOverlay {
  type: 'omnibox'
  mode: OmniboxMode
  initial: string
  nonce: number
}

export type Overlay = OmniboxOverlay

// Where the tab bar sits: a capsule across the top, or a vertical sidebar on one side.
export type TabLayout = 'top' | 'left' | 'right'

export const TAB_LAYOUTS: readonly TabLayout[] = ['top', 'left', 'right']

export interface BarState {
  visible: boolean
  pinned: boolean
}

export interface StageState {
  tabs: TabSnapshot[]
  activeTabId: TabId | null
  canGoBack: boolean
  canGoForward: boolean
  zoomFactor: number
  bar: BarState
  hideExtensionIcons: boolean
  extensionActions: number
  overlay: Overlay | null
  barHeight: number
  tabLayout: TabLayout
  sidebarWidth: number
  fullscreen: boolean
}

interface SuggestionBase {
  title: string
  url: string
  favicon: string | null
}

export type Suggestion = (SuggestionBase & { kind: 'search' | 'url' | 'history' }) | (SuggestionBase & { kind: 'tab'; tabId: TabId })

export interface SubmitOptions {
  newTab: boolean
}

// The bar's traffic lights and a title-bar double-click.
export type WindowAction = 'close' | 'minimize' | 'zoom' | 'fullscreen' | 'double-click'

export interface UiCommands {
  activateTab: [id: TabId]
  closeTab: [id: TabId]
  moveTab: [id: TabId, toIndex: number]
  showTabMenu: [id: TabId]
  openOmnibox: [mode: OmniboxMode]
  closeOverlay: []
  submitOmnibox: [input: string, options: SubmitOptions]
  back: []
  forward: []
  reload: []
  setBarHover: [hovering: boolean]
  passClick: [x: number, y: number, button: number, clickCount: number]
  startWindowDrag: []
  endWindowDrag: []
  windowAction: [action: WindowAction]
}

export interface UiQueries {
  getState: { args: []; result: StageState }
  suggest: { args: [query: string]; result: Suggestion[] }
}

export type StageApi = { [K in keyof UiCommands]: (...args: UiCommands[K]) => void } & {
  [K in keyof UiQueries]: (...args: UiQueries[K]['args']) => Promise<UiQueries[K]['result']>
} & {
  onState(listener: (state: StageState) => void): () => void
}

export const channel = <K extends keyof UiCommands | keyof UiQueries | 'state'>(name: K) => `stage:${name}` as const
