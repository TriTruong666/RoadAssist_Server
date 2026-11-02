# Phase 5: Dispatch and assist

The API implements WALK_IN, SOS and TOW using the fifteen roadmap statuses. All `/api/v1/dispatch` operations require the HttpOnly `road_as_token` cookie. No body/header token fallback is supported. OpenAPI is in `src/swagger/dispatch.swagger.js` and `/api-docs`.

## Authority, transactions and history

- The rider owns the active vehicle (or an explicit owned `vehicleProfileId`). Creation snapshots plate, type, brand/model, riding mode, physical/load dimensions and tariff settings. Later active-vehicle changes never move an existing ticket to another vehicle.
- A partial unique PostgreSQL index allows **one nonterminal ticket per vehicle**. Terminal states are 4, 5, 8, 12, 15. Creation also checks jobs assigned to rescue profiles sharing that vehicle, so a tow truck cannot simultaneously accept work and be a rider's disabled vehicle.
- Mutations lock all involved owner accounts in UUID order, then vehicles, providers and ticket. Assignment calls `ProviderAvailabilityService.lockForAssignment` within the same transaction, checking fresh review/vehicle/account state, capability and actual capacity. SHOP bays are shared across its jobs; mobile/tow profiles sharing one vehicle share one job slot.
- After acquiring locks, operations reread assignment/destination and retry on concurrent changes. Deadlocks, serialization errors and lock timeouts retry up to three attempts, then return 409 `DISPATCH_CONCURRENT_CHANGE`. Lock timeout is 3 seconds and statement timeout is 15 seconds per dispatch transaction. Rare generated-code collisions retry with a new code.
- Each transition increments `revision` and appends an immutable `DispatchEvent`, updates chat version/membership and writes notification records in the same transaction. `expectedRevision` is optional on action bodies and rejects stale UI writes with 409 `DISPATCH_STALE_REVISION`.
- Redis and realtime delivery run after commit; a cache/socket failure cannot undo a successful assignment or return a false database failure. Periodic reconciliation and durable notification history support recovery. Database/audit/evidence/child-ticket failures roll back all writes, including chat archival and image claims.
- History keeps IDs and snapshots when provider/vehicle profiles are later revoked or removed. Former providers retain their chat version; they cannot read a reassigned ticket's new private details.

Creation optionally accepts UUID `clientRequestId`. Identical retries by the same rider return the original ticket, including after it ends. Reusing the key with different validated input returns 409 `DISPATCH_IDEMPOTENCY_CONFLICT`. Requests without a key still cannot create a second active ticket on the same vehicle. A completed ticket does not block a deliberately new request.

## API overview

All paths below start with `/api/v1/dispatch`.

| Method / path | Who | Result |
| --- | --- | --- |
| POST `/walk-in` | Rider | SOLO bike check-in at selected shop |
| POST `/sos` | Rider | Pending mobile repair request |
| POST `/tow` | Rider | Pending tow with required destination |
| GET `/my-requests` | Rider | Own active/history tickets |
| GET `/provider-feed` | Owned ready provider | Eligible pending work within 15 km |
| GET `/provider-requests` | Owned provider | Assigned work plus targeted intakes, including while off duty |
| GET `/notifications` | Account owner | Persisted personal notification history |
| GET `/:id` | Related rider/provider/shop | Authorized detail; eligible unassigned providers receive a redacted feed entry |
| POST `/:id/accept` | Eligible provider | Assign under capacity/vehicle locks |
| POST `/:id/arrive` | Rider or assigned provider | Trusted provider GPS proves arrival |
| POST `/:id/in-shop` | Assigned shop | Optional diagnosis stage |
| POST `/:id/quote` | Assigned repair provider | One binding repair quote |
| POST `/:id/approve-quote` | Rider | Funded quote → repair in progress |
| POST `/:id/start` | Rider | Funded tow → transport, waiting fee frozen |
| POST `/:id/ready` | Assigned repair provider | Work ready for rider acceptance |
| POST `/:id/resolve` | Rider | Accept repaired vehicle or delivered tow |
| POST `/:id/unfixable` | Assigned repair provider | Failure with evidence and repriced charges |
| POST `/:id/acknowledge-unfixable` | Rider | Acknowledge failure as state 12 |
| POST `/:id/cancel` | Rider / assigned provider | Role/stage-dependent cancellation or requeue |
| POST `/:id/decline` | Target shop | Decline pending WALK_IN |
| POST `/:id/tow-offer` | Assigned SOS provider | DIRECT or NETWORK offer after failure |
| POST `/:id/retry-sos` | Rider | One linked replacement SOS |
| POST `/:id/request-tow` | Rider | Consent to linked towing after failed repair |
| POST `/:id/return-tow` | Rider | Accept ready repair and request vehicle return |
| POST `/:id/estimate` | Destination shop | 24-hour preliminary repair estimate |
| POST `/:id/approve-estimate` | Rider | Approve exact estimate version |
| POST `/:id/reject-estimate` | Rider | Reject exact estimate version |
| POST `/:id/retarget` | Rider | Change destination before tow starts |

