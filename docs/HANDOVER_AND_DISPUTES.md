# Vehicle handover and dispute adjudication

This implements the evidence-based towing handover and the dispute part of Phase 7. Chat already uses versioned participant rooms. Ratings remain a separate roadmap item. All operations use the `road_as_token` session cookie; Swagger contains request schemas.

## Two-party vehicle handover

GPS confirms proximity only. A new TOW requires separate PICKUP and DELIVERY condition reports:

1. After ARRIVED, the assigned driver posts `/api/v1/dispatch/:id/handovers` with phase PICKUP, condition, 2–8 newly attached owned S3 image assetIds, and an explicit damages array. Each damage records part and description; an empty array explicitly declares none observed. Capture all sides of the vehicle, pre-existing scratches/dents and accessories before loading.
2. The rider reviews that exact report ID and calls `/handovers/confirm` or `/handovers/reject` with a reason and optional own photos. The author cannot self-confirm. Start still requires the accepted shop reservation and payment gate.
3. During IN_PROGRESS, at the destination, the driver creates DELIVERY with after-transport photographs and observed condition. The receiving shop owner confirms for a shop destination; the rider confirms a coordinate destination. This is independent of the rider's existing resolve/financial acceptance action.
4. Rider resolve requires the confirmed current DELIVERY report plus trusted GPS, and atomically performs the existing shop-intake handoff where applicable.

Proposals use the driver's current trusted server-stored GPS at pickup/destination, never arbitrary coordinates from the report body. Reports store location/accuracy/time snapshots, author, recipient, images, condition, damages, version and response. GPS and uploaded photographs remain participant-supplied operational evidence; they do not independently authenticate when a photograph was taken.

Confirmed content cannot be edited. Rejection permits a new version with new owned assets; old evidence and responses remain. Changing provider or destination invalidates applicability of old consent; a confirmed report for the old destination cannot complete the rerouted trip. Exact proposal/confirmation retries preserve the existing record. Claiming image assets, recording consent and writing the dispatch audit occur in the same transaction. Evidence cannot be reused from another attachment or account.

GET `/dispatch/:id/handovers` returns reports to the rider/current driver/current destination shop. Former report parties retain access only to reports they authored or received. Outsiders receive 404. The API never exposes report history to arbitrary nearby providers. S3 assets continue to use the previously requested public `picare-s3/roadassist` storage policy; API authorization does not make those underlying URLs private.

A disagreement blocks departure/completion until corrected evidence is accepted; use operational assistance if the parties cannot agree. The server never fabricates consent or releases an in-transit vehicle on timeout. Startup enables the gate for existing active TOWs. A trip already in progress has no invented historical pickup report, but must provide real DELIVERY evidence before completion. Completed historical trips are not rewritten.

## Filing, response and review

- A rider or the owner of the historically assigned provider may file within **seven days** of rider completion/acknowledged unfixable (4/12, resolvedAt). The exact seven-day boundary is closed. Nonparticipants and uncompleted requests are rejected.
- POST `/api/v1/disputes` takes ticketId, reason, note and optional 0–8 owned image assetIds. One shared case is allowed per ticket; both sides present their positions there. An exact retry by the claimant returns the case; a conflicting filing returns DISPUTE_ALREADY_EXISTS with the existing ID.
- The transaction snapshots claimant, respondent and liable provider owner, stores an immutable OPENED event, sets disputeHold and sends durable in-app notifications. Provider revocation/re-registration does not change the financial owner of the case.
- GET `/disputes/my-disputes` lists both claimant and respondent cases. GET `/disputes/:id` includes immutable evidence/history, related current/direct-parent towing handovers, ruling, refund and recovery ledger. Admin uses `/admin/disputes` and `/admin/disputes/:id`.
- POST `/disputes/:id/evidence` accepts an explanation and up to eight owned images. Each party may add up to 20 entries. The first respondent submission records respondedAt. Neither party may rewrite or delete existing evidence.
- The default response period is **48 hours**, configured by DISPUTE_RESPONSE_HOURS (integer 1–168, validated at startup). Its absolute deadline is saved when filing. After the deadline, submissions close and maintenance changes OPEN to REVIEW once. The hold remains; silence does not award money to either side.

Admin may adjudicate after a respondent has submitted a response, or once the deadline expires. Admin cannot adjudicate their own participant case. PUT `/admin/disputes/:id/resolve` requires resolution and a reasoned note; partial refund also requires an integer VND amount.

