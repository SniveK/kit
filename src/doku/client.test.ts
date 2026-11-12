import { describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { createDokuClient, parseWibTimestamp, type DokuClientOptions } from './client.js'
import { DokuApiError, DokuSignatureError } from './errors.js'

const CLIENT_ID = 'BRN-0214-1714016624673'
const SECRET = 'SK-test-secret'
const NOW = new Date('2024-07-12T02:47:11.456Z')

function referenceSignature(lines: string[]): string {
  return `HMACSHA256=${createHmac('sha256', SECRET).update(lines.join('\n')).digest('base64')}`
}

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

/** A fetch that records the request and answers with `status` and `body`. */
function fakeFetch(status: number, body: unknown) {
  const calls: Captured[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: init?.body as string | undefined,
    })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as typeof fetch
  return { impl, calls }
}

function client(overrides: Partial<DokuClientOptions> = {}) {
  return createDokuClient({
    clientId: CLIENT_ID,
    secretKey: SECRET,
    environment: 'sandbox',
    now: () => NOW,
    generateRequestId: () => 'req-fixed',
    ...overrides,
  })
}

const checkoutResponse = {
  message: ['SUCCESS'],
  response: {
    order: { amount: '20000', invoice_number: 'INV-1', currency: 'IDR', session_id: 'sess-1' },
    payment: {
      payment_due_date: 60,
      token_id: 'tok-1',
      url: 'https://sandbox.doku.com/checkout-link-v2/tok-1',
      expired_date: '20240712104711',
    },
  },
}

describe('createDokuClient', () => {
  test('refuses to start without credentials or a valid environment', () => {
    expect(() => client({ clientId: '' })).toThrow(TypeError)
    expect(() => client({ secretKey: '' })).toThrow(TypeError)
    expect(() => client({ environment: 'prod' as never })).toThrow(TypeError)
  })
})