List APIs accept `limit` 1–100 (default 50) and `offset` 0–100000. Rider/provider request lists support `active=true/false`; omitted lists both. Provider lists require an owned `providerId` query parameter. Feed eligibility filters apply **before** SQL pagination. Exact pickup/vehicle snapshots, plates, image URLs, actor IDs and detailed audit history are withheld from unassigned providers. Destination shops see the repair issue/vehicle summary and estimate fields, without private rider-driver chat or trip tracking.

## Request bodies and GPS

Common create fields: optional `vehicleProfileId`, UUID `clientRequestId`, `description` up to 2000 chars, up to five unique `assetIds` and `requiredCapabilities` selected from supported repair capabilities. Money, state, fees, assignment and snapshot fields sent by a client are ignored. New VND repair quotes/estimates and tariff values must be whole dong; internal monetary arithmetic retains cents precision.

Upload photos through existing `/api/v1/uploads` (at most three per upload call). Creation/failure evidence claims only the caller's unused image assets transactionally. Raw image URLs are rejected. Trusted linked tickets inherit previous scene images without accepting arbitrary new URLs.

WALK_IN additionally requires `providerId` and:

```json
{
  "location": {
    "latitude": 10.77,
    "longitude": 106.69,
    "accuracy": 10,
    "recordedAt": "2026-11-02T08:00:00.000Z"
  }
}
```

Replace recordedAt with the actual current sample timestamp. Latitude/longitude must be finite/in range, accuracy 0–100 m and timestamp no more than two minutes old or 30 seconds future. Check-in requires center distance **plus** accuracy ≤200 m from the shop. Coordinate claims remain authenticated device reports, not hardware-attested physical presence.

SOS/TOW require `pickupLatitude`, `pickupLongitude` and optional `pickupAddress`. TOW requires either an active suitable `dropoffShopId` (coordinates/address resolved from database) or both dropoff coordinates; a shop cannot route a rider to itself through self-assignment. Destination shops must support the vehicle and declared repair needs, with valid approval revision and active verified owner.

Before towing, save `length` (0.5–20 m) and `weightKg` (20–50000 kg) using the vehicle API. Missing data produces 400 `DISPATCH_VEHICLE_SPEC_REQUIRED`; the server never substitutes an unverified request filter for physical vehicle data. Required towing width/height include the registered load configuration. These declarations must describe the actual vehicle/load. Save these details before initial repair if a return-tow option may be needed while the vehicle remains busy.

Mobile/tow acceptance requires duty, capability/capacity and a trusted fix received/recorded within two minutes. Discovery can still show providers within the broader provider TTL; accepting a job is stricter. `arrive` does not trust coordinates attached to that button: it uses the assigned provider's stored GOOD GPS fix and the same ≤200 m uncertainty test. TOW completion similarly checks the provider at the recorded destination. Existing trips may continue while a provider is off duty or administratively suspended, following the existing private-trip GPS policy; this never permits new assignments.

