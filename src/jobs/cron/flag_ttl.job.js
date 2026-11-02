const Flags = require('../../services/flag.service');
module.exports = async () => {
 try { return await Flags.expire(); }
 catch (error) { console.error('[Flag TTL]', error.message); }
};
