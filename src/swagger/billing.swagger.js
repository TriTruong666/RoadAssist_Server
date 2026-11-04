const uuid = { type: "string", format: "uuid" };
const amount = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,9})(\\.[0-9]{1,2})?$",
};
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const schemas = {
  Bill: {
    type: "object",
    properties: {
      id: uuid,
      journeyId: uuid,
      code: { type: "string" },
      status: {
        type: "string",
        enum: ["DRAFT", "PENDING", "PARTIAL", "PAID", "VOID"],
      },
      totalAmount: amount,
      paidAmount: amount,
      dueAmount: amount,
      items: { type: "array", items: ref("BillItem") },
      payments: { type: "array", items: ref("BillPayment") },
    },
  },
  BillItem: {
    type: "object",
    properties: {
      id: uuid,
      billId: uuid,
      ticketId: uuid,
      providerId: uuid,
      type: {
        type: "string",
        enum: [
          "SOS_CALLOUT",
          "SOS_TRAVEL",
          "TOW_FARE",
          "WAITING_FEE",
          "SHOP_REPAIR",
        ],
      },
      title: { type: "string" },
      amount,
    },
  },
  BillPayment: {
    type: "object",
    properties: {
      id: uuid,
      intentId: uuid,
      billItemId: uuid,
      providerId: uuid,
      amount,
      appliedAmount: amount,
      refundedAmount: amount,
      method: { type: "string", enum: ["SEPAY", "CASH"] },
      status: {
        type: "string",
        enum: ["PENDING", "HELD", "CONFIRMED", "REFUNDED", "CANCELLED"],
      },
      commissionAmount: amount,
      payoutAmount: amount,
      cashCommissionOutstanding: amount,
      ticketId: uuid,
      canConfirmCash: { type: "boolean", description: "Present on provider earnings rows; true only for an owned pending CASH payment whose rescue is at handover or a terminal settlement stage. Server rechecks on confirmation." },
    },
  },
  PaymentCreate: {
    type: "object",
    required: ["billId"],
    description:
      "Amounts/providers are resolved server-side. Optional billItemId or ticketId narrows selection; omitted selects all unreserved amounts.",
    properties: {
      billId: uuid,
      billItemId: uuid,
      ticketId: uuid,
      clientRequestId: uuid,
    },
  },
  PaymentIntent: {
    type: "object",
    properties: {
      id: uuid,
      billId: uuid,
      code: { type: "string", pattern: "^RA[0-9]{20}$" },
      method: { type: "string", enum: ["SEPAY", "CASH"] },
      status: { type: "string" },
      amount,
      receivedAmount: amount,
      expiresAt: { type: "string", format: "date-time", nullable: true },
      bank: {
        type: "object",
        properties: {
          accountNumber: { type: "string" },
          bankCode: { type: "string" },
          accountName: { type: "string" },
          transferContent: { type: "string" },
          qrUrl: { type: "string", format: "uri" },
        },
      },
      payments: { type: "array", items: ref("BillPayment") },
    },
  },
  SepayWebhook: {
    type: "object",
    required: [
      "id",
      "gateway",
      "accountNumber",
      "content",
      "transferType",
      "transferAmount",
    ],
    properties: {
      id: {
        oneOf: [
          { type: "integer", minimum: 1 },
          { type: "string", pattern: "^[0-9]{1,30}$" },
        ],
      },
      gateway: { type: "string" },
      accountNumber: { type: "string" },
      subAccount: { type: "string", nullable: true },
      code: { type: "string", nullable: true },
      content: { type: "string", maxLength: 2000 },
      transferType: { type: "string", enum: ["in", "out"] },
      transferAmount: { type: "integer", minimum: 1, maximum: 9999999999 },
      referenceCode: { type: "string", nullable: true },
      transactionDate: { type: "string" },
    },
  },
  PayoutTransfer: {
    type: "object",
    required: ["entryId", "amount", "reference"],
    properties: {
      entryId: uuid,
      amount,
      reference: { type: "string", minLength: 3, maxLength: 150 },
    },
  },
  PayoutBatch: {
    type: "object",
    properties: {
      id: uuid,
      status: { type: "string", enum: ["PENDING", "SETTLED", "CANCELLED"] },
      gross: amount,
      commission: amount,
      net: amount,
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: uuid,
            userId: uuid,
            onlineGross: amount,
            cashGross: amount,
            debtOffset: amount,
            netAmount: amount,
          },
        },
      },
    },
  },
};
const paths = {};
const page = [
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  },
  {
    name: "offset",
    in: "query",
    schema: { type: "integer", minimum: 0, maximum: 100000, default: 0 },
  },
];
function op(
  path,
  method,
  summary,
  { input, created = false, list = false, admin = false } = {},
) {
  const item = {
    tags: [
      admin ? "Finance Admin" : path.includes("/bills") ? "Bills" : "Payments",
    ],
    summary,
    security: [{ cookieAuth: [] }],
    parameters: [
      ...(path.includes("{id}")
        ? [{ name: "id", in: "path", required: true, schema: uuid }]
        : []),
      ...(list ? page : []),
    ],
    responses: {
      [created ? 201 : 200]: {
        description:
          "Standard JSON success envelope; see docs/BILLING_AND_PAYMENTS.md",
      },
      400: { description: "Invalid fields or non-integer VND" },
      401: { description: "Cookie required" },
      403: { description: "Insufficient role" },
      404: { description: "Not found/not owner" },
      409: {
        description:
          "Duplicate, stale price, reserved funds, blocked payout or invalid state",
      },
      503: { description: "SePay not configured" },
    },
  };
  if (input)
    item.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: typeof input === "string" ? ref(input) : input,
        },
      },
    };
  (paths["/api/v1" + path] ??= {})[method] = item;
}
op("/bills/my-bills", "get", "Own journey invoices with unpaid count", {
  list: true,
});
op(
  "/bills/{id}",
  "get",
  "Own reconciled invoice, item allocations and refunds",
);
op(
  "/payments/create-sepay-qr",
  "post",
  "Create/reuse item-allocated SePay intent and direct VietQR URL",
  { input: "PaymentCreate", created: true },
);
op(
  "/payments/choose-cash",
  "post",
  "Create cash commitment; no receipt or payout until provider confirms",
  { input: "PaymentCreate", created: true },
);
op(
  "/payments/confirm-cash",
  "post",
  "Assigned provider confirms one cash allocation at handover",
  {
    input: {
      type: "object",
      required: ["paymentId"],
      properties: { paymentId: uuid },
    },
  },
);
op(
  "/payments/provider-earnings",
  "get",
  "Owner-wide earnings, escrow, commission debt and payout history",
  { list: true },
);
op("/payments/{id}", "get", "Rider polls a reconciled payment intent");
op(
  "/payments/{id}/cancel",
  "post",
  "Rider cancels an unfulfilled intent before approved work",
);
paths["/api/v1/payments/sepay/webhook"] = {
  post: {
    tags: ["Payments"],
    summary:
      "Authenticate, durably receive and ACK SePay webhook; async idempotent processing",
    description:
      "64 KiB JSON. API key mode: Authorization: Apikey TOKEN or X-Secret-Key. HMAC mode: X-SePay-Signature sha256=<hex>, X-SePay-Timestamp Unix seconds, signed timestamp.raw_body, ±300 sec. Authentication modes cannot downgrade. No road_as_token required.",
    security: [
      { sepayApiKey: [] },
      { sepaySecretHeader: [] },
      { sepayHmacSignature: [], sepayTimestamp: [] },
    ],
    requestBody: {
      required: true,
      content: { "application/json": { schema: ref("SepayWebhook") } },
    },
    responses: {
      200: {
        description:
          "Persisted or identical replay; processing may still be pending/review",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["success"],
              properties: { success: { type: "boolean", enum: [true] } },
            },
          },
        },
      },
      400: { description: "Malformed payload" },
      401: { description: "Invalid key/signature/timestamp" },
      409: { description: "Replay financial fields changed" },
      413: { description: "Payload exceeds 64 KiB" },
      503: { description: "Webhook authentication not configured" },
    },
  },
};
for (const [path, summary] of [
  ["pending-items", "Eligible receipts after hold window and dispute checks"],
  ["batches", "Batch history"],
])
  op("/admin/payouts/" + path, "get", summary, { list: true, admin: true });
