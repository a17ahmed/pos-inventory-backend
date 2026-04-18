import express from 'express';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Admin from '../models/admin.mjs';
import Employee from '../models/employee.mjs';
import RefreshToken from '../models/refreshToken.mjs';
import { validate } from '../middleware/validate.mjs';
import { refreshTokenSchema, logoutSchema } from '../middleware/validationSchemas.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const privateKey = fs.readFileSync(path.resolve(__dirname, '../private.key'), 'utf-8');

const authRouter = express.Router();

/**
 * POST /auth/refresh
 * Exchange a valid refresh token for a new access token + new refresh token (rotation)
 */
authRouter.post('/refresh', validate(refreshTokenSchema), async (req, res) => {
    try {
        const { refreshToken } = req.body;
        console.log('[Auth Refresh] Request received');

        console.log('[Auth Refresh] Verifying and rotating token...');
        // Verify and rotate (deletes old token, returns user info)
        const tokenData = await RefreshToken.verifyAndRotate(refreshToken);

        if (!tokenData) {
            console.log('[Auth Refresh] Token invalid or expired');
            return res.status(401).json({ message: 'Invalid or expired refresh token', code: 'REFRESH_TOKEN_INVALID' });
        }
        console.log('[Auth Refresh] Token verified, userType:', tokenData.userType);

        const { userId, userType, businessId } = tokenData;

        // Build new access token based on user type
        let payload;

        if (userType === 'admin') {
            console.log('[Auth Refresh] Fetching admin user...');
            const admin = await Admin.findById(userId).select('email role');
            if (!admin) {
                console.log('[Auth Refresh] Admin not found:', userId);
                return res.status(401).json({ message: 'User not found' });
            }
            payload = {
                email: admin.email,
                adminId: userId,
                businessId,
                role: admin.role || 'admin'
            };
        } else {
            console.log('[Auth Refresh] Fetching employee user...');
            const employee = await Employee.findById(userId).select('employeeId name role status');
            if (!employee) {
                console.log('[Auth Refresh] Employee not found:', userId);
                return res.status(401).json({ message: 'User not found' });
            }
            if (employee.status !== 'active') {
                console.log('[Auth Refresh] Employee account inactive:', userId);
                return res.status(401).json({ message: 'Account is not active', code: 'ACCOUNT_INACTIVE' });
            }
            payload = {
                id: userId,
                name: employee.name,
                employeeId: employee.employeeId,
                businessId,
                role: employee.role
            };
        }

        // Sign new access token
        console.log('[Auth Refresh] Signing new access token...');
        const newAccessToken = jwt.sign(payload, privateKey, {
            algorithm: 'RS256',
            expiresIn: process.env.JWT_ACCESS_TOKEN_EXPIRY || '8h'
        });

        // Issue new refresh token (rotation)
        console.log('[Auth Refresh] Creating new refresh token...');
        const newRefreshToken = await RefreshToken.createToken({
            userId,
            userType,
            businessId,
        });

        console.log('[Auth Refresh] Success - new tokens issued for', userType);
        res.json({
            token: newAccessToken,
            refreshToken: newRefreshToken.token
        });
    } catch (error) {
        console.error('[Auth Refresh] Error:', error.message);
        res.status(500).json({ message: 'Server error' });
    }
});

/**
 * POST /auth/logout
 * Revoke refresh token on logout
 */
authRouter.post('/logout', validate(logoutSchema), async (req, res) => {
    try {
        console.log('[Auth Logout] Request received');
        const { refreshToken } = req.body;
        if (refreshToken) {
            await RefreshToken.deleteOne({ token: refreshToken });
            console.log('[Auth Logout] Refresh token revoked');
        }
        res.json({ message: 'Logged out' });
    } catch (error) {
        console.error('[Auth Logout] Error:', error.message);
        res.json({ message: 'Logged out' });
    }
});

export default authRouter;
