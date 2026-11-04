const axios = require("axios");
const config = require("../config/app.config");
const { BaseException } = require("../common/exceptions/BaseException");
const cache = new Map();
const pending = new Map();
const LIMIT = 16 * 1024 * 1024;
let size = 0;
const unavailable = () =>
  new BaseException({
    code: "MAP_SERVICE_UNAVAILABLE",
    message: "Không tải được lớp nền bản đồ",
    statusCode: 503,
  });
function remove(key) {
  const old = cache.get(key);
  if (old) size -= old.body.length;
  cache.delete(key);
}
module.exports = {
  async tile({ theme, z, x, y }) {
    if (!config.maps.maptilerApiKey) throw unavailable();
    const key = `${theme}/${z}/${x}/${y}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    remove(key);
    if (pending.has(key)) return pending.get(key);
    const request = (async () => {
      try {
        const style = theme === "dark" ? "streets-v4-dark" : "streets-v4";
        const response = await axios.get(
          `https://api.maptiler.com/maps/${style}/256/${z}/${x}/${y}.png`,
          {
            params: { key: config.maps.maptilerApiKey },
            headers: config.maps.maptilerRequestOrigin
              ? { Origin: config.maps.maptilerRequestOrigin }
              : undefined,
            responseType: "arraybuffer",
            timeout: 8000,
            maxContentLength: 1024 * 1024,
          },
        );
        const body = Buffer.from(response.data);
        if (
          !String(response.headers["content-type"]).startsWith("image/png") ||
          body.length > 1024 * 1024 ||
          !body.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
        )
          throw unavailable();
        const policy = String(response.headers["cache-control"] || "");
        const maxAge = /no-store|no-cache/.test(policy)
          ? 0
          : Math.min(Number(policy.match(/max-age=(\d+)/)?.[1] || 60), 3600);
        const value = { body, maxAge, expiresAt: Date.now() + maxAge * 1000 };
        if (maxAge > 0) {
          while (cache.size >= 256 || size + body.length > LIMIT)
            remove(cache.keys().next().value);
          cache.set(key, value);
          size += body.length;
        }
        return value;
      } catch {
        throw unavailable();
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, request);
    return request;
  },
};
