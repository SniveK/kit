/** Base class, so callers can catch everything this package throws in one place. */
export class DokuError extends Error {
  override name = 'DokuError'
}

/** DOKU answered with a non-2xx status. */
export class DokuApiError extends DokuError {
  override name = 'DokuApiError'

  constructor(
    message: string,
    /** HTTP status DOKU returned. */
    readonly status: number,
    /** Parsed JSON body when DOKU sent JSON, otherwise the raw text. */
    readonly body: unknown,
    /** The Request-Id this client sent, for matching against DOKU's dashboard and support. */
    readonly requestId: string,
    /** The request path, e.g. `/checkout/v1/payment`. */
    readonly path: string,
  ) {
    super(message)
  }
}

/** An incoming notification failed verification and must not be trusted. */
export class DokuSignatureError extends DokuError {
  override name = 'DokuSignatureError'
}
