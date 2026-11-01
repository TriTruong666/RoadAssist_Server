const swaggerJSDoc = require("swagger-jsdoc");
const config = require("./app.config");
module.exports = swaggerJSDoc({
  definition: {
    openapi: "3.0.0",
    info: { title: `${config.app.name} API`, version: config.app.version, description: "RoadAssist standalone API" },
    servers: [{ url: `http://localhost:${config.app.port}` }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    paths: {
      "/health": { get: { summary: "Check PostgreSQL and Redis readiness", responses: { 200: { description: "Healthy" }, 503: { description: "Dependency unavailable" } } } },
    },
  },
  apis: [require("node:path").join(__dirname, "../routes/**/*.js")],
});
