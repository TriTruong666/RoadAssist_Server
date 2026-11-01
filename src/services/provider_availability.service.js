const { Op, literal } = require('sequelize');
const sequelize = require('../config/postgres.config');
const { TERMINAL_DISPATCH_STATUSES } = require('../common/provider.constants');
const Capabilities = require('./provider_capability.service');
const { usable } = require('../utils/gps_quality.util');
const { ConflictException, ForbiddenException, NotFoundException } = require('../common/exceptions/BaseException');
const errors = require('../common/exceptions/error_codes');
class ProviderAvailabilityService {
  static countSql() {
    const Ticket = sequelize.models.DispatchTicket;
    if (!Ticket) return '0';
    const q = sequelize.getQueryInterface().queryGenerator;
    const table = q.quoteTable(Ticket.getTableName());
    const providers = q.quoteTable(sequelize.models.Provider.getTableName());
    const field = name => q.quoteIdentifier(Ticket.rawAttributes[name]?.field || name);
    const terminal = TERMINAL_DISPATCH_STATUSES.map(value => sequelize.escape(value)).join(',');
    return `(SELECT COUNT(*)::integer FROM ${table} AS job WHERE job.${field('status')} NOT IN (${terminal}) AND (job.${field('providerId')} = "Provider"."id" OR ("Provider"."kind" != 'SHOP' AND (job.${field('vehicleProfileId')} = "Provider"."vehicle_profile_id" OR job.${field('providerId')} IN (SELECT linked.id FROM ${providers} AS linked WHERE linked.vehicle_profile_id = "Provider"."vehicle_profile_id")))))`;
  }
  static async activeJobs(profile, transaction) {
    const Ticket = sequelize.models.DispatchTicket;
    if (!Ticket) return 0;
    const alternatives = [{ providerId: profile.id }];
    if (profile.kind !== 'SHOP' && profile.vehicleProfileId) {
      const linked = await sequelize.models.Provider.findAll({ attributes: ['id'], where: { vehicleProfileId: profile.vehicleProfileId }, transaction });
      alternatives.push({ vehicleProfileId: profile.vehicleProfileId }, { providerId: { [Op.in]: linked.map(row => row.id) } });
    }
    return Ticket.count({ where: { status: { [Op.notIn]: TERMINAL_DISPATCH_STATUSES }, [Op.or]: alternatives }, transaction });
  }
  static async describe(profile, transaction, validated = false) {
    const { User, VehicleProfile } = sequelize.models;
    const owner = validated ? true : profile.owner || await User.findOne({ where: { userId: profile.userId }, transaction });
    const vehicle = validated ? true : profile.kind === 'SHOP' ? null : profile.vehicle || await VehicleProfile.findByPk(profile.vehicleProfileId, { transaction });
    const accountValid = validated || owner?.status === 'ACTIVE' && owner.emailVerifiedAt;
    const vehicleValid = profile.kind === 'SHOP' || validated || vehicle?.isActive && vehicle.userId === profile.userId && (profile.kind !== 'TOW' || vehicle.type === 'CAR');
    const jobs = profile.get?.('activeJobs') !== undefined ? Number(profile.get('activeJobs')) : await this.activeJobs(profile, transaction);
    const capacity = profile.kind === 'SHOP' ? profile.maxConcurrentJobs : 1;
    let reason = null;
    if (!accountValid || profile.status !== 'ACTIVE' || profile.suspended || !vehicleValid) reason = 'NOT_ACTIVE';
    else if (profile.requiresApproval && profile.reviewedRevision !== profile.profileRevision) reason = 'REVIEW_REQUIRED';
    else if (!Capabilities.valid(profile)) reason = 'CAPABILITIES_REQUIRED';
    else if (!profile.accepting) reason = 'OFF_DUTY';
    else if (profile.kind !== 'SHOP' && !usable(profile)) reason = 'GPS_UNAVAILABLE';
    else if (jobs >= capacity) reason = 'BUSY';
    return { onDuty: Boolean(profile.accepting), available: !reason, state: reason === 'BUSY' ? 'BUSY' : reason === 'OFF_DUTY' ? 'OFF_DUTY' : reason ? 'UNAVAILABLE' : 'AVAILABLE',
      reason, maxConcurrentJobs: capacity, activeJobs: jobs, freeSlots: Math.max(0, capacity - jobs) };
  }
  static afterDispatchChange(profile, transaction) {
    if (!transaction) throw new Error('Dispatch cache reconciliation requires the assignment transaction');
    transaction.afterCommit(async () => {
      const rows = profile.kind === 'SHOP' ? [profile] : await sequelize.models.Provider.findAll({ where: { vehicleProfileId: profile.vehicleProfileId } });
      for (const row of rows) await require('./location.service').syncProvider(row.id);
    });
  }
  // Must remain in the SAME transaction as the caller's ticket assignment. No public reservation endpoint.
  static async lockForAssignment(providerId, requirements, transaction) {
    if (!transaction) throw new Error('Dispatch assignment requires a caller-owned transaction');
    const { Provider, User, VehicleProfile } = sequelize.models;
    const snapshot = await Provider.findByPk(providerId, { transaction });
    if (!snapshot) throw new NotFoundException(errors.PROVIDER_NOT_FOUND);
    const owner = await User.findOne({ where: { userId: snapshot.userId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!owner) throw new NotFoundException(errors.PROVIDER_NOT_FOUND);
    if (snapshot.vehicleProfileId) await VehicleProfile.findByPk(snapshot.vehicleProfileId, { transaction, lock: transaction.LOCK.UPDATE });
    const profile = await Provider.findByPk(providerId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!profile) throw new NotFoundException(errors.PROVIDER_NOT_FOUND);
    const availability = await this.describe(profile, transaction);
    if (!availability.available) throw new ConflictException(availability.reason === 'BUSY' ? errors.PROVIDER_CAPACITY_EXHAUSTED : errors.PROVIDER_NOT_AVAILABLE, availability);
    if (!Capabilities.matches(profile, requirements)) throw new ConflictException(errors.PROVIDER_CAPABILITY_MISMATCH);
    this.afterDispatchChange(profile, transaction);
    return profile;
  }
}
module.exports = ProviderAvailabilityService;
