# Stage — architecture and UI contract

Stage is a minimal Chromium (Electron) browser for presenting. The page fills the whole window. The tab bar stays hidden until the cursor reaches the top edge of the window, then slides in over the page.

This file is the contract between the **main process** (`src/main/`, `src/preload/`) and the **UI renderer** (`src/ui/`). Both sides build against it. Change it here first if it has to change.

## Layout

```
src/shared/contract.ts      the typed interface below, imported by main, preload and UI
src/main/main.ts            entry: app lifecycle, window, wiring
src/main/*.ts               tabs, extensions, menu, persistence, url resolution (main side owns the split)
src/preload/ui-preload.ts   exposes window.stage (below) to the UI renderer
src/ui/index.html           the UI window: tab bar, traffic lights, omnibox
src/ui/styles.css
src/ui/app.ts
src/ui/mock.ts              fake window.stage so the UI renders in a plain browser (preview/screenshots)
src/ui/newtab.html          the page a new, empty tab shows (self-contained, no window.stage)
src/bin/stage.ts            terminal launcher, the npm `bin` (see "Terminal launch")
scripts/ui-preview.mts      screenshots the UI in mock mode with headless Chrome
scripts/install-cli.sh      symlinks dist/bin/stage.js into ~/.local/bin
```

`npm run build` compiles `src/` to `dist/` with `tsc` and copies the HTML and CSS alongside. The UI files and `src/preload/extension-compat.ts` compile as classic scripts, not modules: the UI page's CSP allows only `'self'` scripts, and sandboxed preloads have no `exports`.

## Windows and views

A presenter usually shares just the Stage window. The audience must see the page and nothing else: no tab bar, no omnibox, no traffic lights. So Stage uses two windows.

- **The page window**: one `BaseWindow` (macOS `titleBarStyle: 'hidden'`, native traffic lights always hidden). It holds only the tabs. Each tab is a `WebContentsView` on the persistent session `persist:stage`, and tab views always fill the whole content area, pinned or not.
- **The UI window** (`src/main/ui-window.ts`): a frameless, transparent, shadowless child window of the page window (`parent: win`). It is not resizable, movable or focusable, and it's left out of the Window menu. Its one `WebContentsView` loads `dist/ui/index.html` with `dist/preload/ui-preload.js` (`contextIsolation: true`, `sandbox: false`).
- `setContentProtection(true)` (NSWindow `sharingType` none) is what keeps the UI out of a share. A window capture of the page window would otherwise include this child window. With protection set, ScreenCaptureKit and `screencapture` leave it out of both window and full-display captures (checked on macOS 26). Protection is per window, which is why the UI can't live in the page window.
- The child window moves with its parent natively, so it can't lag behind during a drag. Main keeps its size and visibility in step with the parent's resize, full screen, minimize, restore, show and hide. It's destroyed when the parent closes.
- It is a child window, not a `panel`: a panel would float over other apps and show on every Space.

### UI window bounds (main process sets these)

Relative to the page window's content area (`W × H`), at the same screen origin.

| State | UI window |
| --- | --- |
| bar hidden, no overlay | hidden |
| bar visible, no overlay, not pinned | `{ x: 0, y: 0, width: W, height: BAR_HEIGHT + 20 }`: the extra 20 px is transparent room for the capsule's shadow, and the mouse goes through it to the page |
| bar visible, pinned | `{ x: 0, y: 0, width: W, height: BAR_HEIGHT }`: the bar floats over the top of the page, with a shadow that fits in the strip |
| overlay open (omnibox) | full content area `{ 0, 0, W, H }`, focusable and focused |

`BAR_HEIGHT` is **52** px and is sent in the state (`barHeight`). The UI lays the bar out inside that strip.

### Mouse and keyboard

- The UI window takes the mouse only over the strip (`y < BAR_HEIGHT`) or while the omnibox is open. Everywhere else it ignores the mouse (`setIgnoreMouseEvents(true, { forward: true })`), so clicks go to the page. Main switches this from the polled cursor (below). A click that lands in the shadow room before the next poll reaches the UI, which passes it on with `passClick`.
- The UI window can't take keyboard focus, so clicking the bar leaves focus on the page. Opening the omnibox makes it focusable and focuses it. Closing the omnibox gives focus back to the page window and the active tab.
- App menu accelerators (Cmd+L, Cmd+T, Cmd+1–9, ...) work whichever of the two windows is key.

