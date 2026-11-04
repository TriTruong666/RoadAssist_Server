# Cross-repository implementation audit

Objective: finish both seven-phase roadmaps as one application for admin, rider
and provider. Keep the map mounted while all operations open in menus/panels;
retain KPI as a preview. Setup follows Office MemberAccessPage. Only the SePay
gateway is simulated in application operation. Do not commit, push or deploy.

Status: implementation and local acceptance are complete for the requested scope.
The requirement-by-requirement mapping and superseded historical examples are in
[ROADMAP_ACCEPTANCE.md](ROADMAP_ACCEPTANCE.md). No commit, push or deployment was
performed; real SePay onboarding and the landing page remain explicitly deferred.

## Current implementation and concrete evidence

| Requirement | Implementation | Evidence / limits |
| --- | --- | --- |
| Foundation | Independent Express/PostgreSQL/Redis, REST cookie session, RoadAssist Axios base, DTO/APIs/hooks, WMS pages pruned; old shipping map/tracking source retained as reference | Live server 9898 health confirms DB/Redis. Whole client TypeScript and production build pass. |
| Authentication | `/login`, `/register`, `/verify-otp`, recovery, refresh/logout; `/` redirects to login | 11 auth browser tests pass, including timer suspension/recovery while hidden; real registration OTP/reset test verifies old cookie session is revoked. SMTP transport is a fixture in E2E. |
| Setup | Office-style sticky header/profile aside/Stepper/FloatingActionDock; rider vehicles and SHOP/MOBILE/TOW registration, evidence, optional bank account | Browser walkthroughs cover all four service choices, TOW pending duty lock, resume/prefill, approval/suspension in current session, denial/resubmission and evidence withdrawal/replacement with duty disabled until reapproval. Server derives grants independently of requested services. |
| Map workspace | Persistent OperationsMap + panels, clusters updated by ID, hazard circles, dispatch pulses, filters/search/flyTo, route geometry | Browser checks same map DOM instance after closing panel. Provider/hazard/dispatch data are real domain reads. A dedicated 1,000-provider PostgreSQL case verifies bounded 100-provider rendering, clustering, layer/kind filtering and complete-list pagination without remounting the map. |
| Basemap/search/routing | Authenticated MapTiler raster tile proxy, geocoding scoped VN/VI with proximity, official Valhalla Docker profile with real Vietnam OSM data | Actual upstream calls succeed. Rendered screenshot shows actual roads, not a placeholder. Real route example has 105 points / 3.152797 km. Map browser test saves/reloads real geometry and avoids a confirmed hazard. |
| Vehicles/providers | CRUD/ride config/active vehicle; provider fields/capabilities/hours/capacity; admin filters including suspension, owner/vehicle metadata/evidence/audit | Provider DB suite; browser SHOP hours/capacity and TOW review/approval/suspension. Public DTO/reviews omit private owner/vehicle/license identifiers. |
| Hazards/places | Report/upload/TTL/votes/unflag, admin lock/unlock/remove, saved places/routes and avoidance | Real browser three independent confirmations, admin lock and reporter cannot unflag; places/route real service browser test. DB suite includes races, TTL, permissions and scoped storage. |
| Dispatch | 15 states, WALK_IN/SOS/TOW, quote/funding, unfixable/handoffs, estimates/intake, support/rematch/retarget/return, immutable handovers | Browser full WALK_IN and TOW/CASH, plus SOS → unfixable → TOW → destination shop → final quote state 11 → mock payment/repair/resolve. A focused scenario verifies matched estimates, pre-departure retarget, supported in-transit alternative proposal/rejection/consent, unchanged fare, final handover and support resolution. Browser also verifies DIRECT offer/targeted assignment, provider cancellation requeue, retry-SOS owner exclusion, return towing from READY to a distant rider and deadline-driven rematch/chat rotation. |
| Payments/financial administration | Actual receipt inbox/escrow, CASH, refunds, commission/debt, payouts/bank snapshots/proofs; explicit mock gateway only | Full PostgreSQL suite includes replay races/rollback/holds/cash offsets/refunds. Browser partial refund + payout settlement, TOW CASH and split journey mock funding. Four payout KPI cards show exact decimal aggregates with scope notes. |
| Chat/ratings/disputes | Scoped versioned chat, real uploads, Socket.IO room subscription, cursor pages, rating upsert/reply, seven-day disputes and admin-only transcript | Browser asserts actual received WebSocket `chat:message` frame. Twice inserts 61 test-only PostgreSQL messages and verifies old messages remain pageable after new traffic. Rating fields restore after reload; dispute transcript shows only disputed room versions. |
| Announcements/settings | Rich editor/uploads, recipient snapshots, user/device delivery and read acknowledgments; bounded settings with revision/tariff snapshots | Browser broadcast/device/read counts, PostgreSQL audience/ownership/idempotency and settings revision/bounds tests. Browser verifies two admins editing the same revision: two consecutive stale saves return 409 without changing the stored value; explicit reload shows the winning value and allows a fresh save. |
| Admin operational inbox | Per-admin durable alerts for provider review, hazard consensus and new disputes, unread count, owned read acknowledgments and panel links | API rollback/deduplication/ownership tests; actual socket frame; offline/reload recovery; desktop/mobile screenshots and viewport/keyboard checks. |

