# Stage — architecture and UI contract

Stage is a minimal Chromium (Electron) browser for presenting. The page fills the whole window. The tab bar stays hidden until the cursor reaches the top edge of the window, then slides in over the page.

This file is the contract between the **main process** (`src/main/`, `src/preload/`) and the **UI renderer** (`src/ui/`). Both sides build against it. Change it here first if it has to change.

## Layout

```
src/shared/contract.ts      the typed interface below, imported by main, preload and UI
src/main/main.ts            entry: app lifecycle, window, wiring
src/main/*.ts               tabs, extensions, menu, persistence, url resolution (main side owns the split)
src/main/updates.ts         the app's side of updates (see "Updates")
src/update/                 checks, verification and installs: plain Node, shared by launcher, app and helper
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
| overlay open (omnibox, update) | full content area `{ 0, 0, W, H }`, focusable and focused |

`BAR_HEIGHT` is **52** px and is sent in the state (`barHeight`). The UI lays the bar out inside that strip.

### Mouse and keyboard

- The UI window takes the mouse only over the strip (`y < BAR_HEIGHT`) or while an overlay is open. Everywhere else it ignores the mouse (`setIgnoreMouseEvents(true, { forward: true })`), so clicks go to the page. Main switches this from the polled cursor (below). A click that lands in the shadow room before the next poll reaches the UI, which passes it on with `passClick`.
- The UI window can't take keyboard focus, so clicking the bar leaves focus on the page. Opening an overlay makes it focusable and focuses it. Closing the overlay gives focus back to the page window and the active tab.
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
  overlay: null                  // nonce changes on every open
    | { type: 'omnibox'; mode: 'new' | 'edit'; initial: string; nonce: number }
    | { type: 'update'; nonce: number }
  update: {
    current: string
    available: string | null     // shows the Update button
    status: 'idle' | 'checking' | 'current' | 'working' | 'ready' | 'restarting' | 'error'
    step: null | 'download' | 'verify' | 'prepare' | 'runtime'
    percent: number | null       // null: indeterminate
    message: string | null
    warnings: string[]           // with 'ready': what a restart would end; empty means nothing seen
    canInstall: boolean          // false: only the command updates this install
    command: string
  }
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

  // updates: none takes an argument, so the UI can't choose a version, command or path
  openUpdate(): void                            // the Update button
  installUpdate(): void                         // ignored unless the update overlay is open
  cancelUpdate(): void                          // until Stage starts to restart
  copyUpdateCommand(): void
}
```

### Omnibox behavior

- Mode `new` (Cmd+T, `+` button): Enter opens a new tab. Mode `edit` (Cmd+L): Enter navigates the active tab; Cmd+Enter opens a new tab instead. `initial` is pre-filled and fully selected.
- Up/Down move through suggestions, Enter picks the highlighted one (default: the first), Esc or a backdrop click closes.
- The UI calls `suggest()` on every input change (debounce ~60 ms) and ignores stale responses.

### Update popover

- The Update button shows while `update.available` is set or an update is under way. It reads Restart when one is `ready`.
- It opens only from that button or the app menu. Nothing about updates reveals the bar, opens an overlay, makes a sound or posts a notification, because someone may be watching the screen.
- Closing it during a download doesn't cancel. The status becomes `ready` and waits: Stage restarts only from an open popover.
- Before it restarts, main looks for what a restart would end (`src/main/restart-warnings.ts`): downloads in progress, tabs playing sound, and tabs with a `beforeunload` handler, which is how a page asks to keep unsaved changes. If it finds any, the status stays `ready` with `warnings` set, the popover lists them, and the button reads Restart Anyway. A second click in that popover restarts. Reopening the popover clears them, so the next click looks again.
- Looking never runs the page's code. Handlers are listed through the DevTools protocol (`DOMDebugger.getEventListeners`), not called, and no event is sent. Only the top frame is looked at, and some pages always register a handler, so the copy says "may have unsaved changes". `stage update` and `stage --restart` don't warn: someone typed them on purpose.
- Copy is neutral. It doesn't assume the person is presenting.

### Extensions in the bar

The preload injects the `<browser-action-list>` custom element from `electron-chrome-extensions/browser-action`. The UI places one in the bar's right side:

```html
<browser-action-list partition="persist:stage" alignment="bottom right"></browser-action-list>
```

Main calls `ElectronChromeExtensions.handleCRXProtocol()` on the UI window's session so the icons load. In mock mode the element renders nothing, so the mock should place a stand-in icon.

## Terminal launch (no packaging, no signing)

Stage runs as an npm package and publishes no `.app`, so there is nothing to notarize. `electron` is a dev dependency only: a published install downloads the official zip pinned in `dist/runtime.json` on first launch, and a clone uses its own copy. The package is `stage-browser` and the command is `stage`:

```
npx stage-browser https://andrewckor.com    # anyone, no install
npm i -g stage-browser && stage             # anyone, installed
npm run cli:install && stage                # from a clone of this repo
```

- `src/bin/stage.ts` (compiled to `dist/bin/stage.js`: `#!/usr/bin/env node`, CommonJS) gets the runtime ready, then spawns `<runtime> . <args>` with the package root as working directory, detached, and exits, so the terminal prompt comes straight back. With `--fg` it inherits stdio and waits.
- It passes `--size=WxH` in one piece: Chromium moves switches to the front of a second instance's argv, which would leave a separate value looking like an address.
- `npm run cli:install` (`scripts/install-cli.sh`) runs `npm install` if `node_modules` is missing, builds, then symlinks `dist/bin/stage.js` to `~/.local/bin/stage`. The launcher must resolve its real path through that symlink.
- **One profile for every install path.** Main sets `app.setName('Stage')` and `app.setPath('userData', <appData>/Stage)` before `ready`. A clone, a global install, and an npx run then share the same cookies, logins, session, and installed extensions.

```
stage                        open Stage (restores the last session)
stage <url|domain|words> …   open each argument as a tab; bare words become a Google search
stage --size 1280x720 …      set the window's content size (for a consistent share)
stage --pin                  start with the tab bar pinned
stage --fresh                skip the saved session
stage --fg                   run in the foreground with logs in the terminal
stage update                 update Stage, then reopen it with the same tabs (only as the sole argument)
stage --restart              restart the open Stage into this installed version (takes no other argument)
stage --help | --version
```

- A single-instance lock means a second `stage …` call hands its parsed arguments to the running window as the lock's additional data (argv is the fallback for older launchers) and brings it to the front instead of starting another copy.
- macOS takes the menu-bar app name, Dock label and icon from the app bundle, so the launcher runs a renamed copy of Electron's bundle: `~/Library/Application Support/Stage/Runtime/electron-<version>-r<n>/Stage.app`. It's an APFS clone with `CFBundleName`/`CFBundleDisplayName` set to Stage, `CFBundleIdentifier` set to `app.stage.browser`, `build/icon.icns` as its icon, re-signed ad-hoc. It's rebuilt when the Electron version or `RUNTIME_REVISION` in `src/bin/stage.ts` changes. Other runtimes are removed at launch unless a process is running from them or `STAGE_KEEP_RUNTIMES` is set. `STAGE_PLAIN_ELECTRON=1` skips it.

## Updates

### Finding out

- The app looks 30 s after launch, every 10 minutes and on activation, and asks npm's dist-tags when a check is due and the Mac is in use: daily, an hour after a first sighting, or an hour after a failure.
- A version is announced on its second sighting, so a release pulled straight away is never offered. Check for Updates… announces at once. Older versions are never offered.
- The request uses its own in-memory session: no cookies, cache, identifiers or installed version.
- `checkForUpdates` in prefs.json and `STAGE_NO_UPDATE_CHECK` turn automatic checks off. Clones never check by themselves.
- The launcher prints at most one line from what is cached. It never waits on the network.

### Installing, by kind (`src/update/install.ts`)

| Kind | Where | What an update does |
| --- | --- | --- |
| `npx`, `staged` | npx's cache, or `<userData>/Updates/<version>` | puts a copy in `<userData>/Updates/<version>` and starts from it |
| `global` | a writable npm global prefix | swaps that exact package folder, by rename |
| `system` | an npm global prefix only an administrator can write, such as `/usr/local` | shows `sudo npm i -g stage-browser@latest && stage --restart`. Stage never asks for a password |
| `manual` | anything someone else owns | shows a command, built from constants only |
| `dev` | a source checkout | never updates itself |