### Showing and hiding

- Main polls the cursor (~60 ms). When the window is visible and the cursor is inside the window horizontally and within **6 px** of the top of the content area, the bar is revealed.
- The bar hides once the cursor has been below `BAR_HEIGHT + 24` px for **350 ms**, unless: the bar is pinned, an overlay is open, the UI reports hover (`setBarHover(true)`), or an extension popup is open.
- Reveal order: main pushes `bar.visible = true`, then shows the UI window. The UI animates in.
- Hide order: main pushes `bar.visible = false`; the UI plays its exit animation (≤ 160 ms); main hides the UI window 180 ms later if the bar is still hidden.
- Traffic lights: the UI draws close, minimize and green buttons (12 px, `#ff5f57` / `#febc2e` / `#28c840`, glyphs on hover) in the leftmost **84 px** of the strip, and they show and hide with the bar. They call `windowAction`: `close`, `minimize` (disabled in full screen), `fullscreen` for green, `zoom` for Option-green.
- Window dragging: `-webkit-app-region` would drag the child window, not the page window, so it isn't used. A pointerdown on the strip's background (not a tab, button or extension icon) calls `startWindowDrag()`. Main then moves the page window with the cursor until `endWindowDrag()`, sent on the window's `pointerup` or `pointercancel`. Main also stops after 60 s, in case the mouse-up is lost. A double-click there calls `windowAction('double-click')`, which zooms or minimizes per the macOS "double-click a window's title bar" setting.

## `window.stage` (exposed by the preload)

All methods are fire-and-forget unless they return a Promise. The source of truth is `StageApi` in `src/shared/contract.ts`; this sketch mirrors it.

```ts
type Tab = {
  id: number            // stable tab id (the tab's webContents id)
  title: string
  url: string           // '' for the new-tab page
  favicon: string | null
  loading: boolean
  audible: boolean
  muted: boolean
}

type State = {
  tabs: Tab[]                    // display order
  activeTabId: number | null
  canGoBack: boolean             // for the active tab
  canGoForward: boolean
  zoomFactor: number             // active tab, 1 = 100%
  bar: { visible: boolean; pinned: boolean }
  hideExtensionIcons: boolean    // Extensions menu → Hide Icons in Tab Bar (saved in prefs.json)
  extensionActions: number       // installed extensions with a toolbar button; 0 hides the divider
  overlay: null | { type: 'omnibox'; mode: 'new' | 'edit'; initial: string; nonce: number } // nonce changes on every open
  barHeight: number              // 52
  fullscreen: boolean
}

type Suggestion = {
  kind: 'url' | 'search' | 'tab' | 'history'
  title: string
  url: string                    // for 'search', the search URL
  tabId?: number                 // for 'tab'
  favicon?: string | null
}

interface Stage {
  getState(): Promise<State>
  onState(cb: (s: State) => void): () => void   // returns unsubscribe; fires on every change

  // tabs
  activateTab(id: number): void
  closeTab(id: number): void
  moveTab(id: number, toIndex: number): void    // drag-to-reorder
  showTabMenu(id: number): void                 // native context menu (reload, duplicate, close others, ...)

  // omnibox
  openOmnibox(mode: 'new' | 'edit'): void       // '+' button uses 'new'
  closeOverlay(): void                          // Esc / backdrop click
  suggest(query: string): Promise<Suggestion[]> // max 8, best first
  submitOmnibox(input: string, opts: { newTab: boolean }): void
    // main resolves URL vs search, navigates (or opens a tab), closes the overlay, refocuses the page
    // for a 'tab' suggestion the UI calls activateTab(tabId) + closeOverlay() instead

  // navigation (active tab)
  back(): void
  forward(): void
  reload(): void

  // bar
  setBarHover(hovering: boolean): void          // mouseenter/mouseleave on the bar itself
  passClick(x: number, y: number, button: number, clickCount: number): void
    // a pointerdown in the transparent band below the strip: main hides the bar at once and
    // sends the click to the active tab at the same window coordinates
  startWindowDrag(): void                       // pointerdown on the strip background
  endWindowDrag(): void
  windowAction(action: 'close' | 'minimize' | 'zoom' | 'fullscreen' | 'double-click'): void
}
```

### Omnibox behavior

