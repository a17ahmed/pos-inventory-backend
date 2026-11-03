import NodeCache from 'node-cache';
import mongoose from 'mongoose';
import Business from '../models/business.mjs';

/**
 * Shop-side guard for the platform "block a business" control.
 *
 * Every protected request checks its business's subscription status. The
 * status is cached for 60s per business (NodeCache) so this isn't a DB read on
 * every request; the platform panel clears the cache entry when it changes a
 * status, so on this server instance it applies at once (other instances
 * within 60s).
 *
 *   blocked → 403 { code: 'BUSINESS_BLOCKED', message, contact }
 *   warning → request allowed; header X-Account-Status: warning
 *   tokens issued before subscription.sessionsRevokedAt → 401 SESSION_REVOKED
 */

const statusCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

export const getBusinessStatus = async (businessId) => {
    if (!businessId || !mongoose.Types.ObjectId.isValid(String(businessId))) return null;
    const key = String(businessId);
    const cached = statusCache.get(key);
    if (cached !== undefined) return cached;

    const business = await Business.findById(key).select('name subscription').lean();
    const s = business?.subscription || {};
    const status = business
        ? {
            name: business.name,
            status: s.status || 'active',
            message: s.message || '',
            contact: s.contact || '',
            paidUntil: s.paidUntil || null,
            sessionsRevokedAt: s.sessionsRevokedAt || null,
        }
        : null;
    statusCache.set(key, status);
    return status;
};

export const invalidateBusinessStatus = (businessId) => statusCache.del(String(businessId));

export const blockedResponse = (status) => ({
    code: 'BUSINESS_BLOCKED',
    message: status?.message
        ? `Your account is suspended. ${status.message}`
        : 'Your account is suspended. Please contact support.',
    contact: status?.contact || '',
});

/** Express middleware — place after jwtAuth (needs req.user.businessId). */
export const checkBusinessStatus = async (req, res, next) => {
    try {
        const status = await getBusinessStatus(req.user?.businessId);
        if (!status) return next();

        if (status.status === 'blocked') {
            req.blockedByPlatform = true;
            return res.status(403).json(blockedResponse(status));
        }
        if (status.sessionsRevokedAt && req.user?.iat && req.user.iat * 1000 < new Date(status.sessionsRevokedAt).getTime()) {
            return res.status(401).json({ message: 'Your session has ended. Please log in again.', code: 'SESSION_REVOKED' });
        }
        if (status.status === 'warning') {
            res.set('X-Account-Status', 'warning');
        }
        next();
    } catch (error) {
        // Never take the whole shop down because the status read failed
        console.error('[BusinessStatus]', error.message);
        next();
    }
};

/**
 * GET /account/status — for the shop apps' lock screen / warning banner.
 * Mounted after jwtAuth only (not checkBusinessStatus) so it works while blocked.
 */
export const accountStatus = async (req, res) => {
    try {
        const status = await getBusinessStatus(req.user?.businessId);
        if (!status) return res.status(404).json({ message: 'Business not found' });
        res.json({ status: status.status, message: status.message, contact: status.contact, paidUntil: status.paidUntil });
    } catch (error) {
        console.error('[Account status]', error.message);
        res.status(500).json({ message: 'Failed to load account status' });
    }
};