## Authoritative verification at this checkpoint

- `RUN_DB_TESTS=1 npm test`: **206/206 pass**, zero skipped,
  `/tmp/roadassist-goal-server-all.log`.
- `RUN_MAP_SERVICE_TESTS=1 PLAYWRIGHT_CHANNEL=chrome npm run test:integration`:
  **12/12 pass**, about 3.5 minutes, `/tmp/roadassist-goal-browser-integration.log`.
  Actual PostgreSQL/Redis/domain APIs and cookies; fixture SMTP/S3 transports,
  explicitly mocked payment gateway, real MapTiler search/tiles and real Valhalla.
- `PLAYWRIGHT_CHANNEL=chrome npm run test:auth`: **11/11 pass**,
  `/tmp/roadassist-auth-check.log` (HTTP auth mocks; separate from real integration).
- `npm run typecheck`, `npm run lint` and `npm run build` pass for the whole
  client. Full ESLint has **0 errors / 0 warnings**, with its configuration
  unchanged. Rich-editor chunk size remains a build advisory.
- Both local Docker images build. The client image contains the configured public
  API URL and passes `nginx -t`; server native Sharp produces a valid PNG.
  Development/production/routing/client compose configurations validate, and both
  workflow YAML files parse. No containers were deployed to an external service.
- OpenAPI has **149 paths** and no dangling schema references. All **80 roadmap
  API contract rows** are present; anonymous/invalid-input probes reach guards,
  validation or domain-not-found responses. The real SePay webhook returns the
  intended `503 SEPAY_MOCK_MODE`. These negative probes are registration evidence,
  separate from successful business behavior in the DB/browser suites.
- A focused final browser regression passes after the mobile inbox correction:
  actual bold/link broadcast, read state, keyboard dismissal and dialog bounds at
  390 px. `/tmp/roadassist-alert-responsive-check.log` records **1/1 pass**.
- Visual artifact inspected:
  `RoadAssist_Client/test-results/roadassist-map-profile-light.png`.
  It shows full real MapTiler tiles, light profile panel and persisted uploaded
  avatar; browser waits for all map images to finish, not merely the first tile.
  `roadassist-admin-alerts-desktop.png` and `roadassist-admin-alerts-mobile.png`
  were also inspected: operational alerts stay above the panel and inside mobile
  viewport bounds.

## Important fixes found by using the actual application

- CARTO public URLs returned `API KEY REQUIRED` PNGs with HTTP 200. Replaced them
  with actual MapTiler tiles using the provided key in ignored server env only.
  Fixed upstream Origin is configured; neither tile URLs nor errors expose keys.
  Coordinate/style validation, request coalescing, at most 256 tiles / 16 MiB
  transient cache and private HTTP caching are implemented and tested.
- Valhalla native JSON returns encoded polyline even when shape_format=geojson.
  Adapter now explicitly requests OSRM + GeoJSON, validates complete geometry,
  and converts meters to km while preserving seconds.
- Setup completion survives denial/revocation of a submitted application. Owners
  can inspect/resubmit from the map; no provider grants are inferred from setup.
  A missing application for a newly requested kind still requires setup.
- Owner evidence now exposes current/withdrawn/stale status and a withdrawal action;
  withdrawing approved evidence returns the profile to review and stops duty.
- All visible OTP/hazard countdowns share one timer. It stops while hidden and
  refreshes against actual time immediately on visibility restoration.
- Setup restores saved identity/capabilities/towing data/bank account. Mobile
  profile updates omit fixed-shop GPS fields; denied profiles can resubmit.