- Mode `new` (Cmd+T, `+` button): Enter opens a new tab. Mode `edit` (Cmd+L): Enter navigates the active tab; Cmd+Enter opens a new tab instead. `initial` is pre-filled and fully selected.
- Up/Down move through suggestions, Enter picks the highlighted one (default: the first), Esc or a backdrop click closes.
- The UI calls `suggest()` on every input change (debounce ~60 ms) and ignores stale responses.

### Extensions in the bar

The preload injects the `<browser-action-list>` custom element from `electron-chrome-extensions/browser-action`. The UI places one in the bar's right side:

```html
<browser-action-list partition="persist:stage" alignment="bottom right"></browser-action-list>
```

Main calls `ElectronChromeExtensions.handleCRXProtocol()` on the UI window's session so the icons load. In mock mode the element renders nothing, so the mock should place a stand-in icon.

## Terminal launch (no packaging, no signing)

Stage runs as an npm package. `electron` is a regular dependency, so installing the package downloads Chromium, and the launcher runs it directly. Nothing gets bundled into an `.app`, so there is nothing to sign or notarize. The package is `stage-browser` and the command is `stage`:

```
npx stage-browser https://andrewckor.com    # anyone, no install
npm i -g stage-browser && stage             # anyone, installed
npm run cli:install && stage                # from a clone of this repo
```

- `src/bin/stage.ts` (compiled to `dist/bin/stage.js`: `#!/usr/bin/env node`, CommonJS, no dependencies beyond `electron`) gets the binary path from `require('electron')` and spawns `<electron> <package root> <args>` with `detached: true, stdio: 'ignore'`, then `unref()`s and exits, so the terminal prompt comes straight back. With `--fg` it inherits stdio and waits.
- `npm run cli:install` (`scripts/install-cli.sh`) runs `npm install` if `node_modules` is missing, builds, then symlinks `dist/bin/stage.js` to `~/.local/bin/stage`. The launcher must resolve its real path through that symlink.
- **One profile for every install path.** Main sets `app.setName('Stage')` and `app.setPath('userData', <appData>/Stage)` before `ready`. A clone, a global install, and an npx run then share the same cookies, logins, session, and installed extensions.

```
stage                        open Stage (restores the last session)
stage <url|domain|words> …   open each argument as a tab; bare words become a Google search
stage --size 1280x720 …      set the window's content size (for a consistent share)
stage --pin                  start with the tab bar pinned
stage --fresh                skip the saved session
stage --fg                   run in the foreground with logs in the terminal
stage --help
```

- A single-instance lock means a second `stage …` call forwards its arguments to the running window (`second-instance` event) and brings it to the front instead of starting another copy.
- macOS takes the menu-bar app name, Dock label and icon from the app bundle, so the launcher runs a renamed copy of Electron's bundle: `~/Library/Application Support/Stage/Runtime/electron-<version>-r<n>/Stage.app`. It's an APFS clone with `CFBundleName`/`CFBundleDisplayName` set to Stage, `CFBundleIdentifier` set to `app.stage.browser`, `build/icon.icns` as its icon, re-signed ad-hoc. It's rebuilt when the Electron version or `RUNTIME_REVISION` in `src/bin/stage.ts` changes. Other runtimes are removed at launch unless a process is running from them. `STAGE_PLAIN_ELECTRON=1` skips it.

## Keyboard shortcuts (main process, app menu accelerators)

| Shortcut | Action |
| --- | --- |
| Cmd+T | omnibox, mode `new` |
| Cmd+L | omnibox, mode `edit` |
| Cmd+W | close tab (closing the last tab leaves a new-tab page; it never quits) |
| Cmd+Shift+T | reopen closed tab |
| Cmd+1 … Cmd+8, Cmd+9 | go to tab N, last tab |
| Ctrl+Tab, Ctrl+Shift+Tab, Cmd+Shift+] [, Cmd+Opt+→ ← | next / previous tab |
| Cmd+R, Cmd+Shift+R | reload, hard reload |
| Cmd+[ / Cmd+] | back / forward |
| Cmd+= / Cmd+- / Cmd+0 | zoom in / out / reset |
| Cmd+Shift+B | pin / unpin the tab bar |
| Cmd+Ctrl+F | full screen |
| Cmd+Opt+I | developer tools for the active tab |
| Cmd+Shift+O | open the current page in Google Chrome |
