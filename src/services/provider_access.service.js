const sequelize = require('../config/postgres.config');
const { PROVIDER_KINDS } = require('../common/auth.constants');
class ProviderAccessService {
  // The operational permission source is approved, non-suspended provider profiles, never user input.
  static async permissions(user, transaction) {
    const services = ['RIDER'];
    const Provider = sequelize.models.Provider;
    if (Provider) {
      const profiles = await Provider.findAll({ where: { userId: user.userId, status: 'ACTIVE', suspended: false }, transaction });
      for (const profile of profiles) {
        if (!PROVIDER_KINDS.includes(profile.kind)) continue;
        if (profile.requiresApproval && profile.reviewedRevision !== profile.profileRevision) continue;
        if (profile.kind !== 'SHOP') {
          const vehicle = await sequelize.models.VehicleProfile.findOne({ where: { id: profile.vehicleProfileId, userId: user.userId, isActive: true }, transaction });
          if (!vehicle || (profile.kind === 'TOW' && vehicle.type !== 'CAR')) continue;
        }
        if (!services.includes(profile.kind)) services.push(profile.kind);
      }
    }
    return { services, role: user.role === 'admin' ? 'admin' : services.length > 1 ? 'provider' : 'guest' };
  }
  static async synchronize(user, transaction) {
    const permissions = await this.permissions(user, transaction);
    const sameServices = permissions.services.length === user.services.length && permissions.services.every(service => user.services.includes(service));
    // JWT verification recalculates provider permissions from live profiles on every
    // request. A derived guest/provider transition need not revoke valid sessions.
    // Explicit role/password/account changes still increment sessionVersion.
    if (!sameServices || user.role !== permissions.role) await user.update(permissions, { transaction, providerPermissionSync: true });
    return permissions;
  }
}
module.exports = ProviderAccessService;
