const ref = name => ({ $ref: `#/components/schemas/${name}` });
const text = extra => ({ type: 'string', ...extra });
const uuid = () => text({ format: 'uuid' });
const latitude = { type: 'number', minimum: -85.05112878, maximum: 85.05112878 };
const longitude = { type: 'number', minimum: -180, maximum: 180 };
const kind = text({ enum: ['SHOP', 'MOBILE_SHOP', 'TOW'] });
const fields = {
  kind, name: text({ maxLength: 120 }), phone: text(), address: text({ maxLength: 255 }), latitude, longitude,
  vehicleProfileId: { ...uuid(), nullable: true }, plateNumber: text(), licenseNumber: text({ maxLength: 50 }),
  serviceSegments: { type: 'array', items: text({ enum: ['SOLO_BIKE', 'CAR'] }), minItems: 1 },
  openHours: { type: 'object', description: 'SHOP only. MON–SUN keys with HH:MM-HH:MM; overnight is supported.', example: { MON: '22:00-05:00' } },
  confirmNearby: { type: 'boolean', description: 'Acknowledge the 300m duplicate-location warning and retry registration.' },
};
const gps = { latitude, longitude, speed: { type: 'number', minimum: 0, maximum: 150, description: 'Meters/second' },
  accuracy: { type: 'number', minimum: 0, maximum: 10000, description: 'Meters' }, recordedAt: text({ format: 'date-time', description: 'Optional capture timestamp, monotonic and within the last 15 minutes. Server receive time determines freshness.' }) };
const schemas = {
  CreateProviderRequest: { type: 'object', required: ['kind', 'name', 'phone', 'address', 'latitude', 'longitude'], properties: fields },
  UpdateProviderRequest: { type: 'object', properties: { ...fields, resubmit: { type: 'boolean', description: 'Re-submit a DENIED profile for manual review.' } } },
  Provider: { type: 'object', properties: { ...fields, id: uuid(), userId: uuid(), status: text({ enum: ['ACTIVE', 'PENDING', 'DENIED'] }),
    accepting: { type: 'boolean' }, suspended: { type: 'boolean' }, requiresApproval: { type: 'boolean' },
    denialReason: text({ nullable: true }), suspensionReason: text({ nullable: true }), lastHeartbeatAt: text({ format: 'date-time', nullable: true }),
    ratingAvg: { type: 'number' }, ratingCount: { type: 'integer' } } },
  PublicProvider: { type: 'object', description: 'Public projection excludes owner IDs, licenses, review/suspension details and private coordinates of off-duty/stale mobile providers.',
    properties: { id: uuid(), kind, name: text(), phone: text(), address: text(), latitude: { ...latitude, nullable: true }, longitude: { ...longitude, nullable: true },
      accepting: { type: 'boolean' }, available: { type: 'boolean' }, distanceMeters: { type: 'integer' }, ratingAvg: { type: 'number' }, ratingCount: { type: 'integer' }, serviceSegments: fields.serviceSegments, openHours: fields.openHours } },
  ProviderDutyRequest: { type: 'object', required: ['accepting'], properties: { accepting: { type: 'boolean' }, ...gps } },
  ProviderLocationRequest: { type: 'object', required: ['providerId', 'latitude', 'longitude'], properties: { providerId: uuid(), ...gps } },
  ProviderSearchRequest: { type: 'object', required: ['latitude', 'longitude'], properties: { latitude, longitude,
    radiusKm: { type: 'number', exclusiveMinimum: true, minimum: 0, maximum: 50, default: 50 }, kinds: { type: 'array', items: kind },
    minRating: { type: 'number', minimum: 0, maximum: 5, default: 0 }, acceptingOnly: { type: 'boolean', default: false },
    sortBy: text({ enum: ['distance', 'rating'], default: 'distance' }), limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } },
  ProviderDenialRequest: { type: 'object', required: ['reason'], properties: { reason: text({ maxLength: 500 }) } },
  ProviderSuspensionRequest: { type: 'object', required: ['suspended'], properties: { suspended: { type: 'boolean' }, reason: text({ description: 'Required when suspending.', maxLength: 500 }) } },
};
const id = [{ in: 'path', name: 'id', required: true, schema: uuid() }];
function operation(summary, { input, public: isPublic = false, withId = false, list = false, created = false, description, parameters = [] } = {}) {
  return { summary, tags: [summary.startsWith('Admin') ? 'Admin Providers' : 'Providers'], security: isPublic ? [] : [{ cookieAuth: [] }],
    ...(description && { description }), ...((withId || parameters.length) && { parameters: [...(withId ? id : []), ...parameters] }),
    ...(input && { requestBody: { required: true, content: { 'application/json': { schema: ref(input) } } } }),
    responses: {
      [created ? 201 : 200]: { description: list ? 'Public provider array in data' : 'Success; role changes in owner mutations may replace HttpOnly authentication cookies',
        content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: list ? { type: 'array', items: ref('PublicProvider') } : { type: 'object' } } } } } },
      400: { description: 'Invalid profile, GPS, vehicle/plate/license or validation data' },
      401: { description: 'Missing or expired road_as_token cookie' }, 403: { description: 'Admin only, suspended/inactive profile, or pending approval' },
      404: { description: 'Profile not found, private, or not owned' },
      409: { description: 'Duplicate kind, nearby-location confirmation, invalid status transition, stale GPS, or active rescue dispatch' },
    } };
}
const pagination = [ { in: 'query', name: 'page', schema: { type: 'integer', minimum: 1, default: 1 } },
  { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } } ];
