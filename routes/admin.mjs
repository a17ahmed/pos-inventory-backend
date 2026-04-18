import express from 'express';
import { validate } from '../middleware/validate.mjs';
import { updateAdminSchema, updateBusinessSettingsSchema } from '../middleware/validationSchemas.mjs';

import { getAdmin, getAdminEmail, patchAdmin, deleteAdmin, updateBusinessSettings, getBusinessSettings, changePassword } from '../controllers/admin.mjs';
import rateLimit from 'express-rate-limit';

const adminRouter = express.Router();

const changePasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { message: 'Too many password change attempts, please try again later' },
});

adminRouter
    .get('/business/settings', getBusinessSettings)
    .get('/email/:email', getAdminEmail)
    .get('/:id', getAdmin)
    .patch('/:id', validate(updateAdminSchema), patchAdmin)
    .post('/change-password', changePasswordLimiter, changePassword)
    .put('/business/settings', validate(updateBusinessSettingsSchema), updateBusinessSettings)
    .delete('/:id', deleteAdmin);

export default adminRouter;
