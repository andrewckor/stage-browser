# Update tests

End-to-end tests of how Stage updates itself. They install real copies of this checkout's build (global, npx and project installs), point them at a fake npm registry on this Mac, and drive the Stage windows over the DevTools protocol: the Update button and popover, `stage update`, `stage --restart`, rollbacks, cancels, network failures, proxies, and handing over between two installs.

```sh
npm run test:updates            # every scenario, about 15 minutes
npm run test:updates -- cli npx # only these
```

It needs a Mac with an unlocked display, and network access the first time in each run: it downloads Stage's runtime once and one real release signature from npm. CI runs it on every push and pull request, once each on Node 22, 24 and 26.

## How it stays away from your own Stage

- Everything lives in a new temporary folder: each test's home, profile, npm prefix and npm cache. It's deleted when every check passes, and kept for a look when one fails.
- The copies that run are built in that folder (`fixtures.mjs`): this build under versions 0.4.0 to 0.9.0, each with test hooks added to its own files there. The hooks refuse to start Stage with a profile or home outside the folder, give it a debugging port, and swap the npm registry and the clipboard for local stand-ins. They are never in `src/`, so they can't ship.
- It only stops processes that run from that folder.

Test windows open and close on your screen while it runs. Leave the keyboard alone until it's done, or run it in CI instead.

## Adding a scenario

Add a function to `S` in `run.mjs`. `Box` in `lib.mjs` gives it a fresh home and profile, installs a fixture (`global`, `npx`, `local`), launches it, and reads its state. Use `check(name, ok, detail)` for each thing you expect. If a scenario needs a new kind of release, add it to `FIXTURES` in `fixtures.mjs`.
