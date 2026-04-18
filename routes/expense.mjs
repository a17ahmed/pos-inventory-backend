import express from 'express';
import { validate } from '../middleware/validate.mjs';
import {
    createExpenseSchema,
    updateExpenseSchema,
    rejectExpenseSchema,
} from '../middleware/validationSchemas.mjs';

import {
    createExpense,
    getAllExpenses,
    getExpense,
    updateExpense,
    deleteExpense,
    approveExpense,
    rejectExpense,
    getExpenseStats
} from '../controllers/expense.mjs';

const expenseRouter = express.Router();

// Stats endpoint (must be before /:id to avoid conflict)
expenseRouter.get('/stats', getExpenseStats);

// CRUD endpoints
expenseRouter
    .post('/', validate(createExpenseSchema), createExpense)
    .get('/', getAllExpenses)
    .get('/:id', getExpense)
    .patch('/:id', validate(updateExpenseSchema), updateExpense)
    .delete('/:id', deleteExpense);

// Approval endpoints
expenseRouter
    .post('/:id/approve', approveExpense)
    .post('/:id/reject', validate(rejectExpenseSchema), rejectExpense);

export default expenseRouter;
