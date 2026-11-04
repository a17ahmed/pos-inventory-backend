import express from 'express';
import { validate } from '../middleware/validate.mjs';
import { registerBusinessSchema, updateBusinessSchema } from '../middleware/validationSchemas.mjs';
import { registerBusiness, getBusinessById, updateBusiness } from '../controllers/business.mjs';
import { isPlatformToken } from '../middleware/platformAuth.mjs';
import { checkBusinessStatus } from '../middleware/businessStatus.mjs';
import { trackUsage } from '../middleware/usageTracker.mjs';

const businessRouter = express.Router();

// Public route - register new business (no auth required)
businessRouter.post('/register', validate(registerBusinessSchema), registerBusiness);

// Note: GET /:id and PATCH /:id require auth.
// Auth is applied via jwtAuth in index.mjs for routes that need it.
// Since /business is a public route mount, we handle auth inline here.
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicKey = fs.readFileSync(
    path.resolve(__dirname, '..', process.env.JWT_PUBLIC_KEY_PATH || './public.key'),
    'utf-8'
);

const requireAuth = (req, res, next) => {
    try {
        const authHeader = req.get("Authorization");
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Authentication required' });
        }
        const token = authHeader.split('Bearer ')[1];
        const decoded = jwt.verify(token, publicKey);
        if (isPlatformToken(decoded)) return res.status(401).json({ message: 'Invalid token', code: 'TOKEN_INVALID' });
        req.user = {
            id: decoded.id || decoded.adminId,
            name: decoded.name || null,
            email: decoded.email,
            adminId: decoded.adminId,
            employeeId: decoded.employeeId,
            businessId: decoded.businessId,
            role: decoded.role || (decoded.adminId ? 'admin' : 'employee'),
            iat: decoded.iat
        };
        next();
    } catch (error) {
        res.status(401).json({ message: 'Authentication failed' });
    }
};

// Protected routes - require authentication
businessRouter.get('/:id', requireAuth, trackUsage, checkBusinessStatus, getBusinessById);
businessRouter.patch('/:id', requireAuth, trackUsage, checkBusinessStatus, validate(updateBusinessSchema), updateBusiness);

export default businessRouter;
