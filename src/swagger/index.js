const swaggerJSDoc = require("swagger-jsdoc");
const config = require("../config/app.config");
const { schemas, paths } = require("./auth_user_vehicle.swagger");
const providers = require("./provider.swagger");
const placesFlags = require("./places_flags.swagger");
const chatUploads = require("./chat_upload.swagger");
const dispatch = require("./dispatch.swagger");
const custodyDisputes = require("./custody_dispute.swagger");
const operations = require("./operations.swagger");
const billing = require("./billing.swagger");
const platform = require("./platform.swagger");
const accounts = require("./admin_accounts.swagger");
module.exports = swaggerJSDoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: `${config.app.name} API`,
      version: config.app.version,
      description: "RoadAssist standalone API",
    },
    servers: [{ url: `http://localhost:${config.app.port}` }],
    components: {
      schemas: {
        ...schemas,
        ...providers.schemas,
        ...placesFlags.schemas,
        ...chatUploads.schemas,
        ...dispatch.schemas,
        ...billing.schemas,
        ...operations.schemas,
        ...custodyDisputes.schemas,
        ...platform.schemas,
        ...accounts.schemas,
      },
      securitySchemes: {
        sepayApiKey: { type: "apiKey", in: "header", name: "Authorization" },
        sepaySecretHeader: {
          type: "apiKey",
          in: "header",
          name: "X-Secret-Key",
        },
        sepayHmacSignature: {
          type: "apiKey",
          in: "header",
          name: "X-SePay-Signature",
        },
        sepayTimestamp: {
          type: "apiKey",
          in: "header",
          name: "X-SePay-Timestamp",
        },
        cookieAuth: { type: "apiKey", in: "cookie", name: "road_as_token" },
        refreshCookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "road_as_refresh_token",
        },
      },
    },
    paths: {
      ...paths,
      ...providers.paths,
      ...placesFlags.paths,
      ...chatUploads.paths,
      ...dispatch.paths,
      ...billing.paths,
      ...operations.paths,
      ...custodyDisputes.paths,
      ...platform.paths,
      ...accounts.paths,
      "/health": {
        get: {
          summary: "Check PostgreSQL and Redis readiness",
          responses: {
            200: { description: "Healthy" },
            503: { description: "Dependency unavailable" },
          },
        },
      },
    },
  },
  apis: [require("node:path").join(__dirname, "../routes/**/*.js")],
});
