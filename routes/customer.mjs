import express from 'express';
import { validate } from '../middleware/validate.mjs';
import { createCustomerSchema, updateCustomerSchema, collectFromCustomerSchema } from '../middleware/validationSchemas.mjs';
import {
    createOrGetCustomer,
    getCustomers,
    getCustomer,
    updateCustomer,
    deleteCustomer,
    getCustomerLedger,
    collectFromCustomer,
    searchCustomers
} from '../controllers/customer.mjs';

const router = express.Router();

router.get('/search', searchCustomers);
router.post('/', validate(createCustomerSchema), createOrGetCustomer);
router.get('/', getCustomers);
router.get('/:id/ledger', getCustomerLedger);
router.post('/:id/collect', validate(collectFromCustomerSchema), collectFromCustomer);
router.get('/:id', getCustomer);
router.patch('/:id', validate(updateCustomerSchema), updateCustomer);
router.delete('/:id', deleteCustomer);

export default router;
