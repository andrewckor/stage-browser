// Scripted self-test: `npm run selftest`. No human input. Writes results.json and PNGs, exits 0 or 1.
import { app, BaseWindow, BrowserWindow, Menu, screen, shell, type NativeImage, type Rectangle, type Size } from 'electron'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { crc32 } from 'node:zlib'
import { parseArgs, readHandoff } from './cli-args'
import type { Ctx } from './context'
import { idFromPublicKey, unzip, verifyCrx } from './crx'
import { installed, type ActionPopup } from './extensions'
import { firefoxUA, isGoogleSignIn } from './google-sign-in'
import type { TabLayout } from '../shared/contract'
import { readPrefs } from './store'
import { suggest } from './suggest'
import { NEWTAB_FILE, type Tab } from './tabs'
import { resolveInput } from './url'
import { NAME, launcherOf, updatesDir } from '../update/common'
import { detectInstall, type InstallKind } from '../update/install'
import { unpack } from '../update/package'
import { parseLatest, readCapped } from '../update/registry'
import { CONFIRM_AFTER_MS, afterSighting, availableVersion, isDue, type CheckState } from '../update/state'
import { verifyProvenance } from '../update/verify'
import { isNewer, isStable } from '../update/version'
import { SHADOW_ROOM, SIDEBAR_WIDTH } from './window'
import { extensionsDir, install, installCrx, remove, webStoreId } from './web-store'

interface Outcome {
  pass: boolean
  detail?: string
}

interface Result {
  name: string
  pass: boolean
  detail: string
}

interface Diagnostics {
  pageConsole: string[]
  swConsole: string[]
  swRunning: string[] | null
  popupDom: unknown
  newTabsAfterClick?: string[]
  newTabText?: string
}

const OUT = resolve(process.env.STAGE_SELFTEST_OUT || './selftest-out')
const OKTA_ID = 'glnpjglilkicbckjpbgcfkogebgllemb'

type Truthy<T> = Exclude<T, false | 0 | '' | null | undefined>

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitFor<T>(fn: () => T | Promise<T>, timeout = 25_000, step = 100): Promise<Truthy<T>> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v as Truthy<T>
    if (Date.now() - t0 > timeout) throw new Error('timeout waiting for condition')
    await sleep(step)
  }
}

// Draws PNG layers over each other in a hidden window's canvas; returns base64 PNG.
// `offsets` places a layer at x,y in DIPs of a page `dipWidth` wide (the sidebar on the right edge).
async function composite(layers: readonly NativeImage[], offsets: readonly { x: number; y: number }[] = [], dipWidth = 1): Promise<string> {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  try {
    await win.loadURL('about:blank')
    const urls = layers.map((img) => img.toDataURL())
    const dataUrl: string = await win.webContents.executeJavaScript(`(async () => {
      const urls = ${JSON.stringify(urls)};
      const offsets = ${JSON.stringify(offsets)};
      const imgs = await Promise.all(urls.map(u => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u })));
      const c = document.createElement('canvas'); c.width = imgs[0].width; c.height = imgs[0].height;
      const g = c.getContext('2d');
      const k = imgs[0].width / ${dipWidth};
      imgs.forEach((i, n) => g.drawImage(i, (offsets[n]?.x ?? 0) * k, (offsets[n]?.y ?? 0) * k));
      return c.toDataURL('image/png');
    })()`)
    return dataUrl.replace(/^data:image\/png;base64,/, '')
  } finally {
    win.destroy()
  }
}

function writeExtension(prefix: string, manifest: object, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

// --- Synthetic extension packages, for the installer checks. ---

interface ZipEntry {
  name: string
  data: string | Buffer
  /** Unix mode in the external attributes, e.g. 0o120777 for a symlink. */
  mode?: number
}

function makeZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const data = Buffer.from(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(0x031e, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt32LE(crc32(data), 16)
    dir.writeUInt32LE(data.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(name.length, 28)
    dir.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38)
    dir.writeUInt32LE(offset, 42)
    locals.push(local, name, data)
    central.push(dir, name)
    offset += local.length + name.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const varint = (value: number): Buffer => {
  const out: number[] = []
  for (let n = value; ; n = Math.floor(n / 128)) {
    out.push(n >= 128 ? (n % 128) | 0x80 : n)
    if (n < 128) break
  }
  return Buffer.from(out)
}

// A length-delimited protobuf field.
const field = (num: number, bytes: Buffer): Buffer => Buffer.concat([varint(num * 8 + 2), varint(bytes.length), bytes])

function newKey() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  return { privateKey, spki, id: idFromPublicKey(spki) }
}

/** A CRX3 whose signed ID is `idKey`'s and whose proofs are made by `signers` (default: `idKey` alone). */
function makeCrx(zip: Buffer, idKey: ReturnType<typeof newKey>, signers = [idKey]): Buffer {
  const crxId = createHash('sha256').update(idKey.spki).digest().subarray(0, 16)
  const signedData = field(1, crxId)
  const length = Buffer.alloc(4)
  length.writeUInt32LE(signedData.length)
  const message = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), length, signedData, zip])
  const proofs = signers.map((k) => field(2, Buffer.concat([field(1, k.spki), field(2, sign('sha256', message, k.privateKey))])))
  const header = Buffer.concat([...proofs, field(10000, signedData)])
  const head = Buffer.alloc(12)
  head.write('Cr24', 0, 'latin1')
  head.writeUInt32LE(3, 4)
  head.writeUInt32LE(header.length, 8)
  return Buffer.concat([head, header, zip])
}

const MANIFEST = JSON.stringify({ manifest_version: 3, name: 'Stage test ext', version: '1.0' })
const throws = (fn: () => unknown): boolean => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

const loaded = (t: Tab) => !t.loading && !!t.url && !!t.title

const sameRect = (a: Rectangle, b: Rectangle) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

// Resolves on the window event, or after `ms` if it never comes.
const once = (win: BaseWindow, event: 'enter-full-screen' | 'leave-full-screen' | 'minimize' | 'restore', ms = 3000) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms)
    win.once(event as 'minimize', () => {
      clearTimeout(t)
      r()
    })
  })

