// Stage's browser follows the Mac's proxy settings and trusts its keychain, but the updater and the
// `stage` command run on Node, which does neither by default. These variables make recent Node do
// both: 24 and later, and late Node 22 releases. Older Node ignores them, and goes direct as before.
export const ADDED_ENV = 'STAGE_ADDED_ENV'

const ADDABLE = ['NODE_USE_ENV_PROXY', 'NODE_USE_SYSTEM_CA', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'] as const
type Addable = (typeof ADDABLE)[number]

/** Every host an update talks to: npm, Sigstore's trust root, and the Electron runtime on GitHub. */
export const UPDATE_HOSTS = ['registry.npmjs.org', 'tuf-repo-cdn.sigstore.dev', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'] as const

const HOST_PORT = /^[A-Za-z0-9.-]{1,253}:\d{1,5}$|^\[[0-9A-Fa-f:.]{2,45}\]:\d{1,5}$/

/**
 * The proxy URL for the first entry of a PAC-style answer such as `PROXY host:8080; DIRECT`.
 * null means direct. undefined is a kind Node can't use, such as SOCKS.
 */
export function proxyUrl(answer: string): string | null | undefined {
  const [kind = '', where = ''] = (answer.split(';')[0] ?? '').trim().split(/\s+/)
  if (kind.toUpperCase() === 'DIRECT') return null
  if (!HOST_PORT.test(where)) return undefined
  if (kind.toUpperCase() === 'PROXY') return `http://${where}`
  if (kind.toUpperCase() === 'HTTPS') return `https://${where}`
  return undefined
}

const hasProxy = (env: NodeJS.ProcessEnv) => ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((name) => env[name])

/**
 * What to add to `env` so Node reaches the update hosts the way the Mac does. `answers` maps each
 * host to what the system proxy settings say for it. A proxy already set in `env` wins.
 */
export function networkEnv(env: NodeJS.ProcessEnv, answers: ReadonlyMap<string, string> = new Map()): Partial<Record<Addable, string>> {
  const added: Partial<Record<Addable, string>> = {}
  if (!env.NODE_USE_SYSTEM_CA) added.NODE_USE_SYSTEM_CA = '1'
  if (hasProxy(env)) {
    if (!env.NODE_USE_ENV_PROXY) added.NODE_USE_ENV_PROXY = '1'
    return added
  }
  let proxy: string | undefined
  const direct: string[] = []
  for (const [host, answer] of answers) {
    const url = proxyUrl(answer)
    if (url === null) direct.push(host)
    else if (url && !proxy) proxy = url
  }
  if (!proxy) return added
  added.NODE_USE_ENV_PROXY = '1'
  added.HTTPS_PROXY = proxy
  added.HTTP_PROXY = proxy
  if (direct.length && !env.NO_PROXY && !env.no_proxy) added.NO_PROXY = direct.join(',')
  return added
}

/** `env` plus `added`, noting which names were added so the app can be started without them. */
export function withAdded(env: NodeJS.ProcessEnv, added: Partial<Record<Addable, string>>): NodeJS.ProcessEnv {
  const names = Object.keys(added)
  return names.length ? { ...env, ...added, [ADDED_ENV]: names.join(',') } : { ...env }
}

/** `env` as it was before `withAdded`: Stage itself starts the way any other launch does. */
export function withoutAdded(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env }
  for (const name of (env[ADDED_ENV] ?? '').split(',')) if ((ADDABLE as readonly string[]).includes(name)) delete out[name]
  delete out[ADDED_ENV]
  return out
}
