const { body, param } = require("express-validator");
const { VEHICLE_TYPES, RIDE_MODES } = require("../common/auth.constants");
const dimensions = (field, min, max) =>
  body(field).optional().isFloat({ min, max }).bail().customSanitizer(Number);
function fields(update = false) {
  const required = (rule) => (update ? rule.optional() : rule);
  return [
    required(body("type")).isIn(VEHICLE_TYPES),
    required(body("plateNumber"))
      .isString()
      .bail()
      .customSanitizer((value) => value.toUpperCase().replace(/\s/g, ""))
      .isLength({ min: 1, max: 20 })
      .matches(/^[A-Z0-9.-]+$/),
    required(body("brand"))
      .isString()
      .bail()
      .trim()
      .isLength({ min: 1, max: 50 }),
    required(body("modelName"))
      .isString()
      .bail()
      .trim()
      .isLength({ min: 1, max: 50 }),
    body("color")
      .optional({ nullable: true })
      .isString()
      .bail()
      .trim()
      .isLength({ max: 30 }),
    dimensions("length", 0.5, 20),
    dimensions("weightKg", 20, 50000),
    dimensions("baseWidth", 0.3, 3),
    dimensions("baseHeight", 0.5, 3),
    ...(update
      ? [
          body("isActive").optional().isBoolean({ strict: true }),
          body("rideConfig").optional().isObject({ strict: true }),
          body("rideConfig.mode").optional().isIn(RIDE_MODES),
          body("rideConfig.width")
            .optional()
            .isFloat({ gt: 0 })
            .bail()
            .custom((value) => Number.isFinite(Number(value)))
            .bail()
            .customSanitizer(Number),
          body("rideConfig.height")
            .optional()
            .isFloat({ gt: 0 })
            .bail()
            .custom((value) => Number.isFinite(Number(value)))
            .bail()
            .customSanitizer(Number),
        ]
      : []),
  ];
}
module.exports = {
  // Accept the public width/height aliases while keeping model fields explicit.
  normalize(req, res, next) {
    if (req.body && typeof req.body === "object") {
      if (req.body.baseWidth === undefined && req.body.width !== undefined)
        req.body.baseWidth = req.body.width;
      if (req.body.baseHeight === undefined && req.body.height !== undefined)
        req.body.baseHeight = req.body.height;
    }
    next();
  },
  create: fields(),
  update: fields(true),
  id: [param("id").isUUID(4)],
};
