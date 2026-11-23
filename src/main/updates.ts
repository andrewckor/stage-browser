// Finds out about new versions and drives the helper that installs one (src/update/helper.ts).
// Someone may always be watching the screen: nothing here shows the bar, opens a popover, makes a
// sound or restarts Stage without the person asking.
import { app, clipboard, powerMonitor, session, type Session } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UpdateState, UpdateStatus, UpdateStep } from '../shared/contract'
import { UpdateError } from '../update/common'
import type { HelperMessage } from '../update/helper'
import { canUpdateItself, detectInstall, type Install } from '../update/install'
import { recordNewest } from '../update/newest'
import { UPDATE_HOSTS, networkEnv, withAdded } from '../update/network'
import { automaticChecks } from '../update/notice'
import { DIST_TAGS_URL, TAGS_MAX_BYTES, USER_AGENT, parseLatest, readCapped } from '../update/registry'
import { afterSighting, availableVersion, isDue, readCheck, saveCheck } from '../update/state'
import type { Ctx } from './context'

const FIRST_CHECK_MS = 30_000
const LOOK_EVERY_MS = 10 * 60 * 1000
const CHECK_TIMEOUT_MS = 15_000
const PROXY_TIMEOUT_MS = 5_000
const IDLE_SECONDS = 60 * 60
const NOT_FINISHED = 'The last update couldn’t finish, so this version is still open. Try again, or update from Terminal.'
const HELPER_STOPPED = 'The update stopped before it finished. Nothing changed.'

interface Options {
  root: string
  version: string
  userData: string
  /** Saves and quits; the helper takes it from there. */
  quit(): void
  /** What a restart would lose right now. */
  warnings(): Promise<string[]>
}

interface View {
  status: UpdateStatus
  step: UpdateStep | null
  percent: number | null
  message: string | null
  warnings: string[]
}

const IDLE: View = { status: 'idle', step: null, percent: null, message: null, warnings: [] }

export class Updates {
  private readonly ctx: Ctx
  private readonly options: Options
  private readonly installed: Install
  private view: View = IDLE
  private available: string | null
  private helper: ChildProcess | null = null
  /** Set while the proxy settings are looked up, before the helper starts. */
  private starting: symbol | null = null
  private committed = false
  private weighing = false
  private request: Promise<void> | null = null
  private network: Session | undefined
  private stopTimers: (() => void) | undefined

  constructor(ctx: Ctx, options: Options) {
    this.ctx = ctx
    this.options = options
    this.installed = detectInstall(options.root, options.userData)
    const saved = readCheck(options.userData)
    this.available = this.installed.kind === 'dev' ? null : availableVersion(saved, options.version)
    if (saved.updateFailed && this.available) this.view = { ...IDLE, status: 'error', message: NOT_FINISHED }
  }

  private get canInstall(): boolean {
    return canUpdateItself(this.installed.kind)
  }

  private get busy(): boolean {
    return this.helper !== null || this.starting !== null || this.committed
  }

  state(): UpdateState {
    return { current: this.options.version, available: this.available, ...this.view, canInstall: this.canInstall, command: this.installed.command }
  }

  start(): void {
    if (this.installed.kind === 'dev' || this.stopTimers) return
    recordNewest(this.options.userData, this.installed.root, this.options.version, this.installed.kind)
    const look = () => {
      if (this.ctx.quitting || this.busy || this.request || !automaticChecks(this.ctx.prefs.checkForUpdates)) return
      const { userData, version } = this.options
      const saved = readCheck(userData) // `stage update` and other launches write it too
      this.setAvailable(availableVersion(saved, version))
      if (isDue(saved, version, Date.now()) && powerMonitor.getSystemIdleState(IDLE_SECONDS) === 'active') void this.check(false)
    }
    const first = setTimeout(look, FIRST_CHECK_MS)
    const every = setInterval(look, LOOK_EVERY_MS)
    app.on('did-become-active', look)
    this.stopTimers = () => {
      clearTimeout(first)
      clearInterval(every)
      app.off('did-become-active', look)
    }
  }

  stop(): void {
    this.stopTimers?.()
    if (!this.committed) this.dropHelper()
  }

  open(): void {
    // Warnings count only in the popover that showed them. They may be out of date by now, so the
    // next Restart looks again.
    if (this.view.status === 'ready' && this.view.warnings.length) this.show({ ...IDLE, status: 'ready' })
    this.ctx.reveal.openUpdate()
  }

  async checkByHand(): Promise<void> {
    this.open()
    if (this.busy) return
    this.show({ ...IDLE, status: 'checking' })
    await this.request // an automatic one may be under way
    await this.check(true)
  }

  private check(byHand: boolean): Promise<void> {
    const run = this.ask(byHand).finally(() => {
      this.request = null
    })
    this.request = run
    return run
  }

  private async ask(byHand: boolean): Promise<void> {
    const { userData, version } = this.options
    try {
      const latest = await this.fetchLatest()
      if (this.ctx.quitting || this.busy) return
      const saved = saveCheck(userData, afterSighting(readCheck(userData), latest, version, Date.now(), byHand))
      this.setAvailable(availableVersion(saved, version))
      if (byHand) this.show({ ...IDLE, status: this.available ? 'idle' : 'current' })
    } catch (e) {
      saveCheck(userData, { attemptedAt: Date.now(), attemptFailed: true })
      if (byHand) this.show({ ...IDLE, status: 'error', message: e instanceof UpdateError ? e.message : 'Couldn’t reach npm. Check your connection and try again.' })
    }
  }

