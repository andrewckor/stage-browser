// Reads a Chrome Web Store package (CRX3) and unpacks it, checking everything Chrome checks
// before it trusts one: the archive is signed by every key in the header, and one of those keys
// hashes to the extension ID that was asked for. Nothing here touches the network.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'

export const EXTENSION_ID = /^[a-p]{32}$/

// Chrome's ID alphabet: the first 16 bytes of a SHA-256, one letter a–p per hex digit.
const idFromHex = (hex: string): string => [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')

export const idFromPublicKey = (spki: Buffer): string => idFromHex(createHash('sha256').update(spki).digest('hex').slice(0, 32))

// --- Protocol buffers: just enough to read the CRX3 header. ---

type Field = { num: number; bytes?: Buffer }

function varint(buf: Buffer, pos: number): [number, number] {
  let value = 0
  let scale = 1
  for (let i = 0; i < 10; i++) {
    const byte = buf[pos++]
    if (byte === undefined) throw new Error('truncated varint')
    value += (byte & 0x7f) * scale
    if (byte < 0x80) {
      if (!Number.isSafeInteger(value)) throw new Error('varint too large')
      return [value, pos]
    }
    scale *= 128
  }
  throw new Error('varint too long')
}

function fields(buf: Buffer): Field[] {
  const out: Field[] = []
  let pos = 0
  while (pos < buf.length) {
    const [key, next] = varint(buf, pos)
    pos = next
    const num = Math.floor(key / 8)
    const wire = key % 8
    if (wire === 0) pos = varint(buf, pos)[1]
    else if (wire === 1) pos += 8
    else if (wire === 5) pos += 4
    else if (wire === 2) {
      const [len, start] = varint(buf, pos)
      if (start + len > buf.length) throw new Error('truncated field')
      out.push({ num, bytes: buf.subarray(start, start + len) })
      pos = start + len
      continue
    } else throw new Error(`unsupported wire type ${wire}`)
    if (pos > buf.length) throw new Error('truncated field')
  }
  return out
}

const bytesOf = (list: Field[], num: number): Buffer[] => list.filter((f) => f.num === num && f.bytes).map((f) => f.bytes as Buffer)

// --- CRX3 ---

const MAX_HEADER = 1 << 20
const SIGNED_DATA_PREFIX = Buffer.from('CRX3 SignedData\x00', 'latin1')

export interface VerifiedCrx {
  /** The zip archive inside the package. */
  archive: Buffer
  /** The key whose hash is the extension ID, base64 DER. Goes in manifest.key so Electron derives the same ID. */
  key: string
}

/** Parses a CRX3 file and checks its signatures. Throws unless it is a validly signed package of `expectedId`. */
export function verifyCrx(crx: Buffer, expectedId: string): VerifiedCrx {
  if (!EXTENSION_ID.test(expectedId)) throw new Error('invalid extension ID')
  if (crx.length < 12 || crx.toString('latin1', 0, 4) !== 'Cr24') throw new Error('not a CRX file')
  if (crx.readUInt32LE(4) !== 3) throw new Error('only CRX3 packages are accepted')
  const headerSize = crx.readUInt32LE(8)
  if (headerSize > MAX_HEADER || 12 + headerSize > crx.length) throw new Error('bad CRX header size')
  const header = fields(crx.subarray(12, 12 + headerSize))
  const archive = crx.subarray(12 + headerSize)

  const [signedHeaderData] = bytesOf(header, 10000)
  if (!signedHeaderData) throw new Error('CRX has no signed header data')
  const [crxId] = bytesOf(fields(signedHeaderData), 1)
  if (!crxId || crxId.length !== 16) throw new Error('CRX has no ID')
  const declaredId = idFromHex(crxId.toString('hex'))
  if (declaredId !== expectedId) throw new Error(`package is for ${declaredId}, not ${expectedId}`)

  const length = Buffer.alloc(4)
  length.writeUInt32LE(signedHeaderData.length)
  const signed = Buffer.concat([SIGNED_DATA_PREFIX, length, signedHeaderData, archive])

  // Field 2 holds RSA proofs, field 3 ECDSA proofs. Like Chrome, every proof present must hold.
  const proofs = [...bytesOf(header, 2), ...bytesOf(header, 3)].map((p) => {
    const f = fields(p)
    const [publicKey] = bytesOf(f, 1)
    const [signature] = bytesOf(f, 2)
    if (!publicKey || !signature) throw new Error('incomplete CRX proof')
    return { publicKey, signature }
  })
  if (!proofs.length) throw new Error('CRX is unsigned')
  let key: Buffer | undefined
  for (const { publicKey, signature } of proofs) {
    const ok = verify('sha256', signed, createPublicKey({ key: publicKey, format: 'der', type: 'spki' }), signature)
    if (!ok) throw new Error('CRX signature does not verify')
    if (idFromPublicKey(publicKey) === declaredId) key = publicKey
  }
  if (!key) throw new Error('no CRX signature is from the extension’s own key')
  return { archive, key: key.toString('base64') }
}

// --- Zip ---

const MAX_ENTRIES = 20_000
const MAX_UNPACKED = 512 * 1024 * 1024
const S_IFMT = 0o170000
const S_IFLNK = 0o120000

/**
 * Unpacks a zip into `dest`, which must exist and be empty. Only regular files and folders are
 * written. Any entry that is encrypted, a symlink, outside `dest` or otherwise unexpected
 * rejects the whole archive, before anything is written.
 */
export function unzip(zip: Buffer, dest: string): void {
  const root = resolve(dest)
  const eocdMin = Math.max(0, zip.length - 22 - 0xffff)
  let eocd = -1
  for (let i = zip.length - 22; i >= eocdMin; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip archive')
  const count = zip.readUInt16LE(eocd + 10)
  const cdOffset = zip.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('zip64 archives are not supported')
  if (count > MAX_ENTRIES) throw new Error('too many files in archive')

  const entries: { path: string; dir: boolean; data: Buffer }[] = []
  const seen = new Set<string>()
  let total = 0
  let pos = cdOffset
  for (let n = 0; n < count; n++) {
    if (pos + 46 > zip.length || zip.readUInt32LE(pos) !== 0x02014b50) throw new Error('bad zip directory')
    const flags = zip.readUInt16LE(pos + 8)
    const method = zip.readUInt16LE(pos + 10)
    const crc = zip.readUInt32LE(pos + 16)
    const packed = zip.readUInt32LE(pos + 20)
    const size = zip.readUInt32LE(pos + 24)
    const nameLen = zip.readUInt16LE(pos + 28)
    const extraLen = zip.readUInt16LE(pos + 30)
    const commentLen = zip.readUInt16LE(pos + 32)
    const mode = zip.readUInt32LE(pos + 38) >>> 16
    const local = zip.readUInt32LE(pos + 42)
    const name = zip.toString('utf8', pos + 46, pos + 46 + nameLen)
    pos += 46 + nameLen + extraLen + commentLen

    if (flags & 1) throw new Error('encrypted zip entries are not supported')
    if ((mode & S_IFMT) === S_IFLNK) throw new Error(`archive contains a symlink: ${name}`)
    const dir = name.endsWith('/')
    const parts = (dir ? name.slice(0, -1) : name).split('/')
    if (!name || name.startsWith('/') || /[\\:\0]/.test(name) || parts.some((p) => p === '' || p === '.' || p === '..')) {
      throw new Error(`unsafe path in archive: ${JSON.stringify(name)}`)
    }
    const path = resolve(root, ...parts)
    if (!path.startsWith(root + sep)) throw new Error(`unsafe path in archive: ${JSON.stringify(name)}`)
    const lower = path.toLowerCase() // macOS volumes are usually case-insensitive
    if (seen.has(lower)) throw new Error(`duplicate path in archive: ${name}`)
    seen.add(lower)

    total += size
    if (total > MAX_UNPACKED) throw new Error('archive is too large')
    if (dir) {
      entries.push({ path, dir, data: Buffer.alloc(0) })
      continue
    }
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip entry')
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    if (start + packed > zip.length) throw new Error('truncated zip entry')
    const raw = zip.subarray(start, start + packed)
    let data: Buffer
    if (method === 0) data = raw
    else if (method === 8) data = size === 0 ? Buffer.alloc(0) : inflateRawSync(raw, { maxOutputLength: size })
    else throw new Error(`unsupported compression method ${method}`)
    if (data.length !== size || crc32(data) !== crc) throw new Error(`corrupt zip entry: ${name}`)
    entries.push({ path, dir, data })
  }

  for (const e of entries) {
    if (e.dir) mkdirSync(e.path, { recursive: true })
    else {
      mkdirSync(dirname(e.path), { recursive: true })
      writeFileSync(e.path, e.data, { flag: 'wx', mode: 0o644 })
    }
  }
}
