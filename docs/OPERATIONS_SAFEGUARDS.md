# Cash obligations, dispatch deadlines and committed shop intake

These rules extend Phase 5–6. All endpoints use the `road_as_token` cookie. Swagger includes the request shapes. Dispatch detail adds `operations`, `intakes` and `supportCases` for full participants; destination shops receive only their own reservations through the redacted view.

## Unpaid cash obligations

`GET /api/v1/payments/cash-eligibility` reads the rider's own obligations. A positive bill item with a historical cash commitment counts only after its request is rider-resolved or acknowledged unfixable (statuses 4/12). Due balance is authoritative item value less online HELD/CONFIRMED or confirmed cash allocations for the current provider. Pending cash is a promise, not receipt of money.

By default, any unpaid completed cash obligation older than 24 hours, or two unpaid completed requests even inside that grace period, prevents a **new cash commitment**. Existing promises remain valid; online rescue/payment remains available. A revoked provider or method change does not erase the item's cash commitment marker. Startup backfills the marker from historical cash allocations.

`POST /payments/switch-cash-to-sepay` accepts billId and optional ticketId/billItemId/clientRequestId. It atomically cancels unpaid cash promises for completed work and creates the QR allocation. Select the entire scope of each original cash intent; mixed partial selection is rejected. Bank/configuration or audit failure rolls the conversion back. Reuse clientRequestId for retries. Creating, cancelling or expiring the QR does not clear debt; actual received funds do. This is separate from the provider's commission debt and payout offset ledger.

## Queue expiry, progress and safe rematching

New unassigned requests receive queueExpiresAt (default 15 minutes). Expired requests are immediately hidden from provider feeds and cannot be accepted. The minute worker records QUEUE_EXPIRED, cancels the unassigned request, voids charges and releases its vehicle through normal ledger reconciliation. A delivered vehicle awaiting shop intake is an exception: timeout opens support and keeps the request, vehicle and bay occupied.

Mobile/TOW acceptance records arrivalDueAt (default 30 minutes) and the initial distance to pickup. Trusted GOOD GPS must approach pickup by at least 100m from the last progress baseline to refresh lastProgressAt. Stationary heartbeats cannot postpone the default 10 minute no-progress deadline. A fresh trusted position within 200m, including reported accuracy, prevents a false rematch.

The rider may call `POST /dispatch/:id/request-rematch` with reason NO_PROGRESS or MISSED_ETA only while MATCHED and the relevant deadline is due. The transaction requeues, rotates chat, reconciles old allocations/refunds, frees the former provider and excludes that profile and its owner. It permits at most three rematches. ARRIVED and IN_PROGRESS cannot be rematched. The worker warns rather than automatically replacing an assigned provider.

Missing GPS during IN_PROGRESS TOW or an unavailable destination opens one support case. It never auto-cancels the trip, frees the driver's capacity, releases the rider's vehicle or silently rewrites payment obligations. Support closure records an outcome; it does not resolve the rescue request. No external SMS, email or emergency-service call is sent by this feature.

The worker walks all active requests in stable UUID pages each run, so unchanged older requests cannot starve later deadlines. Transactions recheck state under locks; repeated worker runs are idempotent. Deadlines can be processed up to one worker interval late. Clients should read current detail after reconnect/notifications.

## Shop acceptance before departure

A TOW to a shop creates a versioned REQUESTED intake. The shop owner calls `/dispatch/:id/intake/accept` with reservationId. The default reply deadline is five minutes; acceptance checks live approval, account, capabilities, duty and remaining bays under the shared owner/vehicle/provider locks. ACCEPTED holds one actual bay for 120 minutes. Simultaneous acceptances cannot overbook; availability/search, capacity edits and revoke/identity guards include held bays.

Rider `start` requires an accepted, unexpired intake and a still-eligible destination in addition to the existing payment gate. Departure changes the hold to IN_TRANSIT. From then on it **does not expire**, including if the shop turns duty off. Delivery changes it to DELIVERED and links the pending WALK_IN. Shop acceptance consumes that reservation and assigns the repair in the same transaction, so it still counts as exactly one bay. Off-duty status alone cannot prevent honoring that existing commitment; other account, approval and capability requirements remain enforced.

The shop may decline/withdraw only before transport. Once the vehicle is IN_TRANSIT/DELIVERED, it cannot abandon the reservation or decline/cancel the linked repair. It can ask for support or use the existing evidence-based unfixable flow after intake. The rider may deliberately cancel the pending child; normal release/reconciliation then applies. Failed delivery/acceptance/audit rolls the entire operation back.

Before transport, rider `/intake/request` renews expired/declined requests with a new version; stale reservation IDs cannot accept a newer request. Normal retarget releases the old hold and requests the new shop. Legacy already-moving tows receive an explicit grandfathered IN_TRANSIT record (reason LEGACY_TRANSPORT_IN_PROGRESS, acceptedAt null); migration never invents historical shop consent or interrupts a vehicle already moving. Legacy delivered vehicles awaiting intake receive a protected DELIVERED record (LEGACY_DELIVERY_AWAITING_INTAKE), so their bay and custody remain accounted for.

## Assisted alternative destination

1. Rider, assigned driver or involved shop opens `/dispatch/:id/request-assistance`. Repeated requests reuse the one open support case.
2. Admin uses `/admin/dispatch/:id/propose-destination` during IN_PROGRESS TOW, with a reason and an open support case. The original slot remains held.
3. The new shop accepts its candidate reservation, with normal capacity checks.
4. Rider calls `/dispatch/:id/confirm-destination`. The transaction validates the live candidate, transfers the hold, updates destination and invalidates the old estimate. Original fare, frozen waiting fees and payment commitments remain unchanged as an assisted operational exception. Delivery still requires trusted GPS at the new destination.

Rider `/reject-destination` releases only the candidate. Candidate expiry also leaves the original commitment intact. Admin support list/detail exposes operational contacts; it does not grant general chat access. `/admin/dispatch/support-cases/:id/resolve` requires a recorded resolution.

## Configuration

| Environment variable | Default | Allowed range |
| --- | ---: | --- |
| CASH_DEBT_GRACE_HOURS | 24 | 0–168 |
| CASH_MAX_UNPAID_COMPLETED_REQUESTS | 2 | 1–20 |
| DISPATCH_QUEUE_TTL_MINUTES | 15 | 1–1440 |
| DISPATCH_ARRIVAL_TIMEOUT_MINUTES | 30 | 1–1440 |
| DISPATCH_NO_PROGRESS_MINUTES | 10 | 1–240 |
| DISPATCH_MIN_PROGRESS_METERS | 100 | 10–1000 |
| DISPATCH_MAX_REMATCHES | 3 | 1–20 |
| INTAKE_REPLY_MINUTES | 5 | 1–60 |
| INTAKE_HOLD_MINUTES | 120 | 5–1440 |

Startup rejects noninteger/out-of-range settings. Queue, arrival, reply and hold deadlines are saved on the records; cash grace/cap and progress/rematch thresholds use the running configuration. Lowering a threshold therefore affects existing obligations or matched requests. Changing configuration never expires IN_TRANSIT/DELIVERED holds.