  // A session of its own in memory: no cookies, no cache, no identifiers.
  private async fetchLatest(): Promise<string> {
    if (!this.network) {
      this.network = session.fromPartition('stage-update', { cache: false })
      this.network.setUserAgent(USER_AGENT, 'en')
    }
    const res = await this.network.fetch(DIST_TAGS_URL, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
    if (!res.ok) throw new UpdateError(`npm answered with HTTP ${res.status}. Try again later.`)
    return parseLatest(await readCapped(res, TAGS_MAX_BYTES))
  }

  install(): void {
    const { ctx } = this
    if (this.committed || ctx.quitting || ctx.overlay?.type !== 'update') return
    if (this.helper) {
      if (this.view.status !== 'ready') return
      // A second click, after the warnings, is the person accepting them.
      if (this.view.warnings.length) this.commit()
      else void this.commitUnlessWarned()
      return
    }
    const announced = this.available
    if (this.starting || !announced || !this.canInstall) return

    this.show({ ...IDLE, status: 'working', step: 'download' })
    const token = Symbol('install')
    this.starting = token
    void this.helperEnv().then((env) => {
      if (this.starting !== token) return // cancelled
      this.starting = null
      if (!ctx.quitting) this.startHelper(env, announced)
    })
  }

  // The helper is Node, so it is told about the proxy the browser uses, if the person has one.
  private async helperEnv(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    delete env.NODE_OPTIONS
    const answers = new Map<string, string>()
    try {
      const look = Promise.all(UPDATE_HOSTS.map(async (host) => answers.set(host, await session.defaultSession.resolveProxy(`https://${host}/`))))
      await Promise.race([look, new Promise((done) => setTimeout(done, PROXY_TIMEOUT_MS))])
    } catch {
      // direct, as before
    }
    return withAdded(env, networkEnv(env, new Map(answers)))
  }

  private startHelper(env: NodeJS.ProcessEnv, announced: string): void {
    const { ctx } = this
    const { root, userData, version } = this.options
    const helper = spawn(process.execPath, [join(root, 'dist', 'update', 'helper.js'), userData, String(process.pid), version, announced], {
      cwd: homedir(),
      env,
      detached: true, // it outlives this process
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    this.helper = helper
    const failed = (message: string) => {
      if (this.helper !== helper || this.committed) return
      this.dropHelper()
      this.show({ ...IDLE, status: 'error', message })
    }
    helper.on('message', (message) => {
      if (this.helper !== helper || this.committed) return
      const m = message as HelperMessage
      if (m.type === 'error') return failed(m.message)
      this.setAvailable(m.version)
      if (m.type === 'progress') return this.show({ ...IDLE, status: 'working', step: m.progress.step, percent: m.progress.percent })
      this.show({ ...IDLE, status: 'ready' })
      // Only while the person is looking at it. Otherwise it waits for another click.
      if (ctx.overlay?.type === 'update') void this.commitUnlessWarned()
    })
    helper.on('error', () => failed(HELPER_STOPPED))
    // 'close', not 'exit': its last message may still be on the way.
    helper.on('close', () => failed(HELPER_STOPPED))
  }

  // Restarts at once when nothing would be lost; otherwise says what would be, and waits.
  private async commitUnlessWarned(): Promise<void> {
    if (this.weighing) return
    this.weighing = true
    let warnings: string[] = []
    try {
      warnings = await this.options.warnings()
    } catch {
      // nothing seen is nothing to warn about; the general note still shows
    } finally {
      this.weighing = false
    }
    if (!this.helper || this.committed || this.ctx.quitting || this.view.status !== 'ready') return
    if (warnings.length) return this.show({ ...IDLE, status: 'ready', warnings })
    this.commit()
  }

  private commit(): void {
    const { helper } = this
    if (!helper?.connected) return
    this.committed = true
    this.show({ ...IDLE, status: 'restarting' })
    helper.send('go', (err) => {
      if (err) {
        this.committed = false
        this.dropHelper()
        return this.show({ ...IDLE, status: 'error', message: HELPER_STOPPED })
      }
      helper.unref()
      this.options.quit()
    })
  }

  cancel(): void {
    if (this.committed || (!this.helper && !this.starting)) return
    this.starting = null
    this.dropHelper()
    this.show(IDLE)
    this.ctx.reveal.closeOverlay()
  }

  private dropHelper(): void {
    const { helper } = this
    this.helper = null
    if (helper?.connected) helper.disconnect() // which cancels it
  }

  copyCommand(): void {
    if (this.ctx.overlay?.type === 'update') clipboard.writeText(this.installed.command)
  }

  private setAvailable(version: string | null): void {
    if (version === this.available) return
    this.available = version
    this.ctx.rebuildMenu()
    this.ctx.push()
  }

  private show(view: View): void {
    this.view = view
    this.ctx.flush()
  }
}
