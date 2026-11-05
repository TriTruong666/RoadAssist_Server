const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const coordinate = { type: "number", format: "double" };
const schemas = {
  SavedPlaceInput: {
    type: "object",
    required: ["name", "latitude", "longitude"],
    properties: {
      name: { type: "string", maxLength: 120 },
      latitude: { ...coordinate, minimum: -90, maximum: 90 },
      longitude: { ...coordinate, minimum: -180, maximum: 180 },
      address: { type: "string", maxLength: 255 },
      category: {
        type: "string",
        enum: ["HOME", "WORK", "OTHER"],
        default: "OTHER",
      },
    },
  },
  RouteSolveInput: {
    type: "object",
    required: ["stops"],
    properties: {
      stops: {
        type: "array",
        minItems: 2,
        maxItems: 25,
        items: {
          type: "object",
          required: ["latitude", "longitude"],
          properties: {
            latitude: { ...coordinate, minimum: -90, maximum: 90 },
            longitude: { ...coordinate, minimum: -180, maximum: 180 },
          },
        },
      },
      costing: {
        type: "string",
        enum: ["auto", "motorcycle", "motor_scooter", "bicycle", "pedestrian"],
        default: "auto",
      },
    },
  },
  RouteGeometry: {
    type: "object",
    required: ["type", "coordinates"],
    properties: {
      type: { type: "string", enum: ["LineString"] },
      coordinates: {
        type: "array",
        minItems: 2,
        maxItems: 20000,
        items: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: { type: "number" },
        },
      },
    },
  },
  SavedRouteInput: {
    allOf: [
      ref("RouteSolveInput"),
      {
        type: "object",
        required: ["name", "geometry"],
        properties: {
          name: { type: "string", maxLength: 120 },
          geometry: ref("RouteGeometry"),
        },
      },
    ],
  },
  HazardInput: {
    type: "object",
    required: ["latitude", "longitude"],
    properties: {
      latitude: { ...coordinate, minimum: -90, maximum: 90 },
      longitude: { ...coordinate, minimum: -180, maximum: 180 },
      category: {
        type: "string",
        enum: ["FLOOD", "ACCIDENT", "OBSTRUCTION"],
        default: "FLOOD",
      },
      description: { type: "string", maxLength: 500 },
      address: { type: "string", maxLength: 255 },
      radiusMeters: {
        type: "integer",
        enum: [25, 50, 100, 200, 250],
        default: 50,
      },
      ttlMinutes: {
        type: "integer",
        enum: [60, 120, 240, 720, 1440],
        default: 120,
      },
    },
  },
  HazardVoteInput: {
    type: "object",
    required: ["voteType"],
    properties: { voteType: { type: "string", enum: ["CONFIRM", "DENY"] } },
  },
  HazardMessageInput: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string", minLength: 1, maxLength: 1000 } },
  },
};
const paths = {};
const page = ["limit", "offset"].map((name, i) => ({
  name,
  in: "query",
  schema: {
    type: "integer",
    minimum: i ? 0 : 1,
    maximum: i ? 100000 : 100,
    default: i ? 0 : 50,
  },
}));
function operation(path, method, summary, options = {}) {
  const parameters = [
    ...(path.match(/\{\w+\}/g) || []).map((v) => ({
      name: v.slice(1, -1),
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    })),
    ...(options.page ? page : []),
    ...(options.parameters || []),
  ];
  const op = {
    tags: [path.includes("places") ? "Places" : "Hazards"],
    summary,
    security: options.public ? [] : [{ cookieAuth: [] }],
    parameters,
    responses: {
      [options.created ? 201 : 200]: {
        description:
          "Standard success envelope; see docs/PLACES_AND_HAZARDS.md for response fields",
      },
      400: { description: "Invalid input" },
      401: { description: "Cookie session required" },
      403: { description: "Insufficient permission" },
      404: { description: "Not found" },
      409: {
        description: "Duplicate vote, closed flag, invalid transition or quota",
      },
      429: { description: "Chat rate limit" },
      503: { description: "Map service unavailable" },
    },
  };
  if (options.input)
    op.requestBody = {
      required: true,
      content: { "application/json": { schema: ref(options.input) } },
    };
  if (options.upload)
    op.requestBody = {
      required: true,
      content: {
        "application/json": { schema: ref("HazardInput") },
        "multipart/form-data": {
          schema: {
            allOf: [
              ref("HazardInput"),
              {
                type: "object",
                properties: {
                  images: {
                    type: "array",
                    maxItems: 3,
                    items: { type: "string", format: "binary" },
                  },
                },
              },
            ],
          },
        },
      },
    };
  (paths["/api/v1" + path] ??= {})[method] = op;
}
operation(
  "/flags",
  "post",
  "Report a suggested hazard; up to 3 images; accepts lat/lng aliases",
  { created: true, upload: true },
);
operation(
  "/flags/nearby",
  "get",
  "Active hazards within 2 km, ordered by exact distance",
  {
    public: true,
    page: true,
    parameters: ["latitude", "longitude"].map((name, i) => ({
      name,
      in: "query",
      required: true,
      schema: {
        type: "number",
        minimum: i ? -180 : -90,
        maximum: i ? 180 : 90,
      },
    })),
  },
);
operation("/flags/my", "get", "Own hazard history", { page: true });
operation(
  "/flags/{id}",
  "get",
  "Hazard details and image URLs; expiry is applied immediately",
  { public: true },
);
operation("/flags/{id}/images/{imageId}", "get", "Compressed WebP evidence", {
  public: true,
});
operation(
  "/flags/{id}/vote",
  "post",
  "One vote per account; no self-vote; 3 confirmations close voting",
  { input: "HazardVoteInput" },
);
operation("/flags/{id}/unflag", "post", "Author removes an unlocked report");
operation("/flags/{id}/messages", "get", "Newest scene messages", {
  page: true,
});
operation(
  "/flags/{id}/messages",
  "post",
  "Persist and broadcast a scene message; max 10/min/account/room",
  { input: "HazardMessageInput", created: true },
);
operation("/admin/flags/{id}/lock", "put", "Admin locks a confirmed hazard");
operation(
  "/admin/flags/{id}/unlock",
  "put",
  "Admin unlocks a locked hazard to confirmed",
);
operation(
  "/admin/flags/{id}",
  "delete",
  "Admin removes a hazard, preserving history",
);
for (const [path, input] of [
  ["saved", "SavedPlaceInput"],
  ["routes", "SavedRouteInput"],
]) {
  operation("/places/" + path, "get", "List own saved " + path, { page: true });
  operation("/places/" + path, "post", "Create own saved " + path, {
    input,
    created: true,
  });
  operation("/places/" + path + "/{id}", "delete", "Delete own saved " + path);
}
operation("/places/saved/{id}", "put", "Update an owned saved place", { input: "SavedPlaceInput" });
operation("/places/search", "get", "VietMap v4 address suggestions; resolve selected refId with /places/detail", {
  parameters: [
    { name: "latitude", in: "query", description: "Optional proximity bias; supply longitude together", schema: { type: "number", minimum: -85.05112878, maximum: 85.05112878 } },
    { name: "longitude", in: "query", description: "Optional proximity bias; supply latitude together", schema: { type: "number", minimum: -180, maximum: 180 } },
    {
      name: "q",
      in: "query",
      required: true,
      schema: { type: "string", minLength: 2, maxLength: 200 },
    },
  ],
});
operation("/places/detail", "get", "Resolve a selected VietMap v4 refId into validated coordinates", {
  parameters: [{ name: "refId", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 2048 } }],
});
operation("/places/reverse", "get", "Resolve a selected map coordinate into VietMap addresses", {
  parameters: [{ name: "latitude", in: "query", required: true, schema: { type: "number", minimum: -90, maximum: 90 } }, { name: "longitude", in: "query", required: true, schema: { type: "number", minimum: -180, maximum: 180 } }],
});
operation(
  "/places/route",
  "post",
  "Solve real Valhalla route excluding unexpired confirmed/locked hazard areas; returns GeoJSON and summary.length in km / summary.time in seconds",
  { input: "RouteSolveInput" },
);
operation("/places/tiles/{theme}/{z}/{x}/{y}.png", "get", "Authenticated MapTiler raster basemap; fixed upstream origin and bounded shared cache", {
  parameters: [{ name: "theme", in: "path", required: true, schema: { type: "string", enum: ["light","dark"] } }, ...["z","x","y"].map(name => ({ name, in: "path", required: true, schema: { type: "integer", minimum: 0, maximum: name === "z" ? 19 : 524287 }, description: name === "z" ? "Zoom" : "Tile index must be less than 2^z" }))],
});
paths["/api/v1/places/tiles/{theme}/{z}/{x}/{y}.png"].get.responses[200] = { description: "PNG bytes; private HTTP cache; credentials never leave server", content: { "image/png": { schema: { type: "string", format: "binary" } } } };
module.exports = { schemas, paths };
