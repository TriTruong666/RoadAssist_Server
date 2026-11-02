const router = require('express').Router();
const S = require('../services/flag.service');
const schema = require('../schemas/place_flag.schema');
const validate = require('../middlewares/validate.middleware');
const { protect, restrictTo } = require('../middlewares/auth.middleware');
const R = require('../common/response.handler');
router.post('/', protect, require('../middlewares/upload.middleware'), schema.aliases, schema.flag, validate, async (req,res) => R.created(res, await S.create(req.user, req.validated, req.files)));
router.get('/nearby', schema.aliases, schema.nearby, schema.page, validate, async (req,res) => R.success(res, await S.nearby(req.validated)));
router.get('/my', protect, schema.page, validate, async (req,res) => R.success(res, await S.mine(req.user, req.validated)));
router.get('/:id', schema.id, validate, async (req,res) => R.success(res, await S.detail(req.validated.id)));
router.get('/:id/images/:imageId', schema.id, schema.imageId, validate, async (req,res) => {
 const image = await S.image(req.validated.id, req.validated.imageId);
 if (image.url) return res.redirect(302, image.url);
 res.set({ 'Content-Type': image.mimeType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=300' }).send(image.content);
});
router.post('/:id/vote', protect, schema.id, schema.vote, validate, async (req,res) => R.success(res, await S.mutate(req.user, req.validated.id, 'vote', req.validated.voteType)));
router.post('/:id/unflag', protect, schema.id, validate, async (req,res) => R.success(res, await S.mutate(req.user, req.validated.id, 'unflag')));
router.get('/:id/messages', protect, schema.id, schema.page, validate, async (req,res) => R.success(res, await S.messages(req.validated.id, req.validated, req.user)));
router.post('/:id/messages', protect, schema.id, schema.message, validate, async (req,res) => {
 const message = await S.message(req.user, req.validated.id, req.validated.text);
 require('../services/chat.service').broadcast(req.app, 'HAZARD', req.validated.id, message);
 R.created(res, message);
});
const admin = require('express').Router();
admin.use(protect, restrictTo('admin'));
admin.put('/:id/lock', schema.id, validate, async (req,res) => R.success(res, await S.mutate(req.user, req.validated.id, 'lock')));
admin.put('/:id/unlock', schema.id, validate, async (req,res) => R.success(res, await S.mutate(req.user, req.validated.id, 'unlock')));
admin.delete('/:id', schema.id, validate, async (req,res) => R.success(res, await S.mutate(req.user, req.validated.id, 'remove')));
module.exports = { router, admin };
