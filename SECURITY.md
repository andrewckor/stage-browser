# Security

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Please don't open a public issue, pull request or discussion for it.

Include the Stage version (`stage --version`, or **Stage → About Stage**), your macOS version, steps to reproduce, and what an attacker gains. You'll get a reply within a week. Once a fix ships, the advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Only the latest release on npm gets security fixes. `npx stage-browser@latest` or `npm i -g stage-browser` gets you onto it.

## What's in scope

Anything that lets a web page, an extension or a download do more than it should, for example:

- A web page reaching Stage's own UI, its IPC channels or Node.js.
- Installing or updating an extension without its Chrome Web Store signature being verified, or with more access than you approved.
- Running a Chromium runtime that doesn't match its pinned SHA-256.
- The `stage` command opening something other than the URL it was given.
- Saved sessions, cookies or logins readable by another site.

Chromium and Electron bugs belong upstream, at [Chromium](https://issues.chromium.org/) and [Electron](https://github.com/electron/electron/security). Report them to Stage too if Stage ships a vulnerable version after a fix is out.
