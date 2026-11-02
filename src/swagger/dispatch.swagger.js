const uuid = { type: "string", format: "uuid" };
const money = {
  oneOf: [
    { type: "string", pattern: "^(0|[1-9][0-9]{0,9})(\\.[0-9]{1,2})?$" },
    { type: "number", minimum: 0, maximum: 9999999999.99, multipleOf: 0.01 },
  ],
};
const coordinate = { type: "number", format: "double" };
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const assetIds = { type: "array", maxItems: 5, uniqueItems: true, items: uuid };
const revision = { expectedRevision: { type: "integer", minimum: 1 } };
const schemas = {
  DispatchLocation: {
    type: "object",
    required: ["latitude", "longitude", "accuracy", "recordedAt"],
    properties: {
      latitude: { ...coordinate, minimum: -90, maximum: 90 },
      longitude: { ...coordinate, minimum: -180, maximum: 180 },
      accuracy: { type: "number", minimum: 0, maximum: 100 },
      recordedAt: { type: "string", format: "date-time" },
    },
    description:
      "Fresh within 2 minutes, at most 30 seconds future. Acceptance uses stored provider GPS. Arrival requires center distance + accuracy <= 200m.",
  },
  DispatchCreate: {
    type: "object",
    properties: {
      vehicleProfileId: uuid,
      clientRequestId: uuid,
      description: { type: "string", maxLength: 2000 },
      assetIds,
      requiredCapabilities: {
        type: "array",
        maxItems: 6,
        uniqueItems: true,
        items: {
          type: "string",
          enum: require("../common/provider.constants").REPAIR_CAPABILITIES,
        },
      },
    },
  },
  DispatchPickup: {
    type: "object",
    required: ["pickupLatitude", "pickupLongitude"],
    properties: {
      pickupLatitude: { ...coordinate, minimum: -90, maximum: 90 },
      pickupLongitude: { ...coordinate, minimum: -180, maximum: 180 },
      pickupAddress: { type: "string", maxLength: 255 },
    },
  },
  DispatchDestination: {
    type: "object",
    properties: {
      dropoffShopId: uuid,
      dropoffLatitude: { ...coordinate, minimum: -90, maximum: 90 },
      dropoffLongitude: { ...coordinate, minimum: -180, maximum: 180 },
      dropoffAddress: { type: "string", maxLength: 255 },
    },
    description:
      "Choose an active shop serving the vehicle/repair needs OR provide both coordinates. Shop coordinates are resolved server-side.",
  },
  DispatchTicket: {
    type: "object",
    properties: {
      id: uuid,
      code: { type: "string" },
      journeyId: uuid,
      type: { type: "string", enum: ["WALK_IN", "SOS", "TOW"] },
      status: {
        type: "string",
        enum: Object.values(require("../common/dispatch.constants").STATUS),
      },
      providerId: { ...uuid, nullable: true },
      revision: { type: "integer" },
      chatVersion: { type: "integer" },
      vehicleSnapshot: { type: "object" },
      pricingSnapshot: { type: "object" },
      callOutFee: { type: "string" },
      travelFee: { type: "string" },
      quoteAmount: { type: "string", nullable: true },
      waitingFee: { type: "string" },
      totalAmount: { type: "string" },
      waitingMinutes: { type: "integer", minimum: 0, maximum: 60 },
      quoteVoided: { type: "boolean" },
      chargesVoided: { type: "boolean" },
      childTicketId: { ...uuid, nullable: true },
      estimateVersion: { type: "integer" },
      estimateExpired: { type: "boolean" },
    },
  },
  DispatchAccept: {
    type: "object",
    required: ["providerId"],
    properties: { providerId: uuid, ...revision },
  },
  DispatchQuote: {
    type: "object",
    required: ["amount"],
    properties: {
      amount: {
        oneOf: [
          { type: "integer", minimum: 0, maximum: 9999999999 },
          { type: "string", pattern: "^(0|[1-9][0-9]{0,9})(\\.00)?$" },
        ],
      },
      ...revision,
    },
  },
  DispatchReason: {
    type: "object",
    required: ["reason"],
    properties: {
      reason: { type: "string", minLength: 3, maxLength: 100 },
      ...revision,
    },
  },
  DispatchUnfixable: {
    type: "object",
    required: ["reason", "assetIds"],
    properties: {
      reason: {
        type: "string",
        enum: ["NO_PARTS", "BEYOND_REPAIR", "SAFETY", "OTHER"],
      },
      assetIds: { ...assetIds, minItems: 1 },
      ...revision,
    },
  },
  DispatchTowOffer: {
    type: "object",
    required: ["mode"],
    properties: {
      mode: { type: "string", enum: ["DIRECT", "NETWORK"] },
      directProviderId: uuid,
      ...revision,
    },
  },
  DispatchEstimateApproval: {
    type: "object",
    required: ["estimateVersion"],
    properties: {
      estimateVersion: { type: "integer", minimum: 1 },
      ...revision,
    },
  },
};
const paths = {};
const id = [{ name: "id", in: "path", required: true, schema: uuid }];
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
const provider = {
  name: "providerId",
  in: "query",
  required: true,
  schema: uuid,
};
const active = { name: "active", in: "query", schema: { type: "boolean" } };
function operation(
  path,
  method,
  summary,
  input,
  parameters = [],
  created = false,
) {
  const entry = {
    tags: ["Dispatch"],
    summary,
    security: [{ cookieAuth: [] }],
    parameters: [...(path.includes("{id}") ? id : []), ...parameters],
    responses: {
      [created ? 201 : 200]: {
        description:
          "Standard success envelope; see docs/DISPATCH_BUSINESS_RULES.md",
      },
      400: {
        description: "Invalid request, vehicle data, location or evidence",
      },
      401: { description: "Cookie session required" },
      403: { description: "Account inactive or unfunded quote" },
      404: {
        description:
          "Ticket/provider/vehicle not found or requester is not a participant",
      },
      409: {
        description:
          "Vehicle busy, capacity/range mismatch, stale revision, excluded provider, duplicate request or invalid transition",
      },
    },
  };
  if (input)
    entry.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: typeof input === "string" ? ref(input) : input,
        },
      },
    };
  (paths["/api/v1/dispatch" + path] ??= {})[method] = entry;
}
operation(
  "/walk-in",
  "post",
  "Create checked-in SOLO bike request at a shop",
  {
    allOf: [
      ref("DispatchCreate"),
      {
        type: "object",
        required: ["providerId", "location"],
        properties: { providerId: uuid, location: ref("DispatchLocation") },
      },
    ],
  },
  [],
  true,
);
operation(
  "/sos",
  "post",
  "Request mobile assistance within 15 km",
  { allOf: [ref("DispatchCreate"), ref("DispatchPickup")] },
  [],
  true,
);
operation(
  "/tow",
  "post",
  "Request towing with saved vehicle length/weight and destination",
  {
    allOf: [
      ref("DispatchCreate"),
      ref("DispatchPickup"),
      ref("DispatchDestination"),
    ],
  },
  [],
  true,
);
operation("/my-requests", "get", "List rider active/history requests", null, [
  ...page,
  active,
]);
operation(
  "/provider-feed",
  "get",
  "Eligible pending work within 15 km; private rider data redacted",
  null,
  [...page, provider],
);
operation(
  "/provider-requests",
  "get",
  "Owned provider assignments and history",
  null,
  [...page, provider, active],
);
operation(
  "/notifications",
  "get",
  "Durable personal dispatch notification history",
  null,
  page,
);
operation(
  "/{id}",
  "get",
  "Participant details, server totals, events and private ongoing-trip location",
);
const actions = [
  [
    "accept",
    "Accept after locking capacity and checking current GPS",
    "DispatchAccept",
  ],
  ["arrive", "Confirm trusted provider GPS within 200m"],
  ["in-shop", "Shop starts diagnosis"],
  ["quote", "Submit one binding repair quote", "DispatchQuote"],
  [
    "approve-quote",
    "Rider approves only after server-side payment verification",
  ],
  ["start", "Rider starts funded tow with accepted shop reservation and freezes waiting fees"],
  ["ready", "Assigned repair provider marks ready for rider acceptance"],
  ["resolve", "Rider resolves; tow to shop atomically spawns linked WALK_IN"],
  [
    "unfixable",
    "Evidence-backed repair failure; SOS charges callout only",
    "DispatchUnfixable",
  ],
  ["acknowledge-unfixable", "Rider acknowledges unfixable result"],
  [
    "cancel",
    "Cancel or requeue according to actor and phase",
    "DispatchReason",
  ],
  ["decline", "Target shop declines pending walk-in", "DispatchReason"],
  [
    "tow-offer",
    "SOS provider offers own tow or network; rider consent required",
    "DispatchTowOffer",
  ],
  [
    "estimate",
    "Destination shop supplies 24-hour preliminary estimate",
    "DispatchQuote",
  ],
  [
    "approve-estimate",
    "Rider approves the exact estimate version",
    "DispatchEstimateApproval",
  ],
  [
    "reject-estimate",
    "Rider rejects preliminary estimate",
    "DispatchEstimateApproval",
  ],
];
for (const [path, summary, input] of actions)
  operation(
    "/{id}/" + path,
    "post",
    summary,
    input || { type: "object", properties: revision },
  );
operation(
  "/{id}/retarget",
  "post",
  "Rider changes destination before transport; recalculates fare and resets estimate",
  {
    allOf: [
      ref("DispatchDestination"),
      { type: "object", properties: revision },
    ],
  },
);
operation(
  "/{id}/retry-sos",
  "post",
  "Rider creates one linked SOS excluding previous providers",
  { type: "object", properties: revision },
  [],
  true,
);
operation(
  "/{id}/request-tow",
  "post",
  "Rider consents to linked direct/network tow",
  {
    allOf: [
      ref("DispatchDestination"),
      { type: "object", properties: revision },
    ],
  },
  [],
  true,
);
operation(
  "/{id}/return-tow",
  "post",
  "Rider over 1 km away accepts ready work and requests return tow",
  {
    type: "object",
    required: ["location"],
    properties: { location: ref("DispatchLocation"), ...revision },
  },
  [],
  true,
);
module.exports = { schemas, paths };