| Resolution | Outcome |
| --- | --- |
| FAVOR_RIDER | Award the full remaining adjudicable ticket value |
| PARTIAL_REFUND | Positive award strictly below the remaining ticket value |
| FAVOR_PROVIDER | No rider monetary award; close RESOLVED |
| NO_ACTION | No monetary award; close REJECTED |

An award is capped at the ticket's current retained service value. This flow does not award vehicle replacement value or compensation above service charges. Already-reduced/refunded service value cannot be awarded again. Repeating an identical ruling is idempotent; a different ruling on a final case is rejected. There is no automatic appeal/reopening or automatic bank transfer.

## Financial treatment

The adjudication separates **unpaid service credit** from **compensation for already collected service**:

1. Apply the award against unpaid line-item value first. Accumulated BillItem.disputeCredit reduces the authoritative item on every future reconciliation. The original dispatch quote/pricing snapshots remain intact. Stale cash/QR promises are reconciled through the existing ledger. No cash receipt or bank refund is invented for money never received.
2. The remainder creates exactly one PENDING Refund linked to the dispute and one immutable ProviderRecovery obligation linked to the captured provider account. That amount is separate adjudicated compensation. The original collected service revenue/commission and historical settled payout entries are retained; this is not a retroactive fee recalculation.
3. Admin executes the refund externally and records it through the existing `/admin/finance/refunds/:id/complete` endpoint with a unique bank transfer reference. The endpoint validates the ruling and amount, atomically stores immutable proof, marks completion, appends dispute/finance history and notifies the rider. Until then the UI must show **refund pending**, not refunded. Global transfer-proof uniqueness prevents reuse for a different refund or payout.
4. Recovery is deducted from the provider's next eligible online net earnings, after existing cash-commission offsets. It never creates a negative payout. Uncovered balance carries forward across provider profiles owned by the same account; cash-only or fully paid-out history does not erase it. The platform may refund before recovering that balance; both liabilities stay visible.
5. A batch reservation does not reduce outstanding recovery. Only SETTLED offsets do. Batch cancellation releases reservations; rebuilding cannot clear or double-consume debt. Dispute events record reservation, cancellation and settlement, and case detail exposes offset history and outstanding balance.

Example: a paid 100,000 VND service at the existing 10% commission receives a 30,000 VND adjudicated award. Original service remains 100,000 collected, commission 10,000; a separate 30,000 refund obligation and provider recovery are created. If not yet paid out, the next payout is 90,000 − 30,000 = 60,000. If the original 90,000 was already paid out, that history stays unchanged and 30,000 carries to future earnings. A 30,000 award against an entirely unpaid 100,000 cash service instead leaves a 70,000 service obligation and creates no bank refund/recovery.

Bill detail includes disputeAwards alongside ordinary and dispute-linked refund rows. Provider earnings includes disputeRecoveries; payout entries include recoveryOffset and batches include recoveryOffsets. Clients should distinguish credited debt, pending refund, completed refund and outstanding provider recovery.

## Payout races and audit

Payout checks both disputeHold and OPEN/REVIEW cases at batch creation and settlement. Filing serializes on the same owner/ticket locks as settlement: settlement may finish before filing, in which case recovery handles the already-paid funds, or the hold blocks it. An open case cannot become eligible from a stale list result.

Monetary rulings acquire the payout advisory lock and lock all affected journeys in one global order. All pending batches containing the liable provider are cancelled atomically for rebuilding, including their cash/recovery reservations; this prevents an older pending batch from paying the full balance after a new recovery arises. Settled batches are never cancelled or rewritten. Zero-award rulings release the hold without invalidating unchanged batches.

Case state, debt credits, batch cancellation, refund/recovery creation and both audit journals commit or roll back together. Evidence and journal failure cannot silently remove the hold. History is append-only. In-app notices are durable with best-effort Socket.IO delivery; clients deduplicate notification IDs and reload after reconnect. No external email, SMS or bank API call is made by these flows.

The integration suite covers photo ownership, stale destination consent, independent parties, legacy trips, filing deadlines/permissions, response expiry, immutable history, unpaid credit, online/cash awards, payout holds, post-settlement recovery, concurrent rulings/filing, unique refund proof and transaction rollback.
