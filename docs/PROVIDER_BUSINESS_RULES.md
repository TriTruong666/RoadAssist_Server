# Provider business contract

All authenticated endpoints use the HttpOnly `road_as_token` cookie. Browsers send credentials; JWTs do not appear in JSON. The new rules apply alongside the original Phase 3 registration/ownership validation.

## Duty, availability and capacity

`accepting` is the stored duty switch; `onDuty` exposes that consent. It does not mean the provider is free. Availability responses contain state, reason, maxConcurrentJobs, activeJobs and freeSlots. State is AVAILABLE, BUSY, OFF_DUTY or UNAVAILABLE.

SHOP declares 1–20 concurrent bays. MOBILE_SHOP and TOW always have one slot, shared by every profile linked to the same vehicle. Nonterminal tickets count against capacity; statuses 4, 5, 8, 12 and 15 release it. A busy rescue unit cannot take another job through its other service profile. Reducing SHOP capacity below current jobs returns 409; increasing capacity does not require identity reapproval.

`GET /api/v1/providers/:id/availability` reports effective availability under the same visibility rules as profile details. Public discovery includes business directories for closed/busy shops, but `availableOnly=true` requires free capacity. `acceptingOnly=true` checks duty consent. Mobile search always excludes busy/unusable units. Public mobile details hide coordinates when not effectively available.

The PostgreSQL DispatchTicket production model remains in Phase 5. Internal `ProviderAvailabilityService.lockForAssignment` requires a caller-owned transaction and must be followed by the ticket assignment before committing. It is not a public job/reservation API. Tests use a real ticket fixture table to verify simultaneous assignments, capacity release and conflicts across two profiles sharing one vehicle.

## Capabilities and matching

Repair capabilities: TYRE_REPAIR, BATTERY_JUMPSTART, ELECTRICAL_REPAIR, ENGINE_REPAIR, FUEL_DELIVERY and LOCKOUT. TOW declares TOWING only; repair profiles cannot grant themselves towing rights.

Declare `supportedVehicleTypes` as BIKE/CAR. This field is authoritative for matching; legacy `serviceSegments` remains a directory/UI category. SHOP and MOBILE_SHOP retain first-registration auto-approval, labeled AUTO_APPROVED. Manual approval is a separate review state; auto-approval is not represented as human verification.

Example TOW declaration, in addition to kind/name/phone/address/coordinates/vehicleProfileId/licenseNumber:

```json
{
  "capabilities": ["TOWING"],
  "supportedVehicleTypes": ["CAR"],
  "towMaxWeightKg": 3500,
  "towMaxWidth": 2.5,
  "towMaxHeight": 3,
  "towMaxLength": 6,
  "towMethods": ["FLATBED"],
  "maxConcurrentJobs": 1
}
```

Tow methods: FLATBED/WHEEL_LIFT. Limits are kilograms/meters and must be positive, finite and inside validation bounds. Missing declarations can be saved as a draft profile, but cannot enable duty or pass manual approval.

Search supports requiredCapabilities (all must match), vehicleType, vehicleWeightKg, vehicleWidth, vehicleHeight, vehicleLength, towMethod and availableOnly. Actual assignment rechecks requirements derived from server-owned request/vehicle data; search results are not authorization.

## Evidence and manual review

Owner upload uses multipart `POST /providers/:id/documents`, fields `documentType` and `file`. Types:

| Profile | Required current evidence for manual approval |
|---|---|
| SHOP | BUSINESS_DOCUMENT |
| MOBILE_SHOP | LICENSE_PHOTO and VEHICLE_PHOTO |
| TOW | LICENSE_PHOTO and VEHICLE_PHOTO, plus licenseNumber |

Files must have matching JPEG/PNG/WebP MIME and signatures, maximum 5MB. Data is private PostgreSQL bytea. Metadata JSON never includes the bytes. Limits: 10 active/50 total/100MB per profile, 200 total/200MB per owner; withdrawn history counts toward storage limits. Retrying an identical current image returns the existing document without creating another revision/audit entry.

Each document has a SHA-256 content hash and identity fingerprint. License images bind to licenseNumber; vehicle images bind to linked vehicle, plate, type, dimensions, brand/model; business documents bind to name/address. Old identity evidence cannot approve a changed identity. `currentForProfile` tells the owner which files need replacing. Identical bytes previously tied to another identity on that profile are rejected as stale; actual authenticity is assessed by the reviewing admin.

Endpoints:

- GET `/providers/:id/documents`: private metadata/history for owner/admin.
- GET `/providers/:id/documents/:documentId/content`: private image download, no-store/nosniff; withdrawn evidence remains readable for review traceability.
- DELETE `/providers/:id/documents/:documentId`: owner withdrawal from future approvals; bytes/history are retained privately.
- GET `/providers/:id/audit?page=1&limit=50`: private append-only review/change history.

Adding/withdrawing evidence on an active profile moves it to PENDING and disables duty. Busy units cannot change evidence or identity. Admin approval requires a nonempty reason, current matching evidence, a valid vehicle/license and complete capabilities. It stores reviewedRevision and an immutable snapshot of identity, vehicle, capabilities and document IDs/hashes. Subsequent identity changes increment profileRevision and require review again. Capacity-only changes do not invalidate identity approval.

Audit events include actor, action, reason and before/after snapshots, including vehicle dimensions before/after vehicle changes. Review history does not contain image bytes or every GPS heartbeat. Audit/profile/evidence writes share one PostgreSQL transaction; an audit failure rolls the mutation back. API/model operations cannot edit or delete audit entries.

## Lifecycle and migration

ACTIVE: operationally approved, still subject to duty/capability/GPS/capacity checks. PENDING: awaiting review. DENIED: admin rejected an application. REVOKED: owner/admin withdrew the license, including vehicle removal.

Only ACTIVE/PENDING profiles occupy the unique owner/kind slot. DENIED applications can be resubmitted for manual review. REVOKED history is not edited/resubmitted; register a new application. Administrative suspension restrictions remain effective across revocation/reapplication.

Before schema sync, migration adds REVOKED and installs the new partial unique index before dropping the old one. After sync it converts only legacy DENIED rows with revokedAt to REVOKED. Genuine rejected applications retain DENIED. Old manual approvals without a matching reviewed revision return to PENDING to collect the required evidence. No reset of users/passwords or background deletion of audit/evidence is performed.

## GPS quality and ongoing rescues

Clients send Geolocation accuracy in meters. A GOOD fix must be within PROVIDER_GPS_MAX_ACCURACY_METERS (default 100m). Missing accuracy is UNKNOWN; worse accuracy is POOR_ACCURACY. A jump inconsistent with the previous trusted fix, elapsed capture time and accuracy allowance is IMPLAUSIBLE_JUMP. These are telemetry-quality states, not findings of fraud; they do not ban the account.

Every valid chronological sample is retained privately with its quality and whether the provider could accept work at that moment. Only GOOD samples update trusted coordinates/time. Poor/jumping fixes preserve the trusted point but immediately remove public discovery; returning to a credible fix restores eligibility. Freshness uses server receive time for the trusted fix, not a client-provided future timestamp.

Turning duty off or administrative suspension stops new work. An already assigned, nonterminal rescue may continue private GPS while the provider is off-duty/suspended; those points never publish GEO or restore operational permission. Once that job ends, off-duty/suspended heartbeat submission is rejected. Phase 5 must authorize ongoing-trip location access through the ticket, independently of public discovery.
