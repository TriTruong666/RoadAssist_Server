const ref = name => ({ $ref: `#/components/schemas/${name}` });
const json = schema => ({ content: { 'application/json': { schema } } });
const envelope = schema => ({ type: 'object', properties: { success: { type: 'boolean', example: true }, message: { type: 'string' }, data: schema } });
const object = (properties, required = []) => ({ type: 'object', required, properties });
const string = (extra = {}) => ({ type: 'string', ...extra });
const uuid = () => string({ format: 'uuid' });
const dimension = (minimum, maximum) => ({ type: 'number', minimum, ...(maximum && { maximum }) });
const registrationFields = { email: string({ format: 'email' }), password: string({ format: 'password', minLength: 8, maxLength: 72, description: 'Maximum 72 UTF-8 bytes' }), phone: string({ pattern: '^\\+?\\d{9,15}$' }), name: string({ maxLength: 120 }) };
const vehicleFields = { type: string({ enum: ['BIKE', 'CAR'] }), plateNumber: string({ maxLength: 20 }), brand: string({ maxLength: 50 }), modelName: string({ maxLength: 50 }), color: string({ nullable: true }), baseWidth: dimension(0.3, 3), baseHeight: dimension(0.5, 3), width: dimension(0.3, 3), height: dimension(0.5, 3) };
const userFields = { userId: uuid(), name: string(), email: string({ format: 'email' }), phone: string(), avatar: string({ nullable: true }), role: string({ enum: ['admin', 'guest', 'provider'] }), services: { type: 'array', items: string({ enum: ['RIDER', 'SHOP', 'MOBILE_SHOP', 'TOW'] }) }, status: string({ enum: ['ACTIVE', 'INACTIVE', 'BANNED'] }), onboarded: { type: 'boolean' }, activeVehicleId: { ...uuid(), nullable: true }, webPushToken: string({ nullable: true }) };
const schemas = {
  RegisterRequest: object(registrationFields, ['email', 'password', 'phone', 'name']),
  RegisterProviderRequest: object({ ...registrationFields, providerKind: string({ enum: ['SHOP', 'MOBILE_SHOP', 'TOW'] }) }, ['email', 'password', 'phone', 'name', 'providerKind']),
  LoginRequest: object({ email: registrationFields.email, password: string({ format: 'password' }) }, ['email', 'password']),
  OtpRequest: object({ challengeId: uuid(), code: string({ pattern: '^\\d{6}$' }) }, ['challengeId', 'code']),
  RefreshRequest: object({ refreshToken: string() }, ['refreshToken']),
  ForgotPasswordRequest: object({ email: registrationFields.email }, ['email']),
  ResetPasswordRequest: object({ challengeId: uuid(), code: string({ pattern: '^\\d{6}$' }), password: registrationFields.password }, ['challengeId', 'code', 'password']),
  User: object(userFields),
  Profile: object({ ...userFields, activeVehicle: { ...ref('Vehicle'), nullable: true } }),
  Session: object({ token: string(), refreshToken: string(), tokenType: string({ example: 'Bearer' }), requiresVerification: { type: 'boolean', example: false }, user: ref('User') }),
  LoginChallenge: object({ requiresVerification: { type: 'boolean', example: true }, challengeId: uuid(), expiresIn: { type: 'integer', example: 300 }, maskedEmail: string() }),
  UpdateProfileRequest: object({ name: registrationFields.name, avatar: string({ format: 'uri', nullable: true }), webPushToken: string({ nullable: true, maxLength: 255 }) }),
  OnboardRequest: object({ services: { type: 'array', items: userFields.services.items, description: 'RIDER is always retained; provider profiles and duty approval are separate Phase 3 operations.' } }),
  ActiveVehicleRequest: object({ vehicleId: { ...uuid(), nullable: true, description: 'null clears the current selection' } }, ['vehicleId']),
  RideConfig: object({ mode: string({ enum: ['SOLO', 'PASSENGER', 'CARGO'] }), width: { type: 'number', exclusiveMinimum: true, minimum: 0 }, height: { type: 'number', exclusiveMinimum: true, minimum: 0 } }),
  CreateVehicleRequest: object(vehicleFields, ['type', 'plateNumber', 'brand', 'modelName']),
  UpdateVehicleRequest: object({ ...vehicleFields, isActive: { type: 'boolean' }, rideConfig: ref('RideConfig') }),
  Vehicle: object({ ...vehicleFields, id: uuid(), userId: uuid(), isActive: { type: 'boolean' }, rideConfig: ref('RideConfig') }),
  ErrorResponse: object({ success: { type: 'boolean', example: false }, message: string(), error_code: string(), details: { type: 'object', nullable: true, description: 'Validation may return an array; rate limiting includes retryAfter in seconds.' } }),
};
function operation(summary, tag, { input, output, public: isPublic = false, created = false, description, parameters } = {}) {
  return {
    summary, tags: [tag], ...(description && { description }), security: isPublic ? [] : [{ bearerAuth: [] }],
    ...(input && { requestBody: { required: true, ...json(ref(input)) } }), ...(parameters && { parameters }),
    responses: {
      [created ? 201 : 200]: { description: 'Success', ...json(envelope(typeof output === 'string' ? ref(output) : output || { type: 'object' })) },
      400: { description: 'Validation or invalid/expired OTP', ...json(ref('ErrorResponse')) },
      401: { description: 'Invalid credentials or expired/revoked session', ...json(ref('ErrorResponse')) },
      403: { description: 'Role or service permission denied', ...json(ref('ErrorResponse')) },
      404: { description: 'Resource does not exist or belongs to another user', ...json(ref('ErrorResponse')) },
      409: { description: 'Conflicting data', ...json(ref('ErrorResponse')) },
      429: { description: 'Rate limited; details.retryAfter and Retry-After header contain the remaining seconds', headers: { 'Retry-After': { schema: { type: 'integer' } } }, ...json(ref('ErrorResponse')) },
    },
  };
}
const id = [{ in: 'path', name: 'id', required: true, schema: uuid() }];
const paths = {
  '/api/v1/auth/register': { post: operation('Register rider', 'Auth', { public: true, created: true, input: 'RegisterRequest', output: 'Session' }) },
  '/api/v1/auth/register-provider': { post: operation('Register provider account', 'Auth', { public: true, created: true, input: 'RegisterProviderRequest', output: 'Session', description: 'Registers an account and selected services; operational provider onboarding and approval are handled in Phase 3.' }) },
  '/api/v1/auth/login': { post: operation('Login or request OTP for an untrusted IP', 'Auth', { public: true, input: 'LoginRequest', output: { oneOf: [ref('Session'), ref('LoginChallenge')] } }) },
  '/api/v1/auth/verify-otp': { post: operation('Complete IP-bound login challenge', 'Auth', { public: true, input: 'OtpRequest', output: 'Session', description: 'OTP expires after 300 seconds, allows three incorrect attempts, and is consumed atomically.' }) },
  '/api/v1/auth/refresh-token': { post: operation('Rotate refresh token', 'Auth', { public: true, input: 'RefreshRequest', output: 'Session', description: 'Persist the replacement refreshToken. The old token cannot be used again.' }) },
  '/api/v1/auth/logout': { post: operation('Logout all sessions', 'Auth', { description: 'Invalidates all access/refresh tokens for the account and clears session cookies.' }) },
  '/api/v1/auth/forgot-password': { post: operation('Request password reset OTP', 'Auth', { public: true, input: 'ForgotPasswordRequest', description: 'Returns a challengeId and the same generic message for existing and unknown accounts.' }) },
  '/api/v1/auth/reset-password': { post: operation('Set new password using reset challenge', 'Auth', { public: true, input: 'ResetPasswordRequest', description: 'Requires the originating IP. Clears trusted IPs and invalidates every session.' }) },
  '/api/v1/users/me': {
    get: operation('Get profile and active vehicle', 'Users', { output: 'Profile' }),
    put: operation('Update display name, avatar or web push token', 'Users', { input: 'UpdateProfileRequest', output: 'Profile' }),
  },
  '/api/v1/users/onboard': { put: operation('Complete service selection', 'Users', { input: 'OnboardRequest', output: 'Session', description: 'Use returned session tokens when a role change invalidates previous tokens. This endpoint cannot select admin.' }) },
  '/api/v1/users/active-vehicle': { put: operation('Select an owned active vehicle', 'Users', { input: 'ActiveVehicleRequest' }) },
  '/api/v1/vehicles': {
    get: operation('List owned vehicles and load configuration', 'Vehicles', { output: { type: 'array', items: ref('Vehicle') } }),
    post: operation('Create vehicle and default SOLO configuration', 'Vehicles', { created: true, input: 'CreateVehicleRequest', output: 'Vehicle', description: 'Defaults: BIKE 0.7 × 1.1m, CAR 1.9 × 1.5m. width/height are aliases for baseWidth/baseHeight.' }),
  },
  '/api/v1/vehicles/{id}': {
    put: operation('Update vehicle and load configuration', 'Vehicles', { parameters: id, input: 'UpdateVehicleRequest', output: 'Vehicle' }),
    delete: operation('Delete vehicle and revoke linked mobile/tow licenses', 'Vehicles', { parameters: id, description: 'Clears the active selection and cascades ride configuration removal. Returns revokedProviders. Provider links are available once Phase 3 registers Provider.' }),
  },
};
module.exports = { schemas, paths };
