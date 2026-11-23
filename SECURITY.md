# Security

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Please don't open a public issue, pull request or discussion for it.

Include the Stage version (`stage --version`, or **Stage → About Stage**), your macOS version, steps to reproduce, and what an attacker gains. You'll get a reply within a week. Once a fix ships, the advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Only the latest release on npm gets security fixes. **Update** in the tab bar, `stage update` from a global npm install, or `npx stage-browser@latest --restart` gets you onto it. Before 0.4.0, quit Stage and run `npx stage-browser@latest`.

## What's in scope

Anything that lets a web page, an extension or a download do more than it should, for example:

- A web page reaching Stage's own UI, its IPC channels or Node.js.
- Installing or updating an extension without its Chrome Web Store signature being verified, or with more access than you approved.
- Updating Stage to a release without npm provenance from this repository's release workflow, to an older release, or without you asking.
- An update running `sudo` or asking for your password. For an install it can't write to, Stage only shows the command.
- The `stage` command handing off to a copy of Stage that npm, npx or Stage's updater didn't install, or to one that isn't newer than itself.
- The restart check running a page's code, or anything of its own there beyond reading `window` to list the page's listeners.
- Running a Chromium runtime that doesn't match its pinned SHA-256.
- The `stage` command opening something other than the URL it was given.
- Saved sessions, cookies or logins readable by another site.

Chromium and Electron bugs belong upstream, at [Chromium](https://issues.chromium.org/) and [Electron](https://github.com/electron/electron/security). Report them to Stage too if Stage ships a vulnerable version after a fix is out.