const paths = {
  '/api/v1/providers': { post: operation('Register provider', { input: 'CreateProviderRequest', created: true,
    description: 'One non-DENIED profile per owner/kind. SHOP and first MOBILE_SHOP registrations auto-approve; TOW is pending. Mobile providers require an owned active vehicle and matching VN plate; MOBILE_SHOP requires licenseNumber. TOW needs licenseNumber before approval. Nearby SHOP/MOBILE_SHOP within 300m returns confirmation-required 409; retry with confirmNearby=true.' }) },
  '/api/v1/providers/me': { get: operation('List owned profiles and application history') },
  '/api/v1/providers/{id}': {
    get: operation('Get public or owned provider details', { withId: true, public: true }),
    put: operation('Update owned provider', { withId: true, input: 'UpdateProviderRequest', description: 'Identity/license/vehicle changes on approved profiles require reapproval. DENIED profiles require resubmit=true. Operational grants/status/suspension cannot be assigned by the client.' }),
  },
  '/api/v1/providers/{id}/toggle-duty': { post: operation('Set provider duty', { withId: true, input: 'ProviderDutyRequest', description: 'Only ACTIVE, non-suspended profiles. Mobile duty activation requires current latitude/longitude immediately. SHOP does not send GPS. Manual accepting controls new requests independently of opening hours.' }) },
  '/api/v1/providers/location': { post: operation('Record provider GPS heartbeat', { input: 'ProviderLocationRequest', description: 'Only owned ACTIVE MOBILE_SHOP/TOW on duty or handling an active trip. Stores PostgreSQL history and publishes on-duty Redis GEO with 15-minute freshness. Rider/SHOP background GPS is rejected; off-duty trip GPS is private.' }) },
  '/api/v1/providers/{id}/revoke': { post: operation('Revoke provider license', { withId: true, description: 'Owner or admin; refuses active rescue dispatches. Keeps vehicle and denied/revoked profile history. An admin suspension cannot be bypassed by revoking and registering again.' }) },
  '/api/v1/providers/search': { post: operation('Search nearby providers', { input: 'ProviderSearchRequest', public: true, list: true, description: 'Maximum 50km. Filters active accounts/approved profiles and valid vehicles; mobile results always require duty plus fresh GPS. SQL validates Redis candidates and fills missing cache entries. Public data never includes private licenses.' }) },
  '/api/v1/admin/providers/pending-tows': { get: operation('Admin list pending TOWs', { parameters: pagination }) },
  '/api/v1/admin/providers/pending': { get: operation('Admin list all pending profiles', { parameters: [...pagination, { in: 'query', name: 'kind', schema: kind }], description: 'Includes MOBILE_SHOP profiles pending reapproval after vehicle/license changes.' }) },
  '/api/v1/admin/providers/{id}/approve': { put: operation('Admin approve pending provider', { withId: true, description: 'Revalidates vehicle ownership/type/plate/license, refuses suspension/busy profiles, synchronizes service grants. Approved owners may need to log in again if their role changes.' }) },
  '/api/v1/admin/providers/{id}/deny': { put: operation('Admin deny pending provider', { withId: true, input: 'ProviderDenialRequest' }) },
  '/api/v1/admin/providers/{id}/suspend': { put: operation('Admin suspend or reinstate provider', { withId: true, input: 'ProviderSuspensionRequest', description: 'suspended=false clears the admin restriction but never automatically turns duty on or approves a pending/denied profile.' }) },
};
module.exports = { schemas, paths };