## States and actors

| State | Meaning and permitted progression |
| --- | --- |
| 1 PENDING | Eligible provider accepts →2; rider cancels →5; target shop may decline →8 |
| 2 MATCHED | Mobile/tow arrives →3; shop may diagnose →10 or quote →9; cancellation is restricted by actor |
| 3 ARRIVED | SOS quotes →9 or proves unfixable →15; funded TOW starts →6; early driver cancellation requeues |
| 4 RESOLVED | Terminal; repeated rider resolve is idempotent |
| 5 CANCELLED | Terminal; repeated rider cancel is idempotent |
| 6 IN_PROGRESS | Repair becomes READY →7 or UNFIXABLE →15; rider completes TOW →4 at destination |
| 7 READY | Rider accepts →4, or accepts and requests return TOW when over 1 km away |
| 8 DECLINED | Terminal target-shop refusal |
| 9 QUOTED | Exact binding quote; funded rider approval →6; no price replacement |
| 10 IN_SHOP | Optional shop diagnosis after accepting WALK_IN; quote →9/11 or failure →15 |
| 11 FINAL_QUOTED | Binding repair quote following an approved tow destination estimate; funded approval →6 |
| 12 RESOLVED_UNFIXABLE | Terminal rider acknowledgment of state 15; eligible linked handoff still allowed |
| 13 ESTIMATED | Pending TOW with preliminary destination estimate; approval →14 or rejection →1; tow acceptance still allowed |
| 14 EST_APPROVED | Pending TOW with approved estimate; tow acceptance →2 |
| 15 UNFIXABLE | Terminal repair failure with evidence; rider acknowledges →12 or creates linked rescue |

Once a TOW has a driver, estimates are tracked in `estimateStatus` and never replace MATCHED/ARRIVED transport state. Estimates carry `estimateVersion`; approval/rejection must specify that exact version. They expire after 24 hours, enforced on approval and by the minute maintenance job. Expiry returns only pending TOWs to state 1 and never rewinds an assigned/arrived trip. Retargeting before transport recalculates fare, clears estimate/approval and advances estimateVersion. Normal rider retargeting after transport starts is rejected; supported alternatives follow the admin → new shop → rider acceptance flow in [OPERATIONS_SAFEGUARDS.md](OPERATIONS_SAFEGUARDS.md).

Repair quote is a single immutable amount. An identical retry returns the current ticket; a different replacement returns `DISPATCH_QUOTE_ALREADY_SUBMITTED`. Repair providers cannot mark READY before funded approval, and cannot accept delivery on the rider's behalf.

Riders may cancel before work/transport starts (pending, matched, arrived, diagnosis or quoted). Providers may cancel only MATCHED/ARRIVED; WALK_IN provider cancellation ends that ticket, while SOS/TOW driver cancellation requeues it, clears old arrival/waiting/callout/travel-assignment data as appropriate, and archives its chat version. An in-progress driver cannot abandon the ticket via the early-cancel endpoint.

No unagreed cancellation penalty is charged in this phase: a terminal cancellation sets `chargesVoided=true` and total zero, with an audit/payment-reconciliation event. Historical price components remain for traceability and must not be billed by summing columns without considering void flags. Provider requeue keeps the TOW base/travel fare but discards the old driver's waiting period. Previous provider IDs **and owner account IDs** are excluded for this ticket/service kind; revoking/recreating a provider cannot bypass the exclusion. Changing service kind, such as an SOS owner's own TOW offer, uses a separate assignment context.

## Pricing, waiting and payment authority

Tariffs are validated at startup and snapshotted on creation. Defaults are configurable VND amounts:

