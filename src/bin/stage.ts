#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

interface PackageJson {
  version: string
}

const root = resolve(dirname(realpathSync(__filename)), '..', '..')
const args = process.argv.slice(2)
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T
const pkg = readJson<PackageJson>(join(root, 'package.json'))

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

// macOS takes the bold app name in the menu bar, the Dock label and the icon from the app bundle,
// and Electron ships as "Electron.app". So Stage runs from a renamed copy, Stage.app, made once per
// Electron version under ~/Library/Application Support/Stage/Runtime. The copy is an APFS clone
// (instant, almost no disk space), and it is re-signed ad-hoc, the same local signature
// Electron.app ships with, so no Apple developer account is involved.
const RUNTIME_REVISION = 2 // bump when the bundle edits or build/icon.icns change

const quiet = (cmd: string, cmdArgs: readonly string[]) => void execFileSync(cmd, cmdArgs, { stdio: ['ignore', 'ignore', 'pipe'] })

function electronVersion(): string {
  try {
    return readJson<PackageJson>(require.resolve('electron/package.json', { paths: [root] })).version
  } catch {
    return 'unknown'
  }
}

function stageRuntime(electronBinary: string): string {
  const sourceApp = resolve(electronBinary, '..', '..', '..')
  if (process.platform !== 'darwin' || !sourceApp.endsWith('.app')) return electronBinary
  const base = join(homedir(), 'Library', 'Application Support', 'Stage', 'Runtime')
  const dir = join(base, `electron-${electronVersion()}-r${RUNTIME_REVISION}`)
  const app = join(dir, 'Stage.app')
  const binary = join(app, 'Contents', 'MacOS', basename(electronBinary))
  const ready = join(dir, '.ready')
  if (existsSync(ready) && existsSync(binary)) return binary

  try {
    process.stderr.write('stage: setting up Stage.app (once per install or update)…\n')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    try {
      quiet('cp', ['-Rc', sourceApp, app]) // APFS clone
    } catch {
      rmSync(app, { recursive: true, force: true })
      quiet('cp', ['-R', sourceApp, app])
    }
    const plist = join(app, 'Contents', 'Info.plist')
    quiet('plutil', ['-replace', 'CFBundleName', '-string', 'Stage', plist])
    quiet('plutil', ['-replace', 'CFBundleDisplayName', '-string', 'Stage', plist])
    quiet('plutil', ['-replace', 'CFBundleIdentifier', '-string', 'app.stage.browser', plist])
    const icon = join(root, 'build', 'icon.icns')
    if (existsSync(icon)) copyFileSync(icon, join(app, 'Contents', 'Resources', 'electron.icns'))
    quiet('codesign', ['--force', '--deep', '--sign', '-', app])
    writeFileSync(ready, `${new Date().toISOString()}\n`)
    for (const old of readdirSync(base)) if (old !== basename(dir)) rmSync(join(base, old), { recursive: true, force: true })
    return binary
  } catch (e) {
    const err = e as Error & { stderr?: Buffer }
    const detail = err.stderr?.toString().trim() || err.message
    process.stderr.write(`stage: could not set up Stage.app, starting Electron directly (${detail})\n`)
    return electronBinary
  }
}

function findElectron(): string {
  try {
    return require('electron') as string
  } catch {
    console.error('stage: could not find Electron. Run `npm install` in ' + root)
    process.exit(1)
  }
}

function main(): void {
  if (args.includes('--help') || args.includes('-h')) return void process.stdout.write(HELP)
  if (args.includes('--version') || args.includes('-v')) return console.log(pkg.version)

  const electron = findElectron()
  const binary = process.env.STAGE_PLAIN_ELECTRON ? electron : stageRuntime(electron)
  const fg = args.includes('--fg')
  const child = spawn(binary, [root, ...args], fg ? { stdio: 'inherit' } : { detached: true, stdio: 'ignore' })
  child.on('error', (e) => {
    console.error('stage: failed to launch: ' + e.message)
    process.exit(1)
  })
  if (fg) {
    child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
  } else {
    child.unref()
    setImmediate(() => process.exit(0)) // spawn errors surface asynchronously
  }
}

main()
