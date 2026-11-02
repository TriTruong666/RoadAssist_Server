const cron = require('node-cron');
const LocationService = require('../services/location.service');
const expireFlags = require('./cron/flag_ttl.job');
let locationTask, flagTask, storageTask;
async function initCronJobs() {
  await LocationService.reconcile();
  const storageMaintenance = async () => {
   try { await require('../services/s3.service').retryCleanup(); await require('../services/storage_migration.service')(); await require('../config/chat.migrations').migrateHazardChat(); }
   catch (error) { console.error('[Storage/chat maintenance]', error.message); }
  };
  if (!storageTask) storageTask = cron.schedule('*/5 * * * *', storageMaintenance, { noOverlap: true });
  await expireFlags();
  if (!flagTask) flagTask = cron.schedule('*/5 * * * *', expireFlags, { noOverlap: true });
  if (!locationTask) locationTask = cron.schedule('* * * * *', () => LocationService.reconcile(), { noOverlap: true });
}
async function stopCronJobs() {
  if (storageTask) { await storageTask.destroy(); storageTask = null; }
  if (flagTask) { await flagTask.destroy(); flagTask = null; }
  if (locationTask) { await locationTask.destroy(); locationTask = null; }
}
module.exports = { initCronJobs, stopCronJobs };
