# Billing, SePay, cash and payouts

Hợp đồng giá và bill hiện hành: [PAYMENTS_AND_PRICING.md](PAYMENTS_AND_PRICING.md). Các mô tả journey tổng hợp dưới đây chỉ còn áp dụng cho bill lịch sử nhiều ticket.

Phase 6 connects the real billing models to Phase 5. Invoice reconciliation happens inside dispatch create/change transactions; the approval/start gate uses current **applied** allocations, not customer flags or the original transfer amount. Account APIs use `road_as_token`; the machine webhook uses its independently configured SePay authentication.

## Invoice and monetary invariants

New tickets have one Bill per ticket (unique ticketId); journeyId groups navigation only. Legacy multi-ticket bills remain unchanged. BillItem is unique per ticket and charge type: SOS_CALLOUT, SOS_TRAVEL, TOW_FARE, WAITING_FEE, SHOP_REPAIR. New charge types include a separate SOS travel line so failure can void travel independently of callout. Historical line IDs are retained when values become zero.

Items derive from immutable vehicle/tariff snapshots, current assigned provider, quoteVoided/chargesVoided and live server waiting time. The invoice is DRAFT for unpriced active work, PENDING/PARTIAL/PAID according to actual applied receipts, or VOID when every ticket ends with no payable amount. Cash promises reserve a payment allocation and can authorize work, but do **not** count as paid money.

Each PaymentIntent allocates into one or more BillPayment rows, each bound to one item, ticket and provider snapshot. A whole-journey QR can therefore cover different providers without reusing one payment to unlock unrelated work. `amount` records the original allocation; `appliedAmount` records the portion still payable; `refundedAmount` records completed returns. Already refunded funds cannot reappear when an item later increases again. The dispatch gate checks the current provider and actual eligible applied amounts.

Use optional UUID `clientRequestId` to retry creation safely. Reuse with different bill/item/ticket/method returns 409. Pending reservations prevent overlapping orders. An identical pending selection can return its existing intent; a growing waiting charge can create a separate top-up for the difference. Changing method requires cancelling the previous unfulfilled intent. Approved/in-progress work cannot lose its cash commitment through the payment-cancel endpoint. Dispatch cancellation/repricing can still invalidate stale promises as part of the authoritative business transition.

Amounts are stored as DECIMAL(12,2), calculated in integer cents and bounded to that database precision. Customer payment allocations, new binding quotes, estimates and dispatch tariffs use **whole VND**. Fractional VND is rejected instead of silently increasing the agreed amount. Existing unpaid fractional quotes need cancellation/recreation before payment. Commission is rounded half-up to whole dong per allocation; the rate is snapshotted as integer basis points when the payment is created. For example, 10% of 5,005₫ is recorded as 501₫, leaving a transferable 4,504₫. Historical debt never changes when the configured rate changes.

## HTTP endpoints

All paths below start with `/api/v1` and use the standard success envelope, except the webhook's exact acknowledgment.

| Method / path | Access | Behavior |
| --- | --- | --- |
| GET `/bills/my-bills` | Rider | Own bills, total count, unpaid count |
| GET `/bills/:id` | Owner rider | Reconciled invoice, items, payments, refunds |
| POST `/payments/create-sepay-qr` | Owner rider | Create/reuse item-allocated QR intent |
| POST `/payments/choose-cash` | Owner rider | Create cash promises without pretending money was received |
| POST `/payments/confirm-cash` | Assigned provider | Confirm one allocation at handover/end |
| GET `/payments/:id` | Owner rider | Poll intent, allocations and transfer instructions |
| POST `/payments/:id/cancel` | Owner rider | Cancel an unfulfilled, cancellable intent |
| GET `/payments/provider-earnings` | Owner account | Gross, held online money, commission debt, receipts and payout entries across owned profiles |
| POST `/payments/sepay/webhook` | SePay key/HMAC | Durable receipt ingestion and exact ACK |
| GET `/admin/payouts/pending-items` | Admin | Eligible confirmed receipts and outstanding cash debts |
| POST `/admin/payouts/create-batch` | Admin | Reserve eligible receipts and commission offsets |
| GET `/admin/payouts/batches` | Admin | Batch history |
| PUT `/admin/payouts/:id/settle` | Admin | Record completed external transfers and settle offsets |
| POST `/admin/payouts/:id/cancel` | Admin | Cancel a pending batch and release reservations |
| GET `/admin/finance/refunds` | Admin | Required refunds and completion history |
| POST `/admin/finance/refunds/:id/complete` | Admin | Record a refund actually performed |
| GET `/admin/finance/sepay-receipts` | Admin | Original payloads, processing/review status |
| POST `/admin/finance/sepay-receipts/:id/reconcile` | Admin | Match a reviewed receipt without bypassing bank validation |
| POST `/admin/finance/sepay-receipts/:id/refund` | Admin | Record return of unmatched money, preventing later reuse |
| GET `/admin/finance/events` | Admin | Append-only application finance journal |
| GET `/admin/finance/transfers` | Admin | Globally unique external transfer attestations |

