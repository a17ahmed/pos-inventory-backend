import express from 'express';
import { authorize } from '../middleware/rbac.mjs';
import { validate } from '../middleware/validate.mjs';
import { updateAccessSchema } from '../middleware/validationSchemas.mjs';
import {
    getMyAccess,
    getEmployeeAccess,
    updateEmployeeAccess,
    getAllAccess,
    deleteEmployeeAccess
} from '../controllers/access.mjs';

const accessRouter = express.Router();

// Employee fetches own permissions (no role restriction)
accessRouter.get('/me', getMyAccess);

// Admin/manager routes
accessRouter.get('/', authorize('admin', 'manager'), getAllAccess);
accessRouter.get('/:employeeId', authorize('admin', 'manager'), getEmployeeAccess);
accessRouter.put('/:employeeId', authorize('admin', 'manager'), validate(updateAccessSchema), updateEmployeeAccess);
accessRouter.delete('/:employeeId', authorize('admin'), deleteEmployeeAccess);

export default accessRouter;
