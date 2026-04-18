import express from 'express';
import { uploadSupplyReceipt } from '../middleware/upload.mjs';
import { validate } from '../middleware/validate.mjs';
import {
    createSupplySchema,
    updateSupplySchema,
    supplyPaymentSchema,
    supplyReturnSchema,
} from '../middleware/validationSchemas.mjs';
import {
    createSupply,
    getAllSupplies,
    getSupply,
    updateSupply,
    recordPayment,
    deleteSupply,
    getSupplyStats,
    processSupplyReturn
} from '../controllers/supply.mjs';

const supplyRouter = express.Router();

supplyRouter.get('/stats', getSupplyStats);
// Parse JSON string fields from multipart form-data before validation
const parseMultipartJson = (req, res, next) => {
    if (typeof req.body.items === 'string') {
        try { req.body.items = JSON.parse(req.body.items); } catch { /* controller handles error */ }
    }
    if (req.body.totalAmount) req.body.totalAmount = Number(req.body.totalAmount);
    if (req.body.paidAmount) req.body.paidAmount = Number(req.body.paidAmount);
    next();
};

supplyRouter.post('/', uploadSupplyReceipt, parseMultipartJson, validate(createSupplySchema), createSupply);
supplyRouter.get('/', getAllSupplies);
supplyRouter.get('/:id', getSupply);
supplyRouter.patch('/:id', uploadSupplyReceipt, parseMultipartJson, validate(updateSupplySchema), updateSupply);
supplyRouter.patch('/:id/pay', validate(supplyPaymentSchema), recordPayment);
supplyRouter.post('/:id/return', validate(supplyReturnSchema), processSupplyReturn);
supplyRouter.delete('/:id', deleteSupply);

export default supplyRouter;
