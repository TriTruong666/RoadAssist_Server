const uuid = { type: "string", format: "uuid" };
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const text = (maxLength) => ({ type: "string", maxLength });
const reason = { type: "string", minLength: 3, maxLength: 200 };
const revision = { type: "integer", minimum: 0 };
const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
});
const schemas = {
  CashEligibility: object({
    eligible: { type: "boolean" },
    onlineAllowed: { type: "boolean", enum: [true] },
    graceHours: { type: "integer" },
    maxUnpaidCompletedRequests: { type: "integer" },
    unpaidCompletedRequests: { type: "integer" },
    unpaidAmount: text(20),
    overdueAmount: text(20),
    tickets: {
      type: "array",
      items: object({
        ticketId: uuid,
        billId: uuid,
        amount: text(20),
        dueAt: { type: "string", format: "date-time" },
        overdue: { type: "boolean" },
      }),
    },
  }),
  ShopIntakeReservation: object({
    id: uuid,
    ticketId: uuid,
    shopId: uuid,
    childTicketId: uuid,
    version: { type: "integer" },
    status: {
      type: "string",
      enum: [
        "REQUESTED",
        "ACCEPTED",
        "IN_TRANSIT",
        "DELIVERED",
        "CONSUMED",
        "DECLINED",
        "EXPIRED",
        "RELEASED",
      ],
    },
    requestExpiresAt: { type: "string", format: "date-time" },
    holdUntil: { type: "string", format: "date-time", nullable: true },
    acceptedAt: { type: "string", format: "date-time", nullable: true },
    reason: text(200),
  }),
  DispatchSupportCase: object({
    id: uuid,
    ticketId: uuid,
    reason: {
      type: "string",
      enum: [
        "NO_PROGRESS",
        "MISSED_ETA",
        "GPS_LOST_IN_TRANSIT",
        "DESTINATION_UNAVAILABLE",
        "CUSTOMER_REQUEST",
        "INTAKE_TIMEOUT",
      ],
    },
    note: text(500),
    status: { type: "string", enum: ["OPEN", "RESOLVED"] },
    resolution: text(1000),
    resolvedBy: uuid,
    resolvedAt: { type: "string", format: "date-time", nullable: true },
  }),
  IntakeDecision: object({ reservationId: uuid, expectedRevision: revision }, [
    "reservationId",
  ]),
  CashConversion: object(
    { billId: uuid, ticketId: uuid, billItemId: uuid, clientRequestId: uuid },
    ["billId"],
  ),
};
const paths = {};
function op(
  path,
  method,
  summary,
  { input, output, description, created = false, list = false } = {},
) {
  const value = {
    tags: [
      path.startsWith("/admin")
        ? "Dispatch Support Admin"
        : path.startsWith("/payments")
          ? "Payments"
          : "Dispatch Operations",
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
      400: { description: "Invalid fields" },
      401: { description: "Session cookie required" },
      403: { description: "Admin role required" },
      404: { description: "Not found or not a participant" },
      409: {
        description:
          "Stale revision/reservation, expired deadline, no capacity, unsafe state or overdue cash balance",
      },
      503: { description: "Payment service not configured" },
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
    );
  paths["/api/v1" + path] = { [method]: value };
}
op(
  "/payments/cash-eligibility",
  "get",
  "Read own unpaid completed cash obligations",
  {
    output: "CashEligibility",
    description:
      "Online rescue stays available. Default: cash blocked at two unpaid completed requests or any obligation overdue by 24 hours. Creating QR alone does not clear debt.",
  },
);
op(
  "/payments/switch-cash-to-sepay",
  "post",
  "Atomically convert unpaid completed cash promises to SePay",
  {
    input: "CashConversion",
    created: true,
    output: "PaymentIntent",
    description:
      "Only completed requests. Select the whole cash intent scope. clientRequestId supports safe retries. Failure preserves the original cash promise; only actual funding clears debt.",
  },
);
op(
  "/dispatch/{id}/request-rematch",
  "post",
  "Rider searches again after no progress or missed arrival deadline",
  {
    input: object(
      {
        reason: { type: "string", enum: ["NO_PROGRESS", "MISSED_ETA"] },
        note: text(500),
        expectedRevision: revision,
      },
      ["reason"],
    ),
    description:
      "Only MATCHED SOS/TOW, before arrival. Default: 10 minutes without 100m approach or 30 minute arrival deadline; no replacement when trusted GPS is within 200m including accuracy. At most 3 rematches; exclude previous provider and owner, rotate chat and reconcile funds transactionally.",
  },
);
op(
  "/dispatch/{id}/request-assistance",
  "post",
  "Participant opens or reuses an active support case",
  {
    input: object(
      {
        reason: schemas.DispatchSupportCase.properties.reason,
        note: text(500),
        expectedRevision: revision,
      },
      ["reason"],
    ),
    output: "DispatchSupportCase",
    description:
      "Rider, assigned provider or involved destination shop. Never cancels transport or releases its vehicle.",
  },
);
op(
  "/dispatch/{id}/intake/request",
  "post",
  "Rider renews destination intake request before transport",
  {
    input: object({ expectedRevision: revision }),
    output: "ShopIntakeReservation",
    description:
      "Default shop reply deadline 5 minutes. Returns existing live request/hold; renewal advances version and invalidates old confirmations.",
  },
);
op(
  "/dispatch/{id}/intake/accept",
  "post",
  "Destination shop reserves a real bay before towing",
  {
    input: "IntakeDecision",
    output: "ShopIntakeReservation",
    description:
      "Owner only. Live capability, duty and capacity checks under locks. Default hold 120 minutes; after departure it stays reserved until delivery and intake, regardless of holdUntil.",
  },
);
op(
  "/dispatch/{id}/intake/decline",
  "post",
  "Shop declines or withdraws an intake before departure",
  {
    input: object({ ...schemas.IntakeDecision.properties, reason }, [
      "reservationId",
      "reason",
    ]),
    output: "ShopIntakeReservation",
    description:
      "IN_TRANSIT/DELIVERED/CONSUMED cannot be withdrawn; request support instead.",
  },
);
op(
  "/dispatch/{id}/confirm-destination",
  "post",
  "Rider approves a supported alternative destination during transport",
  {
    input: "IntakeDecision",
    description:
      "Requires open support case when admin proposes the destination and a still-valid new-shop acceptance. Atomic transfer of reserved bay; original fare/payment/waiting charge retained. Driver must reach the new destination before delivery.",
  },
);
op(
  "/dispatch/{id}/reject-destination",
  "post",
  "Rider rejects alternative while retaining original destination and slot",
  { input: "IntakeDecision" },
);
op(
  "/admin/dispatch/support-cases",
  "get",
  "Admin lists operational support cases",
  { list: true },
);
op(
  "/admin/dispatch/support-cases/{id}",
  "get",
  "Admin reads case, ticket and participant contact details",
);
op(
  "/admin/dispatch/support-cases/{id}/resolve",
  "post",
  "Admin records support outcome without changing ticket or payment state",
  {
    input: object(
      { resolution: { type: "string", minLength: 3, maxLength: 1000 } },
      ["resolution"],
    ),
    output: "DispatchSupportCase",
  },
);
op(
  "/admin/dispatch/{id}/propose-destination",
  "post",
  "Admin proposes alternate shop for supported in-transit tow",
  {
    input: object({ dropoffShopId: uuid, reason }, ["dropoffShopId", "reason"]),
    output: "ShopIntakeReservation",
    description:
      "Requires open support case and IN_PROGRESS TOW. Original destination commitment remains until new shop accepts and rider confirms.",
  },
);
module.exports = { schemas, paths };
