const { body, query, param } = require("express-validator");
const coordinates = (source) => [
  source("latitude").isFloat({ min: -90, max: 90 }).toFloat(),
  source("longitude").isFloat({ min: -180, max: 180 }).toFloat(),
];
const point = (p) =>
  p &&
  typeof p.latitude === "number" &&
  Number.isFinite(p.latitude) &&
  Math.abs(p.latitude) <= 90 &&
  typeof p.longitude === "number" &&
  Number.isFinite(p.longitude) &&
  Math.abs(p.longitude) <= 180;
const geometry = (g) =>
  g?.type === "LineString" &&
  Array.isArray(g.coordinates) &&
  g.coordinates.length >= 2 &&
  g.coordinates.length <= 20000 &&
  g.coordinates.every(
    (p) =>
      Array.isArray(p) &&
      p.length === 2 &&
      point({ longitude: p[0], latitude: p[1] }),
  );
const stops = [
  body("stops")
    .isArray({ min: 2, max: 25 })
    .custom((v) => v.every(point)),
];
const costing = body("costing")
  .optional()
  .isIn(["auto", "motorcycle", "motor_scooter", "bicycle", "pedestrian"]);
module.exports = {
  tiles: [
    param("theme").isIn(["light", "dark"]),
    param("z").isInt({ min: 0, max: 19 }).toInt(),
    ...["x", "y"].map((name) =>
      param(name)
        .isInt({ min: 0, max: 524287 })
        .toInt()
        .custom((value, { req }) => value < 2 ** Number(req.params.z)),
    ),
  ],
  aliases: (req, res, next) => {
    const queryCopy = { ...req.query };
    Object.defineProperty(req, "query", {
      value: queryCopy,
      configurable: true,
    });
    for (const data of [req.body, queryCopy]) {
      if (!data) continue;
      for (const [alias, key] of [
        ["lat", "latitude"],
        ["lng", "longitude"],
      ]) {
        if (data[alias] === undefined) continue;
        if (
          data[key] !== undefined &&
          Number(data[key]) !== Number(data[alias])
        )
          return next(
            new (require("../common/exceptions/BaseException").BadRequestException)(
              "Tọa độ không nhất quán",
            ),
          );
        data[key] = data[alias];
      }
    }
    next();
  },
  point,
  geometry,
  id: [param("id").isUUID()],
  imageId: [param("imageId").isUUID()],
  page: [
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    query("offset").optional().isInt({ min: 0, max: 100000 }).toInt(),
  ],
  nearby: coordinates(query),
  flag: [
    ...coordinates(body),
    body("category").optional().isIn(["FLOOD", "ACCIDENT", "OBSTRUCTION"]),
    body("description").optional().isString().trim().isLength({ max: 500 }),
    body("address").optional().isString().trim().isLength({ max: 255 }),
    body("radiusMeters")
      .optional()
      .isInt()
      .toInt()
      .isIn([25, 50, 100, 200, 250]),
    body("ttlMinutes")
      .optional()
      .isInt()
      .toInt()
      .isIn([60, 120, 240, 720, 1440]),
    body("images")
      .not()
      .exists()
      .withMessage("Ảnh phải gửi bằng multipart/form-data"),
  ],
  vote: [body("voteType").isIn(["CONFIRM", "DENY"])],
  message: [body("text").isString().trim().isLength({ min: 1, max: 1000 })],
  place: [
    ...coordinates(body),
    body("name").isString().trim().isLength({ min: 1, max: 120 }),
    body("address").optional().isString().trim().isLength({ max: 255 }),
    body("category").optional().isIn(["HOME", "WORK", "OTHER"]),
  ],
  route: [
    body("name").isString().trim().isLength({ min: 1, max: 120 }),
    ...stops,
    body("geometry").custom(geometry),
    costing,
  ],
  solve: [...stops, costing],
  detail: [query("refId").isString().trim().isLength({ min: 1, max: 2048 })],
  reverse: coordinates(query),
  search: [
    query("q")
      .isString()
      .trim()
      .isLength({ min: 2, max: 200 })
      .custom(
        (value, { req }) =>
          (req.query.latitude !== undefined) ===
          (req.query.longitude !== undefined),
      )
      .withMessage("Cần cả vĩ độ và kinh độ để ưu tiên vị trí"),
    query("latitude")
      .optional()
      .isFloat({ min: -85.05112878, max: 85.05112878 })
      .toFloat(),
    query("longitude").optional().isFloat({ min: -180, max: 180 }).toFloat(),
  ],
};
