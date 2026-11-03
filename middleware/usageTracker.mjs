import NodeCache from 'node-cache';
import mongoose from 'mongoose';
import UsageDaily from '../models/usageDaily.mjs';
import Business from '../models/business.mjs';
import Admin from '../models/admin.mjs';
import Employee from '../models/employee.mjs';
import { toLocalDateString } from '../utils/dateHelpers.mjs';

/**
 * Counts each shop's requests per local day (UsageDaily) and keeps
 * lastActiveAt fresh on the business and the user — for the platform panel.
 * Runs after the response is sent and never fails a request.
 * lastActiveAt is written at most once per 5 minutes per user.
 */

const RETENTION_DAYS = 180;
const touched = new NodeCache({ stdTTL: 300, checkperiod: 120 });

const isId = (id) => id && mongoose.Types.ObjectId.isValid(String(id));

const areaOf = (req) => {
    const base = (req.baseUrl || req.originalUrl.split('?')[0] || '').replace(/^\/(v1\/)?/, '');
    return (base.split('/')[0] || 'other').replace(/[.$]/g, '_') || 'other';
};

export const recordUsage = (businessId, inc, { userId } = {}) => {
    if (!isId(businessId)) return Promise.resolve();
    const expireAt = new Date(Date.now() + RETENTION_DAYS * 86400000);
    const update = { $inc: inc, $setOnInsert: { expireAt } };
    if (isId(userId)) update.$addToSet = { activeUsers: new mongoose.Types.ObjectId(String(userId)) };
    return UsageDaily.updateOne(
        { business: businessId, date: toLocalDateString(new Date()) },
        update,
        { upsert: true }
    ).catch((err) => {
        // Two first-requests of the day racing the upsert → retry once
        if (err.code === 11000) return UsageDaily.updateOne({ business: businessId, date: toLocalDateString(new Date()) }, update).catch(() => {});
        console.error('[Usage]', err.message);
    });
};

const touchLastActive = (req) => {
    const { businessId, adminId } = req.user || {};
    const userId = adminId || req.user?.id;
    if (!isId(businessId)) return;
    const key = `${businessId}:${userId || '-'}`;
    if (touched.get(key)) return;
    touched.set(key, true);
    const now = new Date();
    Business.updateOne({ _id: businessId }, { $set: { lastActiveAt: now } }).catch(() => {});
    if (isId(userId)) {
        (adminId ? Admin : Employee).updateOne({ _id: userId }, { $set: { lastActiveAt: now } }).catch(() => {});
    }
};

/** Express middleware — place after jwtAuth. */
export const trackUsage = (req, res, next) => {
    res.on('finish', () => {
        const businessId = req.user?.businessId;
        if (!isId(businessId)) return;
        const inc = { requests: 1, [`byArea.${areaOf(req)}`]: 1 };
        if (req.blockedByPlatform) inc.blockedRequests = 1;
        else if (res.statusCode >= 500) inc.errors5xx = 1;
        else if (res.statusCode >= 400) inc.errors4xx = 1;
        recordUsage(businessId, inc, { userId: req.user.adminId || req.user.id });
        if (!req.blockedByPlatform && res.statusCode < 400) touchLastActive(req);
    });
    next();
};
