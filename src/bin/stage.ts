#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

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
// and Electron ships as "Electron.app". So Stage runs from a renamed copy, Stage.app, kept once per
// Electron version under ~/Library/Application Support/Stage/Runtime. It is re-signed ad-hoc, the
// same local signature Electron.app ships with, so no Apple developer account is involved.
//
// Two ways to get that copy:
// - A dev checkout has `electron` in its own node_modules. Stage.app is an APFS clone of it.
// - A published install (npx, npm i -g) does not depend on `electron`, which would download and
//   unpack the 120 MB runtime twice. Instead the first launch downloads the official zip once,
//   checks it against the SHA-256 pinned in dist/runtime.json at build time, and unpacks it with
//   ditto. Later versions that use the same Electron version find the runtime and start at once.
const RUNTIME_REVISION = 3 // bump when the bundle edits or build/icon.icns change

const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024
const STALL_TIMEOUT_MS = 60_000
const LOCK_STALE_MS = 120_000
const LOCK_HEARTBEAT_MS = 5_000
const LOCK_POLL_MS = 500
const TMP_PREFIX = '.tmp-'

interface RuntimePin {
  electron: string
  sha256: Record<'arm64' | 'x64', string>
}

const quiet = (cmd: string, cmdArgs: readonly string[]) => void execFileSync(cmd, cmdArgs, { stdio: ['ignore', 'ignore', 'pipe'] })
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const fail = (message: string): never => {
  process.stderr.write(`stage: ${message}\n`)
  return process.exit(1)
}

/** Renames the bundle's identity and icon, then signs it ad-hoc. `app` must be a copy, never the original. */
function brand(app: string): void {
  const plist = join(app, 'Contents', 'Info.plist')
  quiet('plutil', ['-replace', 'CFBundleName', '-string', 'Stage', plist])
  quiet('plutil', ['-replace', 'CFBundleDisplayName', '-string', 'Stage', plist])
  quiet('plutil', ['-replace', 'CFBundleIdentifier', '-string', 'app.stage.browser', plist])
  const icon = join(root, 'build', 'icon.icns')
  if (existsSync(icon)) copyFileSync(icon, join(app, 'Contents', 'Resources', 'electron.icns'))
  quiet('codesign', ['--force', '--deep', '--sign', '-', app])
}

const runtimeBase = () => join(homedir(), 'Library', 'Application Support', 'Stage', 'Runtime')
const runtimeDir = (base: string, version: string) => join(base, `electron-${version}-r${RUNTIME_REVISION}`)
const runtimeReady = (dir: string, binary: string) => existsSync(join(dir, '.ready')) && existsSync(binary)

/**
 * Removes other runtimes that no process is using. One that is still open goes on a later launch.
 * Only `electron-*` folders: the lock and temp files are not ours to touch here.
 */
function pruneOld(base: string, keep: string): void {
  try {
    const others = readdirSync(base).filter((name) => name.startsWith('electron-') && name !== basename(keep))
    if (!others.length) return
    const running = execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    for (const old of others) {
      // Match the folder, not the whole path: ps escapes non-ASCII home folders in some locales.
      if (!running.includes(`/${old}/Stage.app`)) rmSync(join(base, old), { recursive: true, force: true })
    }
  } catch {
    // old runtimes are only disk space; without a process list none of them is safe to remove
  }
}

// Dev checkout: clone the Electron.app from node_modules.
function cloneRuntime(electronBinary: string, version: string): string {
  const sourceApp = resolve(electronBinary, '..', '..', '..')
  if (process.platform !== 'darwin' || !sourceApp.endsWith('.app')) return electronBinary
  const base = runtimeBase()
  const dir = runtimeDir(base, version)
  const app = join(dir, 'Stage.app')
  const binary = join(app, 'Contents', 'MacOS', basename(electronBinary))
  if (runtimeReady(dir, binary)) {
    pruneOld(base, dir)
    return binary
  }

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
    brand(app)
    writeFileSync(join(dir, '.ready'), `${new Date().toISOString()}\n`)
    pruneOld(base, dir)
    return binary
  } catch (e) {
    const err = e as Error & { stderr?: Buffer }
    const detail = err.stderr?.toString().trim() || err.message
    process.stderr.write(`stage: could not set up Stage.app, starting Electron directly (${detail})\n`)
    return electronBinary
  }
}

