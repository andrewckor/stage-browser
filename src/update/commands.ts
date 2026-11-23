// `stage update` and `stage --restart`. Imported before anything moves on disk, with all it needs.
import { UpdateError } from './common'
import { lockUpdates, prepareInstalled, prepareRelease, quitRunning, switchTo, type Target } from './apply'
import { canUpdateItself, detectInstall } from './install'
import { fetchLatest } from './registry'
import { findRunning, type Running } from './running'
import { isNewer } from './version'

const say = (line: string) => void process.stdout.write(`${line}\n`)

export interface Context {
  root: string
  version: string
  userData: string
}

function assertCanQuit(running: Running | null): void {
  if (running && !running.version) throw new UpdateError('An older Stage is open and can’t restart itself. Quit it with ⌘Q, then run this again.')
}

function cancellable(): () => void {
  const cancel = () => process.exit(130) // runs the cleanups
  process.on('SIGINT', cancel)
  process.on('SIGHUP', cancel)
  process.on('SIGTERM', cancel)
  // From here on stopping would leave Stage closed, so closing the terminal or ⌃C no longer stops it.
  return () => {
    const ignore = () => {}
    for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM'] as const) {
      process.removeListener(signal, cancel)
      process.on(signal, ignore)
    }
    process.stdout.on('error', ignore)
    process.stderr.on('error', ignore)
  }
}

async function open(target: Target, ctx: Context, commit: () => void): Promise<void> {
  const running = findRunning(ctx.userData)
  assertCanQuit(running)
  if (running?.version && isNewer(running.version, target.version)) throw new UpdateError(`Stage ${running.version} is open, which is newer than ${target.version}. Nothing changed.`)
  commit()
  if (running) {
    say('Saving your tabs and closing Stage…')
    await quitRunning(running, target)
  }
  const outcome = await switchTo(target, ctx.userData, ctx.root)
  if (outcome === 'open') return say(`✓ Stage ${target.version} is open`)
  if (outcome === 'restored') throw new UpdateError(`Stage ${target.version} didn’t start, so Stage ${ctx.version} is open instead.`)
  if (outcome === 'unknown') throw new UpdateError(`Stage ${target.version} didn’t confirm it started. Check the Stage window.`)
  throw new UpdateError('Stage didn’t start. Run `stage --fg` to see why.')
}

export async function restart(ctx: Context): Promise<void> {
  const running = findRunning(ctx.userData)
  assertCanQuit(running)
  if (running?.version && isNewer(running.version, ctx.version))
    throw new UpdateError(`Stage ${running.version} is open, which is newer than this ${ctx.version}. Nothing changed.`)
  const commit = cancellable()
  lockUpdates(ctx.userData) // an update may be moving folders and starting Stage
  if (running) say(`Getting Stage ${ctx.version} ready…`)
  await open(await prepareInstalled(ctx.root, { echo: true }), ctx, commit)
}

export async function update(ctx: Context): Promise<void> {
  const { root, version, userData } = ctx
  const install = detectInstall(root, userData)
  if (install.kind === 'dev') throw new UpdateError(`This Stage runs from source. Update it with: ${install.command}`)

  const latest = await fetchLatest()
  const running = findRunning(userData)
  if (!isNewer(latest, version)) {
    if (running && (!running.version || isNewer(version, running.version))) return restart(ctx)
    return say(`Stage ${running?.version ?? version} is up to date`)
  }
  if (!canUpdateItself(install.kind)) throw new UpdateError(`Stage ${latest} is available, but this copy can’t update itself. Run:\n\n  ${install.command}\n`)

  // An open Stage that is already that new only needs the global package brought along, if that.
  const alreadyOpen = !!running?.version && !isNewer(latest, running.version)
  if (alreadyOpen && install.kind !== 'global') return say(`Stage ${running.version} is already open`)
  if (!alreadyOpen) assertCanQuit(running) // before any work

  const commit = cancellable()
  lockUpdates(userData)
  say(`Getting Stage ${latest} ready…`)
  const target = await prepareRelease(install, userData, latest, { echo: true })

  const now = findRunning(userData)
  const leaveOpenOrClosed = install.kind === 'global' && (!now || (!!now.version && !isNewer(latest, now.version)))
  if (!leaveOpenOrClosed) return open(target, ctx, commit)
  commit()
  target.place()
  target.keep()
  say(now ? `✓ Updated to Stage ${latest}` : `✓ Updated to Stage ${latest}. Run stage to open it.`)
}
