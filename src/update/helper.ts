// The process behind the Update button: Stage's own Electron running as Node, started by the main
// process with `<userData> <pid> <version>`. It takes nothing from the renderer or any page.
//
// It gets everything ready while Stage runs, reports 'ready' and waits. Only 'go' from Stage commits;
// losing the channel before that cancels and changes nothing.
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { UpdateError, versionOf } from './common'
import { lockUpdates, prepareInstalled, prepareRelease, switchTo, type Progress, type Target } from './apply'
import { detectInstall } from './install'
import { fetchLatest } from './registry'
import { waitForExit } from './running'
import { saveCheck } from './state'
import { useNodeDigestDefaults } from './verify'
import { isNewer, isVersion } from './version'

export type HelperMessage = { type: 'progress'; progress: Progress; version: string } | { type: 'ready'; version: string } | { type: 'error'; message: string }

const QUIT_TIMEOUT_MS = 20_000

const send = (message: HelperMessage) => {
  if (process.connected) process.send?.(message)
}

let committed = false

async function main(): Promise<void> {
  const [userData, pidArg, running] = process.argv.slice(2)
  const pid = Number(pidArg)
  if (!userData || !Number.isSafeInteger(pid) || pid <= 1 || !isVersion(running) || !process.connected) return process.exit(2)

  const go = new Promise<void>((done) => {
    process.on('message', (m) => {
      if (m !== 'go') return
      committed = true
      done()
    })
  })
  process.on('disconnect', () => {
    if (!committed) process.exit(0) // runs the cleanups
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      if (!committed) process.exit(0)
    })
  }

  const root = resolve(__dirname, '..', '..')
  process.chdir(homedir())
  useNodeDigestDefaults()
  lockUpdates(userData)

  const install = detectInstall(root, userData)
  const installed = versionOf(root)
  const latest = await fetchLatest()
  let last = ''
  const report = (version: string) => ({
    progress(progress: Progress) {
      const key = `${progress.step}${progress.percent}`
      if (key === last) return // a message per percent, not per chunk
      last = key
      send({ type: 'progress', progress, version })
    },
  })
  let target: Target
  // npm or npx may have replaced this folder since Stage started; then a restart is all it takes.
  if (isNewer(installed, running) && !isNewer(latest, installed)) target = await prepareInstalled(root, report(installed))
  else if (isNewer(latest, installed) && isNewer(latest, running)) target = await prepareRelease(install, userData, latest, report(latest))
  else throw new UpdateError('There’s no newer version to install right now.')

  send({ type: 'ready', version: target.version })
  await go
  if (await waitForExit(pid, QUIT_TIMEOUT_MS)) await switchTo(target, userData, root)
  else saveCheck(userData, { updateFailed: true })
  process.exit(0)
}

main().catch((e: unknown) => {
  if (!(e instanceof UpdateError)) console.error('stage update helper:', e)
  send({ type: 'error', message: e instanceof UpdateError ? e.message : 'Stage couldn’t update itself. Nothing changed.' })
  setTimeout(() => process.exit(1), 100) // let the message out
})