1. The helper (`src/update/helper.ts`, Stage's Electron running as Node) or `stage update` takes `Updates/.lock`.
2. It downloads the tarball and verifies it, unpacks it, checks the new version's `engines.node` against the person's Node, and prepares its runtime, all while Stage runs. A failure or cancel up to here changes nothing.
3. Stage saves and quits. It is never killed.
4. The new copy moves into place and starts. The update counts once running.json says that version is `ready`. If it doesn't start, the previous version is put back and reopened.

A global swap is two renames on the same volume, each atomic. Power lost between them leaves no package where npm expects one, and the `stage` command fails until `npm i -g stage-browser` reinstalls it. The previous copy is still beside it, as `.stage-browser-previous-*`. Each update first removes what an interrupted one left (`.tmp-*`, `.stage-browser-update-*`, `.stage-browser-previous-*`).

### Which Node

The helper runs on Stage's own Node, but the `stage` command runs on the person's. The launcher passes that version to the app as `STAGE_NODE`, and an update is refused, with nothing changed, unless the new version's `engines.node` accepts it. `src/update/version.ts` reads the range syntax npm uses: `||`, space-joined comparators, `^`, `~`, `x` and partial versions. `*` or an empty range accepts any Node. A range it can't read, or a prerelease Node, is refused, and the person is told to update from Terminal.

### Several installs

Each Node version manager (asdf, nvm, Homebrew) has its own global prefix, so one Mac can hold several copies of Stage, all sharing one profile. Updating one leaves the others behind.

- When Stage starts it records itself in `<userData>/newest.json` (`{ version, root }`), unless a newer copy recorded there is still installed.
- An older launcher reads it, and if that copy is still there, is the version it names, is a stable release and was installed by npm, npx or Stage's updater, opens it instead: it says so in one line and runs that copy's launcher with the same arguments. `STAGE_HANDED_OFF` stops a second handoff. `--version`, `--help`, `update` and `--restart` stay with the copy that was run.
- If the newer copy needs a Node this one doesn't have, the launcher says so and opens itself.

### Network

Chromium follows the Mac's proxy settings and trusts certificates in the keychain. Node does neither by default, which fails behind a corporate proxy or TLS inspection. So before starting the helper, main asks `session.resolveProxy` about each update host (npm, Sigstore's trust root and the runtime on GitHub), for at most 5 s, and adds to the helper's environment:

- `NODE_USE_SYSTEM_CA=1`, unless it is already set.
- `HTTPS_PROXY` and `HTTP_PROXY` from the first `PROXY` or `HTTPS` answer, `NO_PROXY` for hosts that answered `DIRECT`, and `NODE_USE_ENV_PROXY=1`. SOCKS answers are skipped. A proxy already set in the environment wins, and only `NODE_USE_ENV_PROXY` is added.

`stage update` adds the same, from the environment only. `STAGE_ADDED_ENV` names what was added, so Stage itself starts without it. The in-app Update runs on Stage's own Node, which honours these variables. `stage update` and the first runtime download run on the person's Node. Node 24 and later honour them, and so do late Node 22 releases (22.23.4 does, 22.13.1 doesn't). Older ones go direct.

### Verification (`src/update/verify.ts`)

- The provenance attestation must pass Sigstore against its trusted root, be signed by this repository's release workflow, and name this package, this version and this tarball's SHA-512. There is no fallback without it.
- The accepted workflows are `SIGNERS` in `src/update/verify.ts`. Before publishing, the release workflow runs `scripts/check-signer.mjs`, which stops the release unless both the new build and the version on npm accept the workflow publishing it (`GITHUB_WORKFLOW_REF`). The published copy's list is read as text, never run. So a rename can't silently strand installed copies; it fails the release instead.

#### Moving the release

To rename the repository, the workflow file or the branch:

1. Add the new identity to `SIGNERS`, keeping the old one, and publish that release from the old workflow. Installed copies accept the old identity, so they update to it.
2. Wait until most installs have taken it.
3. Make the move, and publish from the new workflow. The check passes, because the version on npm now accepts it.
4. Remove the old identity in a later release.
- The tarball is self-contained: every dependency is in `bundleDependencies` (the build fails otherwise), so no npm runs and no install script runs.
- The build drops `engines` from bundled packages. npm enforces those ranges on upgrades, and the package as a whole supports the range in its own `engines`.

### Stable between versions

An updater drives the launcher of a version that may be much newer than itself, so these can only be added to:

| | |
| --- | --- |
| `stage.js --prepare-runtime` | gets the runtime ready and exits 0. Sends `{ received, total }` over IPC. A closed channel cancels. |
| `stage.js --quit-running` | asks the running Stage to save and quit, and exits 0 once asked |
| `stage.js` with no arguments | opens Stage with its saved session |
| `STAGE_KEEP_RUNTIMES` | no runtime is pruned, so a rollback still has one |
| `STAGE_NODE` | the person's Node version, `vX.Y.Z`, set by the launcher for the app and passed on to the helper |
| `STAGE_ADDED_ENV` | comma-separated names the updater added to the environment. A launcher removes them before starting Stage |
| `STAGE_HANDED_OFF` | set by a launcher that handed off to a newer copy, so that copy doesn't hand off again |
| `<userData>/newest.json` | `{ version, root }`: the newest copy of Stage that has run on this profile |
| `<userData>/running.json` | `{ pid, version, ready }`, believed only while `SingletonLock` names that pid |
| `<userData>/update.json` | what the last checks saw (`src/update/state.ts`) |
| `dist/bin/stage.js` | where the launcher lives in the package |

Stage before 0.4.0 has none of these, so it can't be asked to quit: people are told to press Cmd+Q.

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
