// Gets a release ready while Stage keeps running, then moves over to it once Stage has quit.
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { UpdateStep } from '../shared/contract'
import { NAME, UpdateError, sleep, updatesDir, userNode, versionOf } from './common'
import { canUpdateItself, type Install } from './install'
import { PREPARE_RUNTIME, QUIT_RUNNING, runLauncher } from './launcher'
import { assertRunsOn, unpack } from './package'
import { get, tarballUrl } from './registry'
import { alive, findRunning, waitForExit, type Running } from './running'
import { saveCheck } from './state'
import { verifyRelease } from './verify'
import { isStable } from './version'

const TARBALL_MAX_BYTES = 30 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 120_000
const QUIT_TIMEOUT_MS = 20_000
const START_TIMEOUT_MS = 30_000
const TMP_PREFIX = '.tmp-'
const NEW_PREFIX = `.${NAME}-update-`
const BACKUP_PREFIX = `.${NAME}-previous-`

export interface Progress {
  step: UpdateStep
  percent: number | null
}

interface PrepareOptions {
  echo?: boolean | undefined
  progress?: ((p: Progress) => void) | undefined
}

/** A version that is ready to start. */
export interface Target {
  version: string
  /** Where its launcher is until `place`. */
  stagedAt: string
  /** Puts it where it will live and returns that folder. */
  place(): string
  /** Puts back what `place` replaced. */
  rollback(): void
  /** Drops what `rollback` would need. */
  keep(): void
}

export type Outcome = 'open' | 'restored' | 'closed' | 'unknown'

const removed = (folder: string) => rmSync(folder, { recursive: true, force: true })

/** Only one update at a time per profile. Released when this process exits. */
export function lockUpdates(userData: string): void {
  const dir = updatesDir(userData)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, '.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' })
      process.once('exit', () => {
        try {
          if (readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file)
        } catch {
          // already gone
        }
      })
      return
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    try {
      const owner = Number(readFileSync(file, 'utf8'))
      if (Number.isSafeInteger(owner) && owner > 1 && alive(owner)) break
      unlinkSync(file)
    } catch {
      // released in the meantime
    }
  }
  throw new UpdateError('Another Stage update is already running.')
}

async function prepareRuntime(root: string, { echo, progress }: PrepareOptions): Promise<void> {
  progress?.({ step: 'prepare', percent: null })
  const ok = await runLauncher(root, [PREPARE_RUNTIME], {
    echo,
    progress: ({ received, total }) => progress?.({ step: 'runtime', percent: total ? Math.min(100, Math.round((received / total) * 100)) : null }),
  })
  if (!ok) throw new UpdateError('Couldn’t get the new version’s browser engine ready. Nothing changed.')
}

/** The version already in `root`, for a plain restart into it. */
export async function prepareInstalled(root: string, options: PrepareOptions = {}): Promise<Target> {
  const version = versionOf(root)
  await prepareRuntime(root, options)
  return { version, stagedAt: root, place: () => root, rollback: () => {}, keep: () => {} }
}

