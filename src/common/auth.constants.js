module.exports = {
  ROLES: ['admin', 'guest', 'provider'],
  SERVICES: ['RIDER', 'SHOP', 'MOBILE_SHOP', 'TOW'],
  PROVIDER_KINDS: ['SHOP', 'MOBILE_SHOP', 'TOW'],
  VEHICLE_TYPES: ['BIKE', 'CAR'],
  RIDE_MODES: ['SOLO', 'PASSENGER', 'CARGO'],
  VEHICLE_DEFAULTS: { BIKE: { baseWidth: 0.7, baseHeight: 1.1 }, CAR: { baseWidth: 1.9, baseHeight: 1.5 } },
};
