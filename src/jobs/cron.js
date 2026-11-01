const cron = require('node-cron');
const LocationService = require('../services/location.service');
let locationTask;
async function initCronJobs() {
  await LocationService.reconcile();
  if (!locationTask) locationTask = cron.schedule('* * * * *', () => LocationService.reconcile(), { noOverlap: true });
}
async function stopCronJobs() {
  if (locationTask) { await locationTask.destroy(); locationTask = null; }
}
module.exports = { initCronJobs, stopCronJobs };
