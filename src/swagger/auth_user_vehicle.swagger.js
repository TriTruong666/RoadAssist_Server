const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ content: { "application/json": { schema } } });
const envelope = (schema) => ({
  type: "object",
  properties: {
    success: { type: "boolean", example: true },
    message: { type: "string" },
    data: schema,
  },
});
const object = (properties, required = []) => ({
  type: "object",
  required,
  properties,
});
const string = (extra = {}) => ({ type: "string", ...extra });
const uuid = () => string({ format: "uuid" });
const dimension = (minimum, maximum) => ({
  type: "number",
  minimum,
  ...(maximum && { maximum }),
});
const registrationFields = {
  email: string({ format: "email" }),
  password: string({
    format: "password",
    minLength: 8,
    maxLength: 72,
    description: "Maximum 72 UTF-8 bytes",
  }),
  phone: string({ pattern: "^\\+?\\d{9,15}$" }),
  name: string({ maxLength: 120 }),
};
const vehicleFields = {
  type: string({ enum: ["BIKE", "CAR"] }),
  plateNumber: string({ maxLength: 20 }),
  brand: string({ maxLength: 50 }),
  modelName: string({ maxLength: 50 }),
  color: string({ nullable: true }),
  baseWidth: dimension(0.3, 3),
  baseHeight: dimension(0.5, 3),
  width: dimension(0.3, 3),
  height: dimension(0.5, 3),
};
const userFields = {
  userId: uuid(),
  name: string(),
  email: string({ format: "email" }),
  phone: string(),
  avatar: string({ nullable: true }),
  role: string({ enum: ["admin", "guest", "provider"] }),
  services: {
    type: "array",
    items: string({ enum: ["RIDER", "SHOP", "MOBILE_SHOP", "TOW"] }),
  },
  status: string({ enum: ["ACTIVE", "INACTIVE", "BANNED"] }),
  onboarded: { type: "boolean" },
  emailVerifiedAt: { type: "string", format: "date-time", nullable: true },
  requestedServices: {
    type: "array",
    items: string({ enum: ["RIDER", "SHOP", "MOBILE_SHOP", "TOW"] }),
  },
  activeVehicleId: { ...uuid(), nullable: true },
  webPushToken: string({ nullable: true }),
};
const schemas = {
  RegisterRequest: object(registrationFields, [
    "email",
    "password",
    "phone",
    "name",
  ]),
  RegisterProviderRequest: object(
    {
      ...registrationFields,
      providerKind: string({ enum: ["SHOP", "MOBILE_SHOP", "TOW"] }),
    },
    ["email", "password", "phone", "name", "providerKind"],
  ),
  LoginRequest: object(
    {
      email: registrationFields.email,
      password: string({ format: "password" }),
    },
    ["email", "password"],
  ),
  OtpRequest: object(
    { challengeId: uuid(), code: string({ pattern: "^\\d{6}$" }) },
    ["challengeId", "code"],
  ),
  ResendVerificationRequest: object({ registrationId: uuid() }, [
    "registrationId",
  ]),
  ForgotPasswordRequest: object({ email: registrationFields.email }, ["email"]),
  ResetPasswordRequest: object(
    {
      challengeId: uuid(),
      code: string({ pattern: "^\\d{6}$" }),
      password: registrationFields.password,
    },
    ["challengeId", "code", "password"],
  ),
  User: object(userFields),
  Profile: object({
    ...userFields,
    activeVehicle: { ...ref("Vehicle"), nullable: true },
  }),
  Session: object({
    requiresVerification: { type: "boolean", example: false },
    user: ref("User"),
  }),
  EmailVerificationChallenge: object({
    registrationId: uuid(),
    verificationPurpose: string({
      enum: ["registration", "email-verification"],
    }),
    requiresVerification: { type: "boolean", example: true },
    challengeId: uuid(),
    expiresIn: { type: "integer", example: 300 },
    maskedEmail: string(),
  }),
  ChangePasswordRequest: object({ oldPassword: string({ format: "password", writeOnly: true }), newPassword: string({ format: "password", minLength: 8, writeOnly: true }) }, ["oldPassword", "newPassword"]),
  UpdateProfileRequest: object({
    name: registrationFields.name,
    phone: registrationFields.phone,
    avatar: string({ format: "uri", nullable: true }),
    webPushToken: string({ nullable: true, maxLength: 255 }),
  }),
  OnboardRequest: object({
    requestedServices: {
      type: "array",
      items: userFields.services.items,
      description: "Service interests only, never operational grants.",
    },
    services: {
      type: "array",
      items: userFields.services.items,
      description:
        "Compatibility alias for requestedServices. No permissions are granted.",
    },
  }),
  ActiveVehicleRequest: object(
    {
      vehicleId: {
        ...uuid(),
        nullable: true,
        description: "null clears the current selection",
      },
    },
    ["vehicleId"],
  ),
  RideConfig: object({
    mode: string({ enum: ["SOLO", "PASSENGER", "CARGO"] }),
    width: { type: "number", exclusiveMinimum: true, minimum: 0 },
    height: { type: "number", exclusiveMinimum: true, minimum: 0 },
  }),
  CreateVehicleRequest: object(vehicleFields, [
    "type",
    "plateNumber",
    "brand",
    "modelName",
  ]),
  UpdateVehicleRequest: object({
    ...vehicleFields,
    isActive: { type: "boolean" },
    rideConfig: ref("RideConfig"),
  }),
  Vehicle: object({
    ...vehicleFields,
    id: uuid(),
    userId: uuid(),
    isActive: { type: "boolean" },
    rideConfig: ref("RideConfig"),
  }),
  ErrorResponse: object({
    success: { type: "boolean", example: false },
    message: string(),
    error_code: string(),
    details: {
      type: "object",
      nullable: true,
      description:
        "Validation may return an array; rate limiting includes retryAfter in seconds.",
    },
  }),
};
function operation(
  summary,
  tag,
  {
    input,
    output,
    public: isPublic = false,
    created = false,
    description,
    parameters,
  } = {},
) {
  return {
    summary,
    tags: [tag],
    ...(description && { description }),
    security: isPublic ? [] : [{ cookieAuth: [] }],
    ...(input && { requestBody: { required: true, ...json(ref(input)) } }),
    ...(parameters && { parameters }),
    responses: {
      [created ? 201 : 200]: {
        description: "Success",
        ...json(
          envelope(
            typeof output === "string"
              ? ref(output)
              : output || { type: "object" },
          ),
        ),
      },
      400: {
        description: "Validation or invalid/expired OTP",
        ...json(ref("ErrorResponse")),
      },
      401: {
        description: "Invalid credentials or expired/revoked session",
        ...json(ref("ErrorResponse")),
      },
      403: {
        description: "Role or service permission denied",
        ...json(ref("ErrorResponse")),
      },
      404: {
        description: "Resource does not exist or belongs to another user",
        ...json(ref("ErrorResponse")),
      },
      409: { description: "Conflicting data", ...json(ref("ErrorResponse")) },
      429: {
        description:
          "Rate limited; details.retryAfter and Retry-After header contain the remaining seconds",
        headers: { "Retry-After": { schema: { type: "integer" } } },
        ...json(ref("ErrorResponse")),
      },
    },
  };
}
const id = [{ in: "path", name: "id", required: true, schema: uuid() }];
const paths = {
  "/api/v1/auth/register": {
    post: operation("Register rider", "Auth", {
      public: true,
      created: true,
      input: "RegisterRequest",
      output: "EmailVerificationChallenge",
      description:
        "Creates a pending registration and sends an email OTP. No account or session is issued until verification.",
    }),
  },
  "/api/v1/auth/register-provider": {
    post: operation("Register provider account", "Auth", {
      public: true,
      created: true,
      input: "RegisterProviderRequest",
      output: "EmailVerificationChallenge",
      description:
        "Records provider interest and sends an email OTP; does not grant provider permissions.",
    }),
  },
  "/api/v1/auth/login": {
    post: operation("Login with email and password", "Auth", {
      public: true,
      input: "LoginRequest",
      output: "Session",
      description:
        "Verified, active accounts receive a session immediately. Login never requires an IP-based OTP.",
    }),
  },
  "/api/v1/auth/verify-otp": {
    post: operation("Verify registration email (compatibility alias)", "Auth", {
      public: true,
      input: "OtpRequest",
      output: "Session",
      description:
        "Alias of /verify-email. Verifies email ownership; never verifies a login IP.",
    }),
  },
  "/api/v1/auth/verify-email": {
    post: operation(
      "Verify email ownership and set authentication cookies",
      "Auth",
      {
        public: true,
        input: "OtpRequest",
        output: "Session",
        description:
          "Six-digit OTP expires after 300 seconds and allows three incorrect attempts. Single use, purpose-bound, independent of IP.",
      },
    ),
  },
  "/api/v1/auth/resend-verification": {
    post: operation("Resend a pending registration email OTP", "Auth", {
      public: true,
      input: "ResendVerificationRequest",
      output: "EmailVerificationChallenge",
      description:
        "60-second cooldown. Replaces the previous challenge. Drafts expire after 15 minutes.",
    }),
  },
  "/api/v1/auth/send-verification": {
    post: operation(
      "Send verification for an existing unverified account",
      "Auth",
      {
        public: true,
        input: "LoginRequest",
        output: "EmailVerificationChallenge",
        description:
          "Requires the correct password. Supports accounts created before registration email verification was introduced.",
      },
    ),
  },
  "/api/v1/auth/refresh-token": {
    post: operation("Rotate refresh token", "Auth", {
      public: true,
      output: "Session",
      description:
        "Reads road_as_refresh_token cookie and rotates both HttpOnly cookies. No token request body or token JSON response.",
    }),
  },
  "/api/v1/auth/logout": {
    post: operation("Logout and clear authentication cookies", "Auth", {
      public: true,
      description:
        "Uses a valid access or refresh cookie to invalidate all sessions. Clears both cookies even when already expired or signed out. No body tokens are accepted.",
    }),
  },
  "/api/v1/auth/forgot-password": {
    post: operation("Request password reset OTP", "Auth", {
      public: true,
      input: "ForgotPasswordRequest",
      description:
        "Returns a challengeId and the same generic message for existing and unknown accounts.",
    }),
  },
  "/api/v1/auth/reset-password": {
    post: operation("Set new password using reset challenge", "Auth", {
      public: true,
      input: "ResetPasswordRequest",
      description:
        "Proves email ownership and invalidates every session. Does not depend on the originating IP.",
    }),
  },
  "/api/v1/auth/change-password": {
    post: operation("Change own password and rotate authenticated session", "Auth", { input: "ChangePasswordRequest", output: "Session", description: "Requires the current password and an authenticated session. Revokes all old sessions and returns replacement HttpOnly cookies for this browser; tokens are never returned in JSON." }),
  },
  "/api/v1/users/me": {
    get: operation("Get profile and active vehicle", "Users", {
      output: "Profile",
    }),
    put: operation("Update own name, phone, avatar or web push token", "Users", {
      input: "UpdateProfileRequest",
      output: "Profile",
    }),
  },
  "/api/v1/users/onboard": {
    put: operation("Complete service selection", "Users", {
      input: "OnboardRequest",
      output: "Session",
      description:
        "Saves requestedServices and marks onboarding complete. Does not grant provider roles or operational services. Grants derive from approved, non-suspended provider profiles.",
    }),
  },
  "/api/v1/users/active-vehicle": {
    put: operation("Select an owned active vehicle", "Users", {
      input: "ActiveVehicleRequest",
    }),
  },
  "/api/v1/vehicles": {
    get: operation("List owned vehicles and load configuration", "Vehicles", {
      output: { type: "array", items: ref("Vehicle") },
    }),
    post: operation(
      "Create vehicle and default SOLO configuration",
      "Vehicles",
      {
        created: true,
        input: "CreateVehicleRequest",
        output: "Vehicle",
        description:
          "Defaults: BIKE 0.7 × 1.1m, CAR 1.9 × 1.5m. width/height are aliases for baseWidth/baseHeight.",
      },
    ),
  },
  "/api/v1/vehicles/{id}": {
    put: operation("Update vehicle and load configuration", "Vehicles", {
      parameters: id,
      input: "UpdateVehicleRequest",
      output: "Vehicle",
      description:
        "409 VEHICLE_BUSY if this vehicle or a linked provider has an open dispatch. Important vehicle changes move approved linked profiles to PENDING and remove their grants. Returns reapprovalRequiredProviders.",
    }),
    delete: operation(
      "Delete vehicle and revoke linked mobile/tow licenses",
      "Vehicles",
      {
        parameters: id,
        description:
          "409 VEHICLE_BUSY if this vehicle or a linked provider has an open dispatch. Otherwise clears active selection and ride configuration, and revokes linked licenses atomically. Provider and dispatch models are registered in Phases 3 and 5.",
      },
    ),
  },
};
paths["/api/v1/auth/refresh-token"].post.security = [{ refreshCookieAuth: [] }];
module.exports = { schemas, paths };

