const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
if (process.env.RUN_DB_TESTS !== '1') {
  test('Demo dataset reset integration (RUN_DB_TESTS=1)', { skip: true }, () => {});
} else {
  const suffix = randomUUID().replaceAll('-', '');
  Object.assign(process.env, {
    NODE_ENV: 'test', DB_SCHEMA: `demo_seed_test_${suffix}`, SEED_DEMO_DATA: 'true',
    PAYMENT_GATEWAY_MODE: 'mock', DB_FORCE_RESET: 'true', DB_RESET: 'false',
    JWT_SECRET: randomUUID() + randomUUID(), AUTH_REDIS_PREFIX: `demo-test:${suffix}:auth:`,
    PROVIDER_REDIS_PREFIX: `demo-test:${suffix}:providers:`,
  });
  const db = require('../src/config/postgres.config');
  const redis = require('../src/config/redis.config');
  const config = require('../src/config/app.config');
  const { User, Provider, DispatchTicket, Bill, BillPayment, Rating, SavedPlace, HazardFlag, PlatformSetting } = require('../src/models');
  const { seedOnStartup, SEED_MARKER } = require('../src/seeds/demo.seed');
  test('force reset restores demo roles/data each time; ordinary startup preserves user changes and calls no external services', async t => {
    const axios = require('axios');
    t.mock.method(axios, 'get', async () => { throw new Error('Demo seed must not call external GET APIs'); });
    t.mock.method(axios, 'post', async () => { throw new Error('Demo seed must not call external POST APIs'); });
    t.mock.method(require('../src/services/s3.service'), 'uploadToS3', async () => { throw new Error('Demo seed must not upload to external storage'); });
    t.mock.method(require('../src/config/mail.config'), 'sendMail', async () => { throw new Error('Demo seed must not send mail'); });
    try {
      await db.authenticate(); await db.createSchema(process.env.DB_SCHEMA); await redis.connect();
      for (let round = 0; round < 2; round++) {
        await db.sync({ force: true });
        await require('../src/config/database.migrations').runStartupDatabaseMigrations(db);
        await require('../src/services/platform_settings.service').load();
        assert.equal(await PlatformSetting.findByPk(SEED_MARKER), null);
        assert.deepEqual(await seedOnStartup(), { seeded: true });
        assert.equal(await User.count(), 5);
        assert.equal(await Provider.count(), 3);
        assert.equal(await DispatchTicket.count(), 7);
        assert.equal(await DispatchTicket.count({ where: { status: '4' } }), 4);
        assert.equal(await Bill.count(), 7);
        assert.equal(await BillPayment.count(), 4);
        assert.equal(await Rating.count(), 4);
        assert.equal(await HazardFlag.count(), 3);
        assert.equal(await SavedPlace.count(), 10);
        const rider = await User.findOne({ where: { email: 'rider@demo.roadassist.test' } });
        assert.equal(await rider.comparePassword('RoadAssistDemo@123'), true);
        const tow = await Provider.findOne({ where: { kind: 'TOW' } }); assert.equal(tow.status, 'PENDING');
        const shop = await User.findOne({ where: { email: 'shop@demo.roadassist.test' } });
        await shop.update({ name: 'Edited demo account' });
        assert.deepEqual(await seedOnStartup(), { seeded: false, reason: 'already-seeded' });
        assert.equal((await shop.reload()).name, 'Edited demo account');
        assert.equal(await DispatchTicket.count(), 7);
      }
      assert.equal(axios.get.mock.calls.length, 0); assert.equal(axios.post.mock.calls.length, 0);
      config.app.isProduction = true;
      assert.deepEqual(await seedOnStartup(), { seeded: false, reason: 'disabled' });
      config.app.isProduction = false;
      config.seeds.demo = false;
      assert.deepEqual(await seedOnStartup(), { seeded: false, reason: 'disabled' });
    } finally {
      await db.dropSchema(process.env.DB_SCHEMA, { cascade: true }).catch(() => {});
      let cursor = '0';
      do { const result = await redis.scan(cursor, 'MATCH', `demo-test:${suffix}:*`, 'COUNT', 1000); cursor = result[0]; if (result[1].length) await redis.del(...result[1]); } while (cursor !== '0');
      redis.disconnect(); await db.close();
    }
  });
}