function readPin(): RuntimePin {
  try {
    const pin = readJson<RuntimePin>(join(root, 'dist', 'runtime.json'))
    const hex = /^[0-9a-f]{64}$/
    if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pin.electron) && hex.test(pin.sha256.arm64) && hex.test(pin.sha256.x64)) return pin
  } catch {
    // fall through
  }
  return fail('dist/runtime.json is missing or invalid. Reinstall stage-browser.')
}

function archForDownload(): 'arm64' | 'x64' {
  if (process.arch === 'arm64') return 'arm64'
  try {
    // An x64 Node under Rosetta on Apple silicon: take the native build.
    const out = execFileSync('sysctl', ['-n', 'sysctl.proc_translated'], { stdio: ['ignore', 'pipe', 'ignore'] })
    if (out.toString().trim() === '1') return 'arm64'
  } catch {
    // the key does not exist on Intel Macs
  }
  return 'x64'
}

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024))

/** Downloads `url` to `dest` over HTTPS, hashing as it goes. Throws if the SHA-256 differs from `expectedHex`. */
async function downloadVerified(url: string, dest: string, expectedHex: string): Promise<void> {
  if (!url.startsWith('https://')) throw new Error('refusing a non-HTTPS download')
  const controller = new AbortController()
  let stall = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS)
  const kick = () => {
    clearTimeout(stall)
    stall = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS)
  }
  let file: FileHandle | undefined
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
    if (new URL(res.url).protocol !== 'https:') throw new Error('refusing a download that was redirected away from HTTPS')
    const total = Number(res.headers.get('content-length')) || 0
    if (total > MAX_DOWNLOAD_BYTES) throw new Error('download is larger than expected')

    const tty = process.stderr.isTTY
    const label = 'stage: downloading Chromium runtime'
    if (!tty) process.stderr.write(`${label} (about ${total ? mb(total) : 115} MB, once)…\n`)
    const hash = createHash('sha256')
    file = await open(dest, 'wx', 0o600)
    let received = 0
    let shown = 0
    for await (const chunk of res.body) {
      kick()
      received += chunk.byteLength
      if (received > MAX_DOWNLOAD_BYTES) throw new Error('download is larger than expected')
      hash.update(chunk)
      await file.write(chunk)
      if (tty && Date.now() - shown > 100) {
        shown = Date.now()
        process.stderr.write(`\r\x1b[K${label} ${mb(received)} MB${total ? ` / ${mb(total)} MB` : ''}`)
      }
    }
    if (tty) process.stderr.write(`\r\x1b[K${label} ${mb(received)} MB, verifying…\n`)
    const actual = hash.digest()
    const expected = Buffer.from(expectedHex, 'hex')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error(`checksum mismatch for the downloaded runtime (expected ${expectedHex}, got ${actual.toString('hex')})`)
    }
  } catch (e) {
    if (controller.signal.aborted) throw new Error(`download stalled for ${STALL_TIMEOUT_MS / 1000} s`, { cause: e })
    throw e
  } finally {
    clearTimeout(stall)
    await file?.close()
  }
}

/**
 * Runs `work` while holding an exclusive lock (a directory, so creation is atomic). `work` gets no
 * lock when another process finishes the job first: `isDone` is checked while waiting, and the
 * caller's result is whatever `isDone` found. A lock whose heartbeat stopped is taken over.
 */
