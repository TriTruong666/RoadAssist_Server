const {body,param,query}=require('express-validator');
module.exports={
 reference:[param('scope').isIn(['HAZARD','DISPATCH']),param('referenceId').isUUID()],
 page:[query('limit').optional().isInt({min:1,max:100}).toInt(),query('before').optional().isUUID(),query('version').optional().isInt({min:1,max:1000000}).toInt()],
 history:[query('limit').optional().isInt({min:1,max:100}).toInt(),query('offset').optional().isInt({min:0,max:100000}).toInt()],
 message:[body('roomId').optional().isUUID(),body('content').optional().isString().trim().isLength({max:1000}),body('clientMessageId').optional().isUUID(),body('assetIds').optional().isArray({max:3}).custom(v=>new Set(v).size===v.length),body('assetIds.*').isUUID(),body('images').not().exists().withMessage('Gửi ảnh multipart hoặc assetIds của chính bạn')],
};
