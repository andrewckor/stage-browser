// What the launcher, the app and the updater share. Plain Node: nothing here imports electron.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const NAME = 'stage-browser'
export const REGISTRY = 'https://registry.npmjs.org'

/** An error whose message is written for the person using Stage. */
export class UpdateError extends Error {}

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

export const userDataDir = (): string =>
  process.env.STAGE_USER_DATA ? resolve(process.env.STAGE_USER_DATA) : join(homedir(), 'Library', 'Application Support', 'Stage')

export const updatesDir = (userData: string) => join(userData, 'Updates')

export const launcherOf = (root: string) => join(root, 'dist', 'bin', 'stage.js')

/** Set by the launcher on Stage and everything Stage starts: the Node version `stage` runs on. */
export const NODE_ENV = 'STAGE_NODE'

/** The Node that runs the `stage` command here, which may not be the one running this code. */
export function userNode(): string | null {
  if (!process.versions.electron) return process.version
  const node = process.env[NODE_ENV]
  return node && /^v\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(node) ? node : null
}

/** A JSON file's object, or an empty one when it is missing, unreadable or something else. */
export function readObject(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // same as empty
  }
  return {}
}

export function writeObject(file: string, data: object): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, file)
}

export function versionOf(root: string): string {
  const { version } = readObject(join(root, 'package.json'))
  return typeof version === 'string' ? version : ''
}
