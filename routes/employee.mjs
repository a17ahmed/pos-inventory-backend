import express from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../middleware/validate.mjs';
import {
    createEmployeeSchema,
    updateEmployeeSchema,
    resetEmployeePasswordSchema,
    updateWorkStatusSchema,
    employeeLoginSchema,
    employeeChangePasswordSchema,
} from '../middleware/validationSchemas.mjs';
import {
    getAllEmployees,
    getEmployeeById,
    createEmployee,
    updateEmployee,
    deleteEmployee,
    reactivateEmployee,
    getEmployeeCount,
    resetEmployeePassword,
    getBusinessPrefixForEmployee,
    checkEmployeeIdAvailable,
    updateWorkStatus
} from '../controllers/employee.mjs';
import { employeeLogin, employeeChangePassword } from '../controllers/employeeAuth.mjs';

const employeeRouter = express.Router();

// Get business prefix for employee ID
employeeRouter.get('/prefix', getBusinessPrefixForEmployee);

// Check if employee ID is available
employeeRouter.get('/check-id', checkEmployeeIdAvailable);

// Get all employees (uses businessId from JWT)
employeeRouter.get('/', getAllEmployees);

// Get employee count
employeeRouter.get('/count', getEmployeeCount);

// Get single employee
employeeRouter.get('/:id', getEmployeeById);

// Create new employee
employeeRouter.post('/', validate(createEmployeeSchema), createEmployee);

// Reactivate employee
employeeRouter.patch('/:id/reactivate', reactivateEmployee);

// Update employee work status (Active/On Break/Busy)
employeeRouter.patch('/:id/status', validate(updateWorkStatusSchema), updateWorkStatus);

// Update employee
employeeRouter.patch('/:id', validate(updateEmployeeSchema), updateEmployee);

// Reset employee password (admin function)
employeeRouter.post('/:id/reset-password', validate(resetEmployeePasswordSchema), resetEmployeePassword);

// Deactivate employee (soft delete)
employeeRouter.delete('/:id', deleteEmployee);

export default employeeRouter;

// Separate router for employee auth (no auth required)
export const employeeAuthRouter = express.Router();

// Employee login
employeeAuthRouter.post('/login', validate(employeeLoginSchema), employeeLogin);

// Employee change password (strict rate limit: 3 attempts per 15 min)
const changePasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    message: { message: 'Too many password change attempts, please try again later.' }
});
employeeAuthRouter.post('/change-password', changePasswordLimiter, validate(employeeChangePasswordSchema), employeeChangePassword);
