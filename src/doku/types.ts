// Field names mirror DOKU's JSON exactly (snake_case) so DOKU's own docs map
// one-to-one onto these types, and new fields can be added without a
// translation layer.
//
// String unions end in `(string & {})`: DOKU adds channels and statuses over
// time, and an unknown value must type-check rather than be rejected, while
// the known values still autocomplete.

export type DokuEnvironment = 'sandbox' | 'production'

/** Values DOKU documents for `payment.payment_method_types`. */
export type PaymentMethodType =
  | 'VIRTUAL_ACCOUNT_BCA'
  | 'VIRTUAL_ACCOUNT_BANK_MANDIRI'
  | 'VIRTUAL_ACCOUNT_BANK_SYARIAH_MANDIRI'
  | 'VIRTUAL_ACCOUNT_DOKU'
  | 'VIRTUAL_ACCOUNT_BRI'
  | 'VIRTUAL_ACCOUNT_BNI'
  | 'VIRTUAL_ACCOUNT_BANK_PERMATA'
  | 'VIRTUAL_ACCOUNT_BANK_CIMB'
  | 'VIRTUAL_ACCOUNT_BANK_DANAMON'
  | 'VIRTUAL_ACCOUNT_BNC'
  | 'VIRTUAL_ACCOUNT_BTN'
  | 'VIRTUAL_ACCOUNT_MAYBANK'
  | 'VIRTUAL_ACCOUNT_SINARMAS'
  | 'ONLINE_TO_OFFLINE_ALFA'
  | 'ONLINE_TO_OFFLINE_INDOMARET'
  | 'CREDIT_CARD'
  | 'DIRECT_DEBIT_BRI'
  | 'DIRECT_DEBIT_CIMB'
  | 'DIRECT_DEBIT_ALLO'
  | 'EMONEY_SHOPEEPAY'
  | 'EMONEY_OVO'
  | 'EMONEY_DANA'
  | 'EMONEY_LINKAJA'
  | 'EMONEY_DOKU'
  | 'QRIS'
  | 'PEER_TO_PEER_AKULAKU'
  | 'PEER_TO_PEER_KREDIVO'
  | 'PEER_TO_PEER_INDODANA'
  | 'PEER_TO_PEER_BRI_CERIA'
  | 'JENIUS_PAY'
  | 'OCTO_CLICKS'
  | 'EPAY_BRI'
  | 'PERMATA_NET'
  | 'KLIKPAY_BCA'
  | 'DANAMON_ONLINE_BANKING'
  | (string & {})

/**
 * `transaction.status` in check-status responses and notifications.
 * https://developers.doku.com/get-started-with-doku-api/check-status-api/non-snap
 */
export type TransactionStatus =
  | 'PENDING'
  | 'SUCCESS'
  | 'FAILED'
  | 'EXPIRED'
  | 'REFUNDED'
  | 'TIMEOUT'
  | 'REDIRECT'
  | 'VOIDED'
  | (string & {})

/**
 * Statuses DOKU marks as final. `FAILED` is deliberately absent: DOKU lets the
 * customer retry on the same checkout page, so a failed attempt can still
 * become `SUCCESS`.
 */
export const FINAL_TRANSACTION_STATUSES: readonly TransactionStatus[] = ['SUCCESS', 'EXPIRED', 'REFUNDED']

export function isFinalStatus(status: TransactionStatus): boolean {
  return FINAL_TRANSACTION_STATUSES.includes(status)
}

export interface LineItem {
  id?: string
  name?: string
  /** Whole IDR. Each `price * quantity` must sum to `order.amount`. */
  price?: number
  quantity?: number
  sku?: string
  category?: string
  url?: string
  image_url?: string
  type?: string
}

export interface Address {
  first_name?: string
  last_name?: string
  address?: string
  city?: string
  postal_code?: string
  phone?: string
  country_code?: string
}

