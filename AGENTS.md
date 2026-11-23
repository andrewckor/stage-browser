# AGENTS.md

Notes for coding agents working on Stage. People should start with [CONTRIBUTING.md](CONTRIBUTING.md). This file doesn't repeat it, or [docs/CONTRACT.md](docs/CONTRACT.md), which explains how the pieces fit together. Read both before changing anything.

## Where things are

- `src/main/`: the Electron main process: windows, tabs, menus, IPC, extensions, updates.
- `src/preload/`: the preloads for the overlay UI and for web pages.
- `src/ui/`: the overlay UI (tab bar, address box, popovers). `npm run ui:preview` renders it without launching Stage.
- `src/shared/contract.ts`: the types shared between main and UI.
- `src/bin/stage.ts`: the `stage` command. It runs on the person's own Node, not Electron's.
- `src/update/`: finding, verifying and installing new versions. Runs as plain Node, in the update helper and in the `stage` command.
- `scripts/`: build and release helpers.

## Checks

```sh
npm run typecheck
npm run lint
npm audit --audit-level=moderate
npm run selftest
```

CI runs all four, the selftest on a macOS runner with a 1024x768 display. Locally it needs a Mac with an unlocked display. If you can't run it, say so in your summary rather than leaving it out.

## Rules

- **Don't change `version` in package.json.** Merging a version change to `main` publishes to npm.
- **Don't change the release identity on your own.** That means the repository name, `.github/workflows/release.yml`, the release branch and `SIGNERS` in `src/update/verify.ts`. Installed copies check every update against them, so a change strands them. Follow "Moving the release" in docs/CONTRACT.md, and only when asked.
- **No test-only switches in shipped code.** No environment variables, flags or branches that exist only so a test can reach in. Put checks in `src/main/selftest.ts`, which is left out of the package.
- **`src/update/` and `src/bin/` can't import `electron`,** and must run on every Node that `engines` allows, currently 22 and later.
- **Stage never runs a page's own code, or code of its own in a page it didn't open itself.** The restart check lists a page's listeners through the DevTools protocol. The only thing it evaluates there is the global `window`, to get a handle on it.
- **Updates never ask for a password.** For an install Stage can't write to, it shows the command to run instead.
- **Add no dependency** unless there's no reasonable way around it. Each one ships to everyone.
- **Keep README.md and docs/CONTRACT.md in step** with any behaviour you change.
- **UI changes come with before and after screenshots.** Take the same view at the same size on `main` and on your branch, with `npm run ui:preview` or from the selftest's `selftest-out/`. Save them outside the repository and never commit them. `gh` can't attach images to a pull request, so give the person the file paths to add to the description, and say so in your summary if you couldn't take them.

## Testing without touching the person's Stage

- Use a temporary profile: `STAGE_USER_DATA=$(mktemp -d)`. The selftest makes one for itself. The real profile is `~/Library/Application Support/Stage`, and holds someone's logins.
- Don't run `npx stage-browser` or `npm i -g stage-browser` against the real npm cache or global prefix. Point `npm_config_cache` and `npm_config_prefix` at temporary folders.
- Don't quit or kill a Stage that you didn't start. It may be on a screen in front of an audience.

## This repository is public

Keep personal paths, usernames, email addresses, machine names and anything about where or for whom the work was done out of code, comments, tests, fixtures and commit messages.
