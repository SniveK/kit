import { describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { digest, formatTimestamp, sign, stringToSign, timingSafeEqual, verify } from './signature.js'

// Reference implementation on node:crypto, independent of the Web Crypto code
// under test, following DOKU's documented recipe literally.
function referenceSignature(secret: string, lines: string[]): string {
  return `HMACSHA256=${createHmac('sha256', secret).update(lines.join('\n')).digest('base64')}`
}

const SECRET = 'SK-test-secret'
const base = {
  clientId: 'MCH-0001-10791114622547',
  requestId: 'cc682442-6c22-493e-8121-b9ef6b3fa728',
  timestamp: '2020-08-11T08:45:42Z',
  requestTarget: '/doku-virtual-account/v2/payment-code',
}

describe('stringToSign', () => {
  test('matches the layout in DOKU docs for a POST, with no trailing newline', async () => {
    const body = '{"order":{"amount":20000,"invoice_number":"INV-1"}}'
    const expectedDigest = createHash('sha256').update(body).digest('base64')
    expect(await stringToSign({ ...base, body })).toBe(
      [
        'Client-Id:MCH-0001-10791114622547',
        'Request-Id:cc682442-6c22-493e-8121-b9ef6b3fa728',
        'Request-Timestamp:2020-08-11T08:45:42Z',
        'Request-Target:/doku-virtual-account/v2/payment-code',
        `Digest:${expectedDigest}`,
      ].join('\n'),
    )
  })

  test('omits the Digest line for bodiless GET requests', async () => {
    const value = await stringToSign({ ...base, requestTarget: '/orders/v1/status/INV-123123-12313' })
    expect(value).not.toContain('Digest')
    expect(value.split('\n')).toHaveLength(4)
  })

  test('signs Response-Timestamp when asked, for verifying DOKU API responses', async () => {
    const value = await stringToSign({ ...base, timestampHeader: 'Response-Timestamp' })
    expect(value).toContain('Response-Timestamp:2020-08-11T08:45:42Z')
    expect(value).not.toContain('Request-Timestamp')
  })
})

describe('sign', () => {
  test('agrees with a node:crypto reference for a POST body', async () => {
    const body = JSON.stringify({ order: { amount: 150000, invoice_number: 'INV-20210124-0001' } })
    const expected = referenceSignature(SECRET, [
      `Client-Id:${base.clientId}`,
      `Request-Id:${base.requestId}`,
      `Request-Timestamp:${base.timestamp}`,
      `Request-Target:${base.requestTarget}`,
      `Digest:${createHash('sha256').update(body).digest('base64')}`,
    ])
    expect(await sign(SECRET, { ...base, body })).toBe(expected)
  })

  test('agrees with a node:crypto reference for a GET', async () => {
    const expected = referenceSignature(SECRET, [
      `Client-Id:${base.clientId}`,
      `Request-Id:${base.requestId}`,
      `Request-Timestamp:${base.timestamp}`,
      'Request-Target:/orders/v1/status/INV-1',
    ])
    expect(await sign(SECRET, { ...base, requestTarget: '/orders/v1/status/INV-1' })).toBe(expected)
  })

  test('digests UTF-8 bytes, not UTF-16 code units', async () => {
    const body = '{"name":"Kopi ☕ Bandung"}'
    expect(await digest(body)).toBe(createHash('sha256').update(body, 'utf8').digest('base64'))
  })
})

describe('verify', () => {
  test('accepts a correct signature and rejects any change to the signed parts', async () => {
    const body = '{"transaction":{"status":"SUCCESS"}}'
    const signature = await sign(SECRET, { ...base, body })
    expect(await verify(SECRET, { ...base, body }, signature)).toBe(true)
    expect(await verify(SECRET, { ...base, body: body.replace('SUCCESS', 'FAILED') }, signature)).toBe(false)
    expect(await verify(SECRET, { ...base, body, requestTarget: '/other' }, signature)).toBe(false)
    expect(await verify('wrong-secret', { ...base, body }, signature)).toBe(false)
  })
})

describe('timingSafeEqual', () => {
  test('compares by value, including length mismatches and empty strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('abcd', 'abc')).toBe(false)
    expect(timingSafeEqual('abc', '')).toBe(false)
    expect(timingSafeEqual('', '')).toBe(true)
  })
})

describe('formatTimestamp', () => {
  test('drops milliseconds to match DOKU examples', () => {
    expect(formatTimestamp(new Date('2020-08-11T08:45:42.123Z'))).toBe('2020-08-11T08:45:42Z')
  })
})
