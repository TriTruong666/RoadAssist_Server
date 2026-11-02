const { body, param, query } = require("express-validator");
const Money = require("../utils/money.util");
const { REPAIR_CAPABILITIES } = require("../common/provider.constants");
const coordinate = (name, min, max, required = false) =>
  (required ? body(name) : body(name).optional())
    .isFloat({ min, max })
    .toFloat();
const location = [
  body("location").isObject({ strict: true }),
  coordinate("location.latitude", -90, 90, true),
  coordinate("location.longitude", -180, 180, true),
  body("location.accuracy").isFloat({ min: 0, max: 100 }).toFloat(),
  body("location.recordedAt").isISO8601({ strict: true }),
];
const destination = [
  body("dropoffShopId").optional().isUUID(),
  coordinate("dropoffLatitude", -90, 90),
  coordinate("dropoffLongitude", -180, 180),
  body("dropoffAddress").optional().isString().trim().isLength({ max: 255 }),
  body("dropoffShopId")
    .custom(
      (value, { req }) =>
        !!value ||
        (Number.isFinite(Number(req.body.dropoffLatitude)) &&
          req.body.dropoffLatitude !== undefined &&
          Number.isFinite(Number(req.body.dropoffLongitude)) &&
          req.body.dropoffLongitude !== undefined),
    )
    .withMessage("Cần tiệm đích hoặc tọa độ giao xe"),
];
const assetIds = (min = 0) => [
  body("assetIds")
    .optional(min === 0 ? {} : { values: "undefined" })
    .isArray({ min, max: 5 })
    .custom((ids) => new Set(ids).size === ids.length),
  body("assetIds.*").isUUID(),
];
const base = [
  body("vehicleProfileId").optional().isUUID(),
  body("clientRequestId").optional().isUUID(),
  body("description").optional().isString().trim().isLength({ max: 2000 }),
  ...assetIds(),
  body("requiredCapabilities")
    .optional()
    .isArray({ max: 6 })
    .custom((v) => new Set(v).size === v.length),
  body("requiredCapabilities.*").isIn(REPAIR_CAPABILITIES),
  body("images").not().exists().withMessage("Dùng assetIds upload từ /uploads"),
];
const pickup = [
  coordinate("pickupLatitude", -90, 90, true),
  coordinate("pickupLongitude", -180, 180, true),
  body("pickupAddress").optional().isString().trim().isLength({ max: 255 }),
];
const revision = [
  body("expectedRevision").optional().isInt({ min: 1 }).toInt(),
];
module.exports = {
  id: [param("id").isUUID()],
  revision,
  location,
  destination,
  walkIn: [...base, body("providerId").isUUID(), ...location],
  sos: [...base, ...pickup],
  tow: [...base, ...pickup, ...destination],
  accept: [body("providerId").isUUID(), ...revision],
  quote: [
    body("amount").custom((value) => {
      if (Money.cents(value) % 100)
        throw new Error("VND phải là số tiền nguyên đồng");
      return true;
    }),
    ...revision,
  ],
  reason: [
    body("reason").isString().trim().isLength({ min: 3, max: 100 }),
    ...revision,
  ],
  unfixable: [
    body("reason").isIn(["NO_PARTS", "BEYOND_REPAIR", "SAFETY", "OTHER"]),
    body("assetIds")
      .isArray({ min: 1, max: 5 })
      .custom((v) => new Set(v).size === v.length),
    body("assetIds.*").isUUID(),
    ...revision,
  ],
  offer: [
    body("mode").isIn(["DIRECT", "NETWORK"]),
    body("directProviderId").if(body("mode").equals("DIRECT")).isUUID(),
    ...revision,
  ],
  estimateVersion: [
    body("estimateVersion").isInt({ min: 1 }).toInt(),
    ...revision,
  ],
  page: [
    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
    query("offset").optional().isInt({ min: 0, max: 100000 }).toInt(),
  ],
  mine: [query("active").optional().isIn(["true", "false"]).toBoolean()],
  feed: [query("providerId").isUUID()],
  handoff: [
    body("providerId")
      .not()
      .exists()
      .withMessage("Chỉ server chọn xe kéo trực tiếp"),
    ...revision,
  ],
};
