import express from 'express';
import { validate } from '../middleware/validate.mjs';
import {
    openingBalanceSchema,
    cashbookTransactionSchema,
} from '../middleware/validationSchemas.mjs';
import {
    getCashBook,
    getCurrentBalance,
    setOpeningBalance,
    manualDeposit,
    manualWithdraw,
    getCashBookSummary,
} from '../controllers/cashbook.mjs';

const cashbookRouter = express.Router();

cashbookRouter.get('/balance', getCurrentBalance);
cashbookRouter.get('/summary', getCashBookSummary);
cashbookRouter.get('/', getCashBook);
cashbookRouter.post('/opening-balance', validate(openingBalanceSchema), setOpeningBalance);
cashbookRouter.post('/deposit', validate(cashbookTransactionSchema), manualDeposit);
cashbookRouter.post('/withdraw', validate(cashbookTransactionSchema), manualWithdraw);

export default cashbookRouter;
