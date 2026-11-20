// RFC 6238 TOTP as ferricade computes it (internal/auth/totp.go): base32
// secret, SHA-1, 30 s steps, 6 digits. The live suite needs real codes for
// the setup wizard and sign-in.
import { createHmac } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32(secret: string): Buffer {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const c of secret.trim().toUpperCase().replace(/=+$/, '')) {
    const i = ALPHABET.indexOf(c)
    if (i < 0) throw new Error(`totp: invalid base32 character ${JSON.stringify(c)}`)
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function totp(secret: string, atMs: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / 30)))
  const sum = createHmac('sha1', base32(secret)).update(counter).digest()
  const off = sum[sum.length - 1]! & 0x0f
  const bin = sum.readUInt32BE(off) & 0x7fffffff
  return String(bin % 1_000_000).padStart(6, '0')
}
