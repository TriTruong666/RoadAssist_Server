# RoadAssist Server

Standalone Express API using PostgreSQL/Sequelize and Redis. Phases 1–2 provide the layered skeleton, Auth/User/Vehicle APIs, centralized errors, Swagger and readiness checks. Provider profiles, dispatch, payments, workers and cron schedules follow in later phases. No Firebase or Core Hub connection is used.

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
- `/api/v1/auth`, `/api/v1/users`, `/api/v1/vehicles`: Phase 2 feature routers; see Swagger for all 16 operations.
- `/api-docs`: Swagger, localhost only unless `SWAGGER_PUBLIC=true`.
- `npm test`: HTTP validation, authentication guards, response/error, CORS, body limits and readiness tests without external services.
- `npm run test:integration`: actual PostgreSQL/Redis integration tests. Each run creates and removes its own PostgreSQL schema and Redis namespace; SMTP is stubbed.

JSON and URL-encoded request bodies support up to 10 MB. Error descriptors contain `code`, `message`, `statusCode`; throw a `BaseException` subclass with a descriptor from `src/common/exceptions/error_codes.js`. `ConflictException` is available for HTTP 409.

## Database and services

Startup synchronizes registered RoadAssist models with `alter: true` and runs RoadAssist-only migrations. Registered models are User, AuthSession, VehicleProfile and VehicleRideConfig. Legacy database tables are not removed by cleanup of source files.

`DB_FORCE_RESET=true` explicitly recreates registered model tables and clears the selected Redis database. Keep it false for normal startup. Legacy partial reset (`DB_RESET=true`) is rejected; enabling both reset flags is rejected as well. Shutdown closes HTTP, Redis and PostgreSQL connections.

SMTP, JWT, SePay, maps and Socket.io settings are listed in `.env.example`. SMTP is used for login OTP and password reset in Phase 2. SePay, maps and realtime business integrations follow later. SMTP transport creation does not send mail. Node.js provides `crypto` as a built-in module.

## Container and deployment

```sh
docker build -t roadassist-server:local .
```

Production reads `.env.production` or injected environment variables. `docker-compose.prod.yml` expects PostgreSQL and Redis reachable through the external `roadassist-network`.

The GitHub production workflow uses `ROADASSIST_PRODUCTION_ENV`, `SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_KEY`, image `ghcr.io/tritruong666/roadassist-server:latest`, and deployment directory `~/projects/roadassist/server`. Configure those secrets and the external network before deployment.

## Authentication and browser clients

Registration accepts `email`, `password` (at least 8 characters, at most 72 UTF-8 bytes), `phone`, and `name`. Provider registration additionally requires `providerKind` (`SHOP`, `MOBILE_SHOP`, `TOW`). The server assigns roles; clients cannot register an administrator or update their own role/status directly. Provider service selection is distinct from approval and duty operations in Phase 3.

Authenticated responses contain `data.token`, `data.refreshToken`, `data.user`, and `data.tokenType`. Send access tokens as `Authorization: Bearer <token>`. Refresh tokens are separate JWTs with a refresh-only purpose; only their SHA-256 hash is stored in PostgreSQL. Refreshing rotates the token atomically. Replace the stored refresh token after every successful refresh. Logging out invalidates every session for that account.

`POST /auth/login` returns either a session or `{ requiresVerification: true, challengeId, expiresIn, maskedEmail }` inside `data`. Submit `challengeId` and six-digit `code` to `/auth/verify-otp` from the same IP. Challenges expire after 300 seconds, allow three incorrect attempts, and cannot be replayed. Unknown-IP verification is enabled by default (`LOGIN_VERIFICATION_ENABLED=true`); configure `SMTP_*` and `MAIL_FROM` for real delivery. Tests use a stub transport and do not deliver real emails. Registration trusts the originating IP for the initial session.

`/auth/forgot-password` accepts `email` and returns a generic message plus `challengeId` regardless of account existence. Submit `challengeId`, `code`, and new `password` to `/auth/reset-password` from the originating IP. Login OTPs and reset OTPs cannot be interchanged. A successful reset clears trusted IPs and invalidates existing tokens.

Five password failures lock the email or IP for a 900-second fixed window. Responses use HTTP 429, `details.retryAfter`, and the `Retry-After` header. Successful authentication clears the account counter; the shared IP counter expires naturally so a different valid account cannot unlock a brute-force source. Redis failures do not bypass authentication controls.

JWTs are checked against the current account status, `sessionVersion`, and PostgreSQL session. Password, email, role and status changes invalidate previous tokens. Onboarding returns a replacement session when role changes. Trusted IP records expire after 30 days and are capped at 10 by default.

For reverse proxies, configure `TRUST_PROXY` with a comma-separated list of trusted proxy IPs/CIDRs. Untrusted `X-Forwarded-For` headers are ignored. JWT_SECRET must contain at least 32 bytes; there is no built-in signing secret.

## User and vehicle payloads

- `PUT /users/me`: `name`, nullable HTTP(S) `avatar`, nullable `webPushToken`.
- `PUT /users/onboard`: optional `services` selection; RIDER is always retained. Returns session tokens and marks onboarding complete. Existing licenses are not removed by this endpoint.
- `PUT /users/active-vehicle`: `{ "vehicleId": "<owned UUID>" }`; use null to clear the selection. Inactive or foreign vehicles cannot be selected.
- `POST /vehicles`: `type`, `plateNumber`, `brand`, `modelName`, optional `color`, `baseWidth`, `baseHeight`. `width`/`height` aliases are accepted. BIKE defaults to 0.7 × 1.1m; CAR defaults to 1.9 × 1.5m. Width must be 0.3–3m and height 0.5–3m. A SOLO ride configuration is created transactionally.
- `PUT /vehicles/:id`: partial vehicle fields and optional `rideConfig: { mode, width, height }`. Modes are SOLO/PASSENGER/CARGO; actual load dimensions must be finite and positive. SOLO follows base dimensions unless dimensions are explicitly supplied.
- `DELETE /vehicles/:id`: clears the active selection, deletes the ride configuration, and returns `revokedProviders`. When Phase 3 registers Provider, linked MOBILE_SHOP/TOW licenses are set to DENIED, suspended, taken off duty and detached within the same transaction; the corresponding service grants are removed. A resulting role change invalidates the current session.

Email is trimmed and lowercased, phone punctuation is removed, and vehicle plates are uppercased with whitespace removed. Passwords, session versions and trusted IP metadata are excluded from public profile responses. Active-vehicle ownership is enforced under a user row lock; its association intentionally has no circular SQL foreign key.

## Initial administrator

Optionally set `ADMIN_SEED_EMAIL`, `ADMIN_SEED_PASSWORD`, `ADMIN_SEED_PHONE`, and `ADMIN_SEED_NAME` before startup. Seeding creates an administrator once, never replaces an existing password, and refuses to promote a conflicting existing account. Leave all seed credential variables empty to disable it. No administrator credentials are embedded in source code.