// Operational extensions: capabilities, live capacity, private evidence and versioned review history.
const businessConstants = require('../common/provider.constants');
const capabilityProperties = {
  capabilities: { type: 'array', items: text({ enum: businessConstants.CAPABILITIES }), description: 'Repair capabilities for SHOP/MOBILE_SHOP; only TOWING for TOW.' },
  supportedVehicleTypes: { type: 'array', items: text({ enum: ['BIKE', 'CAR'] }) },
  maxConcurrentJobs: { type: 'integer', minimum: 1, maximum: 20, default: 1, description: 'SHOP bays; mobile/tow always one shared slot per linked vehicle.' },
  towMaxWeightKg: { type: 'number', minimum: 1, maximum: 100000 }, towMaxWidth: { type: 'number', minimum: 0.3, maximum: 3 },
  towMaxHeight: { type: 'number', minimum: 0.5, maximum: 3 }, towMaxLength: { type: 'number', minimum: 0.5, maximum: 20 },
  towMethods: { type: 'array', items: text({ enum: businessConstants.TOW_METHODS }) },
};
for (const name of ['CreateProviderRequest', 'UpdateProviderRequest', 'Provider', 'PublicProvider']) Object.assign(schemas[name].properties, capabilityProperties);
schemas.Provider.properties.status = text({ enum: ['ACTIVE', 'PENDING', 'DENIED', 'REVOKED'] });
Object.assign(schemas.Provider.properties, { profileRevision: { type: 'integer' }, reviewedRevision: { type: 'integer', nullable: true }, locationQuality: text({ enum: businessConstants.GPS_QUALITIES }), lastAccuracy: { type: 'number', nullable: true } });
schemas.ProviderApprovalRequest = { type: 'object', required: ['reason'], properties: { reason: text({ minLength: 1, maxLength: 500 }) } };
schemas.ProviderAvailability = { type: 'object', properties: { onDuty: { type: 'boolean' }, available: { type: 'boolean' }, state: text({ enum: ['OFF_DUTY', 'UNAVAILABLE', 'BUSY', 'AVAILABLE'] }), reason: text({ nullable: true }), maxConcurrentJobs: { type: 'integer' }, activeJobs: { type: 'integer' }, freeSlots: { type: 'integer' } } };
Object.assign(schemas.PublicProvider.properties, schemas.ProviderAvailability.properties, { verification: text({ enum: ['AUTO_APPROVED', 'MANUALLY_APPROVED', 'PENDING_REVIEW'] }) });
Object.assign(schemas.ProviderSearchRequest.properties, {
  availableOnly: { type: 'boolean', description: 'Require free capacity, declared capabilities, current review and good mobile GPS. acceptingOnly checks only the duty switch.' },
  requiredCapabilities: capabilityProperties.capabilities, vehicleType: text({ enum: ['BIKE', 'CAR'] }), towMethod: text({ enum: businessConstants.TOW_METHODS }),
  vehicleWeightKg: capabilityProperties.towMaxWeightKg, vehicleWidth: capabilityProperties.towMaxWidth, vehicleHeight: capabilityProperties.towMaxHeight, vehicleLength: capabilityProperties.towMaxLength,
});
paths['/api/v1/admin/providers/{id}/approve'].put = operation('Admin approve evidence-backed profile revision', { withId: true, input: 'ProviderApprovalRequest', description: 'Requires complete matching evidence, declared capabilities, valid vehicle/license, a reason, and no suspension or open job. Stores an immutable before/after snapshot with evidence hashes. Images tied to old license/vehicle identities cannot approve the new identity.' });
paths['/api/v1/providers/{id}/availability'] = { get: operation('Get effective duty, availability and capacity', { withId: true, public: true, description: 'onDuty is independent of available. Open tickets consume SHOP bays or the single shared MOBILE_SHOP/TOW vehicle slot. Phase 5 assignment must hold the returned provider lock through its ticket write.' }) };
paths['/api/v1/providers/{id}/documents'] = {
  get: operation('List authorized evidence metadata and public URLs', { withId: true, description: 'Owner/admin only. Lists withdrawn history and currentForProfile; no raw bytes in JSON.' }),
  post: operation('Upload review evidence to public S3', { withId: true, created: true, description: 'Owner only, idle profile. JPEG/PNG/WebP, maximum 5MB; image signatures checked. Direct public S3 URL in picare-s3 under roadassist/, no ACL or Core proxy. Approved profiles move to PENDING. Identical current uploads are idempotent. Limits: 10 active/50 total/100MB per profile; 200 total/200MB per owner, including withdrawn history.' }),
};
paths['/api/v1/providers/{id}/documents'].post.requestBody = { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['documentType', 'file'], properties: { documentType: text({ enum: businessConstants.DOCUMENT_TYPES }), file: text({ format: 'binary' }) } } } } };
const documentId = { in: 'path', name: 'documentId', required: true, schema: uuid() };
paths['/api/v1/providers/{id}/documents/{documentId}/content'] = { get: operation('Get historical evidence public URL', { withId: true, parameters: [documentId], description: 'Owner/admin only, authenticated cookie. New files redirect to public S3 URLs (302); old PostgreSQL bytes remain available during migration. Withdrawn files remain accessible for review traceability.' }) };
paths['/api/v1/providers/{id}/documents/{documentId}'] = { delete: operation('Withdraw private evidence from future approvals', { withId: true, parameters: [documentId], description: 'Soft withdrawal preserves past review evidence. Approved profile becomes PENDING; busy profiles cannot change evidence.' }) };
paths['/api/v1/providers/{id}/audit'] = { get: operation('Read private immutable review history', { withId: true, parameters: pagination, description: 'Owner/admin only. Before/after identity, vehicle, capability and document fingerprints; actor, action and reason. No image bytes or background GPS stream.' }) };
paths['/api/v1/providers/{id}/revoke'].post.description = 'Owner/admin; active jobs block revocation. Sets REVOKED (distinct from DENIED), retains history and releases the live-profile uniqueness slot. Reapplication creates a new profile; admin restrictions remain in force.';
paths['/api/v1/providers/location'].post.description += ' GPS without accuracy, with accuracy above the configured threshold (default 100m), or with an implausible jump is retained privately but cannot publish discovery. Trusted coordinates are preserved. Responses include locationQuality and usableForDispatch. Suspended/off-duty partners on an existing trip may still record private trip GPS without gaining new-work permission.';

paths['/api/v1/providers'].post.description = 'One live profile per owner/kind; DENIED and REVOKED history do not reserve the slot. Declare capabilities/supportedVehicleTypes before duty; TOW additionally declares its towing envelope. Manual reviews require current evidence and a reason. First SHOP/MOBILE_SHOP remain AUTO_APPROVED.';
paths['/api/v1/providers/{id}/documents/{documentId}/content'].get.responses[200] = { description: 'Authenticated private image attachment', headers: { 'Cache-Control': { schema: { type: 'string', example: 'no-store' } } }, content: Object.fromEntries(['image/png', 'image/jpeg', 'image/webp'].map(type => [type, { schema: { type: 'string', format: 'binary' } }])) };

paths['/api/v1/providers/{id}/documents/{documentId}/content'].get.responses[302] = { description: 'Redirect to public S3 URL', headers: { Location: { schema: { type: 'string', format: 'uri' } } } };
