// Proves a tarball came out of this repository's release workflow: npm's provenance is a Sigstore
// bundle that binds the file's SHA-512 to that workflow's GitHub identity.
import { bundleFromJSON } from '@sigstore/bundle'
import * as tuf from '@sigstore/tuf'
import { Verifier, toSignedEntity, toTrustMaterial } from '@sigstore/verify'
import crypto from 'node:crypto'
import { join } from 'node:path'
import { NAME, UpdateError, updatesDir } from './common'
import { attestationsUrl, get } from './registry'

const ISSUER = 'https://token.actions.githubusercontent.com'
/**
 * The release workflows a new version may come from. Moving the repository, renaming the workflow or
 * changing the branch changes this identity, so one release must accept both identities before any
 * release is signed by the new one (docs/CONTRACT.md, "Moving the release"). scripts/check-signer.mjs
 * stops a release that the current one wouldn't accept.
 */
export const SIGNERS: readonly string[] = ['https://github.com/andrewckor/stage-browser/.github/workflows/release.yml@refs/heads/main']
const PREDICATE = 'https://slsa.dev/provenance/v1'
const PAYLOAD_TYPE = 'application/vnd.in-toto+json'
const ATTESTATIONS_MAX_BYTES = 1024 * 1024

type Trust = Parameters<typeof toTrustMaterial>[0]

/**
 * Electron's BoringSSL has no default digest, so `crypto.verify(null, …)`, as @sigstore/core calls
 * it, throws there for EC and RSA keys. OpenSSL's default for both is SHA-256; this supplies exactly
 * that and leaves Ed25519 alone. Only the update helper calls it, in a process of its own.
 */
export function useNodeDigestDefaults(): void {
  if (!process.versions.electron) return
  const verify = crypto.verify as (...args: unknown[]) => unknown
  const patched = function (this: unknown, algorithm: unknown, data: unknown, key: unknown, ...rest: unknown[]) {
    let digest = algorithm
    if (digest == null) {
      const inner = (key as { key?: unknown } | null)?.key
      const parsed = key instanceof crypto.KeyObject ? key : inner instanceof crypto.KeyObject ? inner : crypto.createPublicKey(key as crypto.PublicKeyInput)
      if (parsed.asymmetricKeyType === 'ec' || parsed.asymmetricKeyType === 'rsa') digest = 'sha256'
    }
    return verify.call(this, digest, data, key, ...rest)
  }
  Object.assign(crypto, { verify: patched })
}

/** Throws unless `attestations` holds provenance for exactly this version and these bytes. */
export function verifyProvenance(attestations: unknown, tarball: Buffer, version: string, trust: Trust): void {
  try {
    const list = (attestations as { attestations: { predicateType?: string; bundle?: unknown }[] }).attestations
    const found = list.find((a) => a.predicateType === PREDICATE)
    if (!found) throw new Error('no provenance')
    const bundle = bundleFromJSON(found.bundle)
    const signer = new Verifier(toTrustMaterial(trust)).verify(toSignedEntity(bundle), { extensions: { issuer: ISSUER } })
    // Compared exactly: the library's own identity policy is an unanchored pattern match.
    const name = signer.identity?.subjectAlternativeName
    if (typeof name !== 'string' || !SIGNERS.includes(name)) throw new Error('wrong signer')
    if (signer.identity?.extensions?.issuer !== ISSUER) throw new Error('wrong issuer')

    // From here on only signed bytes are read, never the registry's wrapper around them.
    if (bundle.content.$case !== 'dsseEnvelope') throw new Error('not a DSSE envelope')
    const { payload, payloadType } = bundle.content.dsseEnvelope
    if (payloadType !== PAYLOAD_TYPE) throw new Error('wrong payload type')
    const statement = JSON.parse(payload.toString('utf8')) as { predicateType?: string; subject?: { name?: string; digest?: { sha512?: string } }[] }
    if (statement.predicateType !== PREDICATE || statement.subject?.length !== 1) throw new Error('wrong statement')
    const [subject] = statement.subject
    if (subject?.name !== `pkg:npm/${NAME}@${version}`) throw new Error('wrong package or version')
    if (subject.digest?.sha512 !== crypto.createHash('sha512').update(tarball).digest('hex')) throw new Error('wrong file')
  } catch (e) {
    throw new UpdateError('The update didn’t pass its signature check. Nothing changed.', { cause: e })
  }
}

export async function verifyRelease(tarball: Buffer, version: string, userData: string): Promise<void> {
  let attestations: unknown
  try {
    attestations = JSON.parse((await get(attestationsUrl(version), ATTESTATIONS_MAX_BYTES, 20_000)).toString('utf8'))
  } catch (e) {
    if (e instanceof UpdateError) throw e
    throw new UpdateError('npm returned an unreadable signature. Nothing changed.', { cause: e })
  }
  let trust: Trust
  try {
    trust = await tuf.getTrustedRoot({ cachePath: join(updatesDir(userData), '.tuf'), timeout: 15_000, retry: { retries: 1 } })
  } catch (e) {
    throw new UpdateError('Couldn’t get Sigstore’s keys to check the update. Nothing changed.', { cause: e })
  }
  verifyProvenance(attestations, tarball, version, trust)
}
