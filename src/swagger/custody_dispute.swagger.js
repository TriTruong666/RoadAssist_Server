const uuid = { type: "string", format: "uuid" };
const date = { type: "string", format: "date-time" };
const text = (maxLength) => ({ type: "string", maxLength });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
});
const images = { type: "array", maxItems: 8, items: uuid };
const money = { type: "string", pattern: "^(0|[1-9][0-9]{0,9})(\\.00)?$" };
const schemas = {
  Handover: object({
    id: uuid,
    ticketId: uuid,
    phase: { type: "string", enum: ["PICKUP", "DELIVERY"] },
    version: { type: "integer" },
    providerId: uuid,
    authorId: uuid,
    recipientId: uuid,
    destinationShopId: uuid,
    status: {
      type: "string",
      enum: ["PENDING", "CONFIRMED", "REJECTED", "SUPERSEDED"],
    },
    condition: text(2000),
    damages: {
      type: "array",
      maxItems: 30,
      items: object({ part: text(100), description: text(500) }, [
        "part",
        "description",
      ]),
    },
    images: { type: "array", items: { type: "string", format: "uri" } },
    responseNote: text(1000),
    responseImages: { type: "array", items: { type: "string", format: "uri" } },
    confirmedAt: date,
    locationSnapshot: object({
      latitude: { type: "number" },
      longitude: { type: "number" },
      accuracy: { type: "number" },
      trustedAt: date,
    }),
  }),
  HandoverCreate: object(
    {
      phase: { type: "string", enum: ["PICKUP", "DELIVERY"] },
      condition: { ...text(2000), minLength: 3 },
      damages: {
        type: "array",
        maxItems: 30,
        description:
          "Explicit empty array means no existing/observed damage; delivery records condition after transport.",
        items: object(
          {
            part: { ...text(100), minLength: 1 },
            description: { ...text(500), minLength: 3 },
          },
          ["part", "description"],
        ),
      },
      assetIds: { ...images, minItems: 2 },
      expectedRevision: { type: "integer", minimum: 1 },
    },
    ["phase", "condition", "damages", "assetIds"],
  ),
  HandoverResponse: object(
    {
      handoverId: uuid,
      note: text(1000),
      assetIds: images,
      expectedRevision: { type: "integer", minimum: 1 },
    },
    ["handoverId"],
  ),
  Dispute: object({
    id: uuid,
    ticketId: uuid,
    claimantId: uuid,
    respondentId: uuid,
    providerUserId: uuid,
    reason: text(50),
    note: text(2000),
    status: {
      type: "string",
      enum: ["OPEN", "REVIEW", "RESOLVED", "REJECTED"],
    },
    responseDueAt: date,
    respondedAt: date,
    adminResolution: {
      type: "string",
      enum: ["FAVOR_RIDER", "FAVOR_PROVIDER", "PARTIAL_REFUND", "NO_ACTION"],
    },
    adminNote: text(2000),
    awardAmount: money,
    debtCreditAmount: money,
    refundAmount: money,
    resolvedAt: date,
    resolvedBy: uuid,
    events: { type: "array", items: ref("DisputeEvent") },
    handovers: { type: "array", items: ref("Handover") },
    refund: { type: "object", nullable: true },
    recovery: {
      type: "object",
      nullable: true,
      description:
        "Immutable obligation, outstanding balance and historical reserved/settled/cancelled payout offsets",
    },
  }),
  DisputeEvent: object({
    id: uuid,
    disputeId: uuid,
    actorId: uuid,
    action: text(60),
    note: text(2000),
    images: { type: "array", items: { type: "string", format: "uri" } },
    details: { type: "object" },
    createdAt: date,
  }),
  DisputeOpen: object(
    {
      ticketId: uuid,
      reason: {
        type: "string",
        enum: [
          "LATE",
          "NO_SHOW",
          "OVERCHARGE",
          "UNSAFE",
          "RUDE",
          "POOR_QUALITY",
          "VEHICLE_DAMAGE",
          "OTHER",
        ],
      },
      note: { ...text(2000), minLength: 3 },
      assetIds: images,
    },
    ["ticketId", "reason", "note"],
  ),
  DisputeEvidence: object(
    { note: { ...text(2000), minLength: 3 }, assetIds: images },
    ["note"],
  ),
  DisputeResolution: object(
    {
      resolution: {
        type: "string",
        enum: ["FAVOR_RIDER", "FAVOR_PROVIDER", "PARTIAL_REFUND", "NO_ACTION"],
      },
      amount: money,
      note: { ...text(2000), minLength: 3 },
    },
    ["resolution", "note"],
  ),
};
const paths = {};
function op(
  path,
  method,
  summary,
  { input, output, created = false, list = false, description } = {},
) {
  const value = {
    tags: [
      path.startsWith("/admin")
        ? "Dispute Admin"
        : path.includes("/handovers")
          ? "Vehicle Handover"
          : "Disputes",
    ],
    summary,
    description,
    security: [{ cookieAuth: [] }],
    parameters: path.includes("{id}")
      ? [{ name: "id", in: "path", required: true, schema: uuid }]
      : [],
    responses: {
      [created ? 201 : 200]: {
        description: "Standard success envelope",
        ...(output && {
          content: {
            "application/json": {
              schema: object({
                success: { type: "boolean" },
                data: ref(output),
              }),
            },
          },
        }),
      },
      400: {
        description:
          "Invalid fields, photos must be owned/unclaimed images, integer VND required",
      },
      401: { description: "Session cookie required" },
      403: { description: "Admin role required" },
      404: { description: "Not found or no participant access" },
      409: {
        description:
          "Wrong state, missing/stale consent, deadline, duplicate case, pending response, conflicting ruling or invalid amount",
      },
    },
  };
  if (input)
    value.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: typeof input === "string" ? ref(input) : input,
        },
      },
    };
  if (list)
    value.parameters.push(
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 100 },
      },
      {
        name: "offset",
        in: "query",
        schema: { type: "integer", minimum: 0, maximum: 100000 },
      },
      {
        name: "status",
        in: "query",
        schema: {
          type: "string",
          enum: ["OPEN", "REVIEW", "RESOLVED", "REJECTED"],
        },
      },
    );
  (paths["/api/v1" + path] ??= {})[method] = value;
}
op(
  "/dispatch/{id}/handovers",
  "get",
  "Read vehicle condition reports and both-party responses",
  {
    description:
      "Rider, current driver and current destination shop; former report parties may read only their own reports. Includes pickup and delivery versions.",
  },
);
op(
  "/dispatch/{id}/handovers",
  "post",
  "Driver proposes photo evidence and vehicle condition report",
  {
    input: "HandoverCreate",
    output: "Handover",
    created: true,
    description:
      "PICKUP while ARRIVED; DELIVERY while IN_PROGRESS. Requires 2–8 owned unclaimed S3 images, explicit damages array and trusted GPS at the respective location. No client coordinates can substitute for provider GPS. Rejection or destination/provider change requires a new version; confirmed content cannot be edited.",
  },
);
op(
  "/dispatch/{id}/handovers/confirm",
  "post",
  "Independent delivering/receiving party confirms exact report",
  {
    input: "HandoverResponse",
    output: "Handover",
    description:
      "PICKUP: rider confirms. DELIVERY: destination shop owner confirms, or rider for coordinate destination. Author cannot self-confirm. Start/resolve require valid current confirmation; GPS alone does not prove handover. This consent is separate from rider financial completion.",
  },
);
op(
  "/dispatch/{id}/handovers/reject",
  "post",
  "Recipient rejects condition report with reason",
  {
    input: object(
      {
        ...schemas.HandoverResponse.properties,
        note: { ...text(1000), minLength: 3 },
      },
      ["handoverId", "note"],
    ),
    output: "Handover",
    description:
      "Preserves original evidence and blocks departure/completion until corrected report is confirmed. Request operational support if unresolved.",
  },
);
op(
  "/disputes",
  "post",
  "Participant files one dispute within seven days and freezes payout",
  {
    input: "DisputeOpen",
    output: "Dispute",
    created: true,
    description:
      "Completed/acknowledged-unfixable ticket (4/12). Rider or historical assigned provider owner. One case per ticket; exact retry returns existing case. Both parties use the same case for evidence. Optional owned S3 images. Filing sets disputeHold in the financial transaction.",
  },
);
op(
  "/disputes/my-disputes",
  "get",
  "List disputes where the account is claimant or respondent",
  { list: true },
);
op(
  "/disputes/{id}",
  "get",
  "Read own dispute, immutable evidence history and financial outcome",
  { output: "Dispute" },
);
op(
  "/disputes/{id}/evidence",
  "post",
  "Participant submits explanation and owned evidence within response deadline",
  {
    input: "DisputeEvidence",
    output: "Dispute",
    description:
      "Default response window 48 hours. At most 20 additions per party, 8 images per addition. First respondent submission records respondedAt. Deadline expiry moves to REVIEW, keeps payout hold and never awards money automatically.",
  },
);
op("/admin/disputes", "get", "Admin lists disputes and review backlog", {
  list: true,
});
op(
  "/admin/disputes/{id}",
  "get",
  "Admin reads evidence, handovers and refund/recovery history",
  { output: "Dispute" },
);
op(
  "/admin/disputes/{id}/resolve",
  "put",
  "Independent admin adjudicates with an audited financial outcome",
  {
    input: "DisputeResolution",
    output: "Dispute",
    description:
      "Requires respondent response or elapsed deadline. FAVOR_RIDER awards all remaining ticket value; PARTIAL_REFUND requires positive amount below that value; FAVOR_PROVIDER/NO_ACTION grant zero. Unpaid amount is credited first; actually paid award creates pending manual refund and provider recovery deducted from future net earnings. Paid awards are separate compensation, preserving original collected-service commission and settled batch history. Pending provider batches are cancelled atomically for rebuilding. No bank transfer is executed. Complete refund through existing admin finance endpoint with unique transfer proof. Exact ruling retry is idempotent; conflicting ruling rejected.",
  },
);
module.exports = { schemas, paths };
