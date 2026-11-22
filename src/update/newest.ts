// <userData>/newest.json: the newest Stage this profile has opened. An older `stage` command, such as
// one installed under another Node version, opens that one instead, so the profile never goes back
// to an older Chromium. Whatever can write this file can already change the profile's extensions and
// staged updates, so it opens no new way in. The folder it names is still checked before use.
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { NAME, launcherOf, readObject, versionOf, writeObject } from './common'
import { detectInstall, type InstallKind } from './install'
import { nodeRange, runsOn } from './package'
import { isNewer, isStable } from './version'

const file = (userData: string) => join(userData, 'newest.json')

// Installs that a person or npm put there. A checkout or a project's own copy is never opened for them.
const OPENABLE: readonly InstallKind[] = ['npx', 'staged', 'global', 'system']

export interface Newer {
  root: string
  version: string
  /** Its `engines.node`, when the Node running this launcher doesn't meet it. */
  needs: string | null
}

function installed(userData: string): { root: string; version: string } | null {
  const { root, version } = readObject(file(userData))
  if (!isStable(version) || typeof root !== 'string' || !isAbsolute(root)) return null
  if (versionOf(root) !== version || readObject(join(root, 'package.json')).name !== NAME || !existsSync(launcherOf(root))) return null
  return OPENABLE.includes(detectInstall(root, userData).kind) ? { root, version } : null
}

/** Called once Stage is up. Keeps a newer copy that is still installed. */
export function recordNewest(userData: string, root: string, version: string, kind: InstallKind): void {
  if (!OPENABLE.includes(kind) || !isStable(version)) return
  try {
    const saved = installed(userData)
    if (saved && (isNewer(saved.version, version) || saved.root === root)) return
    writeObject(file(userData), { version, root })
  } catch (e) {
    console.error('[stage] could not write newest.json', e)
  }
}

/** A newer Stage than `version` that this profile has opened and that is still installed. */
export function newerInstall(userData: string, version: string, node: string): Newer | null {
  try {
    const saved = installed(userData)
    if (!saved || !isNewer(saved.version, version)) return null
    return { ...saved, needs: runsOn(saved.root, node) ? null : (nodeRange(saved.root) ?? 'a newer version') }
  } catch {
    return null
  }
}
