'use strict'
// Parses Stage's CLI arguments out of an argv array shaped like
// [electronBinary, appPath, ...userArgs] (also what second-instance delivers).
// Chromium/Electron switches (--inspect, --remote-debugging-port=..., etc.) are ignored.

function parseArgs(argv, appRoot) {
  const out = { urls: [], size: null, pin: false, fresh: false }
  // argv is [electron, appPath, ...args]; second-instance may carry extra leading entries,
  // so anchor on the app path when we know it.
  const at = appRoot ? argv.findIndex((a) => a === appRoot || a === '.') : -1
  const args = at >= 0 ? argv.slice(at + 1) : argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a) continue
    if (a === '--pin') out.pin = true
    else if (a === '--fresh') out.fresh = true
    else if (a === '--fg') continue
    else if (a === '--size' || a.startsWith('--size=')) {
      const v = a === '--size' ? args[++i] : a.slice(7)
      const m = /^(\d{2,5})x(\d{2,5})$/i.exec(v || '')
      if (m) out.size = { width: +m[1], height: +m[2] }
    } else if (a.startsWith('--') || a.startsWith('-psn_')) continue
    else out.urls.push(a)
  }
  return out
}

module.exports = { parseArgs }
