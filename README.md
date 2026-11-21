<p align="center">
  <img src="build/icon.png" width="112" height="112" alt="Stage icon: a one-bit pixel browser window with a red record dot">
</p>

<h1 align="center">Stage</h1>

<p align="center">
  <b>Nothing but the page.</b><br>
  A minimal Chromium browser for workshops, webinars and demos.<br>
  Share the window and your audience sees the site, edge to edge.<br>
  Your tabs wait behind the top edge until you reach for them.
</p>

<p align="center">
  <code>npx stage-browser https://andrewckor.com</code>
</p>

<p align="center">
  <img src="docs/images/stage-window.png" width="880" alt="A Stage window filled by a slide deck, with the floating tab capsule slid in from the top edge">
</p>

## Same site. Two windows.

A normal browser spends about 100 px on tabs, the address bar and bookmarks. In a 720p share, that's **a seventh of every frame**, and every tab title, extension badge and bookmark goes out on the call with the page.

Stage gives it all back to the page. No toolbar, no address bar, no bookmarks bar. Push the pointer against the top edge and a small tab capsule slides in over the page. Move away and it's gone.

## One command.

**Zero installation.** `npx` runs Stage straight from npm: nothing to download from a website, drag into Applications or approve in System Settings.

```sh
npx stage-browser https://andrewckor.com    # run it now
npm i -g stage-browser                      # or keep the short `stage` command
```

Needs macOS and Node 22 or later. The first launch downloads the Chromium runtime once (about 120 MB) and checks it against a pinned SHA-256.

## Run of show.

**1. Before the call: open your demo tabs from the terminal.**

```sh
stage --size 1280x720 app.example.com docs.example.com
```

Each address becomes a tab. `--size` fixes the window at 16:9, so nothing reflows when you start sharing.

**2. Going live: share only the Stage window.** In Zoom, Meet or Teams, pick the Stage window instead of your whole screen. The audience gets the page and nothing around it.

**3. During the demo: reach up when you need another tab.** Push the pointer against the top edge and the tabs slide in. Or stay on the keyboard: <kbd>⌘1</kbd>–<kbd>⌘9</kbd> switch tabs and <kbd>⌘L</kbd> opens a page.

## Small on purpose.

- **Hidden tabs.** The tab capsule floats over the page and hides when you're done with it. <kbd>⇧⌘B</kbd> pins it open.
- **Tabs on the side.** **View → Tabs on Left** or **Tabs on Right** moves them into a vertical sidebar that reveals when you touch that edge. **Tabs on Top** brings the capsule back.
- **Extensions.** Add the ones you use from the Chrome Web Store, with **Extensions → Add Extension from This Page**. Their icons sit in the tab bar.
- **Terminal start.** `stage <url>` opens the page and hands your prompt back. Run it again and the page joins the open window. No app bundle to sign.
- **Share sizes.** Window presets at 1280×720, 1440×900, 1600×900 and 1920×1080. Zoom with <kbd>⌘=</kbd> and <kbd>⌘-</kbd> so the back row can read.
- **Escape hatch.** <kbd>⇧⌘O</kbd> opens the current page in Google Chrome. Zoom and Slack links open in their own apps.

## The command line

```
stage                        open Stage (restores the last session)
stage <url|domain|words> …   open each argument as a tab; bare words become a Google search
stage --size 1280x720 …      set the window's content size
stage --pin                  start with the tab bar pinned
stage --fresh                skip the saved session
stage --fg                   run in the foreground with logs in the terminal
```

If Stage is already running, `stage <url>` opens the URL as a tab in the running window.

## Hands on the keys.

