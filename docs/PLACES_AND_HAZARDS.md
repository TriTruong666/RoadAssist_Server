# Phase 4: Places, routes and community hazards

All URLs below start with `/api/v1`. Writes and saved data require the HttpOnly `road_as_token` cookie. Browser fetches use `credentials: 'include'`. No Authorization header or token in JSON is supported. Swagger at `/api-docs` describes request schemas and permissions.

## Community reports

- `POST /flags`: JSON or multipart; `latitude`, `longitude` (also accepts `lat`, `lng`), optional `category` FLOOD/ACCIDENT/OBSTRUCTION, `description` (500 chars), `address` (255), `radiusMeters` 25/50/100/200/250 (default 50), `ttlMinutes` 60/120/240/720/1440 (default 120). Conflicting coordinate aliases are rejected. Up to 20 simultaneously active reports/account; account lock serializes concurrent creation.
- For images send repeated `images` file fields, at most 3 JPEG/PNG/WebP files, 5 MB each. The server decodes image bytes, checks dimensions (25 megapixel budget), rejects animated/invalid images, rotates, resizes to fit 1600×1600, strips metadata and encodes WebP at quality 75, max 800 KiB/output. Files are uploaded directly to public S3 `picare-s3/roadassist/` with metadata in PostgreSQL, with no caller-supplied remote image URLs. Invalid evidence leaves no report behind.
- `GET /flags/nearby?latitude=10.77&longitude=106.69`: public, active report centers within 2000 m, sorted by exact spherical distance **before** applying limit. Returns array including `distanceMeters`.
- `GET /flags/my`: owner history, including removed/expired reports, `{ total, items }`.
- `GET /flags/:id`: public detail with vote counters, effective status and image metadata/relative URLs. Images use `GET /flags/:id/images/:imageId`, which redirects to S3 for migrated/new files; legacy bytes retain `nosniff`.
- `POST /flags/:id/vote` with `{ "voteType": "CONFIRM" }` or DENY: author cannot vote; each other account gets one immutable vote. A database unique constraint backs this up. Voting is only open for unexpired SUGGESTED reports. Transactions lock the author then report, so concurrent votes and reputation updates remain consistent.
- `POST /flags/:id/unflag`: only author, cannot remove LOCKED reports. Idempotent once removed. No reputation reversal for author resolution or natural expiry.

Statuses: `1` SUGGESTED → `2` CONFIRMED at 3 CONFIRM votes. The author receives **1 reputation point once**, recorded by `reputationAwardedAt` within the same transaction. At least 3 DENY votes and more denies than confirmations remove a SUGGESTED report (`4`). Confirmation closes voting permanently. A report's author is never counted as an implicit vote.

Admin only: `PUT /admin/flags/:id/lock` changes CONFIRMED to LOCKED (`3`); `PUT /admin/flags/:id/unlock` changes LOCKED back to CONFIRMED. Unlock does not reopen voting or award points. `DELETE /admin/flags/:id` removes any report while preserving its history and images. Hard deletion is reserved for database/account lifecycle operations.

The cron runs every 5 minutes and on startup, marking all expired reports REMOVED, including LOCKED reports. Read APIs derive expiry immediately and all votes/locks/messages enforce expiry under lock; no active-map or routing grace period is introduced by cron timing. Removal reasons distinguish EXPIRED, AUTHOR, ADMIN and CONSENSUS_DENIED. Public report responses exclude author account IDs and internal reward metadata.

## Scene chat

`GET /flags/:id/messages` returns newest messages first, readable by authenticated users even after closure. `POST /flags/:id/messages` accepts `{ "text": "Đường đang ngập" }`, trims 1–1000 chars, persists then broadcasts. Closed/expired rooms reject new messages. Each account may send at most 10 messages per minute per room; both HTTP and socket sends share the same database lock and quota. Replies include `authorName` for display and omit sender account IDs. Render text as text, never as HTML.

Socket.IO uses the same HTTP server at default `/socket.io`, requires an allowed Origin plus the access cookie, and accepts no header/body token fallback. Example:

```js
const socket = io(API_ORIGIN, { withCredentials: true });
socket.emit('flag:join', { flagId }, ack => console.log(ack));
socket.on('flag:message', message => renderText(message.text));
socket.emit('flag:message', { flagId, text: 'Xe máy đi chậm' }, ack => console.log(ack));
socket.emit('flag:leave', { flagId });
```

Socket acknowledgements are `{ success, data }` or `{ success: false, message, error_code }`. Archived rooms can be joined for reading; sending requires active room membership. Limit: 40 internal rooms/connection, 16 KiB socket packet. Sessions are revalidated before each event and every 15 seconds, disconnecting expired/revoked sessions. A reconnect must join rooms again; use the messages endpoint to recover history. This phase broadcasts within one server process; multiple replicas require a Socket.IO shared adapter before horizontal scaling.

## Saved places and routes

- `GET /places/saved`, `POST /places/saved`, `DELETE /places/saved/:id`.
- Place body: `{ "name": "Nhà", "latitude": 10.77, "longitude": 106.69, "address": "...", "category": "HOME" }`. Category HOME/WORK/OTHER (default OTHER); name 1–120 chars. Multiple HOME/WORK labels are allowed.
- `GET /places/routes`, `POST /places/routes`, `DELETE /places/routes/:id`.
- Route body: name 1–120 chars, 2–25 `stops` using `{latitude, longitude}`, `geometry` as GeoJSON **LineString** with 2–20000 `[longitude, latitude]` pairs. Optional costing auto/motorcycle/motor_scooter/bicycle/pedestrian (default auto). Coordinates must be finite and in range.
- Each collection has a 100-item/account limit. Lists return `{ total, items }`. Another account cannot read or delete saved records; foreign IDs return 404. Stored geometry is loaded directly without another routing request.
- Saved geometry is a historical snapshot. Before navigating, call `/places/route` again to account for the latest hazards. Saving an externally computed geometry does not certify it as hazard-free.

All paginated endpoints accept `limit` 1–100 (default 50; nearby default 100) and `offset` 0–100000; nearby takes only limit. Stable ordering includes a UUID tie breaker.

## Search and avoiding hazards

`GET /places/search?q=...` requires `MAPTILER_API_KEY`. Returns `{ items: [{ id, name, address, center: [longitude, latitude] }] }` from the fixed MapTiler endpoint. No API key is returned to clients. Requests time out after 8 seconds and failures return HTTP 503 `MAP_SERVICE_UNAVAILABLE`.

`POST /places/route` accepts 2–25 `stops` and optional `costing`. It calls configured `VALHALLA_ROUTER_URL` with `shape_format: geojson` and 16-sided spherical polygons covering current unexpired CONFIRMED/LOCKED reports. Suggested, removed and expired reports do not alter routing. Returns `{ geometry, summary, avoidedFlagIds, calculatedAt }`. Each request reads the latest database state; confirmation itself does not eagerly recalculate previously saved routes. With more than 100 active confirmed/locked reports, routing returns 409 rather than silently omitting known areas. Upstream timeouts (10 seconds), no-route responses and malformed responses return 503; no unprotected route fallback is returned.

Provider references: [Valhalla routing API](https://github.com/valhalla/valhalla/blob/master/docs/docs/api/route/api-reference.md), [MapTiler geocoding API](https://docs.maptiler.com/cloud/api/reference/).

## Validation

`RUN_DB_TESTS=1 npm test` runs isolated PostgreSQL schemas and Redis namespaces. Phase 4 covers ownership, concurrent duplicate voting, consensus and reward atomicity, admin rights, expiry, exact nearby search, actual image decoding/compression, cookie-authenticated sockets, chat throttling and map provider requests/failures. Map provider network responses are stubbed; live MapTiler/Valhalla availability depends on deployment configuration.

Chat now uses the shared versioned engine from Phase 7. Full contract, S3 configuration and migrations: [CHAT_AND_STORAGE.md](CHAT_AND_STORAGE.md).
