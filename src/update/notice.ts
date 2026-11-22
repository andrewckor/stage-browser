import { join } from 'node:path'
import { readObject } from './common'
import { detectInstall } from './install'
import { findRunning } from './running'
import { availableVersion, readCheck } from './state'
import { isNewer } from './version'

/** Whether Stage may ask npm for news by itself. */
export function automaticChecks(checkForUpdates: unknown): boolean {
  return checkForUpdates !== false && !process.env.STAGE_NO_UPDATE_CHECK
}

/** The one line a launch may print. Reads what is cached and never touches the network. */
export function launchNotice(root: string, version: string, userData: string): string | null {
  try {
    const install = detectInstall(root, userData)
    const running = findRunning(userData)
    if (running && !running.version) return `An older Stage is still open. Quit it with ⌘Q and run this again to use ${version}.`
    if (running?.version && isNewer(version, running.version))
      return `Stage ${running.version} is still open. Run \`${install.restartHint}\` to switch to ${version}.`

    if (install.kind === 'dev' || !automaticChecks(readObject(join(userData, 'prefs.json')).checkForUpdates)) return null
    const current = running?.version ?? version
    const available = availableVersion(readCheck(userData), current)
    return available ? `Stage ${available} is available. Run \`${install.updateHint}\` to update.` : null
  } catch {
    return null // a notice is never worth a failed launch
  }
}
