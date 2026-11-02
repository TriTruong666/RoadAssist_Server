const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const Money = require("../src/utils/money.util");
const Policy = require("../src/services/dispatch_policy.service");
after(async () => {
  require("../src/config/redis.config").disconnect();
  require("../src/config/s3.config").destroy();
  await require("../src/config/postgres.config").close();
});
test("money calculations preserve cents, reject overprecision and enforce DECIMAL bounds", () => {
  assert.equal(Money.add("0.10", "0.20"), "0.30");
  assert.equal(Money.amount(Money.cents("9999999999.99")), "9999999999.99");
  assert.equal(Money.add("9999999999.98", "0.01"), "9999999999.99");
  for (const value of [
    "-1",
    "0.001",
    "1e3",
    NaN,
    Infinity,
    null,
    undefined,
    "10000000000",
  ])
    assert.throws(() => Money.cents(value));
  assert.throws(() => Money.add("9999999999.99", "0.01"));
});
test("waiting fee boundaries charge started minutes only after grace and remain frozen after transport starts", () => {
  const arrivedAt = new Date("2026-01-01T00:00:00Z");
  const t = {
    type: "TOW",
    arrivedAt,
    pricingSnapshot: { waitingPerMinute: "2000.00" },
  };
  const at = (ms) => Policy.waiting(t, new Date(+arrivedAt + ms));
  assert.equal(at(600000).waitingMinutes, 0);
  assert.equal(at(600001).waitingMinutes, 1);
  assert.equal(at(660000).waitingMinutes, 1);
  assert.equal(at(660001).waitingMinutes, 2);
  assert.equal(at(100000000).waitingMinutes, 60);
  assert.equal(at(100000000).waitingFee, "120000.00");
  t.waitingEndedAt = new Date(+arrivedAt + 660001);
  assert.equal(at(100000000).waitingMinutes, 2);
  assert.equal(Policy.waiting({ ...t, type: "SOS" }).waitingFee, "0.00");
});
test("GPS checks reject stale, future, inaccurate and distant fixes; all fifteen states are documented", () => {
  const point = { latitude: 10.77, longitude: 106.69 };
  const sample = {
    ...point,
    accuracy: 5,
    recordedAt: new Date().toISOString(),
  };
  assert.equal(Policy.location(sample, point), 0);
  for (const extra of [
    { accuracy: 101 },
    { accuracy: -1 },
    { latitude: NaN },
    { longitude: 181 },
    { recordedAt: new Date(Date.now() - 120001).toISOString() },
    { recordedAt: new Date(Date.now() + 31000).toISOString() },
  ])
    assert.throws(() => Policy.location({ ...sample, ...extra }, point));
  assert.throws(() => Policy.location({ ...sample, latitude: 11 }, point));
  assert.equal(
    Object.keys(require("../src/common/dispatch.constants").STATUS).length,
    15,
  );
  const swagger = require("../src/swagger");
  assert.ok(swagger.paths["/api/v1/dispatch/{id}/start"]);
  assert.ok(swagger.components.schemas.DispatchTicket);
});
