# Stage

A minimal Chromium browser for screen sharing. The page fills the whole window. Tabs stay out of sight until you move the cursor to the top edge, then slide in over the page and hide again when you move away.

Built for workshops, webinars, and demos: share just the Stage window and your audience sees the site, nothing else.

- **Viewport first.** No toolbar, no address bar, no bookmarks bar. Tabs float in a small capsule that appears only when you reach for it.
- **Chrome extensions.** Install the ones you use from the Chrome Web Store.
- **Runs from the terminal.** No `.app` to build, sign, or notarize.
- **Presenter helpers.** Window-size presets (1280×720, 1440×900, 1600×900, 1920×1080), zoom shortcuts, and a pinned-bar mode when you want the tabs visible.

macOS only.

## Install and run

```sh
npx stage-browser https://example.com     # try it without installing
npm i -g stage-browser                     # or install the `stage` command
stage https://example.com docs.example.com
```

From a clone:

```sh
npm install
npm run cli:install    # links bin/stage.js to ~/.local/bin/stage
stage
```

The first install downloads Electron's Chromium build (about 100 MB).

## Usage

```
stage                        open Stage (restores the last session)
stage <url|domain|words> …   open each argument as a tab; bare words become a Google search
stage --size 1280x720 …      set the window's content size
stage --pin                  start with the tab bar pinned
stage --fresh                skip the saved session
stage --fg                   run in the foreground with logs in the terminal
```

If Stage is already running, `stage <url>` opens the URL as a tab in the running window.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| ⌘T | new tab (opens the omnibox) |
| ⌘L | go to an address or search |
| ⌘W / ⇧⌘T | close tab / reopen closed tab |
| ⌘1 … ⌘9 | jump to a tab (⌘9 = last) |
| ⌃Tab, ⇧⌘] / ⇧⌘[ | next / previous tab |
| ⌘[ / ⌘] | back / forward |
| ⌘R / ⇧⌘R | reload / hard reload |
| ⌘= / ⌘- / ⌘0 | zoom in / out / reset |
| ⇧⌘B | pin or unpin the tab bar |
| ⌃⌘F | full screen |
| ⇧⌘O | open the current page in Google Chrome |
| ⌥⌘I | developer tools |

In the tab bar, click the active tab to edit its address, middle-click a tab to close it, drag tabs to reorder, and right-click a tab for more.

## Extensions

Stage comes with no extensions. Choose **Extensions → Open Chrome Web Store**, find the extension, and click "Add to Chrome". Its icon appears on the right of the tab bar, and **Extensions** lists everything installed, each with a Remove option.

Stage uses [electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell/tree/master/packages/electron-chrome-extensions), which covers most of the `chrome.*` APIs extensions rely on, but not every one. An extension that needs a missing API may only partly work. When that happens, ⇧⌘O opens the page in Google Chrome.

Links to apps such as Zoom and Slack open in those apps.

## Where things live

- Profile (cookies, logins, extensions, saved session, history): `~/Library/Application Support/Stage`. A clone, a global install, and npx all share it.
- Errors are logged to `~/Library/Application Support/Stage/stage.log` instead of interrupting you with a dialog.
- The app itself: `~/Library/Application Support/Stage/Runtime/…/Stage.app`. macOS takes the menu-bar name and Dock icon from the app bundle, so the first launch after an install or update makes a renamed copy of Electron's bundle there (a few seconds, almost no extra disk space).

## Known limitations

- After an install or update, macOS asks once whether Stage may use "Chromium Safe Storage" in your Keychain. Choose **Always Allow**: that key decrypts your saved logins, and denying it signs you out of sites.
- Extensions that talk to a desktop app (for example 1Password's desktop unlock) can't connect, because Electron doesn't support Chrome's native messaging. Sign in inside the extension instead.
- One window. Links that open new windows become tabs; sign-in pop-ups (OAuth) open as small separate windows so the sign-in flow keeps working.

## Development

```sh
npm start              # run from source
npm run selftest       # scripted end-to-end checks; writes selftest-out/results.json and screenshots
npm run ui:preview     # renders the tab bar and omnibox in mock mode with headless Chrome
```

`docs/CONTRACT.md` describes the window layout and the interface between the main process (`src/main/`) and the overlay UI (`src/ui/`).