for (const name of ['Vehicle','CreateVehicleRequest','UpdateVehicleRequest']) {
 const schema = schemas[name];
 if (schema?.properties) Object.assign(schema.properties, {length:{type:'number',minimum:0.5,maximum:20,nullable:name==='Vehicle'},weightKg:{type:'number',minimum:20,maximum:50000,nullable:name==='Vehicle'}});
}

for (const name of ['CreateVehicleRequest', 'UpdateVehicleRequest']) {
  for (const field of ['baseWidth', 'baseHeight', 'length', 'weightKg']) {
    if (schemas[name]?.properties[field]) schemas[name].properties[field].nullable = true;
  }
}
const vehiclePhoto = object({ id: uuid(), url: string({ format: 'uri' }) });
schemas.Vehicle.properties.photo = { ...vehiclePhoto, nullable: true, description: 'Latest owner-uploaded vehicle photo; returned by the vehicle list.' };
paths['/api/v1/vehicles/{id}/photo'] = {
  post: operation('Upload or replace an owned vehicle photo', 'Vehicles', {
    parameters: id,
    description: 'Multipart file field. Valid JPEG/PNG/WebP up to 5MB; compressed on the server. Ownership and idle vehicle checks run before persistence. A failed upload preserves the previous image.',
    requestBody: { required: true, content: { 'multipart/form-data': { schema: object({ file: string({ format: 'binary' }) }, ['file']) } } },
    responses: { 201: { description: 'Saved photo', ...json(envelope(vehiclePhoto)) }, 400: { description: 'Invalid image' }, 404: { description: 'Vehicle not owned by account' }, 409: { description: 'Vehicle busy' }, 503: { description: 'Storage unavailable' } },
  }),
};
paths['/api/v1/users/setup-guide'] = {
  get: operation('Read current onboarding service fees', 'Users', { description: 'Authenticated read-only fee allowlist: SOS call-out/per-km, TOW base/per-km, waiting/minute and platform commission rate. No bank credentials or private settings are exposed.' }),
};
