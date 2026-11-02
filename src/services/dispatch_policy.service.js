const { Op } = require("sequelize");
const db = require("../config/postgres.config");
const {
  User,
  VehicleProfile,
  VehicleRideConfig,
  Provider,
  DispatchTicket: Ticket,
} = require("../models");
const {
  BaseException,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} = require("../common/exceptions/BaseException");
const errors = require("../common/exceptions/error_codes");
const { TERMINAL, KIND } = require("../common/dispatch.constants");
const { distanceMeters } = require("../utils/geo.util");
const Money = require("../utils/money.util");
const fail = (code, message, status = 409, details = null) => {
  throw new BaseException({ code, message, statusCode: status }, details);
};
class Policy {
  static fail = fail;
  static async locks(actor, snapshot, data, transaction) {
    const providerIds = [
      snapshot?.providerId,
      snapshot?.targetProviderId,
      snapshot?.dropoffShopId,
      data.providerId,
      data.dropoffShopId,
      data.directProviderId,
      snapshot?.towOffer?.directProviderId,
    ].filter(Boolean);
    const profiles = await Provider.findAll({
      where: { id: { [Op.in]: [...new Set(providerIds)] } },
      transaction,
    });
    const users = [
      ...new Set(
        [
          actor.userId,
          snapshot?.userId,
          ...profiles.map((p) => p.userId),
        ].filter(Boolean),
      ),
    ].sort();
    for (const userId of users) {
      const user = await User.findOne({
        where: { userId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (
        !actor.system &&
        userId === actor.userId &&
        (!user || user.status !== "ACTIVE" || !user.emailVerifiedAt)
      )
        throw new ForbiddenException(errors.AUTH_ACCOUNT_INACTIVE);
    }
    const owner = await User.findOne({
      where: { userId: snapshot?.userId || actor.userId },
      transaction,
    });
    const vehicleIds = [
      ...new Set(
        [
          snapshot?.vehicleProfileId,
          data.vehicleProfileId || (!snapshot && owner?.activeVehicleId),
          ...profiles.map((p) => p.vehicleProfileId),
        ].filter(Boolean),
      ),
    ].sort();
    for (const id of vehicleIds)
      await VehicleProfile.findByPk(id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
    for (const id of [...new Set(providerIds)].sort())
      await Provider.findByPk(id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
    return { owner, profiles };
  }
  static async vehicle(userId, id, transaction) {
    const owner = await User.findOne({ where: { userId }, transaction });
    const vehicle = await VehicleProfile.findOne({
      where: { id: id || owner?.activeVehicleId, userId, isActive: true },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!vehicle) throw new BadRequestException(errors.VEHICLE_ACTIVE_REQUIRED);
    const ride = await VehicleRideConfig.findOne({
      where: { vehicleProfileId: vehicle.id },
      transaction,
    });
    return {
      vehicle,
      snapshot: {
        id: vehicle.id,
        type: vehicle.type,
        plateNumber: vehicle.plateNumber,
        brand: vehicle.brand,
        modelName: vehicle.modelName,
        width: Math.max(vehicle.baseWidth, ride?.width || 0),
        height: Math.max(vehicle.baseHeight, ride?.height || 0),
        length: vehicle.length,
        weightKg: vehicle.weightKg,
        rideMode: ride?.mode || "SOLO",
      },
    };
  }
  static requirements(type, snapshot, capabilities) {
    if (type === "TOW" && (!snapshot.length || !snapshot.weightKg))
      fail(
        "DISPATCH_VEHICLE_SPEC_REQUIRED",
        "Cần khai báo chiều dài và khối lượng trên hồ sơ xe trước khi gọi kéo xe",
        400,
      );
    return {
      vehicleType: snapshot.type,
      requiredCapabilities: type === "TOW" ? ["TOWING"] : capabilities || [],
      ...(type === "TOW" && { repairCapabilities: capabilities || [] }),
      ...(type === "TOW" && {
        vehicleWidth: snapshot.width,
        vehicleHeight: snapshot.height,
        vehicleLength: snapshot.length,
        vehicleWeightKg: snapshot.weightKg,
      }),
    };
  }
  static async busy(vehicleId, transaction, exclude) {
    const linked = await Provider.findAll({
      where: { vehicleProfileId: vehicleId },
      attributes: ["id"],
      transaction,
    });
    const row = await Ticket.findOne({
      where: {
        ...(exclude && { id: { [Op.ne]: exclude } }),
        status: { [Op.notIn]: TERMINAL },
        [Op.or]: [
          { vehicleProfileId: vehicleId },
          ...(linked.length
            ? [{ providerId: { [Op.in]: linked.map((p) => p.id) } }]
            : []),
        ],
      },
      transaction,
    });
    if (row)
      throw new ConflictException(errors.VEHICLE_BUSY, {
        dispatchTicketId: row.id,
      });
  }
  static location(location, target, radius = 200) {
    if (
      !location ||
      ![location.latitude, location.longitude, location.accuracy].every(
        Number.isFinite,
      ) ||
      Math.abs(location.latitude) > 90 ||
      Math.abs(location.longitude) > 180 ||
      location.accuracy < 0 ||
      location.accuracy > 100 ||
      !Number.isFinite(Date.parse(location.recordedAt)) ||
      Date.parse(location.recordedAt) < Date.now() - 120000 ||
      Date.parse(location.recordedAt) > Date.now() + 30000
    )
      fail(
        "DISPATCH_GPS_INVALID",
        "Cần tọa độ mới trong 2 phút, có độ chính xác tối đa 100m",
        400,
      );
    const distance = distanceMeters(location, target);
    if (distance + location.accuracy > radius)
      fail("DISPATCH_LOCATION_OUT_OF_RANGE", "Chưa đủ gần điểm xác nhận", 409, {
        distanceMeters: Math.round(distance),
        accuracy: location.accuracy,
        radiusMeters: radius,
      });
    return distance;
  }
  static trustedLocation(profile, target) {
    if (
      !profile ||
      profile.locationQuality !== "GOOD" ||
      !profile.lastTrustedLocationAt ||
      new Date(profile.lastTrustedLocationAt) < new Date(Date.now() - 120000) ||
      !profile.lastTrustedRecordedAt ||
      new Date(profile.lastTrustedRecordedAt) < new Date(Date.now() - 120000)
    )
      fail(
        "DISPATCH_GPS_STALE",
        "Đối tác phải cập nhật GPS đáng tin cậy trong 2 phút gần nhất",
      );
    return this.location(
      {
        latitude: profile.latitude,
        longitude: profile.longitude,
        accuracy: profile.lastAccuracy ?? 100,
        recordedAt: profile.lastTrustedRecordedAt,
      },
      target,
    );
  }
  static freshFix(profile) {
    if (
      !profile ||
      profile.locationQuality !== "GOOD" ||
      !profile.lastTrustedLocationAt ||
      new Date(profile.lastTrustedLocationAt) < new Date(Date.now() - 120000)
    )
      fail("DISPATCH_GPS_STALE", "Cần cập nhật GPS trước khi nhận cuốc");
    const sample = {
      latitude: profile.latitude,
      longitude: profile.longitude,
      accuracy: profile.lastAccuracy ?? 100,
      recordedAt: profile.lastTrustedRecordedAt,
    };
    this.location(sample, sample);
    return sample;
  }
  static pricing() {
    const result = { ...require("../config/app.config").dispatch };
    for (const [key, value] of Object.entries(result)) {
      if (Money.cents(value) % 100)
        throw new Error("Dispatch tariffs must use whole VND");
      result[key] = Money.amount(Money.cents(value));
    }
    return result;
  }
  static waiting(ticket, now = new Date()) {
    if (ticket.type !== "TOW" || !ticket.arrivedAt)
      return { waitingMinutes: 0, waitingFee: "0.00" };
    const end = ticket.waitingEndedAt ? new Date(ticket.waitingEndedAt) : now;
    const minutes = Math.max(
      0,
      Math.min(
        60,
        Math.ceil((end - new Date(ticket.arrivedAt) - 600000) / 60000),
      ),
    );
    return {
      waitingMinutes: minutes,
      waitingFee: Money.amount(
        minutes * Money.cents(ticket.pricingSnapshot.waitingPerMinute),
      ),
    };
  }
  static total(ticket) {
    if (ticket.chargesVoided) return "0.00";
    return Money.add(
      ticket.callOutFee || 0,
      ticket.travelFee || 0,
      ticket.quoteVoided ? 0 : ticket.quoteAmount || 0,
      ticket.waitingFee || 0,
    );
  }
  static async profileActor(
    actor,
    ticket,
    transaction,
    { destination = false, target = false } = {},
  ) {
    const id = destination
      ? ticket.dropoffShopId
      : ticket.providerId || (target ? ticket.targetProviderId : null);
    const profile = id ? await Provider.findByPk(id, { transaction }) : null;
    if (!profile || profile.userId !== actor.userId)
      throw new NotFoundException(errors.DISPATCH_TICKET_NOT_FOUND);
    return profile;
  }
  static state(ticket, allowed) {
    if (!allowed.includes(ticket.status))
      throw new ConflictException(errors.DISPATCH_INVALID_STATE_TRANSITION, {
        status: ticket.status,
        allowed,
      });
  }
  static rider(actor, ticket) {
    if (ticket.userId !== actor.userId)
      throw new NotFoundException(errors.DISPATCH_TICKET_NOT_FOUND);
  }
  static providerKind(profile, type) {
    if (profile.kind !== KIND[type])
      fail(
        "DISPATCH_PROVIDER_KIND_MISMATCH",
        "Loại đối tác không phù hợp với yêu cầu",
      );
  }
}
module.exports = Policy;
