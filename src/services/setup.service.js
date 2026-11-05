const { Provider, VehicleProfile } = require("../models");
module.exports = {
  async describe(user, transaction) {
    if (user.role === "admin")
      return { required: false, requestedProviderKinds: [], providerKinds: [] };
    const requestedProviderKinds = (user.requestedServices || []).filter(
      (kind) => ["SHOP", "MOBILE_SHOP", "TOW"].includes(kind),
    );
    const [profiles, activeVehicle] = await Promise.all([
      Provider.findAll({
        where: {
          userId: user.userId,
        },
        attributes: ["kind", "status"],
        transaction,
      }),
      user.activeVehicleId
        ? VehicleProfile.findOne({
            where: {
              id: user.activeVehicleId,
              userId: user.userId,
              isActive: true,
            },
            transaction,
          })
        : null,
    ]);
    const providerKinds = profiles
      .filter((profile) => !["DENIED", "REVOKED"].includes(profile.status))
      .map((profile) => profile.kind);
    return {
      required: !user.onboarded,
      requestedProviderKinds,
      providerKinds,
      hasActiveVehicle: Boolean(activeVehicle),
      activeVehicleId: activeVehicle?.id || null,
    };
  },
};