op(
  "/admin/payouts/create-batch",
  "post",
  "Reserve eligible receipts and owner-wide cash commission offsets",
  { created: true, admin: true },
);
op(
  "/admin/payouts/{id}/settle",
  "put",
  "Record exact manual bank-transfer proofs and settle reserved offsets",
  {
    input: {
      type: "object",
      required: ["transfers"],
      properties: {
        transfers: {
          type: "array",
          maxItems: 1000,
          items: ref("PayoutTransfer"),
        },
      },
    },
    admin: true,
  },
);
op(
  "/admin/payouts/{id}/cancel",
  "post",
  "Cancel pending batch and release receipts/debt reservations",
  {
    input: {
      type: "object",
      required: ["reason"],
      properties: { reason: { type: "string", minLength: 3, maxLength: 200 } },
    },
    admin: true,
  },
);
for (const [path, summary] of [
  ["refunds", "Refund queue and completion history"],
  ["sepay-receipts", "Original verified receipts and review queue"],
  ["events", "Append-only financial journal"],
  ["transfers", "Unique manual bank-transfer confirmations"],
])
  op("/admin/finance/" + path, "get", summary, { list: true, admin: true });
op(
  "/admin/finance/refunds/{id}/complete",
  "post",
  "Record manual refund actually performed; does not send funds",
  {
    input: {
      type: "object",
      required: ["externalReference"],
      properties: {
        externalReference: { type: "string", minLength: 3, maxLength: 150 },
      },
    },
    admin: true,
  },
);
op(
  "/admin/finance/sepay-receipts/{id}/reconcile",
  "post",
  "Map reviewed receipt to intent without bypassing receiving-account validation",
  {
    input: {
      type: "object",
      required: ["intentId", "reason"],
      properties: {
        intentId: uuid,
        reason: { type: "string", minLength: 3, maxLength: 200 },
      },
    },
    admin: true,
  },
);
op(
  "/admin/finance/sepay-receipts/{id}/refund",
  "post",
  "Record manual return of an unmatched verified deposit; permanently blocks later credit",
  {
    input: {
      type: "object",
      required: ["externalReference", "reason"],
      properties: {
        externalReference: { type: "string", minLength: 3, maxLength: 150 },
        reason: { type: "string", minLength: 3, maxLength: 200 },
      },
    },
    admin: true,
  },
);
module.exports = { schemas, paths };
