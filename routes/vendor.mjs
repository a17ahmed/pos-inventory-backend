import express from 'express';
import { validate } from '../middleware/validate.mjs';
import {
    createVendorSchema,
    updateVendorSchema,
    vendorPaymentSchema,
} from '../middleware/validationSchemas.mjs';
import { createVendor, getAllVendors, getVendor, updateVendor, deleteVendor, getVendorLedger, payVendor } from '../controllers/vendor.mjs';

const vendorRouter = express.Router();

vendorRouter.post('/', validate(createVendorSchema), createVendor);
vendorRouter.get('/', getAllVendors);
vendorRouter.get('/:id/ledger', getVendorLedger);
vendorRouter.post('/:id/pay', validate(vendorPaymentSchema), payVendor);
vendorRouter.get('/:id', getVendor);
vendorRouter.patch('/:id', validate(updateVendorSchema), updateVendor);
vendorRouter.delete('/:id', deleteVendor);

export default vendorRouter;
