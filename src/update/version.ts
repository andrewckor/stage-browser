const STABLE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/
const ANY = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[0-9A-Za-z.-]{1,64})?$/

/** A release version, the only kind Stage offers or installs. Safe in a URL and as a folder name. */
export const isStable = (value: unknown): value is string => typeof value === 'string' && STABLE.test(value)

export const isVersion = (value: unknown): value is string => typeof value === 'string' && ANY.test(value)

/** Whether `candidate` is newer. A release beats its own prereleases; prereleases don't beat each other. */
export function isNewer(candidate: string, current: string): boolean {
  const a = ANY.exec(candidate)
  const b = ANY.exec(current)
  if (!a || !b) return false
  for (const i of [1, 2, 3]) {
    const diff = Number(a[i]) - Number(b[i])
    if (diff) return diff > 0
  }
  return !a[4] && !!b[4]
}

const COMPARATOR = /^(>=|<=|>|<|=|\^|~)?v?(\d{1,6})(?:\.(\d{1,6}|x|\*))?(?:\.(\d{1,6}|x|\*))?$/

type Triple = [number, number, number]

const compare = (a: Triple, b: Triple): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

// One comparator as the versions from `low` up to, not including, `high`. Missing or x parts widen it.
function interval(token: string): { low: Triple; high: Triple | null } | null {
  const m = COMPARATOR.exec(token)
  if (!m) return null
  const op = m[1] ?? ''
  const part = (s: string | undefined) => (s === undefined || s === 'x' || s === '*' ? null : Number(s))
  const major = Number(m[2])
  const minor = part(m[3])
  const patch = minor === null ? null : part(m[4])
  const at: Triple = [major, minor ?? 0, patch ?? 0]
  // The first version past every version the token names: 22 → 23.0.0, 22.4 → 22.5.0.
  const past: Triple = minor === null ? [major + 1, 0, 0] : patch === null ? [major, minor + 1, 0] : [major, minor, patch + 1]
  const caret: Triple = major > 0 || minor === null ? [major + 1, 0, 0] : minor > 0 || patch === null ? [0, minor + 1, 0] : [0, 0, patch + 1]
  const tilde: Triple = minor === null ? [major + 1, 0, 0] : [major, minor + 1, 0]
  if (op === '>=') return { low: at, high: null }
  if (op === '>') return { low: past, high: null }
  if (op === '<') return { low: [0, 0, 0], high: at }
  if (op === '<=') return { low: [0, 0, 0], high: past }
  if (op === '^') return { low: at, high: caret }
  if (op === '~') return { low: at, high: tilde }
  return { low: at, high: past } // '=' or bare: that version, or every version it names
}

/**
 * Whether a Node version such as `v22.13.1` meets an `engines.node` range. Covers what package.json
 * files actually use: `||`, comparators joined by spaces, `^`, `~`, `x` and partial versions. A range
 * it can't read, or a prerelease Node, is treated as not met.
 */
export function satisfiesNode(nodeVersion: string, range: string): boolean {
  const v = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(nodeVersion.trim())
  if (!v) return false
  const version: Triple = [Number(v[1]), Number(v[2]), Number(v[3])]
  const alternatives = range.trim() === '' || range.trim() === '*' ? [''] : range.split('||')
  return alternatives.some((alternative) => {
    const tokens = alternative.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean)
    if (!tokens.length) return alternatives.length === 1
    return tokens.every((token) => {
      if (token === '*' || token === 'x') return true
      const span = interval(token)
      if (!span) return false
      return compare(version, span.low) >= 0 && (!span.high || compare(version, span.high) < 0)
    })
  })
}