- Internal computed provider-role sync does not revoke identity sessions. Current
  permissions still derive from approved profiles on every request. Explicit
  password/status/email/manual-role changes retain session revocation.
- Sensor timestamps are never forged. Browser asks for uncached GPS and skips
  samples already submitted. Heartbeat timers and sockets stop while hidden.
- Parent and handover mutations share a pending gate through async query refresh;
  TOW start/resolve waits for matching confirmed handover. This avoids using a
  stale revision immediately after signing. Handoff navigation uses returned child
  ticket IDs; linked trip navigation is limited to rider/admin.
- Provider selection matches the pending ticket kind and preserves ongoing jobs
  even when duty/permission is suspended. Map data includes all relevant owned
  profiles; archived idle profiles do not trigger unbounded polling.
- Chat now joins its actual authorized Socket.IO room, reconnects on visibility
  and room changes, and invalidates HTTP data rather than inserting untrusted raw
  socket DTOs. Infinite cursor queries refetch a coherent page chain after traffic,
  retaining correct `mine` flags and old-message access. Upload retry IDs stay
  bound to the original files and room.
- Intake controls distinguish the current destination from the proposed candidate and
  respect transport stage/expiry. Admin ticket detail includes both reservations
  and support cases; estimates can be approved after assignment without resetting
  the assigned transport status. TOW state 6 displays “Đang vận chuyển”.
- HTTP 409 mutation failures refresh domain queries before a deliberate retry.
  Mutations are never automatically replayed. Settings drafts retain the revision
  that was originally edited, even when background data is refreshed.
- Theme state uses a shared external store, so header, profile and editor switches agree.
  Lightbox traps focus/inerts background and restores focus/scroll with Escape.
- Local env had DB_FORCE_RESET=true and duplicate prior nodemon processes. Reset
  is now false; one server listens on 9898. Existing user seed changes were not
  overwritten. No commits/push/deploy were made.

## Isolated test and local service lifecycle

`scripts/e2e-server.js` requires ROADASSIST_E2E=1, creates a unique DB schema and
Redis namespaces, seeds test users, binds 9899 only on loopback and cleans its own
resources on shutdown. Fixture-only mail/assets/history routes are never imported
by normal startup; history dataset writes require an admin cookie and are limited
to the isolated schema. They seed real rows for pagination, not fake API responses. The admin-only
`/__test/dispatch-stall` handler ages an existing MATCHED assignment in that same
isolated schema, so the browser can exercise actual deadline/rematch logic without
a ten-minute wall-clock wait. Production startup never imports these handlers.

Integration Vite uses 5175/API 9899; auth mock Vite uses 5176/API 9898. Their output
folders are separate to avoid one runner deleting another runner's active traces.

Valhalla runs from `docker-compose.routing.yml` / the `routing` compose profile,
using the official scripted image pinned by digest, two threads and a 4 GB limit.
The real Vietnam extract was about 317 MB; built tiles persist in a named volume.
`/status` reports version 3.9.1-2085e78a5. Live normal backend `/health` reports
PostgreSQL and Redis connected. No external deployment was performed.

## Final acceptance and preserved boundaries

All requested roadmap phases have current implementation and local verification;
see [the acceptance matrix](ROADMAP_ACCEPTANCE.md). The final review additionally
closed the administration alert inbox, pending-provider entry path, complete-data
map warning, mobile dropdown bounds, full-repository lint and stale WMS Docker
configuration. The alert/inbox source, whole-client static checks and focused mobile
regression were checked after the last display correction.

Pure re-export barrels are `.ts`; rendering refs and conditional hooks in retained
components were repaired, editor subscriptions use external-store semantics, and
shared throttles cancel on lifecycle changes. No lint rule was weakened. Editor
portals render above map panels, and mobile admin alerts remain inside the viewport.

Preserved boundaries: SePay remains mock; no bank integration or deployment is
claimed. SMTP/S3 transports are fixtures in tests, while map/search/routing use
real services. Existing user changes to `src/seeds/seed_data/user_seed.json` were
preserved. Diff whitespace validation excludes only that pre-existing user change.
Normal local endpoints remain available on client 5173, API 9898 and Valhalla 8002.

Verification metadata: [latest-local-checks.json](verification/latest-local-checks.json).
The full core integration run is followed by a focused mobile regression; these
are recorded separately so the scope of each result is explicit.