export async function run(ctx: Ctx): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const results: Result[] = []
  const uncaught: string[] = []
  ctx.holdQuit = true // keep the app alive after the close-window check so results get written
  process.on('uncaughtException', (e) => {
    uncaught.push(String(e.stack ?? e))
    console.error('[selftest] uncaughtException', e)
  })

  const check = async (name: string, fn: () => Promise<Outcome>) => {
    let outcome: Outcome
    try {
      outcome = await fn()
    } catch (e) {
      outcome = { pass: false, detail: 'threw: ' + (e instanceof Error ? e.message : String(e)) }
    }
    const result = { name, pass: outcome.pass, detail: outcome.detail ?? '' }
    results.push(result)
    console.log(`[selftest] ${result.pass ? 'PASS' : 'FAIL'} ${name} ${result.detail}`)
  }
  const save = (name: string, data: string | Buffer) => writeFileSync(join(OUT, name), data)
  const { tabs, reveal, win } = ctx
  const uiWin = ctx.ui.win
  const ui = ctx.ui.view.webContents
  // The UI window should sit exactly over the page window's content area, `height` tall.
  const overContent = (height: number) => {
    const c = win.getContentBounds()
    return uiWin.isVisible() && sameRect(uiWin.getBounds(), { ...c, height })
  }
  const activeTab = (): Tab => {
    const t = tabs.active
    if (!t) throw new Error('no active tab')
    return t
  }
  const only = (keep: readonly Tab[]) => {
    for (const t of tabs.list.filter((x) => !keep.includes(x))) tabs.close(t.id)
  }

  await check('page window and UI child window exist; new tab page present when empty', async () => {
    tabs.create()
    const child = win.getChildWindows().some((w) => w.id === uiWin.id) && uiWin.getParentWindow()?.id === win.id
    const protectedUi = uiWin.isContentProtected() && !uiWin.isFocusable()
    return {
      pass: tabs.list.length === 1 && !!tabs.list[0]?.newTab && child && protectedUi,
      detail: `newtab.html exists=${existsSync(NEWTAB_FILE)} child=${child} protected+unfocusable=${protectedUi}`,
    }
  })
  only([])

  let t1!: Tab
  let t2!: Tab
  const openWorkingSet = () => {
    t1 = tabs.create({ url: 'https://example.com', activate: true })
    t2 = tabs.create({ url: 'https://en.wikipedia.org/wiki/Web_browser', activate: false })
  }

  await check('launch with two URLs: both load with title', async () => {
    openWorkingSet()
    await waitFor(() => loaded(t1) && loaded(t2))
    return { pass: /Example Domain/.test(t1.title) && /Web browser/i.test(t2.title), detail: `${t1.title} | ${t2.title}` }
  })
  only([t1, t2]) // drop the fresh tab that replaced the one closed above

  await check('favicon and state pushed (wikipedia)', async () => {
    await waitFor(() => t2.favicon, 15_000).catch(() => {})
    const w = ctx.getState().tabs.find((t) => t.id === t2.id)
    return { pass: !!(w?.favicon && w.title && w.url), detail: `favicon=${w?.favicon}` }
  })

  await check('user agent has no Electron/Stage token', async () => {
    const ua: string = await t1.wc.executeJavaScript('navigator.userAgent')
    const bad = /Electron|stage-browser|Stage\//i
    return { pass: !bad.test(ua) && !bad.test(ctx.session.getUserAgent()), detail: ua }
  })

  await check('google sign-in: firefox version and host rules', async () => {
    const at = (y: number, m: number, d: number) => /rv:(\d+)/.exec(firefoxUA(Date.UTC(y, m, d)))?.[1]
    const versions = [at(2025, 0, 1), at(2025, 6, 23), at(2026, 10, 21)]
    const hosts: [string, boolean][] = [
      ['https://accounts.google.com/v3/signin/identifier', true],
      ['http://accounts.google.com/', false],
      ['https://accounts.google.com.example.com/', false],
      ['https://myaccount.google.com/', false],
      ['https://mail.google.com/', false],
      ['not a url', false],
    ]
    const wrong = hosts.filter(([url, want]) => isGoogleSignIn(url) !== want).map(([url]) => url)
    const pass = versions.join() === '140,140,157' && !wrong.length
    return { pass, detail: `versions=${versions.join()} wrong=${wrong.join(' ') || 'none'}` }
  })

  // Each case ends somewhere else than it starts. Redirects across the sign-in host used to
  // abort Electron, so reaching the end of the list is itself part of the check.
  await check('google sign-in sees Firefox, other sites see Chrome, across redirects', async () => {
    let sent: Record<string, string> = {}
    ctx.session.webRequest.onSendHeaders({ urls: ['https://accounts.google.com/*'] }, (d) => {
      if (d.resourceType === 'mainFrame') sent = d.requestHeaders
    })
    const visit = async (url: string, endsOnSignIn: boolean) => {
      sent = {}
      let navigated = false
      t1.wc.once('did-navigate', () => (navigated = true))
      t1.wc.loadURL(url).catch(() => {})
      await waitFor(() => navigated && isGoogleSignIn(t1.wc.getURL()) === endsOnSignIn && !t1.wc.isLoading()).catch(() => {
        throw new Error(`${url} stuck at ${t1.wc.getURL()} navigated=${navigated} loading=${t1.wc.isLoading()}`)
      })
      const page: string = await t1.wc.executeJavaScript('navigator.userAgent + "|" + navigator.appVersion')
      return { url: t1.wc.getURL(), page, header: sent['User-Agent'] ?? '', hints: Object.keys(sent).some((k) => /^sec-ch-ua/i.test(k)) }
    }
    try {
      const cases = [
        { name: 'direct', ...(await visit('https://accounts.google.com/ServiceLogin?hl=en', true)) },
        { name: 'redirect in', ...(await visit('https://www.google.com/accounts/ServiceLogin?hl=en', true)) },
        { name: 'redirect out', ...(await visit('https://accounts.google.com/Logout?continue=https://www.google.com/&hl=en', false)) },
        { name: 'elsewhere', ...(await visit('https://example.com/', false)) },
      ]
      const wrong = cases.filter((c) => {
        const firefox = isGoogleSignIn(c.url)
        if (firefox) return !/Firefox\/.*\|5\.0 \(Macintosh/.test(c.page) || !/Firefox\//.test(c.header) || c.hints
        return /Firefox/.test(c.page) || !/Chrome\//.test(c.page)
      })
      return { pass: !wrong.length, detail: cases.map((c) => `${c.name}: ${new URL(c.url).hostname} ${/Firefox/.test(c.page) ? 'firefox' : 'chrome'}`).join(' | ') }
    } finally {
      ctx.session.webRequest.onSendHeaders(null)
    }
  })

  await check('url resolution cases', async () => {
    const cases: [input: string, want: string][] = [
      ['https://a.com/x', 'https://a.com/x'],
      ['example.com', 'https://example.com'],
      ['example.com/path?q=1', 'https://example.com/path?q=1'],
      ['localhost:3000', 'http://localhost:3000'],
      ['127.0.0.1:8080/a', 'http://127.0.0.1:8080/a'],
      ['localhost', 'http://localhost'],
      ['about:blank', 'about:blank'],
      ['hello world', 'https://www.google.com/search?q=hello%20world'],
      ['stage', 'https://www.google.com/search?q=stage'],
      ['what is 3.5', 'https://www.google.com/search?q=what%20is%203.5'],
      ['zoommtg://x', 'zoommtg://x'],
    ]
    const bad = cases.filter(([i, o]) => resolveInput(i) !== o).map(([i, o]) => `${i} -> ${resolveInput(i)} (want ${o})`)
    return { pass: bad.length === 0, detail: bad.join('; ') }
  })

  await check('cli-args parsing', async () => {
    const a = parseArgs(['electron', '.', '--inspect=1', '--size', '1280x720', 'a.com', '--pin', '--fresh', 'hello world'])
    return { pass: a.pin && a.fresh && a.size?.width === 1280 && a.size.height === 720 && a.urls.join('|') === 'a.com|hello world', detail: JSON.stringify(a) }
  })

  await check('second launch: urls only, never the install path, and quit only when sent', async () => {
    const root = '/opt/lib/node_modules/stage-browser'
    const old = readHandoff(['/x/Electron', '--pin', '--allow-file-access', root, 'a.com', 'hello world'], undefined)
    const sized = readHandoff(['/x/Electron', '--size', '--allow-file-access', root, 'a.com', '800x600'], undefined)
    const dot = readHandoff(['/x/Electron', '.', 'a.com'], null)
    const sent = readHandoff(['/x/Electron', '--quit-running', '.', 'ignored'], { args: { urls: ['b.com', 7, 'x'.repeat(40_000)], size: { width: '1;2', height: 5 }, pin: 'yes', fresh: true }, quit: false })
    const spoofed = readHandoff(['/x/Electron', '.', '--quit-running'], undefined)
    const quit = readHandoff([], { args: { urls: [] }, quit: true })
    const ok = old.args.urls.join('|') === 'a.com|hello world' && old.args.pin && dot.args.urls.join('|') === 'a.com'
    const strict = sent.args.urls.join('|') === 'b.com' && !sent.args.size && !sent.args.pin && sent.args.fresh && !sent.quit && !spoofed.quit && quit.quit
    const moved = sized.args.urls.join('|') === 'a.com' && sized.args.size?.width === 800
    return { pass: ok && strict && moved, detail: JSON.stringify({ old, dot, sized, sent, spoofed }) }
  })

  await check('update versions: releases only, never a downgrade', async () => {
    const valid = ['0.0.1', '10.20.30'].every(isStable)
    const invalid = ['1.2', 'v1.2.3', '01.2.3', '1.2.3-rc.1', '../../x', '1.2.3\n', '1.2.3/..', 1, null].every((v) => !isStable(v))
    const order = isNewer('0.10.0', '0.9.9') && isNewer('1.0.0', '1.0.0-rc.1') && !isNewer('1.0.0', '1.0.0') && !isNewer('0.3.2', '0.4.0') && !isNewer('junk', '0.4.0')
    let refused = 0
    for (const body of ['{"latest":"latest"}', '{"latest":"../1.0.0"}', '[]', 'null', '<html>']) {
      try {
        parseLatest(Buffer.from(body))
      } catch {
        refused++
      }
    }
    const capped = await readCapped(new Response('x'.repeat(5000)), 4096).then(() => false, () => true)
    return { pass: valid && invalid && order && refused === 5 && capped, detail: `valid=${valid} invalid=${invalid} order=${order} refused=${refused}/5 capped=${capped}` }
  })

  await check('update news: second sighting an hour later, withdrawn releases disappear', async () => {
    const t = 1_800_000_000_000
    const h = CONFIRM_AFTER_MS
    const none: CheckState = { latest: null, latestAt: 0, announced: null, attemptedAt: 0, attemptFailed: false, updateFailed: false }
    const first = afterSighting(none, '0.5.0', '0.4.0', t, false)
    const early = afterSighting(first, '0.5.0', '0.4.0', t + h - 1, false)
    const second = afterSighting(first, '0.5.0', '0.4.0', t + h, false)
    const byHand = afterSighting(none, '0.5.0', '0.4.0', t, true)
    const newer = afterSighting(second, '0.6.0', '0.4.0', t + 2 * h, false)
    const pulled = afterSighting(second, '0.4.0', '0.4.0', t + 2 * h, false)
    const shown = [first, early, second, byHand, newer, pulled].map((x) => availableVersion(x, '0.4.0') ?? '-').join(' ')
    const due = !isDue(first, '0.4.0', t + h - 1) && isDue(first, '0.4.0', t + h) && !isDue(second, '0.4.0', t + h + h) && isDue(second, '0.4.0', t + h + 24 * h)
    return { pass: shown === '- - 0.5.0 0.5.0 0.5.0 -' && due, detail: `shown=${shown} due=${due}` }
  })

  await check('update install kinds: only npx, staged and own global copies install themselves; locked ones get sudo', async () => {
    const base = mkdtempSync(join(tmpdir(), 'stage-kinds-'))
    const userData = join(base, 'profile')
    const copy = (...at: string[]) => {
      const root = join(base, ...at)
      mkdirSync(join(root, 'dist', 'bin'), { recursive: true })
      writeFileSync(launcherOf(root), '')
      return root
    }
    const global = copy('prefix', 'lib', 'node_modules', NAME)
    mkdirSync(join(base, 'prefix', 'bin'))
    symlinkSync(launcherOf(global), join(base, 'prefix', 'bin', 'stage'))
    const system = copy('locked', 'lib', 'node_modules', NAME)
    mkdirSync(join(base, 'locked', 'bin'))
    symlinkSync(launcherOf(system), join(base, 'locked', 'bin', 'stage'))
    const locked = [dirname(system), system]
    for (const dir of locked) chmodSync(dir, 0o555)
    const cases: [root: string, want: InstallKind][] = [
      [copy('checkout'), 'dev'],
      [copy('.npm', '_npx', 'bad26ad5956fda27', 'node_modules', NAME), 'npx'],
      [global, 'global'],
      [system, 'system'],
      [copy('other', 'lib', 'node_modules', NAME), 'manual'],
      [copy('project', 'node_modules', NAME), 'manual'],
      [copy('.volta', 'tools', 'lib', 'node_modules', NAME), 'manual'],
      [copy('profile', 'Updates', '0.5.0'), 'staged'],
    ]
    mkdirSync(updatesDir(userData), { recursive: true })
    const got = cases.map(([root]) => detectInstall(root, userData))
    for (const dir of locked) chmodSync(dir, 0o755)
    rmSync(base, { recursive: true, force: true })
    const bad = cases.flatMap(([root, want], i) => (got[i]?.kind === want ? [] : [`${root} -> ${got[i]?.kind} (want ${want})`]))
    const leak = got.some((i) => i.command.includes(base))
    const sudo = got[cases.findIndex(([root]) => root === system)]?.command.startsWith('sudo npm i -g ')
    return { pass: !bad.length && !leak && !!sudo, detail: `${bad.join('; ')} pathInCommand=${leak} sudo=${sudo}` }
  })

  await check('update packages: unsigned, linked, misnamed and incomplete ones are refused', async () => {
    const base = mkdtempSync(join(tmpdir(), 'stage-unpack-'))
    const accepts = (name: string, pkg: object, link?: string): boolean => {
      const src = join(base, name, 'package')
      const dest = join(base, name, 'dest')
      mkdirSync(join(src, 'dist', 'bin'), { recursive: true })
      mkdirSync(dest)
      writeFileSync(launcherOf(src), '')
      writeFileSync(join(src, 'package.json'), JSON.stringify(pkg))
      if (link) symlinkSync(link, join(src, 'escape'))
      const made = join(base, name, 'made.tgz')
      execFileSync('/usr/bin/tar', ['-czf', made, '-C', join(base, name), 'package'])
      try {
        unpack(readFileSync(made), join(base, name, 'received.tgz'), dest, '9.9.9')
        return true
      } catch {
        return false
      }
    }
    const good = accepts('good', { name: NAME, version: '9.9.9' })
    const bad = [accepts('link', { name: NAME, version: '9.9.9' }, '/etc/hosts'), accepts('name', { name: 'other', version: '9.9.9' }), accepts('version', { name: NAME, version: '9.9.8' }), accepts('dependency', { name: NAME, version: '9.9.9', dependencies: { missing: '1.0.0' } })]
    rmSync(base, { recursive: true, force: true })
    let unsigned = 0
    for (const attestations of [null, {}, { attestations: [] }, { attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: {} }] }]) {
      try {
        verifyProvenance(attestations, Buffer.alloc(1), '9.9.9', {} as Parameters<typeof verifyProvenance>[3])
      } catch {
        unsigned++
      }
    }
    return { pass: good && !bad.includes(true) && unsigned === 4, detail: `good=${good} bad=${bad} unsigned=${unsigned}/4` }
  })

  await check('update popover: protected, focused, out of reach of pages', async () => {
    const page: string = await t1.wc.executeJavaScript('typeof window.stage')
    await ui.executeJavaScript('window.stage.openUpdate()')
    await waitFor(() => ctx.overlay?.type === 'update', 3000)
    const open: { shown: boolean; focus: string } = await waitFor(
      () => ui.executeJavaScript("document.querySelector('#update').hidden ? null : { shown: document.querySelector('#update-panel').getClientRects().length > 0, focus: document.activeElement.id }"),
      3000,
    )
    const protectedUi = uiWin.isContentProtected()
    await ui.executeJavaScript('window.stage.installUpdate()') // a source checkout never installs
    await sleep(200)
    const { status, canInstall } = ctx.getState().update
    await ui.executeJavaScript('window.stage.closeOverlay()')
    await waitFor(() => ctx.overlay === null, 3000)
    const pass = page === 'undefined' && open.shown && open.focus === 'update-panel' && protectedUi && status === 'idle' && !canInstall
    return { pass, detail: JSON.stringify({ page, ...open, protectedUi, status, canInstall }) }
  })

  await check('update check: asks npm by hand and reports', async () => {
    await ctx.updates.checkByHand()
    const { status, available, message } = ctx.getState().update
    ctx.reveal.closeOverlay()
    return { pass: status === 'current' || (status === 'idle' && !!available), detail: JSON.stringify({ status, available, message }) }
  })

  await check('activate / close / reopen closed tab', async () => {
    tabs.activate(t1.id)
    const ok1 = ctx.getState().activeTabId === t1.id && t1.view.getVisible() && !t2.view.getVisible()
    const url2 = t2.url
    tabs.close(t2.id)
    const ok2 = tabs.list.length === 1
    tabs.reopenClosed()
    await sleep(200)
    const reopened = tabs.list.find((x) => x.id !== t1.id)
    if (!reopened) return { pass: false, detail: 'nothing reopened' }
    t2 = reopened
    const ok3 = tabs.list.length === 2 && tabs.activeId === t2.id
    await waitFor(() => loaded(t2))
    return { pass: ok1 && ok2 && ok3 && t2.url === url2, detail: `visibleOnlyActive=${ok1} closed=${ok2} reopened=${ok3} url=${t2.url}` }
  })

  await check('closing the last tab leaves a new-tab page', async () => {
    const t = tabs.create({ url: 'about:blank' })
    only([t])
    await sleep(100)
    const single = tabs.list.length === 1
    tabs.close(t.id)
    await sleep(300)
    const newTab = tabs.list.length === 1 && !!tabs.list[0]?.newTab
    const placeholder = tabs.list[0]
    openWorkingSet()
    if (placeholder) tabs.close(placeholder.id)
    await waitFor(() => loaded(t1) && loaded(t2))
    tabs.activate(t1.id)
    return { pass: single && newTab, detail: `single=${single} newtab=${newTab}` }
  })

  await check("suggest('wiki') returns open tab + history", async () => {
    const t3 = tabs.create({ url: 'https://en.wikipedia.org/wiki/Google_Chrome', activate: false })
    await waitFor(() => loaded(t3))
    tabs.close(t3.id)
    const s = suggest(tabs.list, 'wiki')
    const okTab = s.some((x) => x.kind === 'tab' && x.tabId === t2.id)
    const okHist = s.some((x) => x.kind === 'history' && /Google_Chrome/.test(x.url))
    return { pass: s[0]?.kind === 'search' && okTab && okHist && s.length <= 8, detail: JSON.stringify(s.map((x) => [x.kind, x.url])) }
  })

  await check('suggest: url and search first items', async () => {
    const a = suggest(tabs.list, 'example.org')[0]
    const b = suggest(tabs.list, 'two words')[0]
    return { pass: a?.kind === 'url' && a.url === 'https://example.org' && b?.kind === 'search', detail: `${a?.kind} ${b?.kind}` }
  })

  const shot = async (name: string): Promise<{ page: Size; ui: Size }> => {
    const page = await activeTab().wc.capturePage()
    const bar = await ui.capturePage()
    save(`${name.replace('composite', 'page')}.png`, page.toPNG())
    save(`${name.replace('composite', 'ui')}.png`, bar.toPNG())
    save(`${name}.png`, Buffer.from(await composite([page, bar]), 'base64'))
    return { page: page.getSize(), ui: bar.getSize() }
  }

  await check('reveal bar: state pushed visible, UI window shown over the strip, composite captured', async () => {
    reveal.setHover(true) // the real cursor is elsewhere; keep the poller from hiding the bar
    try {
      reveal.show()
      await sleep(1200)
      const sizes = await shot('bar-composite')
      const over = overContent(72)
      return { pass: ctx.bar.visible && over && sizes.ui.height > 0, detail: JSON.stringify({ sizes, ui: uiWin.getBounds(), content: win.getContentBounds() }) }
    } finally {
      reveal.setHover(false) // a failed capture must not leave the bar pinned for later checks
    }
  })

  await check('UI window follows the page window when it moves', async () => {
    reveal.setHover(true)
    reveal.show()
    const [x = 0, y = 0] = win.getPosition()
    win.setPosition(x + 40, y + 30)
    await sleep(100)
    const moved = overContent(72)
    win.setPosition(x, y)
    await sleep(100)
    const back = overContent(72)
    reveal.setHover(false)
    return { pass: moved && back, detail: JSON.stringify({ moved, back, ui: uiWin.getBounds(), content: win.getContentBounds() }) }
  })

  await check('omnibox overlay: UI window covers the content area and takes focus, composite captured', async () => {
    reveal.openOverlay('new', '')
    await sleep(800)
    await ui
      .executeJavaScript(`(() => { const i = document.querySelector('input'); if (i) { i.focus(); i.value = 'wiki'; i.dispatchEvent(new Event('input', { bubbles: true })) } return !!i })()`)
      .catch(() => {})
    await sleep(900)
    const [, h = 0] = win.getContentSize()
    const full = overContent(h)
    const focusable = uiWin.isFocusable()
    const sizes = await shot('omnibox-composite')
    reveal.closeOverlay()
    const released = !uiWin.isFocusable()
    return { pass: full && focusable && released && !ctx.overlay, detail: JSON.stringify({ full, focusable, released, sizes }) }
  })

  await check('pin: tab view still fills the content area, UI window is the 52px strip over it', async () => {
    reveal.setPinned(true)
    await sleep(100)
    const [cw = 0, ch = 0] = win.getContentSize()
    const fills = sameRect(activeTab().view.getBounds(), { x: 0, y: 0, width: cw, height: ch })
    const strip = overContent(52)
    reveal.setPinned(false)
    const unpinned = sameRect(activeTab().view.getBounds(), { x: 0, y: 0, width: cw, height: ch })
    return { pass: fills && strip && unpinned, detail: JSON.stringify({ fills, strip, unpinned, view: activeTab().view.getBounds() }) }
  })

  await check('hide: state false, UI window hidden after timeout', async () => {
    reveal.hide()
    const stateFalse = !ctx.bar.visible
    await sleep(500)
    return { pass: stateFalse && !uiWin.isVisible(), detail: `uiVisible=${uiWin.isVisible()}` }
  })

  await check('minimize hides the UI window; restore brings it back', async () => {
    reveal.setPinned(true)
    await sleep(100)
    const before = overContent(52)
    const minimized = once(win, 'minimize')
    win.minimize()
    await minimized
    await sleep(200)
    const hiddenWhileMin = win.isMinimized() && !uiWin.isVisible()
    const restored = once(win, 'restore')
    win.restore()
    await restored
    await sleep(300)
    const after = overContent(52)
    reveal.setPinned(false)
    reveal.hide()
    return { pass: before && hiddenWhileMin && after, detail: JSON.stringify({ before, hiddenWhileMin, after }) }
  })

  await check('full screen: the UI window covers the strip of the full-screen window; leaving restores it', async () => {
    reveal.setPinned(true)
    await sleep(100)
    const entered = once(win, 'enter-full-screen', 5000)
    win.setFullScreen(true)
    await entered
    await sleep(500)
    const inFull = win.isFullScreen() && overContent(52) && ctx.getState().fullscreen
    const left = once(win, 'leave-full-screen', 5000)
    win.setFullScreen(false)
    await left
    await sleep(500)
    const out = !win.isFullScreen() && overContent(52)
    reveal.setPinned(false)
    reveal.hide()
    return { pass: inFull && out, detail: JSON.stringify({ inFull, out, ui: uiWin.getBounds(), content: win.getContentBounds() }) }
  })

  await check('floating bar has room for its shadow; clicks under the strip reach the page', async () => {
    const page =
      'data:text/html,' +
      encodeURIComponent('<body style="margin:0"><button style="position:absolute;left:300px;top:55px;width:240px;height:14px" onclick="window.clicked=(window.clicked||0)+1">x</button></body>')
    reveal.closeOverlay()
    reveal.setPinned(false)
    const tab = tabs.create({ url: page, activate: true })
    await waitFor(() => !tab.loading && tab.url.startsWith('data:'))
    reveal.show()
    await sleep(400)
    const floatH = uiWin.getBounds().height
    for (const type of ['mouseDown', 'mouseUp'] as const) ui.sendInputEvent({ type, x: 420, y: 62, button: 'left', clickCount: 1 })
    const clicked = await waitFor((): Promise<number> => tab.wc.executeJavaScript('window.clicked || 0'), 3000).catch(() => 0)
    const hidden = !ctx.bar.visible && !uiWin.isVisible()
    reveal.setPinned(true)
    await sleep(100)
    const pinnedH = uiWin.getBounds().height
    reveal.setPinned(false)
    reveal.hide()
    tabs.close(tab.id)
    return { pass: floatH === 72 && clicked === 1 && hidden && pinnedH === 52, detail: JSON.stringify({ floatH, clicked, hidden, pinnedH }) }
  })

  // --- Sidebar layouts. The poller reads the real cursor, so these checks stand in a fake one. ---
  const realCursor = screen.getCursorScreenPoint.bind(screen)
  const cursorAt = (p: { x: number; y: number } | null) => {
    screen.getCursorScreenPoint = p ? () => p : realCursor
  }
  const content = () => win.getContentBounds()
  // The UI window's rect for a sidebar on `side`, in screen coordinates.
  const sidebarRect = (side: 'left' | 'right', pinned: boolean): Rectangle => {
    const c = content()
    const width = SIDEBAR_WIDTH + (pinned ? 0 : SHADOW_ROOM)
    return { x: side === 'left' ? c.x : c.x + c.width - width, y: c.y, width, height: c.height }
  }
  const edgeCursor = (side: 'left' | 'right', along = 0.5) => {
    const c = content()
    return { x: side === 'left' ? c.x + 2 : c.x + c.width - 3, y: Math.round(c.y + c.height * along) }
  }
  const centerCursor = () => {
    const c = content()
    return { x: Math.round(c.x + c.width / 2), y: Math.round(c.y + c.height / 2) }
  }
  const viewFills = () => {
    const [cw = 0, ch = 0] = win.getContentSize()
    return sameRect(activeTab().view.getBounds(), { x: 0, y: 0, width: cw, height: ch })
  }
  const layoutRadios = () =>
    Menu.getApplicationMenu()
      ?.items.find((i) => i.label === 'View')
      ?.submenu?.items.filter((i) => i.type === 'radio')
      .map((i) => `${i.label}${i.checked ? '*' : ''}`)
      .join('|')
  const radiosFor = (layout: TabLayout) =>
    (['top', 'left', 'right'] as const).map((l) => `Tabs on ${l[0]?.toUpperCase()}${l.slice(1)}${l === layout ? '*' : ''}`).join('|')
  // Whatever a failed sidebar check left behind: layout, pin, hover, omnibox, fake cursor.
  const resetLayout = async () => {
    cursorAt(null)
    reveal.setHover(false)
    reveal.closeOverlay()
    reveal.setPinned(false)
    ctx.setTabLayout('top')
    reveal.hide()
    await sleep(350)
  }
  const proofDir = process.env.STAGE_SELFTEST_SIDEBAR_SHOTS || OUT
  const proof = async (name: string, side: 'left' | 'right', pinned: boolean) => {
    const page = await activeTab().wc.capturePage()
    const bar = await ui.capturePage()
    mkdirSync(proofDir, { recursive: true })
    const r = sidebarRect(side, pinned)
    const png = await composite([page, bar], [{ x: 0, y: 0 }, { x: r.x - content().x, y: 0 }], content().width)
    writeFileSync(join(proofDir, `${name}.png`), Buffer.from(png, 'base64'))
  }

  tabs.activate(t1.id)
  for (const side of ['left', 'right'] as const) {

    await check(`sidebar ${side}: pref switches and persists, menu radio and state follow, no restart`, async () => {
      try {
        ctx.setTabLayout(side)
        const r = { pref: ctx.prefs.tabLayout === side, saved: readPrefs().tabLayout === side, radios: layoutRadios() === radiosFor(side), state: ctx.getState().tabLayout === side }
        ctx.setTabLayout('top')
        const back = { pref: ctx.prefs.tabLayout === 'top', saved: readPrefs().tabLayout === 'top', radios: layoutRadios() === radiosFor('top') }
        return { pass: Object.values(r).every(Boolean) && Object.values(back).every(Boolean), detail: JSON.stringify({ r, back, radios: layoutRadios() }) }
      } finally {
        await resetLayout()
      }
    })

    await check(`sidebar ${side}: pinned strip sits on the ${side} edge at full height, floating adds shadow room, page view fills`, async () => {
      try {
        ctx.setTabLayout(side)
        reveal.setPinned(true)
        await sleep(300)
        const pinned = sameRect(uiWin.getBounds(), sidebarRect(side, true)) && uiWin.isVisible()
        const fillsPinned = viewFills()
        const guarded = uiWin.isContentProtected() && !uiWin.isFocusable()
        reveal.setPinned(false)
        reveal.show()
        await sleep(300)
        const floating = sameRect(uiWin.getBounds(), sidebarRect(side, false))
        const fills = viewFills()
        const dom: boolean = await ui.executeJavaScript(`document.documentElement.dataset.side === '${side}'`)
        const r = { pinned, fillsPinned, guarded, floating, fills, dom }
        return { pass: Object.values(r).every(Boolean), detail: JSON.stringify({ ...r, ui: uiWin.getBounds(), want: sidebarRect(side, false), content: content() }) }
      } finally {
        await resetLayout()
      }
    })

    await check(`sidebar ${side}: touching the ${side} edge reveals, leaving hides after the delay, the top edge does not reveal`, async () => {
      try {
        ctx.setTabLayout(side)
        reveal.hide()
        await sleep(400)
        const c = content()
        cursorAt({ x: c.x + Math.round(c.width / 2), y: c.y + 2 })
        await sleep(400)
        const topInert = !ctx.bar.visible && !uiWin.isVisible()
        const seen: boolean[] = []
        for (const along of [0.02, 0.5, 0.98]) {
          cursorAt(edgeCursor(side, along))
          await sleep(400)
          seen.push(ctx.bar.visible && uiWin.isVisible())
          cursorAt(centerCursor())
          reveal.setHover(false) // the real pointer may rest over the strip; the faked one has left
          await sleep(1100)
          seen.push(!ctx.bar.visible && !uiWin.isVisible())
        }
        // Inside the strip it stays up, however long the cursor rests there.
        cursorAt({ x: edgeCursor(side).x + (side === 'left' ? 100 : -100), y: edgeCursor(side).y })
        reveal.show()
        await sleep(900)
        const stays = ctx.bar.visible
        const r = { topInert, seen: seen.every(Boolean), stays }
        return { pass: Object.values(r).every(Boolean), detail: JSON.stringify({ ...r, seen }) }
      } finally {
        await resetLayout()
      }
    })

    await check(`sidebar ${side}: a click outside the sidebar reaches the page`, async () => {
      try {
        const [cw = 0] = win.getContentSize()
        const left = side === 'left' ? 230 : cw - 290 // spans the shadow room beside the sidebar
        const page = 'data:text/html,' + encodeURIComponent(`<body style="margin:0"><button style="position:absolute;left:${left}px;top:270px;width:100px;height:60px" onclick="window.clicked=(window.clicked||0)+1">x</button></body>`)
        const tab = tabs.create({ url: page, activate: true })
        await waitFor(() => !tab.loading && tab.url.startsWith('data:'))
        ctx.setTabLayout(side)
        reveal.show()
        reveal.setHover(true)
        cursorAt(centerCursor())
        await sleep(400)
        const x = side === 'left' ? SIDEBAR_WIDTH + SHADOW_ROOM / 2 : SHADOW_ROOM / 2
        for (const type of ['mouseDown', 'mouseUp'] as const) ui.sendInputEvent({ type, x, y: 300, button: 'left', clickCount: 1 })
        const clicked = await waitFor((): Promise<number> => tab.wc.executeJavaScript('window.clicked || 0'), 3000).catch(() => 0)
        await sleep(300)
        const hidden = !ctx.bar.visible && !uiWin.isVisible()
        tabs.close(tab.id)
        tabs.activate(t1.id)
        return { pass: clicked === 1 && hidden, detail: JSON.stringify({ clicked, hidden }) }
      } finally {
        await resetLayout()
      }
    })

    await check(`sidebar ${side}: pin keeps it up over an unchanged page; unpin and switching to Top restore the top bar`, async () => {
      try {
        ctx.setTabLayout(side)
        reveal.setPinned(true)
        await sleep(300)
        const up = ctx.bar.visible && ctx.bar.pinned && ctx.getState().bar.pinned && uiWin.isVisible() && viewFills()
        const item = Menu.getApplicationMenu()
          ?.items.find((i) => i.label === 'View')
          ?.submenu?.items.find((i) => i.label === 'Pin Tab Bar')
        const checked = !!item?.checked
        cursorAt(centerCursor())
        await sleep(900)
        const stays = uiWin.isVisible()
        ctx.setTabLayout('top')
        await sleep(300)
        const top = overContent(52) && viewFills() && ctx.bar.pinned
        reveal.setPinned(false)
        await sleep(100)
        const floatTop = ctx.bar.visible && uiWin.getBounds().height === 72 && uiWin.getBounds().width === content().width
        const dom: boolean = await ui.executeJavaScript('document.documentElement.dataset.side === undefined')
        const r = { up, checked, stays, top, floatTop, dom }
        return { pass: Object.values(r).every(Boolean), detail: JSON.stringify(r) }
      } finally {
        await resetLayout()
      }
    })

    await check(`sidebar ${side}: screenshots (revealed${side === 'left' ? ', pinned' : ''})`, async () => {
      try {
        ctx.setTabLayout(side)
        cursorAt(edgeCursor(side))
        await sleep(1400)
        await proof(`sidebar-${side}-revealed`, side, false)
        if (side === 'left') {
          cursorAt(centerCursor())
          reveal.setPinned(true)
          await sleep(1000)
          await proof('sidebar-left-pinned', side, true)
        }
        return { pass: true, detail: proofDir }
      } finally {
        await resetLayout()
      }
    })
  }

  await check('sidebar: switching layouts while visible, pinned or in the omnibox leaves no stale window', async () => {
    try {
      // Visible, unpinned: switching drops the window.
      ctx.setTabLayout('left')
      reveal.setHover(true)
      reveal.show()
      await sleep(300)
      ctx.setTabLayout('right')
      await sleep(300)
      const dropped = !ctx.bar.visible && !uiWin.isVisible()
      // Pinned: it follows to the new edge.
      reveal.setPinned(true)
      await sleep(300)
      ctx.setTabLayout('left')
      await sleep(300)
      const pinnedLeft = sameRect(uiWin.getBounds(), sidebarRect('left', true)) && uiWin.isVisible()
      ctx.setTabLayout('right')
      await sleep(300)
      const pinnedRight = sameRect(uiWin.getBounds(), sidebarRect('right', true)) && uiWin.isVisible()
      reveal.setPinned(false)
      reveal.setHover(false)
      reveal.hide()
      await sleep(400)
      // Omnibox open: the window keeps covering the content, and closing it leaves the sidebar's own rect.
      reveal.openOverlay('new', '')
      await sleep(400)
      ctx.setTabLayout('top')
      await sleep(300)
      const [, h = 0] = win.getContentSize()
      const covers = overContent(h) && !!ctx.overlay
      reveal.closeOverlay()
      reveal.hide()
      await sleep(500)
      const closed = !uiWin.isVisible() && !ctx.overlay && !uiWin.isFocusable()
      const r = { dropped, pinnedLeft, pinnedRight, covers, closed }
      return { pass: Object.values(r).every(Boolean), detail: JSON.stringify(r) }
    } finally {
      await resetLayout()
    }
  })

  await check('extension icons: shown with a button extension, hidden by the menu option, gone with none installed', async () => {
    const dir = writeExtension('stage-action-ext-', { manifest_version: 3, name: 'Stage action probe', version: '1.0', action: { default_title: 'Probe' } })
    const probe = await ctx.session.extensions.loadExtension(dir)
    const controlsShown = (): Promise<boolean> => ui.executeJavaScript("document.getElementById('controls').checkVisibility()")
    reveal.show()
    await sleep(400)
    const withExt = await controlsShown()
    ctx.setHideExtensionIcons(true)
    await sleep(250)
    const hiddenByOption = !(await controlsShown())
    const item = Menu.getApplicationMenu()
      ?.items.find((i) => i.label === 'Extensions')
      ?.submenu?.items.find((i) => i.label === 'Hide Icons in Tab Bar')
    const checked = !!item?.checked
    const saved = readPrefs().hideExtensionIcons
    ctx.setHideExtensionIcons(false)
    await sleep(250)
    const back = await controlsShown()
    ctx.session.extensions.removeExtension(probe.id)
    await sleep(400)
    const goneWithNone = !(await controlsShown())
    const noPinButton: boolean = await ui.executeJavaScript("!document.getElementById('pin')")
    reveal.hide()
    const r = { withExt, hiddenByOption, checked, saved, back, goneWithNone, noPinButton }
    return { pass: Object.values(r).every(Boolean), detail: JSON.stringify(r) }
  })

  await check('the page window holds only tab views', async () => {
    tabs.create({ url: 'about:blank', activate: false })
    const kids = win.contentView.children
    const onlyTabs = kids.length === tabs.list.length && kids.every((v) => tabs.list.some((t) => t.view === v))
    return { pass: onlyTabs, detail: `children=${kids.length} tabs=${tabs.list.length}` }
  })

  await check('content size 1280x720 sets and centers', async () => {
    win.setContentSize(1280, 720)
    win.center()
    const [w, h] = win.getContentSize()
    return { pass: w === 1280 && h === 720, detail: `${w}x${h}` }
  })

  await check('external scheme from page opens via shell, not in tab', async () => {
    const original = shell.openExternal
    let called = ''
    shell.openExternal = async (url) => {
      called = url
    }
    try {
      const r = tabs.openHandler({
        url: 'zoommtg://zoom.us/join?x=1',
        frameName: '',
        features: '',
        disposition: 'foreground-tab',
        referrer: { url: '', policy: 'default' },
      })
      return { pass: r.action === 'deny' && called.startsWith('zoommtg:'), detail: called }
    } finally {
      shell.openExternal = original
    }
  })

  // Real clicks, so Electron's own window-open path runs (not just openHandler's return value).
  const LINKS_PAGE =
    'data:text/html,' +
    encodeURIComponent(
      '<a id="blank" target="_blank" href="https://example.com/?from=blank">blank</a>' +
        '<script>window.openWithOpener = () => { const w = window.open("about:blank"); return !!w && !w.closed && w.opener === window }</script>',
    )
  const openLinksPage = async () => {
    const src = tabs.create({ url: LINKS_PAGE, activate: true })
    await waitFor(() => !src.loading && src.url.startsWith('data:'))
    return src
  }

  await check('target=_blank link opens the URL in a new active tab', async () => {
    const errorsBefore = uncaught.length
    const src = await openLinksPage()
    const before = tabs.list.length
    await src.wc.executeJavaScript('document.getElementById("blank").click()', true)
    const t = await waitFor(() => tabs.list.length === before + 1 && tabs.list.find((x) => x.url.includes('from=blank')), 15_000)
    const ok = tabs.activeId === t.id && uncaught.length === errorsBefore
    tabs.close(t.id)
    tabs.close(src.id)
    return { pass: ok, detail: t.url }
  })

  await check('window.open() opens a tab that keeps window.opener', async () => {
    const errorsBefore = uncaught.length
    const src = await openLinksPage()
    const before = tabs.list.length
    const hasOpener: boolean = await src.wc.executeJavaScript('window.openWithOpener()', true)
    await waitFor(() => tabs.list.length === before + 1, 5000)
    const t = tabs.list.find((x) => x.id !== src.id && x.id === tabs.activeId)
    if (t) tabs.close(t.id)
    tabs.close(src.id)
    const clean = uncaught.length === errorsBefore
    return { pass: hasOpener && !!t && clean, detail: `opener=${hasOpener} tabs=${tabs.list.length} uncaught=${!clean}` }
  })

  // Opt-in compatibility suite against a real extension from the Web Store. The app itself
  // installs nothing. STAGE_SELFTEST_EXT_ID=<web store id> targets any other extension.
  const goodZip = makeZip([{ name: 'manifest.json', data: MANIFEST }])
  const key = newKey()
  const goodCrx = makeCrx(goodZip, key)
  const versionDirs = (id: string): string[] => (existsSync(join(extensionsDir(), id)) ? readdirSync(join(extensionsDir(), id)).filter((n) => n.endsWith('_0')) : [])

  await check('installer: a signed package installs with its key, loads under its ID, and removes cleanly', async () => {
    const ext = await installCrx(ctx.session, key.id, goodCrx, async () => true)
    const manifestPath = join(extensionsDir(), key.id, '1.0_0', 'manifest.json')
    const stored = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as { key?: string }) : {}
    const r = { loadedId: ext?.id === key.id, keyStored: stored.key === key.spki.toString('base64'), listed: installed(ctx.session).some((e) => e.id === key.id) }
    await remove(ctx.session, key.id)
    const gone = !ctx.session.extensions.getExtension(key.id) && !existsSync(join(extensionsDir(), key.id))
    return { pass: Object.values(r).every(Boolean) && gone, detail: JSON.stringify({ ...r, gone }) }
  })

  await check('installer: one flipped byte in the archive is rejected', async () => {
    const bad = Buffer.from(goodCrx)
    bad.writeUInt8(bad.readUInt8(bad.length - 60) ^ 0xff, bad.length - 60)
    return { pass: throws(() => verifyCrx(bad, key.id)) }
  })

  await check('installer: a package checked against a different extension ID is rejected', async () => {
    return { pass: throws(() => verifyCrx(goodCrx, newKey().id)) && !throws(() => verifyCrx(goodCrx, key.id)) }
  })

  await check('installer: a signature from a key that is not the extension’s own is rejected', async () => {
    const other = newKey()
    const crx = makeCrx(goodZip, key, [other])
    return { pass: throws(() => verifyCrx(crx, key.id)) }
  })

  await check('installer: archive paths that climb out of the folder are rejected, and nothing is written', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'stage-unzip-'))
    const dest = join(parent, 'dest')
    mkdirSync(dest)
    const rejected = throws(() => unzip(makeZip([{ name: 'manifest.json', data: MANIFEST }, { name: '../evil.txt', data: 'x' }]), dest))
    const clean = readdirSync(dest).length === 0 && !existsSync(join(parent, 'evil.txt'))
    rmSync(parent, { recursive: true, force: true })
    return { pass: rejected && clean, detail: JSON.stringify({ rejected, clean }) }
  })

  await check('installer: a symlink in the archive is rejected', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'stage-unzip-'))
    const rejected = throws(() => unzip(makeZip([{ name: 'manifest.json', data: MANIFEST }, { name: 'link', data: '/etc', mode: 0o120777 }]), dest))
    const clean = readdirSync(dest).length === 0
    rmSync(dest, { recursive: true, force: true })
    return { pass: rejected && clean, detail: JSON.stringify({ rejected, clean }) }
  })

  await check('installer: declining the prompt installs nothing', async () => {
    const k = newKey()
    let asked = 0
    const ext = await installCrx(ctx.session, k.id, makeCrx(goodZip, k), async () => {
      asked++
      return false
    })
    const r = { asked, resolvedNull: ext === null, noVersionDir: versionDirs(k.id).length === 0, notLoaded: !ctx.session.extensions.getExtension(k.id) }
    rmSync(join(extensionsDir(), k.id), { recursive: true, force: true })
    return { pass: r.asked === 1 && r.resolvedNull && r.noVersionDir && r.notLoaded, detail: JSON.stringify(r) }
  })

  await check('installer: Web Store listing URLs give their ID, other sites give none', async () => {
    const id = 'abcdefghijklmnopabcdefghijklmnop'
    const r = [webStoreId(`https://chromewebstore.google.com/detail/some-name/${id}`) === id, webStoreId(`https://example.com/detail/${id}`) === null, webStoreId(undefined) === null]
    return { pass: r.every(Boolean), detail: JSON.stringify(r) }
  })

  if (process.env.STAGE_SELFTEST_OKTA || process.env.STAGE_SELFTEST_EXT_ID) {
    const extId = process.env.STAGE_SELFTEST_EXT_ID || OKTA_ID
    // Console output from every extension page and service worker, recorded from before the
    // install so startup errors are caught.
    const diag: Diagnostics = { pageConsole: [], swConsole: [], swRunning: null, popupDom: null }
    app.on('web-contents-created', (_e, wc) => {
      wc.on('console-message', (ev) => {
        const url = wc.isDestroyed() ? '' : wc.getURL()
        if (url.startsWith('chrome-extension://')) diag.pageConsole.push(`[${ev.level}] ${url.split('/').slice(3).join('/')}: ${ev.message} (${ev.sourceId}:${ev.lineNumber})`)
      })
    })
    ctx.session.serviceWorkers.on('console-message', (_e, d) => {
      diag.swConsole.push(`[${d.level}] ${d.message} (${d.sourceUrl}:${d.lineNumber})`)
    })
    const heard = (marker: string) => diag.swConsole.filter((l) => l.includes(marker)).length

    await check(`extension ${extId} installs from the Web Store`, async () => {
      await install(ctx.session, extId, async () => true)
      const list = installed(ctx.session)
      return { pass: list.some((e) => e.id === extId), detail: JSON.stringify(list) }
    })

    await check('extension responds to its toolbar button (popup or page)', async () => {
      tabs.activate(t1.id)
      reveal.setHover(true)
      reveal.show()
      await sleep(2500)
      const desc: string = await ui.executeJavaScript(`(() => {
        const l = document.querySelector('browser-action-list'); if (!l) return 'no element';
        const r = l.shadowRoot; const btns = r ? r.querySelectorAll('button, .action, [part]') : [];
        return 'buttons=' + btns.length + ' html=' + (r ? r.innerHTML.slice(0, 300) : 'no shadow')
      })()`)
      await shot('ext-bar-composite').catch(() => {}) // screenshots need an awake display; the check doesn't
      let popupInfo = 'not attempted'
      const tabsBefore = new Set(tabs.list.map((t) => t.id))
      const popupCreated = new Promise<ActionPopup>((res) => ctx.ext.once('browser-action-popup-created', (p: ActionPopup) => res(p)))
      await ui.executeJavaScript(`(() => {
        const l = document.querySelector('browser-action-list'); const b = l && l.shadowRoot && l.shadowRoot.querySelector('button, .action');
        if (b) b.click(); return !!b })()`)
      const popup = await Promise.race([popupCreated, sleep(6000).then(() => null)])
      let opened = false
      const bw = popup && (await popup.whenReady().catch(() => {}), await sleep(4000), popup.browserWindow)
      if (popup && bw && !bw.isDestroyed()) {
        opened = true
        diag.popupDom = await bw.webContents
          .executeJavaScript(`(() => {
            const t = (o) => typeof o
            const c = window.chrome || {}
            return {
              readyState: document.readyState,
              contentHtmlLength: (document.getElementById('content') || {}).innerHTML?.length,
              bodyText: document.body.innerText.slice(0, 300),
              apis: {
                'runtime.sendMessage': t(c.runtime && c.runtime.sendMessage), 'storage.local': t(c.storage && c.storage.local),
                'storage.session': t(c.storage && c.storage.session), 'tabs.query': t(c.tabs && c.tabs.query),
                scripting: t(c.scripting), declarativeNetRequest: t(c.declarativeNetRequest), webRequest: t(c.webRequest),
                cookies: t(c.cookies), i18n: t(c.i18n), permissions: t(c.permissions), privacy: t(c.privacy),
                windows: t(c.windows), action: t(c.action), alarms: t(c.alarms), idle: t(c.idle), management: t(c.management),
                downloads: t(c.downloads), offscreen: t(c.offscreen), contextMenus: t(c.contextMenus), notifications: t(c.notifications),
                'runtime.connectNative': t(c.runtime && c.runtime.connectNative), 'runtime.sendNativeMessage': t(c.runtime && c.runtime.sendNativeMessage),
                identity: t(c.identity), commands: t(c.commands), sidePanel: t(c.sidePanel), 'privacy.services': t(c.privacy && c.privacy.services),
              },
            }
          })()`)
          .catch((e: Error) => 'executeJavaScript failed: ' + e.message)
        diag.swRunning = Object.values(ctx.session.serviceWorkers.getAllRunning()).map((w) => w.scriptUrl)
        await bw.webContents
          .capturePage()
          .then((img) => save('ext-popup.png', img.toPNG()))
          .catch(() => {})
        popupInfo = 'popup url=' + bw.webContents.getURL() + ' revealHeld=' + ctx.popupOpen
        popup.destroy()
      }
      // An extension may answer a click by opening a page instead (1Password does on first run).
      if (!popup) await sleep(3000)
      const newTabs = tabs.list.filter((t) => !tabsBefore.has(t.id))
      diag.newTabsAfterClick = newTabs.map((t) => (t.wc.isDestroyed() ? '' : t.wc.getURL()))
      for (const t of newTabs) {
        await waitFor(() => !t.loading, 10_000).catch(() => {})
        await t.wc
          .capturePage()
          .then((img) => save('ext-click-tab.png', img.toPNG()))
          .catch(() => {})
        diag.newTabText = await t.wc.executeJavaScript('document.body ? document.body.innerText.slice(0, 300) : ""').catch(() => '')
      }
      save('ext-diag.json', JSON.stringify(diag, null, 2))
      const dom = diag.popupDom
      const popupText = dom && typeof dom === 'object' && 'bodyText' in dom ? String(dom.bodyText) : ''
      const respondedWithPage = newTabs.length > 0 && !!diag.newTabText
      return {
        pass: (opened && !!popupText) || respondedWithPage,
        detail: [desc.slice(0, 40), popupInfo, 'popup text: ' + JSON.stringify(popupText), 'new tabs: ' + JSON.stringify(diag.newTabsAfterClick) + ' ' + JSON.stringify((diag.newTabText ?? '').slice(0, 80))].join(' | '),
      }
    })

    // Okta injects its autofill scripts with chrome.scripting.executeScript from its service worker.
    await check('extension service worker can inject a script into the active tab', async () => {
      const dir = writeExtension(
        'stage-probe-ext-',
        { manifest_version: 3, name: 'Stage probe', version: '1.0', permissions: ['scripting', 'tabs'], host_permissions: ['<all_urls>'], background: { service_worker: 'sw.js' } },
        {
          'sw.js': `
            chrome.tabs.query({ active: true }).then(([tab]) =>
              chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => 'PROBE:' + document.title })
            ).then((r) => console.log(r[0].result)).catch((e) => console.log('PROBE-ERR:' + e.message))`,
        },
      )
      tabs.activate(t1.id)
      await ctx.session.extensions.loadExtension(dir)
      const line = await waitFor(() => diag.swConsole.find((l) => l.includes('PROBE')), 10_000).catch(() => null)
      return { pass: !!line?.includes('PROBE:Example Domain'), detail: line ?? 'no probe output' }
    })

    // Regression: a tracker iframe whose URL contains a UUID made Okta take over the tab, because
    // webNavigation URL filters were ignored.
    const UUID_IFRAME_PAGE = 'data:text/html,' + encodeURIComponent('<h1>host</h1><iframe src="https://example.com/?id=11111111-2222-4333-8444-555555555555"></iframe>')

    await check('webNavigation URL filters: listeners hear only matching URLs', async () => {
      const dir = writeExtension(
        'stage-navfilter-ext-',
        { manifest_version: 3, name: 'Stage nav filter probe', version: '1.0', permissions: ['webNavigation'], host_permissions: ['<all_urls>'], background: { service_worker: 'sw.js' } },
        {
          'sw.js': `
            const oktaLike = '^https://personal\\\\.okta\\\\.com/okta-personal-app/([0-9a-f-]{36})/launch'
            chrome.webNavigation.onBeforeNavigate.addListener((d) => console.log('NAVOKTA:' + d.url), { url: [{ urlMatches: oktaLike }] })
            chrome.webNavigation.onBeforeNavigate.addListener((d) => console.log('NAVORG:' + d.url), { url: [{ hostEquals: 'example.org' }] })
            chrome.webNavigation.onBeforeNavigate.addListener((d) => { if (d.url.includes('11111111-2222')) console.log('NAVALL:' + d.url) })`,
        },
      )
      await ctx.session.extensions.loadExtension(dir)
      await sleep(1000)
      const tab = tabs.create({ url: UUID_IFRAME_PAGE, activate: true })
      await waitFor(() => heard('NAVALL:') > 0, 10_000).catch(() => {})
      tab.wc.loadURL('https://example.org/').catch(() => {})
      await waitFor(() => heard('NAVORG:') > 0, 10_000).catch(() => {})
      tabs.close(tab.id)
      const ok = heard('NAVALL:') > 0 && heard('NAVOKTA:') === 0 && heard('NAVORG:') > 0 && heard('NAVORG:https://example.com') === 0
      return { pass: ok, detail: `unfiltered=${heard('NAVALL:')} oktaPattern=${heard('NAVOKTA:')} example.org=${heard('NAVORG:')}` }
    })

    await check('Okta does not take over a tab when an iframe URL contains a UUID', async () => {
      const tab = tabs.create({ url: UUID_IFRAME_PAGE, activate: true })
      await waitFor(() => !tab.loading && tab.url.startsWith('data:'), 10_000).catch(() => {})
      await sleep(4000) // the takeover ran within about a second of the iframe navigating
      const url = tab.wc.isDestroyed() ? '(destroyed)' : tab.wc.getURL()
      tabs.close(tab.id)
      return { pass: !url.startsWith('chrome-extension://'), detail: url.slice(0, 120) }
    })
  }

  await check('closing the window with a push pending does not throw, and takes the UI window with it', async () => {
    ctx.push()
    win.close()
    await sleep(800) // give the push, poll, save and hide timers a chance to fire
    const left = BaseWindow.getAllWindows().filter((w) => !w.isDestroyed()).length
    const ok = uncaught.length === 0 && ctx.quitting && win.isDestroyed() && uiWin.isDestroyed() && ui.isDestroyed() && left === 0
    return { pass: ok, detail: `windows left=${left} ${uncaught.join(' | ').slice(0, 400)}` }
  })

  const failed = results.filter((r) => !r.pass).length
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ passed: results.length - failed, failed, results }, null, 2))
  console.log(`[selftest] ${results.length - failed}/${results.length} passed -> ${OUT}`)
  ctx.quitting = true
  app.exit(failed ? 1 : 0)
}
