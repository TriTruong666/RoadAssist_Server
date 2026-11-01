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
- `/api/v1/auth`, `/api/v1/users`, `/api/v1/vehicles`: Phase 2 feature routers; see Swagger for all 19 operations.
- `/api-docs`: Swagger, localhost only unless `SWAGGER_PUBLIC=true`.
- `npm test`: HTTP validation, authentication guards, response/error, CORS, body limits and readiness tests without external services.
- `npm run test:integration`: actual PostgreSQL/Redis integration tests. Each run creates and removes its own PostgreSQL schema and Redis namespace; SMTP is stubbed.

JSON and URL-encoded request bodies support up to 10 MB. Error descriptors contain `code`, `message`, `statusCode`; throw a `BaseException` subclass with a descriptor from `src/common/exceptions/error_codes.js`. `ConflictException` is available for HTTP 409.

## Database and services

Startup synchronizes registered RoadAssist models with `alter: true` and runs RoadAssist-only migrations. Registered models are User, AuthSession, PendingRegistration, VehicleProfile and VehicleRideConfig. Legacy database tables are not removed by cleanup of source files.

`DB_FORCE_RESET=true` explicitly recreates registered model tables and clears the selected Redis database. Keep it false for normal startup. Legacy partial reset (`DB_RESET=true`) is rejected; enabling both reset flags is rejected as well. Shutdown closes HTTP, Redis and PostgreSQL connections.

SMTP, JWT, SePay, maps and Socket.io settings are listed in `.env.example`. SMTP is used for login OTP and password reset in Phase 2. SePay, maps and realtime business integrations follow later. SMTP transport creation does not send mail. Node.js provides `crypto` as a built-in module.

## Container and deployment

```sh
docker build -t roadassist-server:local .
```

Production reads `.env.production` or injected environment variables. `docker-compose.prod.yml` expects PostgreSQL and Redis reachable through the external `roadassist-network`.

The GitHub production workflow uses `ROADASSIST_PRODUCTION_ENV`, `SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_KEY`, image `ghcr.io/tritruong666/roadassist-server:latest`, and deployment directory `~/projects/roadassist/server`. Configure those secrets and the external network before deployment.

## Authentication and browser clients

Registration accepts `email`, `password` (at least 8 characters, at most 72 UTF-8 bytes), `phone`, and `name`. Provider registration additionally requires `providerKind` (`SHOP`, `MOBILE_SHOP`, `TOW`).

1. `POST /api/v1/auth/register` or `/register-provider` saves a pending registration in PostgreSQL with a bcrypt password hash and sends an email OTP. The response contains `data.registrationId`, `challengeId`, `expiresIn`, `resendAfter`, and `requiresVerification: true`. It does **not** contain a session. Unverified drafts do not reserve an email or phone in the users table.
2. `POST /api/v1/auth/verify-email` with `{ challengeId, code }` proves email ownership, creates the account with `emailVerifiedAt`, and sets authentication cookies. `/verify-otp` is a compatibility alias for email verification; it no longer verifies a login IP.
3. `POST /api/v1/auth/login` with email/password immediately issues a session for a verified, ACTIVE account. Changing location, network, browser or IP never triggers a login OTP.

Email OTPs expire after 300 seconds, allow three incorrect attempts, are consumed atomically and cannot be replayed. Registration and password reset challenges cannot be interchanged. Verification works even if the browser's IP changes. `POST /auth/resend-verification` takes `registrationId` and sends a replacement OTP after a 60-second cooldown; pending drafts expire after 15 minutes. Mail requests are additionally rate limited by email and IP. Configure `SMTP_*`, `MAIL_FROM`, and optionally `AUTH_OTP_SECRET` (defaults to JWT_SECRET) for real delivery. Tests stub the SMTP transport and do not send real mail.

Existing accounts without `emailVerifiedAt` receive `403 AUTH_EMAIL_NOT_VERIFIED` on login. Call `POST /auth/send-verification` with email/password and then `/auth/verify-email` once. This proves email ownership; it is independent of IP. Explicitly provisioned environment admins are treated as trusted operator-created accounts. Do not mark legacy public accounts verified automatically.

Authentication uses cookies exclusively:

- `road_as_token`: access JWT, HttpOnly, Path=/.
- `road_as_refresh_token`: refresh JWT, HttpOnly, Path=/api/v1/auth.

Login, email verification and onboarding set both cookies. JSON contains the public user/session state and never contains access/refresh tokens. Authorization headers, old cookie names and refresh tokens in request bodies are not accepted for authentication.

Call `POST /api/v1/auth/refresh-token` with no token body; the server reads the refresh cookie, validates the PostgreSQL session/hash and rotates both cookies. `POST /auth/logout` revokes all account sessions and clears both cookies, including when the access token has expired but the refresh cookie remains valid. Logout is idempotent when already signed out. A successful password reset also clears the browser's authentication cookies.

Browser requests must enable credentials:

```js
fetch(`${API_URL}/api/v1/users/me`, { credentials: "include" });
// Axios: axios.create({ baseURL: API_URL, withCredentials: true })
```

