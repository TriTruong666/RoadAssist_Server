const router = require('express').Router();
const S = require('../services/place.service');
const schema = require('../schemas/place_flag.schema');
const validate = require('../middlewares/validate.middleware');
const R = require('../common/response.handler');
router.use(require('../middlewares/auth.middleware').protect);
router.get('/search', schema.search, validate, async (req,res) => R.success(res, await S.search(req.validated)));
router.post('/route', schema.solve, validate, async (req,res) => R.success(res, await S.solve(req.validated)));
for (const [path, routes] of [['saved',false],['routes',true]]) {
 router.get('/'+path, schema.page, validate, async (req,res) => R.success(res, await S.list(req.user, routes, req.validated)));
 router.post('/'+path, routes ? schema.route : schema.place, validate, async (req,res) => R.created(res, await S.create(req.user, routes, req.validated)));
 router.delete('/'+path+'/:id', schema.id, validate, async (req,res) => R.success(res, await S.remove(req.user, routes, req.validated.id)));
}
module.exports = router;
