// ID generation + hashing utilities (node:crypto only).
import { randomBytes, createHash } from "node:crypto"

const ENCODING = "0123456789abcdefghjkmnpqrstvwxyz" // Crockford base32

/** ULID-like: 48-bit timestamp + 80-bit randomness, sortable, URL-safe. */
export function newId(prefix?: string): string {
  const now = Date.now()
  const bytes = randomBytes(16)
  // encode 48-bit time into first 10 chars
  let time = now
  const timeChars: string[] = []
  for (let i = 0; i < 10; i++) { timeChars.unshift(ENCODING[time & 31]); time = Math.floor(time / 32) }
  // encode 80-bit randomness into 16 chars
  let rand = ""
  for (let i = 0; i < 16; i++) rand += ENCODING[bytes[i] & 31]
  const id = timeChars.join("") + rand
  return prefix ? `${prefix}_${id}` : id
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

export function nowISO(): string {
  return new Date().toISOString()
}

/** Stable stringify for hashing objects (sorted keys). */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v)
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]"
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}"
}

export function hashObject(v: unknown): string {
  return sha256(stableStringify(v))
}
