# Roadmap acceptance: server and client

Scope is the seven roadmap files in each repository, with the user's later
requirements: all three roles, Office-style setup, a permanent map with panels,
KPI as a preview, mock SePay, and local code only. Historical commit/deploy plans
are not execution requirements for this delivery. No commit, push or deployment
was performed. The landing page is explicitly deferred; `/` opens `/login`.

This document maps requirements to current source and focused verification. It
must be read with [the verification ledger](IMPLEMENTATION_AUDIT.md), which records
command results and test transport limits. A negative HTTP probe verifies route
registration/guards only, not successful business behavior.

## Server roadmap

| Phase and requirement | Current implementation | Verification |
| --- | --- | --- |
| 1: Standalone architecture; remove Hub/gRPC/WMS/Firebase; keep MVC, env, centralized exceptions | `index.js`, `src/config`, `src/common`, independent models/routes/services; no gRPC/Firebase or WMS server modules/dependencies | `test/core.test.js`, package/source inspection, actual `/health`, Docker build and native Sharp check |
| 1: PostgreSQL/Redis readiness, 9898, 10 MB JSON, CORS, Swagger, safe reset/start/shutdown | Dependency checks before listen; JSON error handler; localhost Swagger; reset defaults false; startup migrations and cron cleanup | Core HTTP tests, compose config checks, running PostgreSQL/Redis and healthy Valhalla |
| 2: User, sessions, bcrypt, verified email registration, OTP/resend/recovery, refresh/logout and session revocation | Auth/session/PendingRegistration models, auth schemas/controllers/services; HttpOnly cookies; DB-derived grants | `test/auth*.test.js`, `test/auth.integration.test.js`, real registration/reset E2E and 11 auth browser cases |
| 2: User profile/onboard/active vehicle; CRUD vehicle and ride dimensions; owner isolation and linked-provider revocation | User/vehicle services and schemas; busy-vehicle locking and immutable ticket snapshots | Auth/provider/dispatch DB tests; setup E2E; actual avatar upload/save/reload |
| 3: One live profile per kind, normalized plate, proximity confirmation, TOW CAR + manual review | Provider/capability/access/availability/audit/document services; live-owner partial index and migration | Provider policy and DB tests; all provider kinds in browser; deny/resubmit/withdraw/reapprove E2E |
| 3: Owner/admin operations, opening hours/capacity, duty/GPS, 15 km assignment/15 minute discovery freshness, Redis GEO | Transactional owner/vehicle/provider locks; trusted GPS history; Redis reconciliation and SQL fallback; public/private DTO separation | Provider/dispatch DB tests; current-session approval/suspension E2E; hidden-tab cleanup source inspection |
| 4: Saved places/routes, geocoding and routing, scoped storage, no fake map data | Place models/service/schema, MapTiler VN/VI/proximity adapter, authenticated tile proxy; real Vietnam Valhalla OSRM/GeoJSON adapter | Places DB tests and real-service browser test: search, avoidance, save/reload/replay, actual tile PNGs |
| 4: Hazard models/images/votes, three independent votes, no self vote/duplicate votes, reputation, TTL, lock/unlock/remove | `flag.service.js`, flag/chat/storage services, validated multipart schemas, TTL cron and read-time expiry | Places/flags tests for permissions/races/TTL; three-account consensus + admin lock E2E |
| 5: 15 dispatch states, busy vehicle, shared lock order, WALK_IN 200 m SOLO_BIKE, single quote and funding gate | Dispatch/policy/vehicle policy services and schema, unique active vehicle index, lifecycle events and snapshots | Dispatch/operations/billing DB suites; full WALK_IN quote/payment/ready/resolve browser flow |
| 5: SOS 15 km, callout waiver within 1 km, unfixable evidence and cost reset; DIRECT/NETWORK TOW, retry owner exclusion | Dispatch notification outbox, handoffs and parent/child journey linkage | Dispatch/operations DB tests; full NETWORK journey and DIRECT/retry/cancel-requeue E2E |
| 5: TOW destination/estimate expiry and approval, waiting grace/cap, driver requeue, return tow and shop child | Intake/liveness/handover services; server-calculated waiting fees; immutable two-end evidence; support-driven in-transit changes | Operations DB tests and full TOW CASH/online, matched-estimate, retarget, alternative consent, return/rematch browser cases |
| 6: Bill/items/payments, unique transfer intent, authenticated/replay-safe receipt inbox, escrow HELD to CONFIRMED | Bill/payment/SePay services, immutable allocations, exact decimal helpers and maintenance | Billing/operations DB tests, actual mock receipt funding in browser; live webhook intentionally returns `SEPAY_MOCK_MODE` in mock mode |
| 6: CASH confirmation/debt, grace/overdue rules, batch payouts/offsets, bank snapshots, settlement proofs/refunds | Finance models/services, scoped endpoints, admin aggregates and notifications; no arbitrary withdrawal | Billing/operations DB tests for races/rollback/holds/replays; CASH and partial refund/payout settlement E2E |
| 7: Versioned chat and archives, private room membership, text/photo limits, cursor history, upload rollback | Chat/storage models/services, cookie-authenticated Socket.IO joins and reauthorization | Chat/storage DB suite; received WebSocket frame, uploads, twice-61-message pagination/reconnect E2E |
| 7: Two-way 1–5 ratings, 280-character text, upsert/reply and provider/rider aggregates | Rating model/schema/service/routes, public DTO without private member identifiers | Platform DB tests and browser save/reload/public review |
| 7: Seven-day disputes, party ownership, holds, evidence/response, admin verdicts and scoped transcript | Dispute/finance services, audit events and admin-only transcript route | Operations/platform DB tests for window/holds/refunds/payout race; real dispute/response/transcript/refund E2E |
| 7: Complete OpenAPI and integration documentation | 149 OpenAPI paths, all 80 roadmap contract rows present, no dangling schema references | `verification/roadmap-openapi.json`, `verification/roadmap-http.json`, full DB suite and browser suites |