Lists accept `limit` 1–100 and `offset` 0–100000. Currency strings are exact decimal representations. An unrelated UUID returns 404, not another account's bank or invoice data.

Create payment body:

```json
{
  "billId": "<owned bill UUID>",
  "billItemId": "<optional one item UUID>",
  "ticketId": "<optional ticket UUID>",
  "clientRequestId": "<optional retry UUID>"
}
```

Omit item/ticket selectors for all unreserved balances. Amount, provider, paid status, commission and bank destination are server-owned. Sending those fields cannot override the invoice. Cash confirmation takes `{ "paymentId": "<BillPayment UUID>" }`. PaymentIntent IDs and allocation IDs are distinct.

## Configuration

```dotenv
SEPAY_ACCOUNT_NUMBER=
SEPAY_BANK_CODE=MBBank
SEPAY_GATEWAY_NAME=MBBank
SEPAY_ACCOUNT_NAME=
SEPAY_SUB_ACCOUNT=
SEPAY_TRANSFER_PREFIX=
SEPAY_WEBHOOK_AUTH=apikey
SEPAY_WEBHOOK_TOKEN=
SEPAY_WEBHOOK_SECRET=
PAYMENT_TTL_MINUTES=15
PLATFORM_COMMISSION_RATE=0.10
PAYOUT_HOLD_DAYS=7
```

Configure the merchant account and webhook in the SePay console before live use. `SEPAY_GATEWAY_NAME` must match the callback's bank name, especially if BANK_CODE is a BIN/alias. SUB_ACCOUNT is an optional virtual-account identifier; TRANSFER_PREFIX supports required bank memo text. Beneficiary details and required memo prefix are captured on each intent so later configuration changes do not rewrite existing instructions. QR generation fails with 503 if the bank or the selected webhook authentication is missing.

`SEPAY_API_KEY`/`SEPAY_API_URL` are separate Bank API settings; they are not substituted for the webhook secret. This implementation receives signed/authenticated bank notifications and does not issue bank transfers through the SePay Bank API. No real merchant secrets are committed in `.env.example`.

QR instructions use SePay's documented `https://vietqr.app/img` parameters and a generated `RA` plus 20 decimal digits. Bank-specific VA/memo configuration remains a merchant setting. See [SePay QR reference](https://developer.sepay.vn/en/tien-ich-khac/tao-qr-code).

## Webhook authentication and durable inbox

The JSON endpoint is capped at 64 KiB. API-key mode accepts `Authorization: Apikey <SEPAY_WEBHOOK_TOKEN>` or `X-Secret-Key`. If both are supplied, neither may conflict. HMAC mode requires its own secret, `X-SePay-Timestamp` and `X-SePay-Signature`; it checks the original raw bytes and a five-minute clock window. HMAC mode never falls back to an API key. See [SePay authentication](https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc).

After authentication and structural validation, the server persists SepayReceipt before returning HTTP 200 with exactly `{ "success": true }`. Database failure does not receive a success acknowledgment. Processing runs after the response and through a ten-second startup/cron worker; acknowledgment means accepted for processing, not paid. This follows the provider's [webhook contract](https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook).

