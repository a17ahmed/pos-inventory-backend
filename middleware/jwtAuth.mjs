import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isPlatformToken } from './platformAuth.mjs';

// Shop API token check (admin + employee tokens). Moved out of index.mjs
// unchanged so tests can run the real middleware chain.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicKey = fs.readFileSync(path.resolve(__dirname, '..', process.env.JWT_PUBLIC_KEY_PATH || './public.key'), 'utf-8');

export const jwtAuth = (req, res, next) => {
    try {
        const authHeader = req.get("Authorization");
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Authentication required' });
        }

        const token = authHeader.split('Bearer ')[1];
        const decoded = jwt.verify(token, publicKey);

        // Platform panel tokens are never valid on the shop API
        if (isPlatformToken(decoded)) {
            return res.status(401).json({ message: 'Invalid token', code: 'TOKEN_INVALID' });
        }

        // Accept both admin and employee tokens
        if (decoded.adminId || decoded.email || decoded.employeeId || decoded.id) {
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
        } else {
            res.status(401).json({ message: 'Invalid token' });
        }
    } catch (error) {
        console.log('[Auth Middleware] JWT Error:', error.name, '-', error.message);
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ message: 'Token expired', code: 'TOKEN_EXPIRED' });
        }
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ message: 'Invalid token', code: 'TOKEN_INVALID' });
        }
        res.status(401).json({ message: 'Authentication failed' });
    }
};
