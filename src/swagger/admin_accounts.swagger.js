const account = {
  type: "object",
  properties: {
    userId: { type: "string", format: "uuid" },
    name: { type: "string" },
    email: { type: "string", format: "email" },
    phone: { type: "string" },
    role: { type: "string", enum: ["admin", "guest", "provider"] },
    status: { type: "string", enum: ["ACTIVE", "INACTIVE", "BANNED"] },
    onboarded: { type: "boolean" },
    emailVerifiedAt: { type: "string", format: "date-time", nullable: true },
    isOnline: {
      type: "boolean",
      description: "An authenticated socket is currently connected",
    },
    createdAt: { type: "string", format: "date-time" },
  },
};
const response = {
  200: {
    description:
      "Success; safe account DTO without credentials or session metadata",
  },
  401: { description: "Authentication required" },
  403: { description: "Administrator required or forbidden admin suspension" },
  409: { description: "Email or phone already in use" },
};
const op = (summary, extra = {}) => ({
  tags: ["Admin accounts"],
  summary,
  security: [{ cookieAuth: [] }],
  responses: response,
  ...extra,
});
const body = (schema) => ({
  required: true,
  content: { "application/json": { schema } },
});
module.exports = {
  schemas: { AdminAccount: account },
  paths: {
    "/api/v1/admin/accounts": {
      get: op(
        "List accounts with server pagination, literal search, role filter and global online/date sorting",
        {
          parameters: [
            ["page", "integer"],
            ["limit", "integer"],
            ["search", "string"],
            ["role", "string"],
            ["sort", "string"],
          ].map(([name, type]) => ({ in: "query", name, schema: { type } })),
        },
      ),
    },
    "/api/v1/admin/accounts/{id}": {
      parameters: [
        {
          in: "path",
          name: "id",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      get: op("Get account details"),
      put: op(
        "Update name, phone or status; suspending a customer invalidates existing sessions",
        {
          requestBody: body({
            type: "object",
            properties: {
              name: { type: "string" },
              phone: { type: "string" },
              status: {
                type: "string",
                enum: ["ACTIVE", "INACTIVE", "BANNED"],
              },
            },
          }),
        },
      ),
    },
  },
};
