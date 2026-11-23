import { execFileSync } from 'node:child_process'
import { readlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { readObject, sleep, writeObject } from './common'
import { isVersion } from './version'

export interface Running {
  pid: number
  /** null: a Stage from before 0.4.0, which can't be asked to quit. */
  version: string | null
  /** Its tabs are restored. */
  ready: boolean
}

const recordFile = (userData: string) => join(userData, 'running.json')

/**
 * Whether `pid` is a process that started after `ms`, so it can't be the one that wrote a file at
 * `ms`: that process ended and the system gave its pid to another. ps reports the start to the
 * whole second, rounded down, so a reused pid is missed only within the second the file was written.
 * False when ps can't tell.
 */
export function startedAfter(pid: number, ms: number): boolean {
  try {
    const started = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const at = Date.parse(started.trim())
    return Number.isFinite(at) && at > ms
  } catch {
    return false
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The Stage holding this profile's single-instance lock. Chromium keeps that lock as a symlink to
 * `<hostname>-<pid>`, so this finds any version; running.json adds what only 0.4.0 and later know.
 */
export function findRunning(userData: string): Running | null {
  try {
    const pid = Number(/-(\d+)$/.exec(readlinkSync(join(userData, 'SingletonLock')))?.[1])
    if (!Number.isSafeInteger(pid) || pid <= 1 || !alive(pid)) return null
    const command = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    if (!command.includes('/MacOS/Electron')) return null // the lock is stale and the pid was reused
    const record = readObject(recordFile(userData))
    const known = record.pid === pid && isVersion(record.version)
    return { pid, version: known ? (record.version as string) : null, ready: known && record.ready === true }
  } catch {
    return null
  }
}

export function writeRunning(userData: string, version: string, ready: boolean): void {
  try {
    writeObject(recordFile(userData), { pid: process.pid, version, ready })
  } catch (e) {
    console.error('[stage] could not write running.json', e)
  }
}

export function clearRunning(userData: string): void {
  try {
    if (readObject(recordFile(userData)).pid === process.pid) unlinkSync(recordFile(userData))
  } catch {
    // already gone
  }
}

export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (alive(pid)) {
    if (Date.now() > until) return false
    await sleep(100)
  }
  return true
}
