// Installs and updates extensions from the Chrome Web Store, the way Chrome does: download the
// signed package from Google, check it with ./crx, unpack it under userData/Extensions/<id>/<version>_0
// and load it. Updates follow the same path. Only packages that pass the checks are ever loaded.
import { app, powerMonitor, type Extension, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXTENSION_ID, idFromPublicKey, unzip, verifyCrx } from './crx'

export const WEB_STORE_URL = 'https://chromewebstore.google.com/'

const MAX_DOWNLOAD = 100 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 60_000
const UPDATE_EVERY_MS = 5 * 60 * 60 * 1000
const UPDATE_AT_MOST_EVERY_MS = 3 * 60 * 60 * 1000
const FIRST_UPDATE_AFTER_MS = 30_000

// Chrome's own version format, which also keeps the folder name safe.
const VERSION = /^\d{1,9}(\.\d{1,9}){0,3}$/
const VERSION_DIR = /^(\d{1,9}(?:\.\d{1,9}){0,3})_0$/

export interface ExtensionManifest {
  name: string
  version: string
  manifest_version?: number
  default_locale?: string
  permissions?: unknown[]
  host_permissions?: unknown[]
  content_scripts?: { matches?: unknown[] }[]
  background?: { service_worker?: string }
  key?: string
}

/** What the user is shown before an extension is added, or before an update that asks for more. */
export interface InstallRequest {
  name: string
  version: string
  /** Permissions and site access the package asks for that it didn't have before. */
  access: string[]
  update: boolean
}

export type Confirm = (req: InstallRequest) => Promise<boolean>

export const extensionsDir = (): string => join(app.getPath('userData'), 'Extensions')