| Env | Default | Rule |
| --- | --- | --- |
| DISPATCH_SOS_CALLOUT_FEE | 30000 | Waived when trusted assignment distance ≤1000 m |
| DISPATCH_SOS_PER_KM | 5000 | Assignment distance, each started kilometre |
| DISPATCH_TOW_BASE_FEE | 150000 | Fixed tow base |
| DISPATCH_TOW_PER_KM | 10000 | Pickup-to-destination distance, each started kilometre |
| DISPATCH_WAITING_PER_MINUTE | 2000 | After ten free minutes, each started minute, at most 60 billable minutes |

Current distance pricing uses spherical straight-line distance, not a road-router quote; this policy is visible in the contract and should be reviewed with actual service tariffs before launch. TOW base and distance are grouped in travelFee; SOS total = callout + travel + binding repair quote. Integer cents avoid binary floating-point money arithmetic and enforce DECIMAL(12,2) limits.

Waiting starts once the trusted tow arrival is confirmed. Read DTOs derive live waiting from server time; `/start` computes and freezes it atomically. No minute-by-minute money writes are required. Phase 6 bill generation must use current `DispatchService.dto(ticket)`/`DispatchPolicy.waiting(ticket)` **under the ticket transaction**, not stale waitingFee columns before start. Rider start verifies funding for the frozen total. After start, elapsed wall-clock time cannot raise waiting fees.

SOS failure requires reason NO_PARTS/BEYOND_REPAIR/SAFETY/OTHER and at least one owned proof image. It voids travel/repair and leaves **callout only**, which may be zero. WALK_IN failure leaves total zero. `quoteVoided=true` retains the original quoted amount for audit while excluding it from payable total. TOW does not use the repair-failure endpoint.

The payment gate fails closed. Phase 6 now registers Bill/BillItem/BillPayment and synchronizes them in dispatch transactions. Positive-value repair approval and tow start still reject unfunded allocations with 403 `PAYMENT_UNFUNDED_FOR_APPROVAL`. Zero-value work needs no deposit. Once payment models exist, the adapter:

- Locks a non-VOID journey bill belonging to the rider, its line items and payment rows.
- Requires sufficient ticket-specific line-item value and payments for the currently assigned provider.
- Accepts SePay HELD/CONFIRMED or CASH PENDING/CONFIRMED, per roadmap; rejects SePay PENDING, refunded, wrong-provider and underfunded rows.
- Allows unallocated whole-bill payments only when every item belongs to this one ticket. Multi-ticket journey payments must be allocated before approval, avoiding reuse of unrelated funds.

Client-provided funded/payment flags never affect approval. Phase 6 now implements the authenticated SePay inbox, escrow ledger, refund review and manual payout settlement. Cancellation/failure/retarget audit events mark payment reconciliation required; Phase 6 must reconcile bill items and any held money before release. Billing must respect chargesVoided/quoteVoided and immutable ticket snapshots.

## Handoff, return and delivery

A rider consents to each new rescue through the handoff endpoints; a provider offer alone creates no charged child ticket. Handoffs preserve journey ID and scene photos, link both tickets and allow only one continuation child. Retrying the same handoff returns that child. Another active ticket on the vehicle still blocks continuation. New children re-read an existing, active, owned vehicle profile and snapshot its current specifications; a deleted vehicle cannot silently reappear through an old ticket.

- Failed SOS → `/retry-sos`: a new SOS excludes prior rescuers and their replacement accounts/profiles of the same service kind.
- Failed repair → `/request-tow`: creates network TOW by default. An SOS provider may offer DIRECT only through an active eligible TOW profile owned by the same account; the rider's request then targets that profile. Other providers cannot take a DIRECT request.
- READY repair → `/return-tow`: fresh rider GPS must be over 1 km away, accounting for uncertainty. This action constitutes rider acceptance of the finished repair and atomically resolves it before opening the return TOW, so the vehicle's one-open-ticket rule holds. The return destination is the rider's validated location.
- Completed TOW to a shop: in one transaction, resolve the TOW and create a linked pending WALK_IN for the same vehicle/journey. A CAR delivered by TOW is allowed in this internal shop intake; direct rider WALK_IN remains SOLO bike only. The child preserves repair capabilities and an unexpired approved destination estimate, with its own single binding final quote.

