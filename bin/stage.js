#!/usr/bin/env node
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')

const root = path.resolve(path.dirname(fs.realpathSync(__filename)), '..')
const args = process.argv.slice(2)
const pkg = require(path.join(root, 'package.json'))

const HELP = `Stage ${pkg.version} - a minimal browser for screen sharing

Usage:
  stage                        open Stage (restores the last session)
  stage <url|domain|words> ... open each argument as a tab; bare words become a Google search
  stage --size 1280x720 ...    set the window's content size
  stage --pin                  start with the tab bar pinned
  stage --fresh                skip the saved session
  stage --fg                   run in the foreground with logs in the terminal
  stage --help | --version
`

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(HELP)
  process.exit(0)
}
if (args.includes('--version') || args.includes('-v')) {
  console.log(pkg.version)
  process.exit(0)
}

let electron
try {
  electron = require('electron')
} catch (e) {
  console.error('stage: could not find Electron. Run `npm install` in ' + root)
  process.exit(1)
}

// macOS takes the bold app name in the menu bar, the Dock label and the icon from the app bundle,
// and Electron ships as "Electron.app". So Stage runs from a renamed copy, Stage.app, made once per
// Electron version under ~/Library/Application Support/Stage/Runtime. The copy is an APFS clone
// (instant, almost no disk space), and it is re-signed ad-hoc, the same local signature
// Electron.app ships with, so no Apple developer account is involved.
const RUNTIME_REVISION = 2 // bump when the bundle edits or build/icon.icns change

function run(cmd, cmdArgs) {
  execFileSync(cmd, cmdArgs, { stdio: ['ignore', 'ignore', 'pipe'] })
}

function stageRuntime(electronBinary) {
  const sourceApp = path.resolve(electronBinary, '..', '..', '..')
  if (process.platform !== 'darwin' || !sourceApp.endsWith('.app')) return electronBinary
  let electronVersion = 'unknown'
  try {
    electronVersion = require(require.resolve('electron/package.json', { paths: [root] })).version
  } catch {}
  const base = path.join(os.homedir(), 'Library', 'Application Support', 'Stage', 'Runtime')
  const dir = path.join(base, `electron-${electronVersion}-r${RUNTIME_REVISION}`)
  const app = path.join(dir, 'Stage.app')
  const binary = path.join(app, 'Contents', 'MacOS', path.basename(electronBinary))
  const ready = path.join(dir, '.ready')
  if (fs.existsSync(ready) && fs.existsSync(binary)) return binary

  try {
    process.stderr.write('stage: setting up Stage.app (once per install or update)…\n')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    try {
      run('cp', ['-Rc', sourceApp, app]) // APFS clone
    } catch {
      fs.rmSync(app, { recursive: true, force: true })
      run('cp', ['-R', sourceApp, app])
    }
    const plist = path.join(app, 'Contents', 'Info.plist')
    run('plutil', ['-replace', 'CFBundleName', '-string', 'Stage', plist])
    run('plutil', ['-replace', 'CFBundleDisplayName', '-string', 'Stage', plist])
    run('plutil', ['-replace', 'CFBundleIdentifier', '-string', 'app.stage.browser', plist])
    const icon = path.join(root, 'build', 'icon.icns')
    if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(app, 'Contents', 'Resources', 'electron.icns'))
    run('codesign', ['--force', '--deep', '--sign', '-', app])
    fs.writeFileSync(ready, `${new Date().toISOString()}\n`)
    for (const old of fs.readdirSync(base)) {
      if (old !== path.basename(dir)) fs.rmSync(path.join(base, old), { recursive: true, force: true })
    }
    return binary
  } catch (e) {
    const detail = (e.stderr && e.stderr.toString().trim()) || e.message
    process.stderr.write(`stage: could not set up Stage.app, starting Electron directly (${detail})\n`)
    return electronBinary
  }
}

const binary = process.env.STAGE_PLAIN_ELECTRON ? electron : stageRuntime(electron)
const fg = args.includes('--fg')
const child = spawn(binary, [root, ...args], fg ? { stdio: 'inherit' } : { detached: true, stdio: 'ignore' })
child.on('error', (e) => {
  console.error('stage: failed to launch: ' + e.message)
  process.exit(1)
})
if (fg) {
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code || 0))
} else {
  child.unref()
  // spawn errors surface asynchronously; give them a tick before exiting
  setImmediate(() => process.exit(0))
}