/** The extension ID in a Web Store listing URL, or null. */
export function webStoreId(url: string | undefined): string | null {
  if (!url) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const store = u.protocol === 'https:' && (u.hostname === 'chromewebstore.google.com' || (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore/')))
  if (!store) return null
  const parts = u.pathname.split('/')
  if (!parts.includes('detail')) return null
  return parts.find((p) => EXTENSION_ID.test(p)) ?? null
}

function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

function readManifest(dir: string): ExtensionManifest {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ExtensionManifest
  if (typeof m.name !== 'string' || typeof m.version !== 'string' || !VERSION.test(m.version)) throw new Error('manifest has no valid name or version')
  return m
}

/** The display name, with Chrome's __MSG_key__ placeholder resolved from the default locale. */
function displayName(dir: string, m: ExtensionManifest): string {
  const msg = /^__MSG_(\w+)__$/.exec(m.name)
  if (!msg || !m.default_locale || !/^[\w-]+$/.test(m.default_locale)) return m.name
  try {
    const messages = JSON.parse(readFileSync(join(dir, '_locales', m.default_locale, 'messages.json'), 'utf8')) as Record<string, { message?: string }>
    const want = msg[1]?.toLowerCase()
    const hit = Object.entries(messages).find(([k]) => k.toLowerCase() === want)
    return hit?.[1].message || m.name
  } catch {
    return m.name
  }
}

const strings = (v: unknown[] | undefined): string[] => (v ?? []).filter((s): s is string => typeof s === 'string')

function access(m: ExtensionManifest): Set<string> {
  const hosts = [...strings(m.host_permissions), ...(m.content_scripts ?? []).flatMap((c) => strings(c.matches))]
  return new Set([...strings(m.permissions), ...hosts.map((h) => `site: ${h}`)])
}

function crxUrl(id: string): string {
  const u = new URL('https://clients2.google.com/service/update2/crx')
  u.searchParams.set('response', 'redirect')
  u.searchParams.set('acceptformat', 'crx3')
  u.searchParams.set('prodversion', process.versions.chrome)
  u.searchParams.set('x', new URLSearchParams({ id, uc: '' }).toString())
  return u.toString()
}

async function download(url: string): Promise<Buffer> {
  if (!url.startsWith('https://')) throw new Error('refusing a download that is not HTTPS')
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`)
  if (!res.url.startsWith('https://')) throw new Error('download was redirected off HTTPS')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.length
    if (size > MAX_DOWNLOAD) throw new Error('download is too large')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function startWorker(session: Session, ext: Extension): Promise<void> {
  const m = ext.manifest as ExtensionManifest
  if (m.manifest_version === 3 && m.background?.service_worker) {
    await session.serviceWorkers.startWorkerForScope(`chrome-extension://${ext.id}`).catch(() => console.error(`[stage] could not start ${ext.id}'s service worker`))
  }
}

/** The newest verified install of `id` on disk, or null. */
function latestInstall(id: string): { dir: string; manifest: ExtensionManifest } | null {
  const base = join(extensionsDir(), id)
  if (!existsSync(base)) return null
  let best: { dir: string; manifest: ExtensionManifest } | null = null
  for (const name of readdirSync(base)) {
    const v = VERSION_DIR.exec(name)?.[1]
    if (!v || (best && compareVersions(v, best.manifest.version) <= 0)) continue
    try {
      const dir = join(base, name)
      const manifest = readManifest(dir)
      // Only what this installer unpacked: the stored key must hash to the folder's ID.
      if (manifest.key && idFromPublicKey(Buffer.from(manifest.key, 'base64')) === id) best = { dir, manifest }
    } catch {
      // unreadable install, skip it
    }
  }
  return best
}

/**
 * Checks and unpacks a downloaded package into a staging folder, asks `confirm` when there is
 * something to ask, then moves it into place. Returns the installed folder, or null if declined.
 */
async function unpack(id: string, crx: Buffer, confirm: Confirm, previous: ExtensionManifest | null): Promise<{ dir: string; manifest: ExtensionManifest } | null> {
  const { archive, key } = verifyCrx(crx, id)
  const base = join(extensionsDir(), id)
  const staging = join(base, `.staging-${randomUUID()}`)
  try {
    mkdirSync(staging, { recursive: true })
    unzip(archive, staging)
    const manifest = readManifest(staging)
    if (previous && compareVersions(manifest.version, previous.version) <= 0) throw new Error(`not newer than ${previous.version}`)
    const before = previous ? access(previous) : new Set<string>()
    const added = [...access(manifest)].filter((a) => !before.has(a))
    if (!previous || added.length) {
      const ok = await confirm({ name: displayName(staging, manifest), version: manifest.version, access: added, update: !!previous })
      if (!ok) return null
    }
    manifest.key = key
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2))
    const dir = join(base, `${manifest.version}_0`)
    rmSync(dir, { recursive: true, force: true })
    renameSync(staging, dir)
    return { dir, manifest }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Installs a package that is already in memory. The selftest uses this directly. */
export async function installCrx(session: Session, id: string, crx: Buffer, confirm: Confirm): Promise<Extension | null> {
  const done = await unpack(id, crx, confirm, null)
  if (!done) return null
  const ext = await session.extensions.loadExtension(done.dir)
  await startWorker(session, ext)
  return ext
}

/** Downloads `id` from the Web Store and installs it. Resolves null if the user declines. */
export async function install(session: Session, id: string, confirm: Confirm): Promise<Extension | null> {
  if (!EXTENSION_ID.test(id)) throw new Error('invalid extension ID')
  const loaded = session.extensions.getExtension(id)
  if (loaded) return loaded
  return installCrx(session, id, await download(crxUrl(id)), confirm)
}

export async function remove(session: Session, id: string): Promise<void> {
  if (!EXTENSION_ID.test(id)) throw new Error('invalid extension ID')
  if (session.extensions.getExtension(id)) session.extensions.removeExtension(id)
  rmSync(join(extensionsDir(), id), { recursive: true, force: true })
}

/** Loads every installed extension. Older versions and interrupted installs are cleaned up. */
export async function loadInstalled(session: Session): Promise<void> {
  const root = extensionsDir()
  if (!existsSync(root)) return
  for (const id of readdirSync(root)) {
    if (!EXTENSION_ID.test(id) || session.extensions.getExtension(id)) continue
    const latest = latestInstall(id)
    for (const name of readdirSync(join(root, id))) {
      const dir = join(root, id, name)
      if (name.startsWith('.staging-') || (latest && VERSION_DIR.test(name) && dir !== latest.dir)) rmSync(dir, { recursive: true, force: true })
    }
    if (!latest) continue
    try {
      await startWorker(session, await session.extensions.loadExtension(latest.dir))
    } catch (e) {
      console.error(`[stage] could not load extension ${id}:`, (e as Error).message)
    }
  }
}

// --- Updates ---

interface UpdateApp {
  appid?: string
  updatecheck?: { status?: string; urls?: { url?: { codebase?: string }[] }; manifest?: { version?: string; packages?: { package?: { name?: string }[] } } }
}

async function availableUpdates(installed: Extension[]): Promise<{ ext: Extension; url: string }[]> {
  const res = await fetch('https://update.googleapis.com/service/update2/json', {
    method: 'POST',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { 'content-type': 'application/json', 'X-Goog-Update-Interactivity': 'bg', 'X-Goog-Update-AppId': installed.map((e) => e.id).join(',') },
    body: JSON.stringify({
      request: {
        '@updater': 'stage',
        acceptformat: 'crx3',
        app: installed.map((e) => ({ appid: e.id, updatecheck: {} })),
        os: { platform: 'Mac OS X', arch: process.arch === 'arm64' ? 'arm64' : 'x86_64' },
        prodversion: process.versions.chrome,
        protocol: '3.1',
        requestid: randomUUID(),
      },
    }),
  })
  if (!res.ok) return []
  const text = await res.text()
  const json = JSON.parse(text.replace(/^\)\]\}'\n/, '')) as { response?: { app?: UpdateApp[] } }
  const out: { ext: Extension; url: string }[] = []
  for (const a of json.response?.app ?? []) {
    const ext = installed.find((e) => e.id === a.appid)
    const version = a.updatecheck?.manifest?.version
    const base = a.updatecheck?.urls?.url?.find((u) => u.codebase?.startsWith('https://'))?.codebase
    const file = a.updatecheck?.manifest?.packages?.package?.[0]?.name
    if (!ext || a.updatecheck?.status !== 'ok' || !version || !base || !file) continue
    if (compareVersions(version, ext.version) > 0) out.push({ ext, url: new URL(file, base).toString() })
  }
  return out
}