| Shortcut | Action |
| --- | --- |
| <kbd>⌘T</kbd> | New tab, straight into the address box |
| <kbd>⌘L</kbd> | Go to an address or search |
| <kbd>⌘W</kbd> / <kbd>⇧⌘T</kbd> | Close a tab / reopen it |
| <kbd>⌘1</kbd> … <kbd>⌘9</kbd> | Jump to a tab (<kbd>⌘9</kbd> is the last) |
| <kbd>⌃Tab</kbd>, <kbd>⇧⌘]</kbd> / <kbd>⇧⌘[</kbd> | Next / previous tab |
| <kbd>⌘[</kbd> / <kbd>⌘]</kbd> | Back / forward |
| <kbd>⌘R</kbd> / <kbd>⇧⌘R</kbd> | Reload / hard reload |
| <kbd>⌘=</kbd> / <kbd>⌘-</kbd> / <kbd>⌘0</kbd> | Zoom in / out / reset |
| <kbd>⇧⌘B</kbd> | Pin or unpin the tab bar (or sidebar) |
| <kbd>⌃⌘F</kbd> | Full screen |
| <kbd>⇧⌘O</kbd> | Open the page in Google Chrome |
| <kbd>⌥⌘I</kbd> | Developer tools |

In the tab bar, click the active tab to edit its address, middle-click a tab to close it, drag tabs to reorder, and right-click a tab for more.

## Extensions

Stage starts with none. Choose **Extensions → Open Chrome Web Store** and go to the extension's page. Then choose **Extensions → Add Extension from This Page**. Stage shows what the extension can access and asks before adding it. The Web Store's own **Add to Chrome** button doesn't work in Stage, so use the menu item instead.

Packages are checked against Google's signature, the same way Chrome checks them. Updates are automatic, and Stage asks again if an update wants more access.

Its icon appears on the right of the tab bar, and the **Extensions** menu lists everything installed, each with a Remove option. **Hide Icons in Tab Bar** keeps the capsule bare.

Extension support comes from [electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell/tree/master/packages/electron-chrome-extensions), which covers most of the `chrome.*` APIs extensions rely on, but not every one. If an extension misbehaves, <kbd>⇧⌘O</kbd> opens the page in Google Chrome.

## Before you go live.

**Why does macOS ask about "Chromium Safe Storage"?**
That Keychain key decrypts your saved logins. macOS asks once after you install or update Stage. Choose **Always Allow**, or sites will treat you as signed out.

**Is it signed or notarized?**
It doesn't need to be. On first launch, Stage copies Electron's Chromium app on your own Mac, names it Stage and gives it a local signature, the same kind Electron itself ships with. That copy lives in `~/Library/Application Support/Stage/Runtime/`.

**Where are my logins and tabs kept?**
In `~/Library/Application Support/Stage`. npx, a global install and a clone all share it, so you sign in once. Stage reopens your last tabs when it starts, and logs errors to `stage.log` in the same folder instead of interrupting you with a dialog.

**Can I sign in to Google?**
Yes. Google blocks sign-in from browsers built on Electron, so on `accounts.google.com`, and only there, Stage tells Google it is Firefox, which Google accepts. Gmail, YouTube and every other site see Stage's normal Chrome user agent.

**Does every extension work?**
Most do. Extensions that talk to a desktop app, such as 1Password's desktop unlock, can't connect, because Electron doesn't support Chrome's native messaging. Sign in inside the extension instead.

**Can I open more than one window?**
Not yet. Links that open new windows become tabs, and sign-in pop-ups open as small separate windows so the sign-in flow keeps working.

**Windows or Linux?**
Not yet. Stage is macOS only.

## Build from source

```sh
git clone https://github.com/andrewckor/stage-browser
cd stage-browser
npm install
npm start              # build to dist/ and run
npm run cli:install    # build and link dist/bin/stage.js to ~/.local/bin/stage
npm run typecheck      # tsc over src/ and scripts/
npm run lint           # oxlint, warnings fail
npm run selftest       # scripted end-to-end checks; writes selftest-out/results.json and screenshots
npm run ui:preview     # render the tab bar and address box in mock mode with headless Chrome
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. [`docs/CONTRACT.md`](docs/CONTRACT.md) describes the window layout and the interface between the main process (`src/main/`) and the overlay UI (`src/ui/`). The website lives in [`site/`](site/).

---

<p align="center">MIT · Built on Electron and Chromium</p>