Unique SePay event IDs and bank reference keys prevent replay credit. Identical replays acknowledge successfully; changed financial fields return 409 and append a rejected-replay audit entry. Receipt payloads retain their original validated values. The processing transaction locks the journey and receipt and checks again before crediting, so concurrent workers cannot apply one transfer twice. Receipt processing is ordered by persistence time and UUID.

The processor validates incoming direction, beneficiary account, bank and optional subaccount against the intent snapshot. It requires one unambiguous payment code. Unknown/ambiguous codes, wrong receiving accounts and balance-limit exceptions enter REVIEW without unlocking work. Outgoing notifications are IGNORED. This preserves bank evidence for operations rather than silently claiming success as a payment.

Partial transfers accumulate in `receivedAmount` but leave allocations PENDING until the full intended amount is received. Once funded, the allocations become HELD; **the rider must still approve the quote or start towing**. A callback does not directly move dispatch to IN_PROGRESS. Additional transfers cannot fund the allocation twice: excess money creates a distinct unallocated refund liability. Receipts persisted before expiry may finish processing afterward; an unprocessed timely receipt prevents premature expiry. Late receipts for expired/cancelled intents become refund liabilities instead of funding changed work.

Admin reconciliation requires a reason and a reviewed receipt. It records a resolved code separately, preserving the original payload/hash, and still checks account/bank/VA. An unmatched verified incoming receipt can instead be marked REFUNDED after the actual return; the processor then refuses any later reconciliation/replay credit. Receipts for an unrecognized receiving account cannot be marked as if merchant funds were returned.

## Cash, escrow and repricing

CASH PENDING is a promise permitted by the roadmap's approval gate. Only the allocation's provider owner can confirm receipt, only for current assignment and at READY/RESOLVED/UNFIXABLE/acknowledged failure. Duplicate confirmation is harmless. Cash-confirmed money is never scheduled to be paid to the provider again; it creates commission debt.

Online HELD is an application ledger reservation of money in the configured merchant bank account. It is not a separately provisioned bank escrow account. On rider RESOLVED or acknowledged UNFIXABLE, positive retained allocations become CONFIRMED. Voided zero-value allocations stay held for refund processing and cannot enter payouts. Provider-ready alone does not release online money.

Each dispatch mutation reconciles its invoice in the same database transaction. Cancellation, provider replacement, repricing and repair failure invalidate mismatched pending commitments and reduce applied value of received allocations. Fees are never inferred from customer-supplied money fields. Refund requests preserve original amounts, retained value and completed returns; requesting a refund does **not** mark it paid back. Rider-authorized actions continue to respect the dispatch state machine.

For TOW, invoice reads/payment creation derive current waiting fees from server time. If waiting increases before `/dispatch/:id/start`, the existing allocations cover only their original amounts; create a top-up for the difference. Start freezes waiting and verifies funding against that frozen total. After start, waiting cannot grow further.

Refund completion records an admin attestation of an external return. It checks available received money, existing refunds and payout locks, then writes the globally unique transfer proof, amount/state change and journal atomically. This server does not send the refund automatically. Fully returned allocations become REFUNDED; partial returns remain visible through refundedAmount and Refund records. Completed refunds reduce the capacity of the old allocation permanently.

A bank transfer reference cannot be reused to attest both a refund and a payout. The proof key normalizes Unicode, case and whitespace; exact retries of already completed operations remain idempotent. Application hooks prevent finance journal/proof edits and deletion; normal APIs expose no financial hard-delete operation.

## Payout batches and commission debt

Eligibility is checked when reserving **and** settling. Only positive CONFIRMED allocations whose ticket is rider-resolved/acknowledged qualify. Default release delay is seven days from resolvedAt, matching the future dispute window. `disputeHold`, an OPEN/REVIEW Dispute case, pending allocation refunds and prior reservation block release. HELD funds and unconfirmed cash cannot be paid out. Dispute filing sets disputeHold under the same financial locks; OPEN/REVIEW cases both block payout.

