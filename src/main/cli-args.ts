export interface Size {
  width: number
  height: number
}

export interface LaunchArgs {
  urls: string[]
  size: Size | null
  pin: boolean
  fresh: boolean
}

const SIZE = /^(\d{2,5})x(\d{2,5})$/i

// argv is shaped like [electron, appPath, ...args], possibly with switches before the app path, so
// anchor on that path when it is known.
export function appArgs(argv: readonly string[], appRoot?: string): string[] {
  const at = appRoot ? argv.findIndex((a) => a === appRoot || a === '.') : -1
  return at >= 0 ? argv.slice(at + 1) : argv.slice(2)
}

// Chromium switches are ignored.
export function parseArgs(argv: readonly string[], appRoot?: string): LaunchArgs {
  const out: LaunchArgs = { urls: [], size: null, pin: false, fresh: false }
  const args = appArgs(argv, appRoot)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a || a === '--fg') continue
    if (a === '--pin') out.pin = true
    else if (a === '--fresh') out.fresh = true
    else if (a === '--size' || a.startsWith('--size=')) {
      const m = SIZE.exec((a === '--size' ? args[++i] : a.slice(7)) ?? '')
      if (m) out.size = { width: Number(m[1]), height: Number(m[2]) }
    } else if (!a.startsWith('--') && !a.startsWith('-psn_')) out.urls.push(a)
  }
  return out
}

const MAX_URLS = 100
const MAX_URL_LENGTH = 32_768

/** What a second launch hands to the running Stage through the single-instance lock. */
export interface Handoff {
  args: LaunchArgs
  /** An update or restart wants the running Stage to save and quit. */
  quit: boolean
}

/**
 * Reads a second launch. Launchers from before 0.4.0 send only argv, which Chromium reorders to put
 * switches first, with their install path as the first plain argument: that path is not a tab. The same
 * reordering parts `--size` from its value, which is no tab either.
 */
export function readHandoff(argv: readonly string[], data: unknown): Handoff {
  const sent = data as Partial<Handoff> | null | undefined
  const a = sent?.args as Partial<LaunchArgs> | undefined
  if (a && Array.isArray(a.urls)) {
    const { width, height } = a.size ?? {}
    const size = SIZE.test(`${width}x${height}`) ? { width: Number(width), height: Number(height) } : null
    const urls = a.urls.slice(0, MAX_URLS).filter((u): u is string => typeof u === 'string' && u.length <= MAX_URL_LENGTH)
    return { args: { urls, size, pin: a.pin === true, fresh: a.fresh === true }, quit: sent?.quit === true }
  }
  const rest = argv.slice(1)
  const appPath = rest.findIndex((x) => !x.startsWith('-'))
  if (appPath >= 0) rest.splice(appPath, 1)
  const sizeAt = rest.indexOf('--size')
  const valueAt = sizeAt < 0 ? -1 : rest.findIndex((x) => SIZE.test(x))
  if (valueAt >= 0) {
    rest[sizeAt] = `--size=${rest[valueAt]}`
    rest.splice(valueAt, 1)
  }
  return { args: parseArgs(['', '', ...rest]), quit: false }
}
