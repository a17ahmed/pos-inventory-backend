import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import NodeCache from 'node-cache';
import PlatformAdmin from '../models/platformAdmin.mjs';

/**
 * Auth for the platform admin panel (/platform/*).
 * Platform tokens are signed with the same RSA keys as shop tokens but carry
 * audience "platform" + scope "platform":
 *   - platformAuth only accepts tokens with that audience
 *   - the shop's jwtAuth rejects them (see isPlatformToken)
 * The panel user is re-checked (cached 30s) so a disabled user is locked out quickly.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(path.resolve(__dirname, '../private.key'), 'utf-8');
const publicKey = fs.readFileSync(path.resolve(__dirname, '..', process.env.JWT_PUBLIC_KEY_PATH || './public.key'), 'utf-8');

export const PLATFORM_AUDIENCE = 'platform';
const userCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });

export const isPlatformToken = (decoded) => decoded?.scope === 'platform' || decoded?.aud === PLATFORM_AUDIENCE;

export const signPlatformToken = (admin) =>
    jwt.sign(
        { platformAdminId: String(admin._id), role: admin.role, name: admin.name, scope: 'platform', v: admin.tokenVersion || 0 },
        privateKey,
        { algorithm: 'RS256', audience: PLATFORM_AUDIENCE, expiresIn: process.env.PLATFORM_TOKEN_EXPIRY || '12h' }
    );

export const invalidatePlatformUser = (id) => userCache.del(String(id));

export const platformAuth = async (req, res, next) => {
    try {
        const header = req.get('Authorization') || '';
        if (!header.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Authentication required', code: 'PLATFORM_AUTH_REQUIRED' });
        }
        let decoded;
        try {
            decoded = jwt.verify(header.slice(7), publicKey, { algorithms: ['RS256'], audience: PLATFORM_AUDIENCE });
        } catch (err) {
            const expired = err.name === 'TokenExpiredError';
            return res.status(401).json({ message: expired ? 'Session expired' : 'Invalid token', code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID' });
        }
        if (decoded.scope !== 'platform' || !decoded.platformAdminId) {
            return res.status(401).json({ message: 'Invalid token', code: 'TOKEN_INVALID' });
        }

        let user = userCache.get(decoded.platformAdminId);
        if (user === undefined) {
            user = await PlatformAdmin.findById(decoded.platformAdminId).select('name email role isActive tokenVersion').lean();
            userCache.set(decoded.platformAdminId, user || null);
        }
        if (!user || !user.isActive) {
            return res.status(401).json({ message: 'Account disabled', code: 'PLATFORM_USER_DISABLED' });
        }
        if ((decoded.v || 0) !== (user.tokenVersion || 0)) {
            return res.status(401).json({ message: 'You were signed out. Please sign in again.', code: 'TOKEN_REVOKED' });
        }

        req.platformAdmin = { id: String(user._id), name: user.name, email: user.email, role: user.role };
        next();
    } catch (error) {
        console.error('[PlatformAuth]', error.message);
        res.status(500).json({ message: 'Authentication failed' });
    }
};

/** Only superadmins (block / unblock / manage panel users). */
export const requireSuperadmin = (req, res, next) => {
    if (req.platformAdmin?.role !== 'superadmin') {
        return res.status(403).json({ message: 'Only a superadmin can do this', code: 'PLATFORM_FORBIDDEN' });
    }
    next();
};