A global database advisory lock serializes payout batch operations. Journey owner/ticket/payment locks and reservation records prevent duplicate inclusion and double use of a cash debt. Cash commission is tracked by captured owner account, so revoking/recreating a Provider cannot remove debt. Historical profiles can still have earned receipts and debts.

For each owner:

```text
online net before offset = online applied gross - online commission
cash debt available = cash commission still owed - pending batch reservations
debt offset = min(online net before offset, available cash debt)
bank payout = online net before offset - debt offset
```

Cash gross is reported but is already physically received by the provider, so it never increases bank payout. Uncovered debt carries into later batches, including across profiles of the same owner. A cash-only batch may have zero bank payout and can be settled without a transfer. Reserved offsets do not reduce outstanding debt until settlement; cancelling a pending batch releases reservations and leaves the debt intact. Reconciliation always deducts all historically settled offsets, even if the original cash-only batch is later cancelled, so settled commission cannot become debt again. A reduction below commission already recovered is blocked pending an explicit adjustment.

Settle body:

```json
{
  "transfers": [
    { "entryId": "<nonzero payout entry UUID>", "amount": "80000", "reference": "<actual external transfer reference>" }
  ]
}
```

Supply exactly one matching amount/reference for every positive entry; zero entries need none. Settlement records manual transfers already performed, not an instruction to move money. Wrong amounts, duplicate proofs, newly opened holds or changed debt reject the whole operation. Identical settle retries return the settled batch; a different proof cannot replace history. Settled batches cannot be cancelled. A pending blocked batch can be cancelled before refund/reconciliation proceeds.

Gross and commission reporting include newly batched online and cash receipts; `net` is the actual bank payout after debt offsets, not simply gross minus commission. Provider earnings show gross confirmed receipts, held online funds, cash commission outstanding, allocation history and payout entries. Transfer/rounding limits remain bounded by DECIMAL(12,2); an oversized aggregate is rejected rather than partially committed.

## Recovery, notifications and test coverage

Finance notifications are durable rows plus best-effort Socket.IO events: PAYMENT_HELD, PAYMENT_CONFIRMED, REFUND_COMPLETED and PAYOUT_SETTLED. Clients deduplicate notification IDs and reload bills/earnings after reconnect. The ten-second maintenance worker drains verified receipts, expires pending intents, creates bills for older dispatch journeys in bounded batches, and retries notices. Raw bank evidence and financial audit views are admin-only.

Database work is retried for deadlock/serialization/lock timeout and remains transactional with dispatch, debt reservations, refund/proof records and journal writes. External payment/transfer APIs are not called while holding database locks.

`RUN_DB_TESTS=1 npm test` uses isolated PostgreSQL schemas and Redis prefixes, fake merchant values and synthetic authenticated webhooks. It covers real API flow through dispatch → cash/QR → approval → completion → commission → payout, plus replay, amount/account mismatch, partial/extra/late money, HMAC tampering, fee top-ups, unfixable refunds, owner-wide debt carry, batch races, dispute delay, manual reconciliation, proof reuse and rollback. These tests do not transfer real money or claim a live merchant integration has been verified.

## Completed cash obligations

New cash promises are subject to rider eligibility: default 24 hour grace and maximum two unpaid completed requests. Online rescue remains available. `/payments/cash-eligibility` and atomic `/payments/switch-cash-to-sepay` support repayment; creating a QR does not clear debt. See [OPERATIONS_SAFEGUARDS.md](OPERATIONS_SAFEGUARDS.md) for scope, configuration and migration rules.

## Adjudicated refunds and provider recovery

[HANDOVER_AND_DISPUTES.md](HANDOVER_AND_DISPUTES.md) defines the implemented Phase 7 flow. Unpaid awards become persistent item credits; paid awards become separate dispute compensation/refund and immutable provider recovery, preserving historical collected-service commission and settled batches. Pending provider batches are cancelled atomically for rebuilding with recovery offsets. Refund completion still requires unique manual bank-transfer proof. Provider earnings exposes recovery balances; case history records reservation, cancellation and settlement.