/**
 * Body of `POST /checkout/v1/payment`. Which optional fields are required
 * depends on the payment methods offered (paylater channels need line items
 * and addresses, for example); see DOKU's backend integration guide.
 */
export interface CheckoutPaymentRequest {
  order: {
    /** Whole IDR, no decimals. */
    amount: number
    /** Max 64 chars, or 30 if credit card is enabled. */
    invoice_number: string
    currency?: 'IDR' | (string & {})
    callback_url?: string
    callback_url_cancel?: string
    callback_url_result?: string
    language?: 'EN' | 'ID' | (string & {})
    auto_redirect?: boolean
    disable_retry_payment?: boolean
    recover_abandoned_cart?: boolean
    /** Minutes, max 44640. */
    expired_recovered_cart?: number
    line_items?: LineItem[]
  }
  payment?: {
    /** Minutes until the checkout page expires. DOKU's default is 60. */
    payment_due_date?: number
    type?: 'SALE' | 'INSTALLMENT' | 'AUTHORIZE'
    /** Omit to show every method enabled on the merchant account. */
    payment_method_types?: PaymentMethodType[]
  }
  customer?: {
    id?: string
    name?: string
    last_name?: string
    phone?: string
    email?: string
    address?: string
    postcode?: string
    state?: string
    city?: string
    country?: string
  }
  shipping_address?: Address
  billing_address?: Address
  additional_info?: {
    allow_tenor?: number[]
    doku_wallet_notify_url?: string
    /** Sends this order's notifications to a different URL than the dashboard setting. */
    override_notification_url?: string
    [key: string]: unknown
  }
}

/** The `response` object DOKU returns from `POST /checkout/v1/payment`. */
export interface CheckoutPaymentResponse {
  order: {
    /** DOKU echoes the amount back as a string. */
    amount: string | number
    invoice_number: string
    currency?: string
    session_id?: string
    [key: string]: unknown
  }
  payment: {
    payment_method_types?: PaymentMethodType[]
    payment_due_date: number
    token_id: string
    url: string
    /** `yyyyMMddHHmmss` in UTC+7 (WIB). */
    expired_date: string
  }
  [key: string]: unknown
}

export interface CheckoutPayment {
  /** Hosted checkout page to redirect the customer to. */
  url: string
  tokenId: string
  sessionId: string | undefined
  /** When the checkout page expires, parsed from DOKU's WIB `expired_date`. */
  expiresAt: Date
  /**
   * The Request-Id this payment was created with. Store it: DOKU's cancel API
   * identifies the order by it (`original_request_id`), and check status
   * accepts it in place of the invoice number.
   */
  requestId: string
  /** DOKU's full `response` object, for fields this type doesn't surface. */
  raw: CheckoutPaymentResponse
}

/**
 * Shared shape of check-status responses and payment notifications. Channel
 * specific blocks (`virtual_account_info`, `card_payment`, `emoney_payment`
 * and so on) vary by method and come through untyped.
 */
export interface DokuTransaction {
  order: {
    invoice_number: string
    amount: number
    /** Checkout order-level status, e.g. `ORDER_GENERATED`, `ORDER_EXPIRED`, `ORDER_RECOVERED`. */
    status?: string
    [key: string]: unknown
  }
  transaction: {
    status: TransactionStatus
    date?: string
    original_request_id?: string
    type?: string
    [key: string]: unknown
  }
  service?: { id: string; [key: string]: unknown }
  acquirer?: { id: string; name?: string; [key: string]: unknown }
  channel?: { id: string; name?: string; [key: string]: unknown }
  customer?: { name?: string; email?: string; [key: string]: unknown }
  additional_info?: Record<string, unknown>
  [key: string]: unknown
}

export type CheckStatusResponse = DokuTransaction
export type DokuNotification = DokuTransaction

export interface VerifiedNotification {
  notification: DokuNotification
  /** Unique per notification. Use it to drop DOKU's duplicate deliveries. */
  requestId: string
  timestamp: string
}