Do not copy JWTs into localStorage or add an Authorization header. The browser manages cookie storage and rotation. Cookie lifetime follows the corresponding JWT expiration. Locally cookies use SameSite=Lax over HTTP; production uses Secure + SameSite=None over HTTPS, matching the Core pattern. AUTH_COOKIE_SAME_SITE can be lax/strict/none; none requires Secure/HTTPS. Cookies are host-only. Configure CORS origins explicitly: credentials are allowed only for listed origins, and unsafe cross-site browser requests without Origin are rejected. Swagger is configured to send credentials and documents cookie security schemes.

`/auth/forgot-password` accepts email and returns a generic message plus challengeId regardless of account existence. `/auth/reset-password` takes `{ challengeId, code, password }`; it proves email ownership and invalidates every existing session. It is not tied to an IP address.

Five failed password attempts lock the email or IP for a 900-second fixed window. HTTP 429 includes `details.retryAfter` and a `Retry-After` header. Successful authentication clears the account counter; the shared IP counter expires naturally. IPs are audit metadata and an abuse-control input, never a login verification requirement. Redis failures do not bypass authentication controls.

JWTs are checked against account status, email verification, sessionVersion and the PostgreSQL session. Password, email, role, status and email-verification changes invalidate previous tokens. Changing email clears its verification. JWT_SECRET must contain at least 32 bytes. For reverse proxies, set TRUST_PROXY to an explicit list of trusted IPs/CIDRs; arbitrary forwarded headers are ignored.

## Provider service permissions

`requestedServices` records the services a user wants to register. `services` is the operational permission list and must never be copied from browser input. New verified accounts start as guest with RIDER only, including accounts using `/register-provider`.

`PUT /users/onboard` accepts requestedServices, marks onboarding complete and preserves existing approved permissions. The legacy services request field is accepted only as an alias for requestedServices. Selecting TOW never grants TOW permission.

`ProviderAccessService` derives grants from registered Provider profiles that are ACTIVE and not suspended. MOBILE_SHOP/TOW additionally require an owned active vehicle; TOW requires CAR. Without a Provider model, only RIDER is granted. Role becomes provider only when at least one operational provider service is available; admin is preserved. JWT middleware and `/users/me` derive live permissions, so stale stored services cannot bypass approval or suspension.

Phase 3 approval/revocation operations must lock the owner row and call `ProviderAccessService.synchronize(user, transaction)` after updating the provider profile. Startup migration preserves old service selections as requestedServices and reconciles operational grants; it does not grandfather unapproved provider permissions.

## User and vehicle payloads

- `PUT /users/me`: name, nullable HTTP(S) avatar, nullable webPushToken. Public input cannot update role, services, verification or account status.
- `PUT /users/active-vehicle`: `{ vehicleId: "<owned UUID>" }`; null clears the selection. Inactive or foreign vehicles cannot be selected.
- `POST /vehicles`: type, plateNumber, brand, modelName, optional color/baseWidth/baseHeight. width/height aliases are accepted. BIKE defaults to 0.7 × 1.1m; CAR to 1.9 × 1.5m. Base width must be 0.3–3m and height 0.5–3m. A SOLO ride configuration is created transactionally.
- `PUT /vehicles/:id`: partial vehicle fields and optional rideConfig `{ mode, width, height }`. Modes: SOLO/PASSENGER/CARGO. Actual load dimensions must be finite and positive.
- Vehicle edits/deletion return `409 VEHICLE_BUSY` when the vehicle has a nonterminal rider dispatch **or a linked provider is assigned to another rider's open dispatch**. Rejection leaves vehicle, licenses, duty and active selection unchanged.
- When an idle vehicle's type, plate, brand/model, base dimensions or activation changes, linked approved MOBILE_SHOP/TOW profiles move to PENDING, duty is disabled and grants are removed atomically. Update responses include reapprovalRequiredProviders. A resulting role change invalidates old sessions; the user can log in again with their password.
- Deleting an idle vehicle clears active selection, removes its ride configuration and revokes linked licenses atomically, returning revokedProviders. No license is revoked mid-job.

The Provider and DispatchTicket production models are implemented in Phases 3 and 5. Phase 2 policies use their registered Sequelize interfaces and integration tests exercise those policies against real PostgreSQL fixture tables. Dispatch creation/assignment must use the same owner → vehicle → provider locking protocol, ensuring a new job cannot race a vehicle edit/deletion. Terminal dispatch statuses are 4, 5, 8, 12 and 15. Each future dispatch must snapshot its vehicle details so active selection changes do not rewrite an existing rescue request.

Email is trimmed/lowercased, phone punctuation removed, and vehicle plates uppercased without whitespace. Passwords and security metadata are excluded from profile responses. Active-vehicle ownership is checked under the user row lock; its association intentionally avoids a circular SQL foreign key.

## Initial administrator

Optionally set `ADMIN_SEED_EMAIL`, `ADMIN_SEED_PASSWORD`, `ADMIN_SEED_PHONE`, and `ADMIN_SEED_NAME` before startup. Seeding creates an administrator once, never replaces an existing password, and refuses to promote a conflicting existing account. Leave all seed credential variables empty to disable it. The public registration API never assigns administrator privileges.

Seed JSON accounts use requestedServices as service interests; legacy services values are treated as requests. Non-admin seeds start as guest and do not grant provider permissions. Set `emailVerified: true` explicitly only for trusted fixture accounts; public registration always requires email OTP. The existing JSON seed workflow is retained.
