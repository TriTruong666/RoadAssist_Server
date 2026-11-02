# Unified versioned chat and direct S3 uploads

## Scope and authentication

This implements the **chat section of Phase 7**, sharing one engine with Phase 4 hazard chat. Ratings and disputes remain in their roadmap phase. Phase 5 provides production dispatch; Phase 6 provides payment allocation, refund records and manual payout settlement. Chat HTTP APIs and Socket.IO authenticate using the HttpOnly `road_as_token` cookie; browser clients include credentials. Tokens, sender IDs, roles, versions and system events cannot be assigned by a chat message body.

OpenAPI is maintained in `src/swagger/`: `index.js` composes Auth/User/Vehicle, Provider, Places/Hazards and Chat/Upload modules. Files in `src/config/*swagger*` are compatibility exports. `/api-docs` still serves the complete UI.

## HTTP chat contract

All routes start with `/api/v1/chat`:

- `GET /:scope/:referenceId`: `scope` is HAZARD or DISPATCH. Returns `{room, items, nextCursor}` with newest messages first. `limit` 1–100, default 50. `before` is the last returned message UUID and must belong to the same room. `version` selects a historical version; dispatch membership is checked against the selected version's participant snapshot.
- `POST /:scope/:referenceId/messages`: JSON `{content, clientMessageId?, roomId?, assetIds?}` or multipart `content` plus up to three `images` file fields. Text is trimmed and limited to 1000 characters. Empty text is allowed only with images. `roomId` expresses the room displayed by the client and rejects stale assignment views with 409. Use UUID `clientMessageId` to retry safely: the same sender/room/ID returns the original message with `duplicate:true` and does not rebroadcast or consume another quota slot.
- `GET /:scope/:referenceId/history`: archived room metadata, newest version first; `limit` 1–100 and `offset` 0–100000. Only original members can list dispatch archives. The rider sees their prior versions; a new provider sees none of the previous provider's rooms. Read messages using the `version` query above.

Messages contain `id`, `roomId`, `senderRole`, `authorName`, `content`, `images`, `systemEvent`, `clientMessageId`, `createdAt`. Public responses omit sender account IDs. Roles: RIDER, PROVIDER, COMMUNITY, SYSTEM. Render content as text rather than HTML.

Hazard chat is community-readable for authenticated accounts. Closed/expired hazards and ended/replaced dispatch rooms are read-only. The shared limit is 10 messages/minute/sender/room across HTTP, sockets and legacy hazard APIs. PostgreSQL locks the reference while checking state and writing messages, and unique constraints enforce room/version and idempotency.

Existing `GET/POST /flags/:id/messages` and `flag:*` socket events delegate to this engine and return legacy `text`/`flagId` fields. History is no longer split between independent message tables. Startup migrates old `hazard_messages` into `chat_messages`, preserving UUIDs, authors and timestamps; legacy rows remain as migration source. Reruns do not duplicate messages.

## Socket.IO

Use one connection, default `/socket.io`, allowed Origin, `withCredentials:true`. No bearer fallback. Sessions are checked on connect, before each event and every 15 seconds. Packet limit 16 KiB; image bytes use HTTP uploads, then asset IDs.

```js
const socket = io(API_ORIGIN, { withCredentials: true });
const reference = { scope: 'DISPATCH', referenceId: ticketId };
socket.emit('chat:join', reference, ack => {
  if (ack.success) currentRoomId = ack.data.room.id;
});
socket.on('chat:message', message => {
  if (message.roomId === currentRoomId) display(message);
});
socket.emit('chat:message', {
  ...reference,
  content: 'Tôi đang đến',
  clientMessageId: crypto.randomUUID(),
}, ack => console.log(ack));
socket.emit('chat:leave', reference);
```

`chat:join` optionally accepts a historical `version`, with the same membership check. Archived rooms can be joined for reading, but sending is blocked. Socket sends require current room membership; the transaction also checks the expected room to close the assignment-change race. Broadcasts address room UUIDs, so reassigned providers' old sockets never receive the new room's messages. Clients should rejoin after reconnect or reassignment and use the cursor HTTP endpoint to recover missed messages. Up to 40 subscribed internal rooms per socket (legacy hazard joins use two rooms).

Both HTTP and socket sends broadcast after database commit. Duplicate client message retries do not broadcast twice. Socket acknowledgements use `{success,data}` or `{success:false,message,error_code}`. This server currently broadcasts within one process; a shared Socket.IO adapter is needed before running multiple API replicas.

## Phase 5 dispatch integration

Phase 5 now registers the production `DispatchTicket` model. Its create/assign/requeue/handoff/completion transactions synchronize chat membership and archive old versions. The chat regression suites now use the production schema with fixture defaults; dispatch HTTP/state integration is covered separately.

