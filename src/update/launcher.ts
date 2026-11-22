import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { launcherOf } from './common'
import { withoutAdded } from './network'

// The protocol every launcher from 0.4.0 on keeps (docs/CONTRACT.md): an updater drives the launcher
// of the version it installs, which may be much newer than itself.
export const PREPARE_RUNTIME = '--prepare-runtime'
export const QUIT_RUNNING = '--quit-running'
export const KEEP_RUNTIMES = 'STAGE_KEEP_RUNTIMES'

export interface RuntimeProgress {
  received: number
  total: number
}

interface Options {
  /** Pass the launcher's stderr through, for the terminal's download progress. */
  echo?: boolean | undefined
  progress?: ((p: RuntimeProgress) => void) | undefined
}

/** Runs `root`'s launcher on this process's Node (Electron's own, in the update helper). */
export function runLauncher(root: string, args: readonly string[], { echo, progress }: Options = {}): Promise<boolean> {
  return new Promise((done) => {
    const prepare = args.includes(PREPARE_RUNTIME)
    const child = spawn(process.execPath, [launcherOf(root), ...args], {
      cwd: homedir(),
      // The runtime download keeps the updater's network settings; Stage itself starts without them.
      env: { ...(prepare ? process.env : withoutAdded(process.env)), [KEEP_RUNTIMES]: '1' },
      // The channel carries progress, and closing it cancels a download.
      stdio: prepare ? ['ignore', 'ignore', echo ? 'inherit' : 'ignore', 'ipc'] : 'ignore',
    })
    child.on('message', (m) => {
      const { received, total } = m as Partial<RuntimeProgress>
      if (typeof received === 'number' && typeof total === 'number') progress?.({ received, total })
    })
    child.on('error', () => done(false))
    child.on('exit', (code) => done(code === 0))
  })
}