describe('checkout.create', () => {
  test('sends a correctly signed POST to the sandbox and returns the page URL', async () => {
    const { impl, calls } = fakeFetch(200, checkoutResponse)
    const payment = await client({ fetch: impl }).checkout.create({
      order: { amount: 20000, invoice_number: 'INV-1' },
      payment: { payment_due_date: 60 },
    })

    expect(payment.url).toBe('https://sandbox.doku.com/checkout-link-v2/tok-1')
    expect(payment.tokenId).toBe('tok-1')
    expect(payment.sessionId).toBe('sess-1')
    expect(payment.requestId).toBe('req-fixed')
    // 10:47:11 WIB is 03:47:11 UTC.
    expect(payment.expiresAt.toISOString()).toBe('2024-07-12T03:47:11.000Z')

    const [call] = calls
    expect(call!.url).toBe('https://api-sandbox.doku.com/checkout/v1/payment')
    expect(call!.method).toBe('POST')
    expect(call!.headers['Client-Id']).toBe(CLIENT_ID)
    expect(call!.headers['Request-Id']).toBe('req-fixed')
    expect(call!.headers['Request-Timestamp']).toBe('2024-07-12T02:47:11Z')
    expect(call!.headers['Content-Type']).toBe('application/json')
    expect(call!.headers.Signature).toBe(
      referenceSignature([
        `Client-Id:${CLIENT_ID}`,
        'Request-Id:req-fixed',
        'Request-Timestamp:2024-07-12T02:47:11Z',
        'Request-Target:/checkout/v1/payment',
        `Digest:${createHash('sha256').update(call!.body!).digest('base64')}`,
      ]),
    )
  })

  test('uses the caller-supplied Request-Id so retries stay idempotent', async () => {
    const { impl, calls } = fakeFetch(200, checkoutResponse)
    const payment = await client({ fetch: impl }).checkout.create(
      { order: { amount: 20000, invoice_number: 'INV-1' } },
      { requestId: 'order-42-attempt' },
    )
    expect(calls[0]!.headers['Request-Id']).toBe('order-42-attempt')
    expect(payment.requestId).toBe('order-42-attempt')
  })

  test('targets production only when asked', async () => {
    const { impl, calls } = fakeFetch(200, checkoutResponse)
    await client({ fetch: impl, environment: 'production' }).checkout.create({
      order: { amount: 20000, invoice_number: 'INV-1' },
    })
    expect(calls[0]!.url).toBe('https://api.doku.com/checkout/v1/payment')
  })

  test('rejects fractional or non-positive amounts before calling DOKU', async () => {
    const { impl, calls } = fakeFetch(200, checkoutResponse)
    const doku = client({ fetch: impl })
    for (const amount of [1000.5, 0, -1, Number.NaN]) {
      await expect(doku.checkout.create({ order: { amount, invoice_number: 'INV-1' } })).rejects.toThrow(TypeError)
    }
    expect(calls).toHaveLength(0)
  })

  test('surfaces DOKU errors with status, body and request id', async () => {
    const { impl } = fakeFetch(400, { message: ['invoice_number is required'] })
    const error = await client({ fetch: impl })
      .checkout.create({ order: { amount: 20000, invoice_number: '' } })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DokuApiError)
    const apiError = error as DokuApiError
    expect(apiError.status).toBe(400)
    expect(apiError.body).toEqual({ message: ['invoice_number is required'] })
    expect(apiError.requestId).toBe('req-fixed')
    expect(apiError.path).toBe('/checkout/v1/payment')
  })

  test('keeps a non-JSON error body as text', async () => {
    const { impl } = fakeFetch(502, '<html>Bad Gateway</html>')
    const error = (await client({ fetch: impl })
      .checkout.create({ order: { amount: 20000, invoice_number: 'INV-1' } })
      .catch((e: unknown) => e)) as DokuApiError
    expect(error.status).toBe(502)
    expect(error.body).toBe('<html>Bad Gateway</html>')
  })

  test('treats a 200 without a payment URL as an error', async () => {
    const { impl } = fakeFetch(200, { message: ['SUCCESS'] })
    await expect(
      client({ fetch: impl }).checkout.create({ order: { amount: 20000, invoice_number: 'INV-1' } }),
    ).rejects.toBeInstanceOf(DokuApiError)
  })
})

describe('orders.status', () => {
  test('sends a signed GET with no Digest and returns the transaction', async () => {
    const { impl, calls } = fakeFetch(200, {
      order: { invoice_number: 'INV-1', amount: 20000 },
      transaction: { status: 'SUCCESS', date: '2024-07-12T03:00:00Z', original_request_id: 'req-orig' },
      channel: { id: 'VIRTUAL_ACCOUNT_BCA' },
    })
    const result = await client({ fetch: impl }).orders.status('INV-1')

    expect(result.transaction.status).toBe('SUCCESS')
    expect(result.channel?.id).toBe('VIRTUAL_ACCOUNT_BCA')
    const [call] = calls
    expect(call!.url).toBe('https://api-sandbox.doku.com/orders/v1/status/INV-1')
    expect(call!.method).toBe('GET')
    expect(call!.body).toBeUndefined()
    expect(call!.headers['Content-Type']).toBeUndefined()
    expect(call!.headers.Signature).toBe(
      referenceSignature([
        `Client-Id:${CLIENT_ID}`,
        'Request-Id:req-fixed',
        'Request-Timestamp:2024-07-12T02:47:11Z',
        'Request-Target:/orders/v1/status/INV-1',
      ]),
    )
  })

  test('URL-encodes the identifier and signs the encoded path', async () => {
    const { impl, calls } = fakeFetch(200, { order: {}, transaction: { status: 'PENDING' } })
    await client({ fetch: impl }).orders.status('INV/2024 01')
    expect(calls[0]!.url).toBe('https://api-sandbox.doku.com/orders/v1/status/INV%2F2024%2001')
  })

  test('throws DokuApiError on 404', async () => {
    const { impl } = fakeFetch(404, { error: { message: 'Not Found' } })
    const error = (await client({ fetch: impl }).orders.status('missing').catch((e: unknown) => e)) as DokuApiError
    expect(error).toBeInstanceOf(DokuApiError)
    expect(error.status).toBe(404)
  })
})