Phase 5 must call `ChatService.synchronizeDispatch(ticket, transaction)` in the **same transaction** that creates, assigns, unassigns, reassigns or terminates a ticket, after updating its fields. Follow the established dispatch/provider locking order. This helper:

1. Locks the ticket and reads the latest room.
2. Archives the previous room and increases `chatVersion` when providerId changes, including unassignment.
3. Creates a room with immutable rider/provider membership snapshots. Clients cannot add members.
4. Archives the current room for terminal statuses 4, 5, 8, 12, 15.

Reads also reconcile the current ticket as a fallback. Starting the same version concurrently cannot create duplicate rooms. A provider is resolved from `Provider.userId`, never from a client-supplied user ID. Archived membership is independent of subsequent assignments or provider status changes.

Trusted services may call `ChatService.systemMessage(ticket, event, text, transaction)` for STATUS_CHANGED, UNFIXABLE, TOW_OFFER, PROVIDER_CHANGED. After the transaction commits, call `ChatService.broadcast(app, 'DISPATCH', ticket.id, messageDTO)` if realtime delivery is required. Public chat endpoints never accept these events.

## S3 contract

The S3 wrapper is adapted from Picare Core's `src/services/s3.service.js` and MIME helper, using AWS SDK v3 multipart `Upload`, timeout/abort, metadata persistence, signed URLs, delete/batch delete, HEAD/exists and slug/UUID keys. RoadAssist accesses S3 directly and has no Core API dependency or Core view links. Video merging and Core client/folder administration are outside this application's upload flows.

Environment names match Core:

```dotenv
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=ap-southeast-1
AWS_S3_BUCKET_NAME=picare-s3
AWS_S3_ENDPOINT=
S3_PUBLIC_BASE_URL=
S3_UPLOAD_TIMEOUT_MS=60000
```

Local credentials are configured only in ignored `.env.development`. `.env.example` contains placeholders. The server fixes **folder `roadassist`, visibility `public`**, and keys are always `roadassist/<timestamp>_<uuid>_<slug>.<extension>`, with no subfolders. Upload callers cannot choose a bucket, prefix, key or visibility. The wrapper rejects cross-prefix/path-traversal keys for download, HEAD, signing and deletion too.

No ACL is sent. Public readability comes from the bucket policy configured separately in S3 Console for `roadassist/*`. Direct URLs default to `https://picare-s3.s3.<region>.amazonaws.com/roadassist/...`; optional `S3_PUBLIC_BASE_URL` supports a public CDN. The anonymous URL may return 403 until that policy is enabled. All newly uploaded project images, including provider evidence and chat attachments, use this public storage policy. API authorization still protects metadata/history; possession of a public file URL permits direct viewing independently of room membership.

`POST /api/v1/uploads`: cookie required, multipart `images`, 1–3 JPEG/PNG/WebP files, max 5 MiB each. Images are decoded, metadata stripped, resized to fit 1600×1600 and encoded WebP ≤800 KiB. Returns `{items:[{id,key,url,mimeType,size,folder,visibility}]}`. Max 100 generic uploads/account/day. Chat can claim only its own unused asset IDs, at most three attachments total; claiming is transactional and one-time. Arbitrary remote image URLs are rejected. Alternatively send files inline with a chat message.

Hazard creation and provider document upload retain their existing endpoints and validation. New uploads store S3 metadata/URLs rather than database bytes. Provider document list/upload responses include `url`/`s3Key`; the authenticated `/content` endpoint redirects to the public S3 URL. Withdrawn review evidence remains available as historical evidence.

Uploads participate in application rollback through compensation: if an image, metadata, message or profile/audit write fails, newly uploaded objects are deleted and the PostgreSQL transaction rolls back. Failed object deletion is recorded in `storage_cleanup` and retried every five minutes. Existing PostgreSQL image bytes migrate in bounded batches (50/model/run) to S3 every five minutes when configured; each row is cleared only after its uploaded URL and asset record commit. Legacy content endpoints continue serving bytes during migration. An S3 outage returns 503 `STORAGE_UNAVAILABLE`; new uploads never silently fall back to database storage.

## Verification

`RUN_DB_TESTS=1 npm test` uses isolated PostgreSQL schemas/Redis namespaces and a deterministic AWS transport. Coverage includes archived membership, reassignment races, socket privacy, client retry idempotency, shared legacy quotas/history, image claims, S3 compensation/retry and idempotent legacy migrations. Test code never writes to the real bucket. A separate live connectivity check uploaded/read metadata/deleted a tiny object in `roadassist/`; AWS operations succeeded while anonymous HEAD returned 403 pending the console policy.

Phase 5 transition messages broadcast after commit; see [DISPATCH_BUSINESS_RULES.md](DISPATCH_BUSINESS_RULES.md) for the current integration and payment boundary.
