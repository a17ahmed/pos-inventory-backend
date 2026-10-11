import express from 'express';
import { validate } from '../middleware/validate.mjs';
import {
    createCustomerSchema,
    updateCustomerSchema,
    collectFromCustomerSchema,
    upsertCustomerRateSchema,
    replaceCustomerRatesSchema
} from '../middleware/validationSchemas.mjs';
import {
    createOrGetCustomer,
    getCustomers,
    getCustomerSummary,
    getCustomer,
    updateCustomer,
    deleteCustomer,
    getCustomerLedger,
    collectFromCustomer,
    searchCustomers
} from '../controllers/customer.mjs';
import {
    getCustomerRates,
    upsertCustomerRate,
    deleteCustomerRate,
    replaceCustomerRates
} from '../controllers/customerRates.mjs';

const router = express.Router();

router.get('/search', searchCustomers);
router.get('/summary', getCustomerSummary);
router.post('/', validate(createCustomerSchema), createOrGetCustomer);
router.get('/', getCustomers);
router.get('/:id/ledger', getCustomerLedger);
router.post('/:id/collect', validate(collectFromCustomerSchema), collectFromCustomer);
router.get('/:id/rates', getCustomerRates);
router.put('/:id/rates', validate(replaceCustomerRatesSchema), replaceCustomerRates);
router.put('/:id/rates/:productId', validate(upsertCustomerRateSchema), upsertCustomerRate);
router.delete('/:id/rates/:productId', deleteCustomerRate);
router.get('/:id', getCustomer);
router.patch('/:id', validate(updateCustomerSchema), updateCustomer);
router.delete('/:id', deleteCustomer);

export default router;
