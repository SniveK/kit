// DOKU's non-SNAP signature scheme, shared by outgoing requests and incoming
// notifications:
// https://developers.doku.com/get-started-with-doku-api/signature-component/non-snap
//
// The string to sign is newline-joined `Name:value` lines with no trailing
// newline. Digest is present only when there is a body (POST); GET requests
// such as check status omit the line entirely.
//
// Only Web Crypto is used, so this runs unchanged on Bun, Node >= 20, Deno and
// edge runtimes.

const encoder = new TextEncoder()

function toBase64(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Base64 of the SHA-256 of `body`: DOKU's `Digest` component. */
export async function digest(body: string): Promise<string> {
  return toBase64(await crypto.subtle.digest('SHA-256', encoder.encode(body)))
}

async function hmacSha256Base64(secretKey: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return toBase64(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
}

export interface SignatureComponents {
  clientId: string
  requestId: string
  timestamp: string
  /** The request path: DOKU's API path when calling DOKU, your notification URL's path when DOKU calls you. */
  requestTarget: string
  /** Exact body bytes as sent or received. Omit for bodiless requests. */
  body?: string
  /**
   * Which timestamp header the signature covers. Requests and notifications
   * sign `Request-Timestamp`; DOKU's signatures on its own API responses sign
   * `Response-Timestamp`.
   */
  timestampHeader?: 'Request-Timestamp' | 'Response-Timestamp'
}

export async function stringToSign(components: SignatureComponents): Promise<string> {
  const lines = [
    `Client-Id:${components.clientId}`,
    `Request-Id:${components.requestId}`,
    `${components.timestampHeader ?? 'Request-Timestamp'}:${components.timestamp}`,
    `Request-Target:${components.requestTarget}`,
  ]
  if (components.body !== undefined) lines.push(`Digest:${await digest(components.body)}`)
  return lines.join('\n')
}

/** Produces the full `Signature` header value, `HMACSHA256=<base64>`. */
export async function sign(secretKey: string, components: SignatureComponents): Promise<string> {
  return `HMACSHA256=${await hmacSha256Base64(secretKey, await stringToSign(components))}`
}

/** Constant-time comparison, so a forged signature can't be found byte by byte through timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  // Still walk the full input on a length mismatch so the length isn't leaked through timing either.
  let diff = left.length ^ right.length
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ (right[i % right.length] ?? 0)
  return diff === 0
}

/** Recomputes the signature from `components` and compares it to `signature` in constant time. */
export async function verify(
  secretKey: string,
  components: SignatureComponents,
  signature: string,
): Promise<boolean> {
  return timingSafeEqual(await sign(secretKey, components), signature)
}

/** ISO 8601 UTC without milliseconds, the format in all of DOKU's examples (`2020-08-11T08:45:42Z`). */
export function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
