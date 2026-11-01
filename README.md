# RoadAssist Server

Standalone Express API using PostgreSQL/Sequelize and Redis. Phase 1 provides the layered skeleton, centralized errors, Swagger and readiness checks. Feature routes, models, seeds, workers and cron schedules are registered in later phases. No Firebase or Core Hub connection is used.

## Local development

```sh
npm ci
cp .env.example .env.development
# Set DB_PASSWORD and REDIS_PASSWORD to match docker-compose.dev.yml.
# Set JWT_SECRET to a random secret before implementing authentication.
npm run infra:up
npm run dev
```

Existing `.env.development` files can be kept. Defaults are HTTP `9898`, PostgreSQL `5436`, Redis `6384`. The server validates both connections before listening.

- `GET /health`: HTTP 200 when PostgreSQL and Redis are reachable; HTTP 503 otherwise.
- `/api/v1`: reserved for RoadAssist feature routers; unimplemented endpoints return the standard JSON 404.
- `/api-docs`: Swagger, localhost only unless `SWAGGER_PUBLIC=true`.
- `npm test`: HTTP response/error, CORS, body limits and readiness tests using isolated dependency mocks.

JSON and URL-encoded request bodies support up to 10 MB. Error descriptors contain `code`, `message`, `statusCode`; throw a `BaseException` subclass with a descriptor from `src/common/exceptions/error_codes.js`. `ConflictException` is available for HTTP 409.

## Database and services

Startup synchronizes registered RoadAssist models with `alter: true` and runs RoadAssist-only migrations. Phase 1 registers no models or migrations. Legacy database tables are not removed by cleanup of source files.

`DB_FORCE_RESET=true` explicitly recreates registered model tables and clears the selected Redis database. Keep it false for normal startup. Legacy partial reset (`DB_RESET=true`) is rejected; enabling both reset flags is rejected as well. Shutdown closes HTTP, Redis and PostgreSQL connections.

SMTP, JWT, SePay, maps and Socket.io settings are listed in `.env.example`. Their business integrations are implemented in subsequent phases. SMTP transport creation does not send mail. Node.js provides `crypto` as a built-in module.

## Container and deployment

```sh
docker build -t roadassist-server:local .
```

Production reads `.env.production` or injected environment variables. `docker-compose.prod.yml` expects PostgreSQL and Redis reachable through the external `roadassist-network`.

The GitHub production workflow uses `ROADASSIST_PRODUCTION_ENV`, `SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_KEY`, image `ghcr.io/tritruong666/roadassist-server:latest`, and deployment directory `~/projects/roadassist/server`. Configure those secrets and the external network before deployment.