/** Downloads, verifies and unpacks `version` beside the current one. The caller holds the update lock. */
export async function prepareRelease(install: Install, userData: string, version: string, options: PrepareOptions = {}): Promise<Target> {
  if (!isStable(version) || !canUpdateItself(install.kind))
    throw new UpdateError('This copy of Stage can’t update itself.')
  const { progress } = options
  const updates = updatesDir(userData)
  const global = install.kind === 'global'
  const packages = dirname(install.root)
  const installed = versionOf(install.root)

  // This process holds the lock, so these are left over from interrupted updates.
  for (const name of readdirSync(updates)) if (name.startsWith(TMP_PREFIX)) removed(join(updates, name))
  if (global) for (const name of readdirSync(packages)) if (name.startsWith(NEW_PREFIX) || name.startsWith(BACKUP_PREFIX)) removed(join(packages, name))

  progress?.({ step: 'download', percent: null })
  const tarball = await get(tarballUrl(version), TARBALL_MAX_BYTES, DOWNLOAD_TIMEOUT_MS, (received, total) =>
    progress?.({ step: 'download', percent: total ? Math.min(100, Math.round((received / total) * 100)) : null }),
  )
  progress?.({ step: 'verify', percent: null })
  await verifyRelease(tarball, version, userData)

  const work = mkdtempSync(join(updates, TMP_PREFIX))
  process.once('exit', () => removed(work))
  // A global update is staged beside the package, so moving it in is a rename on the same volume.
  const staged = global ? mkdtempSync(join(packages, NEW_PREFIX)) : join(work, 'package')
  if (global) process.once('exit', () => removed(staged))
  else mkdirSync(staged)
  unpack(tarball, join(work, 'package.tgz'), staged, version)
  // The updater runs on Stage's own Node, but the `stage` command keeps running on the person's.
  assertRunsOn(staged, version, userNode())
  await prepareRuntime(staged, options)

  if (!global) {
    const dest = join(updates, version)
    let placed = false
    return {
      version,
      stagedAt: staged,
      place() {
        removed(dest)
        renameSync(staged, dest)
        placed = true
        return dest
      },
      rollback() {
        if (placed) removed(dest)
      },
      keep: () => {},
    }
  }

  const backup = join(packages, `${BACKUP_PREFIX}${randomBytes(6).toString('hex')}`)
  let placed = false
  return {
    version,
    stagedAt: staged,
    place() {
      if (versionOf(install.root) !== installed) throw new UpdateError('Stage was changed by something else while it updated.')
      renameSync(install.root, backup)
      try {
        renameSync(staged, install.root)
      } catch (e) {
        renameSync(backup, install.root)
        throw e
      }
      placed = true
      return install.root
    },
    rollback() {
      if (!placed) return
      renameSync(install.root, staged)
      renameSync(backup, install.root)
      removed(staged)
      placed = false
    },
    keep() {
      if (placed) removed(backup)
    },
  }
}

/** Asks the running Stage to save and quit, through the new version's launcher. Never kills it. */
export async function quitRunning(running: Running, target: Target): Promise<void> {
  const asked = await runLauncher(target.stagedAt, [QUIT_RUNNING])
  if (!asked || !(await waitForExit(running.pid, QUIT_TIMEOUT_MS))) throw new UpdateError('Stage didn’t close, so nothing changed. Quit it with ⌘Q and try again.')
}

async function waitUntilReady(userData: string, version: string): Promise<'ready' | 'other' | 'none'> {
  const until = Date.now() + START_TIMEOUT_MS
  let running: Running | null = null
  while (Date.now() < until) {
    running = findRunning(userData)
    if (running?.ready) return running.version === version ? 'ready' : 'other'
    await sleep(250)
  }
  return running ? 'other' : 'none'
}

// Staged copies that no Stage uses any more. Only called once the new one is up.
function pruneStaged(userData: string, inUse: string): void {
  try {
    const dir = updatesDir(userData)
    const keep = realpathSync(inUse)
    for (const name of readdirSync(dir)) if (isStable(name) && realpathSync(join(dir, name)) !== keep) removed(join(dir, name))
  } catch {
    // only disk space
  }
}

/** Opens `target` in place of a Stage that has already quit, or puts the previous one back. */
export async function switchTo(target: Target, userData: string, previous: string): Promise<Outcome> {
  process.chdir(homedir())
  try {
    const root = target.place()
    if (await runLauncher(root, [])) {
      const state = await waitUntilReady(userData, target.version)
      if (state === 'ready') {
        target.keep()
        saveCheck(userData, { updateFailed: false })
        pruneStaged(userData, root)
        return 'open'
      }
      // Some Stage has the profile. Moving files under it would be worse than leaving it be.
      if (state === 'other') return 'unknown'
    }
  } catch (e) {
    console.error('stage: could not switch versions:', e)
  }
  saveCheck(userData, { updateFailed: true })
  try {
    target.rollback()
  } catch (e) {
    console.error('stage: could not put the previous version back:', e)
  }
  if (!(await runLauncher(previous, []))) return 'closed'
  return (await waitUntilReady(userData, versionOf(previous))) === 'ready' ? 'restored' : 'closed'
}
