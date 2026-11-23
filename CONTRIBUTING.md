# Contributing

Thanks for helping. Stage is small on purpose, so the bar for new features is high and the bar for fixes is low.

## Before you start

- **Bugs:** open an issue with your Stage version (`stage --version`) and macOS version, steps to reproduce, and what you expected. Attach `~/Library/Application Support/Stage/stage.log` if it has errors.
- **Features:** open an issue first. Stage aims to show nothing but the page, so anything that adds UI needs a good reason.
- **Security problems:** don't open an issue. See [SECURITY.md](SECURITY.md).

## Setup

Stage runs on macOS only. You need Node 22 or later.

```sh
git clone https://github.com/andrewckor/stage-browser
cd stage-browser
npm install
npm start
```

[`docs/CONTRACT.md`](docs/CONTRACT.md) explains how the main process (`src/main/`), the preloads (`src/preload/`) and the overlay UI (`src/ui/`) fit together. Read it before changing anything that crosses between them.

## Before you open a pull request

Run all four. CI runs them too, the selftest on a macOS runner whose screenshots it keeps with the run, but running them first saves a round trip.

```sh
npm run typecheck
npm run lint
npm audit --audit-level=moderate
npm run selftest
```

`npm run selftest` drives a real Stage window and writes `selftest-out/results.json` with screenshots. If you change the tab bar or address box, `npm run ui:preview` renders them without launching Stage. If you change how Stage updates, run `npm run test:updates` too ([test/updates/README.md](test/updates/README.md)).

## Pull requests

- Keep each one to a single change, with tests in `src/main/selftest.ts` when the change has behaviour to check.
- Describe what changes for someone using Stage, and why.
- **Show anything visible, before and after.** If the change alters what's on screen, put a screenshot from `main` and one from your branch in the description, of the same view at the same window size. `npm run ui:preview` renders the tab bar and address box, and `npm run selftest` saves the main views to `selftest-out/`. For something that moves or animates, add a short screen recording. Take them with a temporary profile so no tabs, accounts or bookmarks of yours end up in a public pull request.
- Keep `README.md` and `docs/CONTRACT.md` in step with what you change.
- Don't add a dependency unless there's no reasonable way around it. Each one ships to every user.
- Don't bump the version in `package.json`. Releases are cut separately.

By contributing, you agree that your work is released under the [MIT License](LICENSE).