## Client roadmap

| Phase and requirement | Current implementation | Verification |
| --- | --- | --- |
| 1: Remove WMS business pages, retain shipping map/tracking/CSS references, preserve APIs/types/hooks/components, branding and direct API | Active App uses RoadAssist routes/workspace; retained reference modules compile; shared Axios aliases point to the independent server | Whole-repo TypeScript/lint/build; active import/router inspection; backend origin/CORS probes |
| 1: Build and environment alignment | `VITE_ROADASSIST_API_URL`, RoadAssist Docker image/compose/workflow and remote path, no old WMS deployment target; server workflow copies the routing compose file too | Both local Docker builds, bundled API URL check, Nginx syntax check, parsed workflow YAML and compose configuration |
| 2: Hub-style auth, refresh/expiry/logout, safe deep links, roles and setup | LoginHubFormSection/AeroShard/form components; cookie sessions; Office-style Stepper/FloatingActionDock setup for rider/SHOP/MOBILE/TOW | 11 auth cases plus real registration/recovery/setup E2E; pending service choices never grant duty |
| 2: Eight admin menus, header logo/live status/notifications/profile/theme | `OperationsWorkspacePage`, admin menu + map link, overview preview, persistent map, header controls and operational inbox | Nine navigation links checked, same map DOM retained, real Socket.IO alert frame; offline inbox/read persistence and theme/avatar tests |
| 3: Provider markers by kind/heartbeat, hazard categories/radii/status, dispatch pulse and route legs | `OperationsMap`, `ProviderClusters`, `dispatchRouteStops`; private busy-provider positions only for authorized views | Source/DTO inspection, backend location privacy tests, actual routes, rendered tile screenshot and focused map-load browser case |
| 3: Layer toggles, kind filter, search/flyTo and clustering without wholesale redraw | Marker map keyed by ID, Leaflet markercluster, bounded monitor with explicit truncation and links to full lists | 1,000 stored providers: map capped at 100, clustering, hide/show, kind filter and full-list pagination while retaining map instance |
| 4: Provider filters/name/plate search, metadata, TOW review/evidence, deny/approve/suspend | ProvidersPanel/ProviderSettingsForm and EvidenceGallery; `/dashboard/providers/pending` initializes pending filter | Provider DB tests; owner/vehicle detail, lightbox focus, approval/suspension/current-session and denial/evidence E2E |
| 5: Hazard list/filter, category/location/radius/images, consensus progress, TTL and moderation | HazardsPanel with countdown, shared image lightbox, admin lock/unlock/remove and owner-only unflag controls | API races/permissions/TTL tests; real three-voter consensus, lock and reporter restriction E2E |
| 6: Dispute identities/reasons/evidence/chat and admin verdict; financial KPI cards and payout batch details | DisputesPanel/FinancePanel, scoped transcript, exact server aggregates, bank snapshot/proof forms | Platform/billing/operations DB tests; browser partial verdict, refund proof, four KPI cards and actual payout settlement |
| 7: Broadcast rich editor, audience/priority, recipient/device/read history; platform settings | PlatformPanel, existing Tiptap primitives/hooks, bounded revisioned settings and tariff snapshots | Browser bold/link creation and safe rendered content; broadcast/device/read counts; two-admin repeated-409 recovery; DB audience and bounds tests |
| 7: Cleanup timers/listeners and full integration/polish | Query background polling disabled; sockets/GPS stop hidden; shared countdown clock stops/reconciles; accessible error states and lightbox focus | Auth hidden-tab expiry test, chat reconnect test, full lint/typecheck/build and complete integration suite |

## Explicit decisions replacing historical examples

- Public registration creates a guest; services are requested preferences until
  provider approval grants them. OTP verifies email, not login IP. Cookies replace
  the original Bearer/localStorage examples.
- Rider/provider access and setup replace the old admin-only client gate because
  the user's later request explicitly includes those roles.
- New map panels replace standalone WMS dashboard pages. KPI is a preview, and
  tracking links enter an authorized dispatch panel; shipping source remains as
  a reference. `/dashboard/providers/pending` remains a working filtered entry.
- Header operational alerts and broadcast announcements are separate flows. Both
  have durable records; read acknowledgements are scoped to each recipient.
- MapTiler replaces unauthenticated CARTO tiles, which returned placeholder PNGs.
  Credentials remain on the server. Routing uses real Vietnam data, not straight
  line mocks. Bounding monitor results is explicit in the UI, with full lists.
- Visible provider GPS uses fresh sensor samples up to once per 30 seconds to
  satisfy assignment freshness checks. Rider GPS is sent only on an explicit
  action. Repeated timestamps are skipped, never forged.
- SePay transport is intentionally mocked as requested. The ledger, escrow,
  payment gates, refunds, debt and payout calculations remain actual domain work.
- Test SMTP/S3 transports, timestamp aging, history rows and bulk map population
  are isolated test fixtures. They do not replace production domain APIs or live
  MapTiler/Valhalla. Tests create/drop only their own DB schemas/Redis namespaces.

## Review boundaries

Production deployment, real bank transfers/SePay sandbox onboarding and the
landing page are outside this delivery by the user's instruction. SMTP/S3 tests
verify application integration with fixture transports, not external account
credentials. Build still reports a rich-editor chunk-size advisory; compilation,
static checks and functional acceptance are separate gates recorded in the ledger.