A shop must reserve a real bay before towing starts. IN_TRANSIT and DELIVERED reservations never auto-expire. Delivery creates the pending intake; shop acceptance consumes the reservation atomically without counting two bays. The shop cannot decline/cancel that committed intake and must request support if unavailable. Failing child creation rolls completion back. See [OPERATIONS_SAFEGUARDS.md](OPERATIONS_SAFEGUARDS.md) for deadlines, rematching, cash eligibility and assisted destination changes.

## Notifications and chat

Pending work is selected within 15 km using the provider GEO/database system's source coordinates and PostgreSQL availability checks; missing Redis entries cannot hide an eligible provider. The dispatch outbox uses authoritative PostgreSQL distance/capacity checks so Redis outages never roll back a rescue request. Sockets join only their server-derived `user:<userId>` room. Notifications use `dispatch-urgent`, `dispatch-created` and `dispatch-updated` and include notificationId plus a redacted ticket summary.

Outbox delivery processes online recipients rather than letting offline rows starve the queue, rechecks eligibility before sending and suppresses stale pending broadcasts after a ticket is assigned/ended. The minute maintenance job retries pending notifications and expires estimates. Delivery is best effort with possible duplicates around a crash; deduplicate by notificationId and use `/notifications` plus ticket reads after reconnect. It does not send external SMS/email/push messages in this phase.

Every accepted transition writes a SYSTEM chat message and broadcasts it after commit. Assignment changes call the existing versioned chat helper in the same transaction; old providers remain in archived rooms and cannot observe messages for a new assignment. See [CHAT_AND_STORAGE.md](CHAT_AND_STORAGE.md).

## Error and verification contract

Invalid input returns 400; missing/stale session 401; inactive account or unfunded approval 403; unrelated tickets/providers return 404; conflicting state/capacity/vehicle/revision/exclusion returns 409. Database faults that cannot be retried use the standard 500 envelope. Important codes include VEHICLE_BUSY (with dispatchTicketId), DISPATCH_INVALID_STATE_TRANSITION, DISPATCH_QUOTE_ALREADY_SUBMITTED, DISPATCH_IDEMPOTENCY_CONFLICT, DISPATCH_STALE_REVISION, DISPATCH_GPS_INVALID, DISPATCH_GPS_STALE, DISPATCH_LOCATION_OUT_OF_RANGE, DISPATCH_PROVIDER_EXCLUDED and PAYMENT_UNFUNDED_FOR_APPROVAL.

`RUN_DB_TESTS=1 npm test` creates isolated PostgreSQL schemas/Redis namespaces. Dispatch coverage includes all fifteen states, conflicting accepts/creation, shared rescue vehicles, immutable quote/payment authority, waiting rounding/cap/freeze, driver requeue/privacy, exclusion evasion, evidence/audit/child rollback, destination estimates, direct handoff, return towing, outbox/socket system events and code-collision retry. AWS uses the existing fake transport; payment fixtures verify the gate without claiming a real Phase 6 integration.

Current payment allocation, refund and payout contract: [BILLING_AND_PAYMENTS.md](BILLING_AND_PAYMENTS.md).

## Vehicle handover evidence

New and active TOWs require versioned PICKUP/DELIVERY condition reports with 2–8 owned images and explicit existing/observed damages. The rider confirms pickup; destination shop owner (or rider for coordinate destinations) confirms delivery. GPS remains an additional location check. Start and completion enforce current consent; rerouting invalidates old-destination consent. See [HANDOVER_AND_DISPUTES.md](HANDOVER_AND_DISPUTES.md) for the API and legacy-trip behavior.
