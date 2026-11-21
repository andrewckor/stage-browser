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

// argv is shaped like [electron, appPath, ...args]. second-instance may add leading entries, so
// anchor on the app path when it is known. Chromium switches are ignored.
export function parseArgs(argv: readonly string[], appRoot?: string): LaunchArgs {
  const out: LaunchArgs = { urls: [], size: null, pin: false, fresh: false }
  const at = appRoot ? argv.findIndex((a) => a === appRoot || a === '.') : -1
  const args = at >= 0 ? argv.slice(at + 1) : argv.slice(2)
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
