const json = (schema) => ({
  required: true,
  content: { "application/json": { schema } },
});
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const id = (name) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
});
const page = [
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  },
  {
    name: "offset",
    in: "query",
    schema: { type: "integer", minimum: 0, default: 0 },
  },
];
const op = (summary, extra = {}) => ({
  tags: ["Platform"],
  summary,
  security: [{ cookieAuth: [] }],
  responses: {
    200: { description: "Standard RoadAssist response envelope" },
    400: { description: "Invalid input" },
    401: { description: "Cookie session required" },
    403: { description: "Role or participant denied" },
  },
  ...extra,
});
const schemas = {
  AdminAlert: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      kind: {
        type: "string",
        enum: ["PROVIDER_REVIEW", "HAZARD_CONFIRMED", "DISPUTE_OPENED"],
      },
      referenceId: { type: "string", format: "uuid" },
      title: { type: "string" },
      message: { type: "string", maxLength: 160 },
      href: {
        type: "string",
        description: "Server-derived local map-panel link.",
      },
      readAt: { type: "string", format: "date-time", nullable: true },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  BrowserDeviceInput: {
    type: "object",
    required: ["clientDeviceId", "name"],
    properties: {
      clientDeviceId: {
        type: "string",
        format: "uuid",
        description:
          "UUID v4 generated per browser; scoped to the authenticated user",
      },
      name: { type: "string", minLength: 1, maxLength: 120 },
    },
  },
  PayoutAccountInput: {
    type: "object",
    required: ["bankCode", "accountNumber", "accountName"],
    properties: {
      bankCode: { type: "string", pattern: "^[A-Za-z0-9_-]{2,30}$" },
      accountNumber: {
        type: "string",
        pattern: "^\\d{6,34}$",
        description: "String preserves leading zeroes",
      },
      accountName: { type: "string", minLength: 2, maxLength: 120 },
    },
  },
  RatingInput: {
    type: "object",
    required: ["ticketId", "stars"],
    properties: {
      ticketId: { type: "string", format: "uuid" },
      stars: { type: "integer", minimum: 1, maximum: 5 },
      content: { type: "string", maxLength: 280 },
    },
  },
  RatingReply: {
    type: "object",
    required: ["content"],
    properties: { content: { type: "string", minLength: 1, maxLength: 280 } },
  },
  PlatformAnnouncement: {
    type: "object",
    required: ["title", "content", "target", "priority"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 160 },
      content: { type: "string", maxLength: 10000 },
      target: { type: "string", enum: ["ALL", "RIDER", "PROVIDER"] },
      priority: { type: "string", enum: ["NORMAL", "IMPORTANT", "CRITICAL"] },
    },
  },
  PlatformSettingsUpdate: {
    type: "object",
    required: ["revision", "values"],
    properties: {
      revision: { type: "integer", minimum: 0 },
      values: {
        type: "object",
        description:
          "Only operations, dispatch and sepay.commissionRate numeric settings are accepted. GET returns current values and bounds; stale revision returns 409.",
        properties: {
          operations: {
            type: "object",
            additionalProperties: { type: "integer" },
          },
          dispatch: {
            type: "object",
            additionalProperties: { type: "integer", minimum: 0 },
          },
          sepay: {
            type: "object",
            properties: {
              commissionRate: { type: "number", minimum: 0, maximum: 1 },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
  },
};
const paths = {
  "/api/v1/admin/alerts": {
    get: op(
      "Current admin durable operational inbox with total and unreadCount",
      {
        description:
          "Recipient snapshot for pending provider review, community-confirmed hazards and new disputes. Requires current admin access, excludes other admins' receipts, preserves history across reconnects. items use AdminAlert DTOs.",
        parameters: page,
      },
    ),
  },
  "/api/v1/admin/alerts/{id}/read": {
    post: op("Idempotently acknowledge an owned admin alert", {
      parameters: [id("id")],
    }),
  },
  "/api/v1/users/devices": {
    get: op("List only this account’s registered browsers"),
    post: op(
      "Register or refresh a browser device, idempotently per account and client UUID",
      {
        description:
          "At most 20 browsers per account. No role or owner fields are accepted.",
        requestBody: json(ref("BrowserDeviceInput")),
      },
    ),
  },
  "/api/v1/users/payout-account": {
    get: op(
      "Read current account’s payout bank details; returns account:null until configured",
    ),
    put: op(
      "Save current account’s payout destination and append a finance audit event",
      {
        description:
          "Existing payout batches retain their immutable bank snapshot. Only future batches use the new destination.",
        requestBody: json(ref("PayoutAccountInput")),
      },
    ),
  },
  "/api/v1/admin/disputes/{id}/chat": {
    get: op(
      "Admin dispute-scoped chat evidence, including archived assignment versions",
      {
        description:
          "Only rooms belonging to the disputed ticket are visible. Defaults to latest version. User identifiers are omitted from message DTOs.",
        parameters: [
          id("id"),
          ...page,
          {
            name: "version",
            in: "query",
            schema: { type: "integer", minimum: 1 },
          },
        ],
      },
    ),
  },
  "/api/v1/ratings": {
    post: op(
      "Upsert a review of a completed rescue; target is derived from ticket participants",
      { requestBody: json(ref("RatingInput")) },
    ),
  },
  "/api/v1/ratings/{id}/reply": {
    post: op("Target of a review writes its one public reply", {
      parameters: [id("id")],
      requestBody: json(ref("RatingReply")),
    }),
  },
  "/api/v1/ratings/provider/{providerId}": {
    get: op("Public provider ratings without private user identifiers", {
      security: [],
      parameters: [id("providerId"), ...page],
    }),
  },
  "/api/v1/ratings/ticket/{ticketId}": {
    get: op("Reviews visible only to rescue parties or admin", {
      parameters: [id("ticketId")],
    }),
  },
  "/api/v1/admin/providers": {
    get: op("Admin provider list with owner information", {
      parameters: [
        ...page,
        ...["kind", "status", "q"].map((name) => ({
          name,
          in: "query",
          schema: { type: "string" },
        })),
      ],
    }),
  },
  "/api/v1/admin/flags": {
    get: op("Admin hazard list, including removed reports", {
      parameters: [
        ...page,
        ...["category", "status"].map((name) => ({
          name,
          in: "query",
          schema: { type: "string" },
        })),
      ],
    }),
  },
  "/api/v1/admin/dispatch": {
    get: op("Admin current dispatch list with private provider positions", {
      parameters: [
        ...page,
        ...["status", "q"].map((name) => ({
          name,
          in: "query",
          schema: { type: "string" },
        })),
      ],
    }),
  },
  "/api/v1/admin/dispatch/tickets/{id}": {
    get: op(
      "Admin ticket, events, provider, current and candidate intake reservations, support cases and immutable handover evidence",
      {
        parameters: [id("id")],
      },
    ),
  },
  "/api/v1/admin/monitor": {
    get: op(
      "Admin live map snapshot with busy provider locations and truncation indicators",
      {
        parameters: [
          {
            name: "latitude",
            in: "query",
            required: true,
            schema: { type: "number", minimum: -85, maximum: 85 },
          },
          {
            name: "longitude",
            in: "query",
            required: true,
            schema: { type: "number", minimum: -180, maximum: 180 },
          },
          {
            name: "radiusKm",
            in: "query",
            schema: { type: "number", minimum: 1, maximum: 50, default: 15 },
          },
        ],
      },
    ),
  },
  "/api/v1/admin/stats": {
    get: op("Admin operational counts and ledger financial aggregates", {
      description:
        "Financial GMV sums effective HELD/CONFIRMED allocations after refund adjustments; commission includes CONFIRMED only. Pending payout combines unbatched confirmed online earnings (before unbatched debt/recovery offsets) and pending batch net. Settled is historical settled batch net; each batch remains the authority for exact transfers. All aggregates are decimal strings.",
    }),
  },
  "/api/v1/admin/settings": {
    get: op(
      "Admin persisted operational settings, bounds, revision and gateway mode",
    ),
    put: op(
      "Validate, persist and apply settings with optimistic concurrency",
      { requestBody: json(ref("PlatformSettingsUpdate")) },
    ),
  },
  "/api/v1/admin/announcements": {
    get: op(
      "Admin broadcast history with actual recipient/delivery/read counts",
      { parameters: page },
    ),
    post: op(
      "Publish to a snapshot of the selected audience; socket hint plus durable feed",
      {
        requestBody: json(ref("PlatformAnnouncement")),
        responses: {
          201: { description: "Announcement created" },
          403: { description: "Admin required" },
        },
      },
    ),
  },
  "/api/v1/notifications": {
    get: op(
      "Current user durable announcement feed; acknowledges HTTP delivery",
      {
        parameters: [
          ...page,
          {
            name: "deviceId",
            in: "query",
            schema: { type: "string", format: "uuid" },
            description:
              "Owned browser client UUID; records one delivery per announcement per browser",
          },
        ],
      },
    ),
  },
  "/api/v1/notifications/{id}/read": {
    post: op("Idempotent read acknowledgement for an assigned recipient only", {
      parameters: [id("id")],
    }),
  },
  "/api/v1/payments/{id}/mock-transfer": {
    post: op(
      "Simulate one full SePay receipt through the actual inbox/escrow ledger",
      {
        description:
          "Only the intent owner, only mock-created intents, only PAYMENT_GATEWAY_MODE=mock outside production. No real transfer or external QR. Replay/concurrent clicks share one bank reference. Live mode rejects this endpoint.",
        parameters: [id("id")],
      },
    ),
  },
  "/api/v1/admin/payouts/batches/{id}": {
    get: op("Read payout batch including per-owner entries and offsets", {
      parameters: [id("id")],
    }),
  },
};
module.exports = { schemas, paths };
