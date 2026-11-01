const { Op } = require("sequelize");
const sequelize = require("../config/postgres.config");
const redis = require("../config/redis.config");
const config = require("../config/app.config").providers;
const UPDATE = `
local previous = tonumber(redis.call('HGET', KEYS[2], 'version') or '-1')
if previous > tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[2], 'version', ARGV[2], 'kind', ARGV[3], 'accepting', ARGV[4], 'updatedAt', ARGV[7])
redis.call('EXPIRE', KEYS[2], ARGV[8])
if ARGV[4] == 'true' then
 redis.call('GEOADD', KEYS[1], ARGV[5], ARGV[6], ARGV[1])
 redis.call('ZADD', KEYS[3], ARGV[7], ARGV[1])
else
 redis.call('ZREM', KEYS[1], ARGV[1])
 redis.call('ZREM', KEYS[3], ARGV[1])
end
return 1
`;
class LocationService {
  static geoKey = `${config.redisPrefix}geo:providers:active`;
  static freshnessKey = `${config.redisPrefix}geo:providers:heartbeat`;
  static metadataKey(id) {
    return `${config.redisPrefix}provider:duty:${id}`;
  }
  static fresh(provider) { return require('../utils/gps_quality.util').usable(provider); }
  static async syncProvider(id) {
    try {
      const { Provider, User, VehicleProfile } = sequelize.models;
      const provider = await Provider.findByPk(id, {
        include: [
          {
            model: User,
            as: "owner",
            attributes: ["userId", "status", "emailVerifiedAt"],
          },
          {
            model: VehicleProfile,
            as: "vehicle",
            attributes: ["id", "userId", "type", "isActive"],
          },
        ],
      });
      if (!provider) {
        await redis
          .multi()
          .zrem(this.geoKey, id)
          .zrem(this.freshnessKey, id)
          .del(this.metadataKey(id))
          .exec();
        return true;
      }
      const vehicle = provider.vehicle;
      const availability = await require('./provider_availability.service').describe(provider);
      const eligible = availability.available && provider.kind !== "SHOP" &&
        provider.status === "ACTIVE" &&
        !provider.suspended &&
        provider.accepting &&
        provider.owner?.status === "ACTIVE" &&
        provider.owner.emailVerifiedAt &&
        vehicle?.isActive &&
        vehicle.userId === provider.userId &&
        (provider.kind !== "TOW" || vehicle.type === "CAR") &&
        this.fresh(provider);
      const timestamp = provider.lastHeartbeatAt
        ? new Date(provider.lastHeartbeatAt).getTime()
        : Date.now();
      const ttl = eligible
        ? Math.max(
            1,
            Math.ceil(
              config.locationTtlSeconds - (Date.now() - timestamp) / 1000,
            ),
          )
        : config.locationTtlSeconds;
      await redis.eval(
        UPDATE,
        3,
        this.geoKey,
        this.metadataKey(id),
        this.freshnessKey,
        id,
        provider.geoVersion,
        provider.kind,
        eligible ? "true" : "false",
        provider.longitude,
        provider.latitude,
        timestamp,
        ttl,
      );
      return true;
    } catch (error) {
      console.error(
        "[PROVIDER GEO]: Cache sync failed; PostgreSQL remains authoritative:",
        error.message,
      );
      return false;
    }
  }
  static async prune() {
    return redis.eval(
      `
      local stale = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
      for _,id in ipairs(stale) do
        redis.call('ZREM', KEYS[1], id)
        redis.call('ZREM', KEYS[2], id)
        redis.call('DEL', ARGV[2] .. id)
      end
      return #stale
    `,
      2,
      this.geoKey,
      this.freshnessKey,
      Date.now() - config.locationTtlSeconds * 1000,
      `${config.redisPrefix}provider:duty:`,
    );
  }
  static async nearby({ latitude, longitude, radiusKm }) {
    try {
      await this.prune();
      const ids = await redis.call(
        "GEOSEARCH",
        this.geoKey,
        "FROMLONLAT",
        longitude,
        latitude,
        "BYRADIUS",
        radiusKm,
        "km",
        "ASC",
        "COUNT",
        500,
      );
      if (!ids.length) return [];
      const metadata = await redis
        .pipeline(ids.map((id) => ["hgetall", this.metadataKey(id)]))
        .exec();
      return ids.filter((id, index) => {
        const [error, item] = metadata[index];
        return (
          !error &&
          item?.accepting === "true" &&
          Date.now() - Number(item.updatedAt) < config.locationTtlSeconds * 1000
        );
      });
    } catch (error) {
      console.error(
        "[PROVIDER GEO]: Search uses PostgreSQL fallback:",
        error.message,
      );
      return [];
    }
  }
  static async reconcile() {
    try {
      await this.prune();
      const Provider = sequelize.models.Provider;
      if (!Provider) return;
      const profiles = await Provider.findAll({
        attributes: ["id"],
        where: {
          kind: { [Op.in]: ["MOBILE_SHOP", "TOW"] },
          accepting: true,
          lastHeartbeatAt: {
            [Op.gte]: new Date(Date.now() - config.locationTtlSeconds * 1000),
          },
        },
      });
      for (const profile of profiles) await this.syncProvider(profile.id);
    } catch (error) {
      console.error("[PROVIDER GEO]: Reconciliation failed:", error.message);
    }
  }
}
module.exports = LocationService;
