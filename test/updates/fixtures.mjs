// Builds the packages the update tests install and update between. Each one is this checkout's
// build under another version number, with test hooks patched into its copy here. The hooks never
// exist in the source, so they can't ship. A patch that no longer matches the build stops the run.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '../..')

function replace(file, from, to) {
  const text = fs.readFileSync(file, 'utf8')
  const count = text.split(from).length - 1
  if (count !== 1) throw new Error(`fixtures: expected one ${JSON.stringify(from)} in ${file}, found ${count}`)
  fs.writeFileSync(file, text.replace(from, () => to))
  parses(file)
}

/** Stops the run on a patch that broke the code, before the app would show it in a dialog. */
function parses(file) {
  execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'inherit'] })
}

/**
 * Hooks at the top of the app's main process. It refuses to start unless its profile and home are
 * inside `dir`, so a fixture can never open someone's real Stage profile.
 */
const hooks = (dir) => `"use strict";
if (!String(process.env.STAGE_USER_DATA || '').startsWith(${JSON.stringify(dir + '/')})) process.exit(97);
if (!String(process.env.HOME || '').startsWith(${JSON.stringify(dir + '/')})) process.exit(96);
// A crash ends the app with a log instead of a dialog that would wait for a click.
process.on('uncaughtException', (e) => { try { require('node:fs').appendFileSync(process.env.STAGE_USER_DATA + '/e2e-crash.log', String((e && e.stack) || e) + '\\n') } catch {} process.exit(98) });
{ const { app, powerMonitor, Menu, BaseWindow } = require('electron');
  app.commandLine.appendSwitch('use-mock-keychain');
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND , EXCLUDE 127.0.0.1');
  if (process.env.E2E_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.E2E_PORT);
  if (process.env.E2E_PROXY) app.commandLine.appendSwitch('proxy-server', process.env.E2E_PROXY);
  app.whenReady().then(() => { if (process.env.E2E_ACTIVE) powerMonitor.getSystemIdleState = () => 'active' });
  app.setPath('downloads', process.env.HOME + '/Downloads'); // macOS ignores HOME for this one
  process.on('SIGUSR2', () => {
    const fs = require('node:fs'), f = process.env.STAGE_USER_DATA + '/e2e-';
    const items = ((Menu.getApplicationMenu() || {}).items || []).flatMap(m => m.submenu ? m.submenu.items : []);
    let clicked = null;
    try { const l = fs.readFileSync(f + 'click', 'utf8'); fs.unlinkSync(f + 'click'); const i = items.find(x => x.label.startsWith(l)); if (i) { i.click(); clicked = i.label } } catch {}
    const about = items.find(x => x.role === 'about');
    fs.writeFileSync(f + 'dump.json', JSON.stringify({ clicked, labels: items.map(i => i.label), about: !!about, name: app.name, version: app.getVersion(), cwd: process.cwd(),
      dock: app.dock.isVisible(), env: Object.keys(process.env).filter(k => /ELECTRON_RUN_AS_NODE|NODE_CHANNEL_FD|STAGE_KEEP_RUNTIMES|STAGE_HANDED_OFF|STAGE_ADDED_ENV|NODE_USE_|_PROXY$/i.test(k)), node: process.env.STAGE_NODE || null,
      windows: BaseWindow.getAllWindows().map(w => ({ bounds: w.getBounds(), visible: w.isVisible(), protected: w.isContentProtected() })) }));
  }) }
`

function patchMain(root, dir, { crash = false } = {}) {
  replace(path.join(root, 'dist/main/main.js'), '"use strict";\n', hooks(dir) + (crash ? 'process.exit(3);\n' : ''))
}

/** The runtime revision this checkout's launcher asks for. */
export function runtimeRevision() {
  const m = /const RUNTIME_REVISION = (\d+)/.exec(fs.readFileSync(path.join(REPO, 'src/bin/stage.ts'), 'utf8'))
  if (!m) throw new Error('fixtures: no RUNTIME_REVISION in src/bin/stage.ts')
  return Number(m[1])
}

const FIXTURES = [
  { version: '0.4.0' },
  { version: '0.4.1' },
  { version: '0.5.0' },
  { version: '0.6.0', crash: true }, // quits at launch, so the update rolls back
  { version: '0.7.0', newRuntime: true }, // needs a runtime it has to download first
  { version: '0.8.0', neverReady: true }, // holds the profile but never says it's ready
  { version: '0.9.0', engines: { node: '>=99' } }, // needs a Node nobody has
]

/** Packs this checkout's `dist` and writes `stage-browser-<version>.tgz` for each fixture to `dir/fix`. */
export function buildFixtures(dir, npm) {
  const base = path.join(dir, 'base')
  const fix = path.join(dir, 'fix')
  fs.mkdirSync(base, { recursive: true })
  fs.mkdirSync(fix, { recursive: true })
  const pack = (cwd, dest) => execFileSync(npm, ['pack', '--ignore-scripts', '--silent', '--pack-destination', dest, '--cache', path.join(dir, 'npm-cache')], { cwd, encoding: 'utf8' }).trim().split('\n').at(-1)
  const tgz = pack(REPO, base)
  execFileSync('/usr/bin/tar', ['-xzf', path.join(base, tgz), '-C', base])
  // npm leaves bundled packages out when node_modules is a link, so check they all made it in.
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'))
  const missing = Object.entries(lock.packages).filter(([dir, p]) => dir && !p.dev && !p.optional && !fs.existsSync(path.join(base, 'package', dir, 'package.json')))
  if (missing.length) throw new Error(`fixtures: the packed build lacks ${missing.map(([dir]) => dir).join(', ')}. Run npm ci, with node_modules a real folder.`)
  const revision = runtimeRevision()
  for (const f of FIXTURES) {
    const root = path.join(fix, f.version)
    fs.cpSync(path.join(base, 'package'), root, { recursive: true, verbatimSymlinks: true })
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    pkg.version = f.version
    delete pkg.scripts
    if (f.engines) pkg.engines = f.engines
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2))
    patchMain(root, dir, f)
    // The fake registry, and a signature check a test can turn back on.
    replace(path.join(root, 'dist/update/common.js'), "exports.REGISTRY = 'https://registry.npmjs.org';", "exports.REGISTRY = process.env.E2E_REGISTRY || 'http://127.0.0.1:9';")
    fs.appendFileSync(path.join(root, 'dist/update/verify.js'), '\n{ const real = exports.verifyRelease; exports.verifyRelease = async (...a) => { if (process.env.E2E_REAL_VERIFY) return real(...a) } }\n')
    parses(path.join(root, 'dist/update/verify.js'))
    // The copied command goes to a file instead of the clipboard.
    replace(path.join(root, 'dist/main/updates.js'), 'electron_1.clipboard.writeText(', "((t) => require('node:fs').writeFileSync(process.env.STAGE_USER_DATA + '/e2e-clipboard', t))(")
    if (f.neverReady) replace(path.join(root, 'dist/main/main.js'), '(USER_DATA, VERSION, true)', '(USER_DATA, VERSION, false)')
    if (f.newRuntime) replace(path.join(root, 'dist/bin/stage.js'), `const RUNTIME_REVISION = ${revision};`, `const RUNTIME_REVISION = ${revision + 1};`)
    pack(root, fix)
  }
}
