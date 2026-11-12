import { DokuApiError, DokuSignatureError } from './errors.js'
import { formatTimestamp, sign, verify } from './signature.js'
import type {
  CheckStatusResponse,
  CheckoutPayment,
  CheckoutPaymentRequest,
  CheckoutPaymentResponse,
  DokuEnvironment,
  DokuNotification,
  VerifiedNotification,
} from './types.js'

const BASE_URLS: Record<DokuEnvironment, string> = {
  sandbox: 'https://api-sandbox.doku.com',
  production: 'https://api.doku.com',
}

export interface DokuClientOptions {
  /** Client ID from DOKU Back Office, e.g. `BRN-0214-1714016624673`. */
  clientId: string
  /** Secret key from DOKU Back Office. Server-side only. */
  secretKey: string
  /** Required rather than defaulted, so production is never reached by omission. */
  environment: DokuEnvironment
  /** Overrides the environment's base URL, e.g. for a recording proxy. */
  baseUrl?: string
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Defaults to 30 seconds. */
  timeoutMs?: number
  /** Clock and id source, injectable so tests can pin signatures. */
  now?: () => Date
  generateRequestId?: () => string
}

export interface RequestOptions {
  /**
   * DOKU dedupes on Request-Id, so pass a stable id when retrying the same
   * payment after a network failure. Generated when omitted.
   */
  requestId?: string
}

export type HeaderSource = Headers | Record<string, string | string[] | undefined>

export interface VerifyNotificationInput {
  /** The incoming request's headers: a Fetch `Headers` or a Node-style header object. */
  headers: HeaderSource
  /**
   * The raw body exactly as received. Re-serialising parsed JSON changes the
   * bytes and breaks the digest, so read the body as text before any parsing.
   */
  body: string
  /**
   * The path of the Notification URL configured in DOKU, e.g.
   * `/webhooks/doku`. Pass the configured path, not one read from the
   * incoming request, which a proxy may have rewritten.
   */
  requestTarget: string
}

export interface DokuClient {
  checkout: {
    /** Creates a hosted checkout page and returns its URL. */
    create(request: CheckoutPaymentRequest, options?: RequestOptions): Promise<CheckoutPayment>
  }
  orders: {
    /**
     * Looks up a transaction by invoice number, or by the Request-Id it was
     * created with. DOKU asks that this be called no sooner than 60 seconds
     * after payment completes.
     */
    status(invoiceNumberOrRequestId: string): Promise<CheckStatusResponse>
  }
  webhooks: {
    /**
     * Verifies that a notification came from DOKU and returns it parsed.
     * Throws `DokuSignatureError` otherwise; never act on an unverified body.
     */
    verify(input: VerifyNotificationInput): Promise<VerifiedNotification>
  }
}

export function createDokuClient(options: DokuClientOptions): DokuClient {
  if (!options.clientId) throw new TypeError('DOKU clientId is required')
  if (!options.secretKey) throw new TypeError('DOKU secretKey is required')
  if (!(options.environment in BASE_URLS)) {
    throw new TypeError(`DOKU environment must be "sandbox" or "production", got "${options.environment}"`)
  }

  const { clientId, secretKey } = options
  const baseUrl = (options.baseUrl ?? BASE_URLS[options.environment]).replace(/\/+$/, '')
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  const now = options.now ?? (() => new Date())
  const generateRequestId = options.generateRequestId ?? (() => crypto.randomUUID())

  async function request(
    method: 'GET' | 'POST',
    path: string,
    payload: unknown,
    requestId: string,
  ): Promise<unknown> {
    const timestamp = formatTimestamp(now())
    // Serialise once: the digest must cover exactly the bytes that are sent.
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    const signature = await sign(secretKey, { clientId, requestId, timestamp, requestTarget: path, body })

    const headers: Record<string, string> = {
      'Client-Id': clientId,
      'Request-Id': requestId,
      'Request-Timestamp': timestamp,
      Signature: signature,
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let parsed: unknown = text
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      // Not JSON; keep the text so the error still shows what DOKU said.
    }
    if (!res.ok) {
      throw new DokuApiError(
        `DOKU ${method} ${path} failed with ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`,
        res.status,
        parsed,
        requestId,
        path,
      )
    }
    return parsed
  }

  return {
    checkout: {
      async create(checkoutRequest, requestOptions) {
        const { amount } = checkoutRequest.order
        if (!Number.isInteger(amount) || amount <= 0) {
          throw new TypeError(`DOKU order.amount must be a positive whole number of IDR, got ${amount}`)
        }
        const path = '/checkout/v1/payment'
        const requestId = requestOptions?.requestId ?? generateRequestId()
        const data = (await request('POST', path, checkoutRequest, requestId)) as
          | { response?: CheckoutPaymentResponse }
          | undefined
        const response = data?.response
        if (!response?.payment?.url) {
          throw new DokuApiError('DOKU checkout response has no payment.url', 200, data, requestId, path)
        }
        return {
          url: response.payment.url,
          tokenId: response.payment.token_id,
          sessionId: response.order.session_id,
          expiresAt: parseWibTimestamp(response.payment.expired_date),
          requestId,
          raw: response,
        }
      },
    },

    orders: {
      async status(invoiceNumberOrRequestId) {
        // Request-Target must be the path as sent, so sign the encoded form.
        const path = `/orders/v1/status/${encodeURIComponent(invoiceNumberOrRequestId)}`
        return (await request('GET', path, undefined, generateRequestId())) as CheckStatusResponse
      },
    },

    webhooks: {
      async verify({ headers, body, requestTarget }) {
        const requestId = readHeader(headers, 'request-id')
        const timestamp = readHeader(headers, 'request-timestamp')
        const signature = readHeader(headers, 'signature')
        const incomingClientId = readHeader(headers, 'client-id')
        if (!requestId || !timestamp || !signature || !incomingClientId) {
          throw new DokuSignatureError('DOKU notification is missing a Client-Id, Request-Id, Request-Timestamp or Signature header')
        }
        if (incomingClientId !== clientId) {
          throw new DokuSignatureError(`DOKU notification is for Client-Id ${incomingClientId}, not this client`)
        }
        const valid = await verify(
          secretKey,
          { clientId, requestId, timestamp, requestTarget, body },
          signature,
        )
        if (!valid) throw new DokuSignatureError('DOKU notification signature does not match')

        let notification: DokuNotification
        try {
          notification = JSON.parse(body) as DokuNotification
        } catch {
          throw new DokuSignatureError('DOKU notification body is signed but is not valid JSON')
        }
        return { notification, requestId, timestamp }
      },
    },
  }
}

function readHeader(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value[0] : value
  }
  return undefined
}

/** Parses DOKU's `yyyyMMddHHmmss` in UTC+7 (WIB) into a Date. */
export function parseWibTimestamp(value: string): Date {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value ?? '')
  if (!match) return new Date(Number.NaN)
  const [, y, mo, d, h, mi, s] = match.map(Number) as [number, number, number, number, number, number, number]
  return new Date(Date.UTC(y, mo - 1, d, h - 7, mi, s))
}
