const cron = require('node-cron');
const LocationService = require('../services/location.service');
const expireFlags = require('./cron/flag_ttl.job');
let locationTask, flagTask, storageTask, dispatchTask, financeTask;
async function initCronJobs() {
  await LocationService.reconcile();
  const financeWork = async () => {
   try { await require('../services/sepay.service').processInbox(); await require('../services/finance_maintenance.service')(); await require('../services/finance_notification.service').deliver(); }
   catch (error) { console.error('[Finance maintenance]', error.errorCode || error.name); }
  };
  await financeWork();
  if (!financeTask) financeTask = cron.schedule('*/10 * * * * *', financeWork, { noOverlap: true });
  if (!dispatchTask) dispatchTask = cron.schedule('* * * * *', async () => {
   try { await require('../services/dispatch.service').expireEstimates(); await require('../services/dispatch_notification.service').deliver(); }
   catch (error) { console.error('[Dispatch maintenance]', error.message); }
  }, { noOverlap: true });
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
  if (financeTask) { await financeTask.destroy(); financeTask = null; }
  require('../services/finance_notification.service').setIO(null);
  if (dispatchTask) { await dispatchTask.destroy(); dispatchTask = null; }
  require('../services/dispatch_notification.service').setIO(null);
  if (storageTask) { await storageTask.destroy(); storageTask = null; }
  if (flagTask) { await flagTask.destroy(); flagTask = null; }
  if (locationTask) { await locationTask.destroy(); locationTask = null; }
}
module.exports = { initCronJobs, stopCronJobs };
