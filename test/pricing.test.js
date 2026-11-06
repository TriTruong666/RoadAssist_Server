const { test } = require('node:test');
const assert = require('node:assert/strict');
const Pricing = require('../src/services/pricing.service');
const Capabilities = require('../src/services/provider_capability.service');
const ticket = (type, km) => ({ vehicleSnapshot:{type}, pricingSnapshot:{towBaseFee:'150000',towPerKm:'10000'}, pickupLatitude:0,pickupLongitude:0,dropoffLatitude:0,dropoffLongitude:km/111.19492664455873 });
test('bike included distance, night card and provider bounds', () => {
  const day = new Date('2026-11-06T05:00:00Z');
  const night = new Date('2026-11-06T16:00:00Z');
  assert.equal(Pricing.tow(ticket('BIKE',8),{},day).estimate,200000);
  const car = Pricing.tow(ticket('CAR',12),{},night);
  assert.equal(car.estimate,825000);
  assert.equal(car.ceiling,908000);
  assert.equal(Pricing.tow(ticket('CAR',12),{towBaseFee:200000,towPerKmFee:10000},day).estimate,220000);
  assert.throws(()=>Capabilities.validate({kind:'TOW',maxConcurrentJobs:1,towBaseFee:99000}));
  assert.throws(()=>Capabilities.validate({kind:'SHOP',maxConcurrentJobs:1,callOutFee:50000}));
});
test('item totals must match, prices must be whole VND and quantities positive',()=>{
  assert.equal(Pricing.quote([{name:'Lốp',qty:2,unitPrice:75000}],150000)[0].amount,'150000.00');
  assert.throws(()=>Pricing.quote([{name:'Lốp',qty:2,unitPrice:75000}],100000));
  assert.throws(()=>Pricing.quote([{name:'Lốp',qty:0,unitPrice:75000}],0));
  assert.throws(()=>Pricing.quote([{name:'Lốp',qty:1,unitPrice:'10.50'}], '10.50'));
});
