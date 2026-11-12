# @kleos/kit/doku

A small, dependency-free TypeScript client for the [DOKU](https://developers.doku.com) payment gateway.
It replaces the hand-rolled DOKU signing code that each Kleos app was carrying.

- **No runtime dependencies.** It uses only Web-standard `fetch` and `crypto.subtle`, so it runs anywhere the app compiles it: Bun, Node 20+, Deno and edge runtimes.
- **Framework-free.** It doesn't touch your env vars, database or HTTP framework. You pass in credentials, and you wire webhooks into your own route.
- **Typed against DOKU's own field names** (snake_case), so DOKU's docs map directly onto the types.

## Usage

```ts
import { createDokuClient } from '@kleos/kit/doku'

const doku = createDokuClient({
  clientId: process.env.DOKU_CLIENT_ID!,
  secretKey: process.env.DOKU_SECRET_KEY!,
  environment: 'sandbox', // or 'production'; required, so production is never the default
})
```

### Create a checkout page

```ts
const payment = await doku.checkout.create({
  order: {
    amount: 150000, // whole IDR
    invoice_number: 'INV-2026-0001',
    callback_url: 'https://app.example.com/billing',
  },
  payment: { payment_due_date: 60 },
})

payment.url       // redirect the customer here
payment.expiresAt // Date, converted from DOKU's WIB expired_date
payment.requestId // store it: DOKU's cancel API needs it as original_request_id
```

DOKU de-duplicates on `Request-Id`. To retry the same payment after a network failure, pass a stable id:
``doku.checkout.create(body, { requestId: `topup-${topup.id}` })``.

### Check a transaction's status

```ts
const status = await doku.orders.status('INV-2026-0001') // or the Request-Id it was created with
status.transaction.status // 'PENDING' | 'SUCCESS' | 'FAILED' | 'EXPIRED' | ...
```

DOKU asks that you call this no sooner than 60 seconds after payment completes. Use it as a fallback when a notification is late, not as a poll loop.

### Verify a payment notification

Read the body as **raw text** before parsing it. The signature covers the exact bytes DOKU sent.

```ts
import { DokuSignatureError, isFinalStatus } from '@kleos/kit/doku'

// Elysia, Hono, Next.js route handlers: anything that gives you a Fetch Request
app.post('/webhooks/doku', async ({ request, set }) => {
  try {
    const { notification, requestId } = await doku.webhooks.verify({
      headers: request.headers,
      body: await request.text(),
      requestTarget: '/webhooks/doku', // the path configured in DOKU Back Office
    })
    // requestId is unique per notification; DOKU may deliver the same one twice.
    await handlePayment(notification.order.invoice_number, notification.transaction.status, requestId)
    return { ok: true }
  } catch (e) {
    if (e instanceof DokuSignatureError) {
      set.status = 401
      return { error: 'invalid signature' }
    }
    throw e
  }
})
```

Node-style header objects (`req.headers` in Express or Medusa) work too, as long as you can get at the raw body.
Answer with a 2xx quickly and do slow work afterwards. Don't treat `FAILED` as final: the customer can still retry
on the same checkout page. `isFinalStatus()` encodes DOKU's list of final statuses.

### Errors

| Error | When |
|---|---|
| `DokuApiError` | DOKU returned a non-2xx. Has `status`, `body` (parsed JSON or text), `requestId` and `path`. |
| `DokuSignatureError` | A notification failed verification. Never act on it. |
| `TypeError` | Bad input caught before any request, e.g. a fractional `amount` or a missing `secretKey`. |

All of these except `TypeError` extend `DokuError`.

### Lower-level signing

`sign`, `verify`, `stringToSign` and `digest` are exported for DOKU APIs this client doesn't wrap yet. They implement
DOKU's [non-SNAP signature](https://developers.doku.com/get-started-with-doku-api/signature-component/non-snap).
Pass `timestampHeader: 'Response-Timestamp'` to verify the signatures DOKU puts on its own API responses.

## DOKU coverage

| Area | Status |
|---|---|
| Non-SNAP request signing (HMAC-SHA256) | ✅ |
| Checkout: create payment (`POST /checkout/v1/payment`) | ✅ |
| Check status (`GET /orders/v1/status/{id}`) | ✅ |
| HTTP notification verification | ✅ |
| Checkout: cancel order (`POST /checkout/v3/cancellations`) | Planned |
| Response signature verification | Primitive exported; not wired into the client yet |
| Direct API (non-SNAP): VA, e-wallet, cards, QRIS, O2O, paylater | Planned |
| Refunds | Planned |
| SNAP APIs (asymmetric RSA signatures, access tokens) | Planned |

## Development

From the repository root:

```sh
bun test src        # unit tests: fake fetch, signatures checked against a node:crypto reference
bun run typecheck
```
