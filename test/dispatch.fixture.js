// Existing policy/chat suites now use the production ticket schema.
const { randomUUID } = require("node:crypto");
const Ticket = require("../src/models").DispatchTicket;
Ticket.addHook("beforeValidate", "legacy-test-defaults", (ticket) => {
  ticket.code ||= `RA-TEST-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  ticket.journeyId ||= randomUUID();
  ticket.userId ||= randomUUID();
  ticket.vehicleProfileId ||= randomUUID();
  ticket.type ||= "SOS";
  ticket.pickupLatitude ??= 10.77;
  ticket.pickupLongitude ??= 106.69;
  ticket.vehicleSnapshot ||= {
    type: "BIKE",
    width: 0.7,
    height: 1.1,
    length: 2,
    weightKg: 150,
  };
  ticket.pricingSnapshot ||= {
    sosCallOutFee: "30000.00",
    sosPerKm: "5000.00",
    towBaseFee: "150000.00",
    towPerKm: "10000.00",
    waitingPerMinute: "2000.00",
  };
  ticket.requirements ||= { vehicleType: "BIKE", requiredCapabilities: [] };
});
module.exports = Ticket;
