const sequelize = require('../config/postgres.config');
const REVIEW_FIELDS = ['name', 'address', 'vehicleProfileId', 'plateNumber', 'licenseNumber', 'capabilities', 'supportedVehicleTypes', 'towMaxWeightKg', 'towMaxWidth', 'towMaxHeight', 'towMaxLength', 'towMethods'];
const SNAPSHOT_FIELDS = [...REVIEW_FIELDS, 'id', 'kind', 'phone', 'status', 'suspended', 'requiresApproval', 'denialReason', 'suspensionReason', 'revokedAt', 'revocationReason', 'reviewedAt', 'reviewedBy', 'profileRevision', 'reviewedRevision', 'maxConcurrentJobs', 'accepting'];
async function snapshot(values, transaction, vehicleOverride) {
  const fields = Object.fromEntries(SNAPSHOT_FIELDS.filter(field => values[field] !== undefined).map(field => [field, values[field]]));
  if (values.kind === 'SHOP') fields.location = { latitude: values.latitude, longitude: values.longitude };
  const { ProviderDocument, VehicleProfile } = sequelize.models;
  const vehicle = vehicleOverride || (values.vehicleProfileId ? await VehicleProfile.findByPk(values.vehicleProfileId, { transaction, attributes: ['id', 'type', 'plateNumber', 'baseWidth', 'baseHeight', 'brand', 'modelName'] }) : null);
  fields.vehicle = vehicle?.get ? vehicle.get({ plain: true }) : vehicle || null;
  fields.documents = ProviderDocument ? (await ProviderDocument.findAll({ where: { providerId: values.id, withdrawnAt: null }, transaction, attributes: ['id', 'documentType', 'sha256', 'subjectFingerprint', 'size', 'mimeType'] })).map(document => document.toJSON()) : [];
  return fields;
}
async function record(provider, options) {
  const changed = provider.changed() || [];
  const creating = options._providerCreating;
  if (!creating && ![...SNAPSHOT_FIELDS, 'profileRevision'].some(field => changed.includes(field))) return;
  const { ProviderAuditLog } = sequelize.models;
  if (!ProviderAuditLog) return;
  const before = creating ? null : options.auditBefore || await snapshot(provider._previousDataValues, options.transaction, options.auditBeforeVehicle);
  await ProviderAuditLog.create({ providerId: provider.id,
    actorUserId: options.auditActorId || options.transaction?.roadAssistActorId || null,
    action: options.auditAction || (creating ? 'REGISTERED' : 'UPDATED'),
    reason: options.auditReason || provider.denialReason || provider.suspensionReason || provider.revocationReason || null,
    before, after: await snapshot(provider.get({ plain: true }), options.transaction),
  }, { transaction: options.transaction });
}
module.exports = { REVIEW_FIELDS, SNAPSHOT_FIELDS, snapshot, record };