async function withLock(lock: string, isDone: () => boolean, work: () => Promise<void>): Promise<void> {
  let told = false
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    if (isDone()) return
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true })
    } catch {
      // released in the meantime; try again
    }
    if (!told) process.stderr.write('stage: another Stage is setting up the runtime, waiting…\n')
    told = true
    await sleep(LOCK_POLL_MS)
  }
  const beat = setInterval(() => {
    try {
      utimesSync(lock, new Date(), new Date())
    } catch {
      // lock was removed under us; the work will still finish, the rename below is atomic
    }
  }, LOCK_HEARTBEAT_MS)
  const release = () => rmSync(lock, { recursive: true, force: true })
  process.once('exit', release)
  try {
    if (!isDone()) await work()
  } finally {
    clearInterval(beat)
    process.removeListener('exit', release)
    release()
  }
}

// Published install: download the official Electron once, straight into Stage's Runtime folder.
async function managedRuntime(): Promise<string> {
  if (process.platform !== 'darwin') return fail('Stage runs on macOS only.')
  const pin = readPin()
  const base = runtimeBase()
  const dir = runtimeDir(base, pin.electron)
  const binary = join(dir, 'Stage.app', 'Contents', 'MacOS', 'Electron')
  if (runtimeReady(dir, binary)) {
    pruneOld(base, dir)
    return binary
  }

  mkdirSync(base, { recursive: true })
  const arch = archForDownload()
  const name = `electron-v${pin.electron}-darwin-${arch}.zip`
  const url = `https://github.com/electron/electron/releases/download/v${pin.electron}/${name}`
  const tmp = join(base, `${TMP_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`)
  const zip = `${tmp}.zip`
  const cleanTmp = () => {
    rmSync(zip, { force: true })
    rmSync(tmp, { recursive: true, force: true })
  }
  const onSignal = () => process.exit(130) // runs the 'exit' cleanups
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  process.once('exit', cleanTmp)

  try {
    await withLock(
      join(base, '.lock'),
      () => runtimeReady(dir, binary),
      async () => {
        // Only the lock holder is here, so every temp file left in the folder belongs to an interrupted run.
        for (const left of readdirSync(base)) if (left.startsWith(TMP_PREFIX)) rmSync(join(base, left), { recursive: true, force: true })
        await downloadVerified(url, zip, pin.sha256[arch])
        process.stderr.write('stage: setting up Stage.app (once per install or update)…\n')
        mkdirSync(tmp)
        quiet('ditto', ['-x', '-k', zip, tmp])
        rmSync(zip, { force: true })
        renameSync(join(tmp, 'Electron.app'), join(tmp, 'Stage.app'))
        brand(join(tmp, 'Stage.app'))
        writeFileSync(join(tmp, '.ready'), `${new Date().toISOString()}\n`)
        rmSync(dir, { recursive: true, force: true })
        renameSync(tmp, dir) // atomic: the runtime is either absent or complete
      },
    )
  } catch (e) {
    cleanTmp()
    const err = e as Error & { stderr?: Buffer }
    return fail(`could not set up the Chromium runtime: ${err.stderr?.toString().trim() || err.message}`)
  } finally {
    process.removeListener('exit', cleanTmp)
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    cleanTmp()
  }
  if (!runtimeReady(dir, binary)) return fail('could not set up the Chromium runtime.')
  pruneOld(base, dir)
  return binary
}

/** The Electron in this checkout's own node_modules, or null for a published install. */
function checkoutElectron(): { binary: string; version: string } | null {
  try {
    const pkgPath = require.resolve('electron/package.json', { paths: [root] })
    if (!pkgPath.startsWith(join(root, 'node_modules') + sep)) return null // someone else's Electron is not ours to run
    return { binary: require('electron') as string, version: readJson<PackageJson>(pkgPath).version }
  } catch {
    return null
  }
}

async function findRuntime(): Promise<string> {
  const dev = checkoutElectron()
  if (!dev) return managedRuntime()
  return process.env.STAGE_PLAIN_ELECTRON ? dev.binary : cloneRuntime(dev.binary, dev.version)
}

async function main(): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) return void process.stdout.write(HELP)
  if (args.includes('--version') || args.includes('-v')) return console.log(pkg.version)

  const binary = await findRuntime()
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

void main()
