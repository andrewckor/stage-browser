# Stage — architecture and UI contract

Stage is a minimal Chromium (Electron) browser for presenting. The page fills the whole window. The tab bar stays hidden until the cursor reaches the top edge of the window, then slides in over the page.

This file is the contract between the **main process** (`src/main/`, `src/preload/`) and the **UI renderer** (`src/ui/`). Both sides build against it. Change it here first if it has to change.

## Layout

```
src/main/main.js          entry: app lifecycle, window, wiring
src/main/*.js             tabs, extensions, menu, persistence, url resolution (main side owns the split)
src/preload/ui-preload.js exposes window.stage (below) to the UI renderer
src/ui/index.html         the overlay UI: tab bar + omnibox
src/ui/styles.css
src/ui/app.js
src/ui/mock.js            fake window.stage so the UI renders in a plain browser (preview/screenshots)
src/ui/newtab.html        the page a new, empty tab shows (self-contained, no window.stage)
scripts/ui-preview.js     screenshots the UI in mock mode with headless Chrome
bin/stage.js              terminal launcher, the npm `bin` (see "Terminal launch")
scripts/install-cli.sh    symlinks bin/stage into ~/.local/bin
```

## Window and views

- One `BaseWindow` (macOS `titleBarStyle: 'hidden'`, traffic lights hidden until the bar shows).
- Each tab is a `WebContentsView` on the persistent session `persist:stage`. Tab views fill the whole content area, unless the bar is **pinned** (then they start at `y = BAR_HEIGHT`).
- The UI is one more `WebContentsView` with a transparent background, stacked on top of the tab views. It loads `src/ui/index.html` with `src/preload/ui-preload.js` (`contextIsolation: true`, `sandbox: false`).

### UI view bounds (main process sets these)

| State | UI view |
| --- | --- |
| bar hidden, no overlay | not visible |
| bar visible, no overlay, not pinned | `{ x: 0, y: 0, width: W, height: BAR_HEIGHT + 20 }`: the extra 20 px is transparent room for the capsule's shadow; the UI passes clicks there to the page (`passClick`) |
| bar visible, pinned | `{ x: 0, y: 0, width: W, height: BAR_HEIGHT }`: the page starts at `BAR_HEIGHT`, so the UI uses a shadow that fits in the strip |
| overlay open (omnibox) | full content area `{ 0, 0, W, H }`, focused |

`BAR_HEIGHT` is **52** px and is sent in the state (`barHeight`). The UI lays the bar out inside that strip.

### Showing and hiding

- Main polls the cursor (~60 ms). When the window is visible and the cursor is inside the window horizontally and within **6 px** of the top of the content area, the bar is revealed.
- The bar hides once the cursor has been below `BAR_HEIGHT + 24` px for **350 ms**, unless: the bar is pinned, an overlay is open, the UI reports hover (`setBarHover(true)`), or an extension popup is open.
- Reveal order: main pushes `bar.visible = true`, then makes the view visible. The UI animates in.
- Hide order: main pushes `bar.visible = false`; the UI plays its exit animation (≤ 160 ms); main hides the view 180 ms later if the bar is still hidden.
- The macOS traffic lights show and hide with the bar. They sit at the left of the strip, so the UI keeps the leftmost **84 px** of the strip free of controls.
- Window dragging: the bar's empty background uses `-webkit-app-region: drag`; every control uses `no-drag`.

## `window.stage` (exposed by the preload)

All methods are fire-and-forget unless they return a Promise.

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

Main calls `ElectronChromeExtensions.handleCRXProtocol()` on the UI view's session so the icons load. In mock mode the element renders nothing, so the mock should place a stand-in icon.

## Terminal launch (no packaging, no signing)

Stage runs as an npm package. `electron` is a regular dependency, so installing the package downloads Chromium, and the launcher runs it directly. Nothing gets bundled into an `.app`, so there is nothing to sign or notarize. The package is `stage-browser` and the command is `stage`:

```
npx stage-browser https://example.com      # anyone, no install
npm i -g stage-browser && stage            # anyone, installed
npm run cli:install && stage               # from a clone of this repo
```

- `bin/stage.js` (`#!/usr/bin/env node`, CommonJS, no dependencies beyond `electron`) gets the binary path from `require('electron')` and spawns `<electron> <package root> <args>` with `detached: true, stdio: 'ignore'`, then `unref()`s and exits, so the terminal prompt comes straight back. With `--fg` it inherits stdio and waits.
- `npm run cli:install` (`scripts/install-cli.sh`) runs `npm install` if `node_modules` is missing, then symlinks `bin/stage.js` to `~/.local/bin/stage`. The launcher must resolve its real path through that symlink.
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
- macOS takes the menu-bar app name, Dock label and icon from the app bundle, so the launcher runs a renamed copy of Electron's bundle: `~/Library/Application Support/Stage/Runtime/electron-<version>-r<n>/Stage.app`. It's an APFS clone with `CFBundleName`/`CFBundleDisplayName` set to Stage, `CFBundleIdentifier` set to `app.stage.browser`, `build/icon.icns` as its icon, re-signed ad-hoc. It's rebuilt when the Electron version or `RUNTIME_REVISION` in `bin/stage.js` changes. `STAGE_PLAIN_ELECTRON=1` skips it.

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
