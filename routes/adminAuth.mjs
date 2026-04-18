import express from 'express';
import { validate } from '../middleware/validate.mjs';
import {
    adminSignupSchema,
    adminLoginSchema,
    forgotPasswordSchema,
    verifyOtpSchema,
    resetPasswordSchema,
} from '../middleware/validationSchemas.mjs';

import { createAdmin, login, requestPasswordReset, verifyingOTP, resetPassword } from '../controllers/adminAuth.mjs';

const adminAuthRouter = express.Router();

adminAuthRouter.post('/', validate(adminSignupSchema), createAdmin);
adminAuthRouter.post('/login', validate(adminLoginSchema), login);
adminAuthRouter.post('/forgot-password', validate(forgotPasswordSchema), requestPasswordReset);
adminAuthRouter.post('/verifying-otp', validate(verifyOtpSchema), verifyingOTP);
adminAuthRouter.post('/reset-password', validate(resetPasswordSchema), resetPassword);

export default adminAuthRouter;