export async function updateAll(session: Session, confirm: Confirm): Promise<void> {
  const mine = session.extensions.getAllExtensions().filter((e) => latestInstall(e.id))
  if (!mine.length) return
  for (const { ext, url } of await availableUpdates(mine)) {
    try {
      const current = latestInstall(ext.id)
      if (!current) continue
      const done = await unpack(ext.id, await download(url), confirm, current.manifest)
      if (!done) continue
      session.extensions.removeExtension(ext.id)
      await startWorker(session, await session.extensions.loadExtension(done.dir))
      rmSync(current.dir, { recursive: true, force: true })
    } catch (e) {
      console.error(`[stage] could not update ${ext.id}:`, (e as Error).message)
    }
  }
}

/** Checks for updates soon after launch, whenever the app comes forward, and every few hours. */
export function startUpdates(session: Session, confirm: Confirm): () => void {
  let last = 0
  const check = () => {
    if (Date.now() - last < UPDATE_AT_MOST_EVERY_MS || powerMonitor.getSystemIdleState(60 * 60) !== 'active') return
    last = Date.now()
    void updateAll(session, confirm).catch((e: Error) => console.error('[stage] update check failed:', e.message))
  }
  const first = setTimeout(check, FIRST_UPDATE_AFTER_MS)
  const every = setInterval(check, UPDATE_EVERY_MS)
  app.on('did-become-active', check)
  return () => {
    clearTimeout(first)
    clearInterval(every)
    app.off('did-become-active', check)
  }
}
