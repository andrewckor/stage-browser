import { NAME, REGISTRY, UpdateError } from './common'
import { isStable } from './version'

export const DIST_TAGS_URL = `${REGISTRY}/-/package/${NAME}/dist-tags`
export const tarballUrl = (version: string) => `${REGISTRY}/${NAME}/-/${NAME}-${version}.tgz`
export const attestationsUrl = (version: string) => `${REGISTRY}/-/npm/v1/attestations/${NAME}@${version}`

export const TAGS_MAX_BYTES = 4096
// No version, no identifier.
export const USER_AGENT = 'Stage'

export async function readCapped(res: Response, max: number, progress?: (received: number, total: number) => void): Promise<Buffer> {
  const total = Number(res.headers.get('content-length')) || 0
  if (!res.body) throw new UpdateError('npm sent an empty response.')
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > max) {
      await reader.cancel().catch(() => {})
      throw new UpdateError('npm sent more data than expected. Nothing changed.')
    }
    chunks.push(value)
    progress?.(received, total)
  }
  return Buffer.concat(chunks)
}

export function parseLatest(body: Buffer): string {
  try {
    const { latest } = JSON.parse(body.toString('utf8')) as { latest?: unknown }
    if (isStable(latest)) return latest
  } catch {
    // reported below
  }
  throw new UpdateError('npm didn’t return a valid version.')
}

export async function get(url: string, max: number, timeoutMs: number, progress?: (received: number, total: number) => void): Promise<Buffer> {
  try {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': USER_AGENT } })
    if (res.status === 404) throw new UpdateError('The release is still arriving on npm. Try again in a few minutes.')
    if (!res.ok) throw new UpdateError(`npm answered with HTTP ${res.status}. Try again later.`)
    return await readCapped(res, max, progress)
  } catch (e) {
    if (e instanceof UpdateError) throw e
    throw new UpdateError('Couldn’t reach npm. Check your connection and try again.', { cause: e })
  }
}

export const fetchLatest = async (): Promise<string> => parseLatest(await get(DIST_TAGS_URL, TAGS_MAX_BYTES, 15_000))