describe('webhooks.verify', () => {
  const requestTarget = '/webhooks/doku'
  const body = JSON.stringify({
    order: { invoice_number: 'INV-1', amount: 20000 },
    transaction: { status: 'SUCCESS', date: '2024-07-12T03:00:00Z', original_request_id: 'req-orig' },
    service: { id: 'VIRTUAL_ACCOUNT' },
  })

  function signedHeaders(overrides: Record<string, string> = {}) {
    const headers = {
      'client-id': CLIENT_ID,
      'request-id': 'notif-1',
      'request-timestamp': '2024-07-12T03:00:05Z',
      ...overrides,
    }
    return {
      ...headers,
      signature: referenceSignature([
        `Client-Id:${headers['client-id']}`,
        `Request-Id:${headers['request-id']}`,
        `Request-Timestamp:${headers['request-timestamp']}`,
        `Request-Target:${requestTarget}`,
        `Digest:${createHash('sha256').update(body).digest('base64')}`,
      ]),
    }
  }

  test('accepts a genuine notification from a Fetch Headers object', async () => {
    const result = await client().webhooks.verify({ headers: new Headers(signedHeaders()), body, requestTarget })
    expect(result.requestId).toBe('notif-1')
    expect(result.timestamp).toBe('2024-07-12T03:00:05Z')
    expect(result.notification.transaction.status).toBe('SUCCESS')
    expect(result.notification.order.invoice_number).toBe('INV-1')
  })

  test('accepts Node-style headers in any case', async () => {
    const { signature, ...rest } = signedHeaders()
    const headers = { 'Client-Id': rest['client-id'], 'REQUEST-ID': rest['request-id'], 'request-timestamp': [rest['request-timestamp']], Signature: signature }
    const result = await client().webhooks.verify({ headers, body, requestTarget })
    expect(result.requestId).toBe('notif-1')
  })

  test('rejects a tampered body', async () => {
    await expect(
      client().webhooks.verify({ headers: signedHeaders(), body: body.replace('20000', '1'), requestTarget }),
    ).rejects.toBeInstanceOf(DokuSignatureError)
  })

  test('rejects a signature made for a different path', async () => {
    await expect(
      client().webhooks.verify({ headers: signedHeaders(), body, requestTarget: '/other' }),
    ).rejects.toBeInstanceOf(DokuSignatureError)
  })

  test('rejects a notification signed over Response-Timestamp instead of Request-Timestamp', async () => {
    const headers = signedHeaders()
    headers.signature = referenceSignature([
      `Client-Id:${CLIENT_ID}`,
      'Request-Id:notif-1',
      'Response-Timestamp:2024-07-12T03:00:05Z',
      `Request-Target:${requestTarget}`,
      `Digest:${createHash('sha256').update(body).digest('base64')}`,
    ])
    await expect(client().webhooks.verify({ headers, body, requestTarget })).rejects.toBeInstanceOf(DokuSignatureError)
  })

  test('rejects a notification for another Client-Id', async () => {
    await expect(
      client().webhooks.verify({ headers: signedHeaders({ 'client-id': 'BRN-OTHER' }), body, requestTarget }),
    ).rejects.toThrow(/BRN-OTHER/)
  })

  test('rejects missing signature headers', async () => {
    const { signature: _, ...unsigned } = signedHeaders()
    await expect(client().webhooks.verify({ headers: unsigned, body, requestTarget })).rejects.toBeInstanceOf(
      DokuSignatureError,
    )
  })
})

describe('parseWibTimestamp', () => {
  test('converts WIB to UTC and flags malformed input as an invalid date', () => {
    expect(parseWibTimestamp('20240101050000').toISOString()).toBe('2023-12-31T22:00:00.000Z')
    expect(Number.isNaN(parseWibTimestamp('2024-01-01').getTime())).toBe(true)
  })
})
