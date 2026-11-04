import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import Business from '../models/business.mjs';
import BusinessType from '../models/businessType.mjs';
import Admin from '../models/admin.mjs';
import Employee from '../models/employee.mjs';
import Access from '../models/access.mjs';
import Product from '../models/product.mjs';
import Customer from '../models/customer.mjs';
import Vendor from '../models/vendor.mjs';
import Supply from '../models/supply.mjs';
import Expense from '../models/expense.mjs';
import Bill from '../models/bill.mjs';
import Closing from '../models/closing.mjs';
import RefreshToken from '../models/refreshToken.mjs';
import UsageDaily from '../models/usageDaily.mjs';
import PlatformAdmin from '../models/platformAdmin.mjs';
import PlatformAudit from '../models/platformAudit.mjs';
import { signPlatformToken, invalidatePlatformUser } from '../middleware/platformAuth.mjs';
import { invalidateBusinessStatus } from '../middleware/businessStatus.mjs';
import { computeBillStats } from './bill.mjs';
import { computeCashBalance } from './cashbook.mjs';
import { startOfToday, startOfMonth, startOfDay, endOfDay, toLocalDateString, getTimezone } from '../utils/dateHelpers.mjs';

// ─── Platform admin panel ───────────────────────────────────────────────────
// Everything here is for the software owner (and their staff), never for a
// shop. Read endpoints see every shop's data; write endpoints only change the
// platform's own fields (business.subscription, panel users) — never shop data.

const round2 = (x) => Math.round((x || 0) * 100) / 100;
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const isId = (id) => mongoose.Types.ObjectId.isValid(String(id || '')) && String(oid(id)) === String(id);
const DAY = 86400000;
const SHOP_HIDDEN = '-password -token -otp -otpExpiry';

const audit = (req, action, { business = null, details = {} } = {}) =>
    PlatformAudit.create({
        actor: req.platformAdmin
            ? { id: req.platformAdmin.id, name: req.platformAdmin.name, email: req.platformAdmin.email }
            : { email: details.email || '' },
        action,
        business: business?._id || null,
        businessName: business?.name || '',
        details,
        ip: req.ip || '',
    }).catch((err) => console.error('[PlatformAudit]', err.message));

const publicAdmin = (a) => ({
    id: String(a._id), name: a.name, email: a.email, role: a.role, isActive: a.isActive,
    lastLoginAt: a.lastLoginAt || null, createdAt: a.createdAt,
});

/** Completed / cancelled sale bills for some businesses in [from, to). Uses the {business,type,status,createdAt} index. */
const billTotals = async (businessIds, from, to = new Date(Date.now() + DAY)) => {
    const rows = await Promise.all(businessIds.map((id) => Bill.aggregate([
        { $match: { business: oid(id), type: 'sale', status: { $in: ['completed', 'cancelled'] }, createdAt: { $gte: from, $lt: to } } },
        {
            $group: {
                _id: '$status',
                count: { $sum: 1 },
                total: { $sum: '$total' },
                credit: { $sum: { $cond: [{ $gt: ['$amountDue', 0] }, '$amountDue', 0] } },
            },
        },
    ])));
    const map = new Map();
    businessIds.forEach((id, i) => {
        const done = rows[i].find((r) => r._id === 'completed') || {};
        const cancelled = rows[i].find((r) => r._id === 'cancelled') || {};
        map.set(String(id), { bills: done.count || 0, sales: round2(done.total), creditGiven: round2(done.credit), cancelled: cancelled.count || 0 });
    });
    return map;
};

const usageFor = async (businessIds, date = toLocalDateString(new Date())) => {
    const rows = await UsageDaily.find({ business: { $in: businessIds.map(oid) }, date }).lean();
    const map = new Map();
    for (const r of rows) {
        map.set(String(r.business), {
            requests: r.requests || 0,
            errors: (r.errors4xx || 0) + (r.errors5xx || 0),
            errors5xx: r.errors5xx || 0,
            logins: r.logins || 0,
            blockedRequests: r.blockedRequests || 0,
            activeUsers: (r.activeUsers || []).length,
        });
    }
    return map;
};
const EMPTY_USAGE = { requests: 0, errors: 0, errors5xx: 0, logins: 0, blockedRequests: 0, activeUsers: 0 };

const statusOf = (b) => b?.subscription?.status || 'active';

/** A real calendar date "YYYY-MM-DD" (rejects 2026-02-31). */
export const isRealDate = (str) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(str))) return false;
    const [y, m, d] = String(str).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/** ?days= : absent → fallback; otherwise a whole number 1..180, else null (→ 400). */
const parseDays = (raw, fallback) => {
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(String(raw))) return null;
    const n = Number(raw);
    return n >= 1 && n <= 180 ? n : null;
};

const subscriptionView = (b) => {
    const s = b.subscription || {};
    const paidUntil = s.paidUntil || null;
    return {
        status: s.status || 'active',
        message: s.message || '',
        contact: s.contact || '',
        paidUntil,
        daysLeft: paidUntil ? Math.ceil((new Date(paidUntil) - Date.now()) / DAY) : null,
        plan: s.plan || '',
        monthlyFee: s.monthlyFee || 0,
        notes: s.notes || '',
        sessionsRevokedAt: s.sessionsRevokedAt || null,
    };
};

// ═══ Auth ════════════════════════════════════════════════════════════════════

/** POST /platform/auth/login { email, password } */
export const platformLogin = async (req, res) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const password = String(req.body.password || '');
        if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });

        const admin = await PlatformAdmin.findOne({ email });
        const ok = admin && admin.isActive && (await bcrypt.compare(password, admin.password));
        if (!ok) {
            // Only failed sign-ins to real panel accounts are recorded, so spam
            // with made-up emails can't fill the audit log
            if (admin) await audit(req, 'auth.login_failed', { details: { email } });
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        admin.lastLoginAt = new Date();
        await admin.save();
        req.platformAdmin = { id: String(admin._id), name: admin.name, email: admin.email, role: admin.role };
        await audit(req, 'auth.login');
        res.json({ token: signPlatformToken(admin), admin: publicAdmin(admin) });
    } catch (error) {
        console.error('[Platform] login', error);
        res.status(500).json({ message: 'Login failed' });
    }
};

/** POST /platform/auth/logout — ends every session of this panel user (all devices). */
export const platformLogout = async (req, res) => {
    try {
        await PlatformAdmin.updateOne({ _id: req.platformAdmin.id }, { $inc: { tokenVersion: 1 } });
        invalidatePlatformUser(req.platformAdmin.id);
        await audit(req, 'auth.logout');
        res.json({ message: 'Signed out' });
    } catch (error) {
        console.error('[Platform] logout', error);
        res.status(500).json({ message: 'Failed to sign out' });
    }
};

/** GET /platform/auth/me */
export const platformMe = async (req, res) => {
    try {
        const admin = await PlatformAdmin.findById(req.platformAdmin.id).lean();
        if (!admin) return res.status(401).json({ message: 'Account not found', code: 'PLATFORM_USER_DISABLED' });
        res.json({ admin: publicAdmin(admin) });
    } catch (error) {
        console.error('[Platform] me', error);
        res.status(500).json({ message: 'Failed to load your account' });
    }
};

/** POST /platform/auth/change-password { currentPassword, newPassword } */
export const platformChangePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!newPassword || String(newPassword).length < 8) {
            return res.status(400).json({ message: 'New password must be at least 8 characters' });
        }
        const admin = await PlatformAdmin.findById(req.platformAdmin.id);
        if (!admin || !(await bcrypt.compare(String(currentPassword || ''), admin.password))) {
            return res.status(400).json({ message: 'Current password is wrong' });
        }
        admin.password = await bcrypt.hash(String(newPassword), 10);
        admin.tokenVersion = (admin.tokenVersion || 0) + 1; // other sessions end
        await admin.save();
        invalidatePlatformUser(admin._id);
        await audit(req, 'auth.change_password');
        res.json({ message: 'Password changed', token: signPlatformToken(admin) }); // this session continues with the new token
    } catch (error) {
        console.error('[Platform] change password', error);
        res.status(500).json({ message: 'Failed to change password' });
    }
};

// ═══ Overview ════════════════════════════════════════════════════════════════

/** GET /platform/overview — the whole platform at a glance */
export const getOverview = async (req, res) => {
    try {
        const businesses = await Business.find({}, { name: 1, subscription: 1, createdAt: 1, lastActiveAt: 1 }).lean();
        const ids = businesses.map((b) => b._id);
        const todayStart = startOfToday();
        const [today, usage, totalUsers] = await Promise.all([
            billTotals(ids, todayStart),
            usageFor(ids),
            Promise.all([Admin.countDocuments({}), Employee.countDocuments({ status: 'active' })]),
        ]);

        const shops = { total: businesses.length, active: 0, warning: 0, blocked: 0, newThisMonth: 0, activeToday: 0 };
        const totals = { bills: 0, sales: 0, cancelled: 0, creditGiven: 0, requests: 0, errors: 0, activeUsers: 0, logins: 0 };
        const monthStart = startOfMonth();
        const paymentsDue = [];
        const topToday = [];

        for (const b of businesses) {
            shops[statusOf(b)] += 1;
            if (new Date(b.createdAt) >= monthStart) shops.newThisMonth += 1;
            const t = today.get(String(b._id));
            const u = usage.get(String(b._id)) || EMPTY_USAGE;
            if (t.bills > 0 || u.requests > 0) shops.activeToday += 1;
            totals.bills += t.bills;
            totals.sales += t.sales;
            totals.cancelled += t.cancelled;
            totals.creditGiven += t.creditGiven;
            totals.requests += u.requests;
            totals.errors += u.errors;
            totals.activeUsers += u.activeUsers;
            totals.logins += u.logins;
            topToday.push({ businessId: b._id, name: b.name, bills: t.bills, sales: t.sales });

            const sub = subscriptionView(b);
            if (sub.status !== 'blocked' && sub.daysLeft !== null && sub.daysLeft <= 3) {
                paymentsDue.push({ businessId: b._id, name: b.name, status: sub.status, paidUntil: sub.paidUntil, daysLeft: sub.daysLeft });
            }
        }
        totals.sales = round2(totals.sales);
        totals.creditGiven = round2(totals.creditGiven);

        res.json({
            shops,
            users: { admins: totalUsers[0], activeEmployees: totalUsers[1] },
            today: totals,
            topShopsToday: topToday.sort((a, b) => b.sales - a.sales).slice(0, 5),
            paymentsDue: paymentsDue.sort((a, b) => a.daysLeft - b.daysLeft),
            generatedAt: new Date(),
        });
    } catch (error) {
        console.error('[Platform] overview', error);
        res.status(500).json({ message: 'Failed to load overview' });
    }
};

// ═══ Shops ═══════════════════════════════════════════════════════════════════

const SORTS = {
    lastActive: { lastActiveAt: -1, createdAt: -1, _id: 1 },
    name: { _nameKey: 1, _id: 1 },
    newest: { createdAt: -1, _id: 1 },
    oldest: { createdAt: 1, _id: 1 },
    // shops without a paid-until date go last
    paidUntil: { _noPaidUntil: 1, 'subscription.paidUntil': 1, _nameKey: 1, _id: 1 },
};

/** GET /platform/businesses?search=&status=&sort=&page=&limit= */
export const listBusinesses = async (req, res) => {
    try {
        const { search = '', status = '', sort = 'lastActive' } = req.query;
        if (status && !['active', 'warning', 'blocked'].includes(status)) {
            return res.status(400).json({ message: 'status must be active, warning or blocked' });
        }
        if (!SORTS[sort]) return res.status(400).json({ message: `sort must be one of: ${Object.keys(SORTS).join(', ')}` });
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);

        const filter = {};
        if (status === 'active') filter['subscription.status'] = { $nin: ['warning', 'blocked'] };
        else if (status) filter['subscription.status'] = status;
        if (search.trim()) {
            const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter.$or = [{ name: re }, { email: re }, { phone: re }];
        }

        const [total, rows] = await Promise.all([
            Business.countDocuments(filter),
            Business.aggregate([
                { $match: filter },
                {
                    $addFields: {
                        _nameKey: { $toLower: { $ifNull: ['$name', ''] } },
                        _noPaidUntil: { $cond: [{ $ifNull: ['$subscription.paidUntil', false] }, 0, 1] },
                    },
                },
                { $sort: SORTS[sort] },
                { $skip: (page - 1) * limit },
                { $limit: limit },
                { $project: { _nameKey: 0, _noPaidUntil: 0 } },
            ]),
        ]);
        const businesses = await Business.populate(rows, { path: 'businessType', select: 'name code' });
        const ids = businesses.map((b) => b._id);
        const [today, usage, owners, employees, products, customers] = await Promise.all([
            billTotals(ids, startOfToday()),
            usageFor(ids),
            Admin.find({ business: { $in: ids } }).select('name email business role').lean(),
            Employee.aggregate([{ $match: { business: { $in: ids } } }, { $group: { _id: '$business', total: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } } } }]),
            Product.aggregate([{ $match: { business: { $in: ids }, isActive: true } }, { $group: { _id: '$business', n: { $sum: 1 } } }]),
            Customer.aggregate([{ $match: { business: { $in: ids } } }, { $group: { _id: '$business', n: { $sum: 1 } } }]),
        ]);
        const byBiz = (rows) => new Map(rows.map((r) => [String(r._id), r]));
        const emp = byBiz(employees), prod = byBiz(products), cust = byBiz(customers);

        res.json({
            businesses: businesses.map((b) => {
                const owner = owners.find((o) => String(o.business) === String(b._id));
                return {
                    businessId: b._id,
                    name: b.name,
                    email: b.email || '',
                    phone: b.phone || '',
                    type: b.businessType?.name || '',
                    owner: owner ? { id: owner._id, name: owner.name, email: owner.email } : null,
                    subscription: subscriptionView(b),
                    createdAt: b.createdAt,
                    lastActiveAt: b.lastActiveAt || null,
                    today: { ...today.get(String(b._id)), ...(usage.get(String(b._id)) || EMPTY_USAGE) },
                    counts: {
                        employees: emp.get(String(b._id))?.total || 0,
                        activeEmployees: emp.get(String(b._id))?.active || 0,
                        products: prod.get(String(b._id))?.n || 0,
                        customers: cust.get(String(b._id))?.n || 0,
                    },
                };
            }),
            pagination: { page, limit, total, pages: Math.ceil(total / limit), hasMore: page * limit < total },
        });
    } catch (error) {
        console.error('[Platform] list businesses', error);
        res.status(500).json({ message: 'Failed to load businesses' });
    }
};

/** Loads :businessId into req.shop (404 if missing). */
export const loadBusiness = async (req, res, next) => {
    try {
        if (!isId(req.params.businessId)) return res.status(404).json({ message: 'Business not found' });
        const business = await Business.findById(req.params.businessId).lean();
        if (!business) return res.status(404).json({ message: 'Business not found' });
        req.shop = business;
        next();
    } catch (error) {
        console.error('[Platform] load business', error);
        res.status(500).json({ message: 'Failed to load business' });
    }
};

/** GET /platform/businesses/:businessId — everything about one shop */
export const getBusinessDetail = async (req, res) => {
    try {
        const b = req.shop;
        const id = b._id;
        const now = new Date();
        const [
            type, owners, employees, products, lowStock, inventory, customers, outstanding,
            vendors, supplies, expenses, billsAllTime, stats, cash, usage, lastClosing, sessions,
        ] = await Promise.all([
            BusinessType.findById(b.businessType).select('name code icon').lean().catch(() => null),
            Admin.find({ business: id }).select(SHOP_HIDDEN).lean(),
            Employee.aggregate([{ $match: { business: id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
            Product.aggregate([{ $match: { business: id } }, { $group: { _id: '$isActive', n: { $sum: 1 } } }]),
            Product.countDocuments({ business: id, isActive: true, trackStock: true, $expr: { $lte: ['$stockQuantity', '$lowStockAlert'] } }),
            Product.aggregate([
                { $match: { business: id, isActive: true, trackStock: true } },
                { $group: { _id: null, units: { $sum: '$stockQuantity' }, cost: { $sum: { $multiply: ['$stockQuantity', { $ifNull: ['$costPrice', 0] }] } }, retail: { $sum: { $multiply: ['$stockQuantity', { $ifNull: ['$sellingPrice', 0] }] } } } },
            ]),
            Customer.countDocuments({ business: id }),
            Customer.aggregate([{ $match: { business: id } }, { $group: { _id: null, owed: { $sum: { $cond: [{ $gt: ['$balance', 0] }, '$balance', 0] } }, credit: { $sum: { $cond: [{ $lt: ['$balance', 0] }, '$balance', 0] } } } }]),
            Vendor.countDocuments({ business: id, isActive: true }),
            Supply.countDocuments({ business: id }),
            Expense.countDocuments({ business: id }),
            Bill.countDocuments({ business: id, type: 'sale', status: 'completed' }),
            computeBillStats(id, 'today'),
            computeCashBalance(id),
            usageFor([id]),
            Closing.findOne({ business: id }).sort({ periodEnd: -1 }).select('closingNumber periodStart periodEnd createdAt closedBy').lean(),
            RefreshToken.countDocuments({ businessId: id, expiresAt: { $gte: now } }),
        ]);
        const countBy = (rows, key) => rows.find((r) => r._id === key)?.n || 0;

        res.json({
            business: {
                businessId: id,
                name: b.name,
                email: b.email || '',
                phone: b.phone || '',
                address: b.address || null,
                currency: b.currency || '',
                type,
                settings: b.settings || {},
                createdAt: b.createdAt,
                lastActiveAt: b.lastActiveAt || null,
                lastClosingAt: b.lastClosingAt || null,
            },
            subscription: subscriptionView(b),
            subscriptionHistory: [...(b.subscription?.history || [])].reverse(),
            owners,
            counts: {
                employees: employees.reduce((s, r) => s + r.n, 0),
                activeEmployees: countBy(employees, 'active'),
                products: products.reduce((s, r) => s + r.n, 0),
                activeProducts: countBy(products, true),
                lowStockProducts: lowStock,
                customers,
                vendors,
                supplies,
                expenses,
                completedBills: billsAllTime,
                activeSessions: sessions,
            },
            inventory: {
                units: inventory[0]?.units || 0,
                costValue: round2(inventory[0]?.cost),
                retailValue: round2(inventory[0]?.retail),
            },
            customersBalance: {
                owedToShop: round2(outstanding[0]?.owed),
                creditHeld: round2(-(outstanding[0]?.credit || 0)),
            },
            cash,
            today: { stats, usage: usage.get(String(id)) || EMPTY_USAGE },
            lastClosing,
        });
    } catch (error) {
        console.error('[Platform] business detail', error);
        res.status(500).json({ message: 'Failed to load business' });
    }
};

/** GET /platform/businesses/:businessId/activity?days=30 — one row per local day */
export const getBusinessActivity = async (req, res) => {
    try {
        const days = parseDays(req.query.days, 30);
        if (days === null) return res.status(400).json({ message: 'days must be a whole number from 1 to 180' });
        const id = req.shop._id;
        const from = startOfToday();
        from.setDate(from.getDate() - (days - 1));
        const tz = getTimezone();
        const fromKey = toLocalDateString(from);

        const [bills, returns, usage] = await Promise.all([
            Bill.aggregate([
                { $match: { business: id, type: 'sale', status: { $in: ['completed', 'cancelled'] }, createdAt: { $gte: from } } },
                {
                    $group: {
                        _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } }, status: '$status' },
                        count: { $sum: 1 },
                        total: { $sum: '$total' },
                        profit: { $sum: '$netProfit' },
                    },
                },
            ]),
            Bill.aggregate([
                { $match: { business: id, 'returns.returnedAt': { $gte: from } } },
                { $unwind: '$returns' },
                { $match: { 'returns.returnedAt': { $gte: from } } },
                { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$returns.returnedAt', timezone: tz } }, count: { $sum: 1 }, amount: { $sum: '$returns.refundAmount' } } },
            ]),
            UsageDaily.find({ business: id, date: { $gte: fromKey } }).lean(),
        ]);

        const rows = [];
        for (let i = 0; i < days; i++) {
            const d = new Date(from);
            d.setDate(d.getDate() + i);
            const date = toLocalDateString(d);
            const done = bills.find((r) => r._id.date === date && r._id.status === 'completed') || {};
            const cancelled = bills.find((r) => r._id.date === date && r._id.status === 'cancelled') || {};
            const ret = returns.find((r) => r._id === date) || {};
            const u = usage.find((r) => r.date === date) || {};
            rows.push({
                date,
                bills: done.count || 0,
                sales: round2(done.total),
                profit: round2(done.profit),
                cancelled: cancelled.count || 0,
                returns: ret.count || 0,
                returnAmount: round2(ret.amount),
                requests: u.requests || 0,
                errors: (u.errors4xx || 0) + (u.errors5xx || 0),
                logins: u.logins || 0,
                activeUsers: (u.activeUsers || []).length,
            });
        }
        const sum = (k) => round2(rows.reduce((s, r) => s + r[k], 0));
        res.json({
            days: rows,
            totals: { bills: sum('bills'), sales: sum('sales'), profit: sum('profit'), cancelled: sum('cancelled'), returns: sum('returns'), returnAmount: sum('returnAmount'), requests: sum('requests'), errors: sum('errors'), logins: sum('logins') },
        });
    } catch (error) {
        console.error('[Platform] activity', error);
        res.status(500).json({ message: 'Failed to load activity' });
    }
};

/** GET /platform/businesses/:businessId/users — owner/admins + counter users with permissions and sessions */
export const getBusinessUsers = async (req, res) => {
    try {
        const id = req.shop._id;
        const now = new Date();
        const [admins, employees, access, sessions] = await Promise.all([
            Admin.find({ business: id }).select(SHOP_HIDDEN).sort({ createdAt: 1 }).lean(),
            Employee.find({ business: id }).select('-password -token').sort({ name: 1 }).lean(),
            Access.find({ business: id }).lean(),
            RefreshToken.aggregate([
                { $match: { businessId: id, expiresAt: { $gte: now } } },
                { $group: { _id: '$user', n: { $sum: 1 }, lastIssuedAt: { $max: '$createdAt' } } },
            ]),
        ]);
        const sess = new Map(sessions.map((s) => [String(s._id), s]));
        const perms = new Map(access.map((a) => [String(a.employee), a.permissions]));
        res.json({
            admins: admins.map((a) => ({
                id: a._id, name: a.name, email: a.email, role: a.role,
                lastLoginAt: a.lastLoginAt || null, lastActiveAt: a.lastActiveAt || null, createdAt: a.createdAt,
                activeSessions: sess.get(String(a._id))?.n || 0,
            })),
            employees: employees.map((e) => ({
                ...e,
                lastLoginAt: e.lastLoginAt || null,
                lastActiveAt: e.lastActiveAt || null,
                activeSessions: sess.get(String(e._id))?.n || 0,
                permissions: perms.get(String(e._id)) || null,
            })),
        });
    } catch (error) {
        console.error('[Platform] users', error);
        res.status(500).json({ message: 'Failed to load users' });
    }
};

/** GET /platform/businesses/:businessId/usage?days=7 — requests by area, errors, who was active */
export const getBusinessUsage = async (req, res) => {
    try {
        const days = parseDays(req.query.days, 7);
        if (days === null) return res.status(400).json({ message: 'days must be a whole number from 1 to 180' });
        const from = startOfToday();
        from.setDate(from.getDate() - (days - 1));
        const rows = await UsageDaily.find({ business: req.shop._id, date: { $gte: toLocalDateString(from) } }).sort({ date: -1 }).lean();

        const userIds = [...new Set(rows.flatMap((r) => (r.activeUsers || []).map(String)))].map(oid);
        const [admins, employees] = await Promise.all([
            Admin.find({ _id: { $in: userIds } }).select('name').lean(),
            Employee.find({ _id: { $in: userIds } }).select('name employeeId').lean(),
        ]);
        const names = new Map([
            ...admins.map((a) => [String(a._id), { name: a.name, kind: 'admin' }]),
            ...employees.map((e) => [String(e._id), { name: e.name, employeeId: e.employeeId, kind: 'employee' }]),
        ]);

        res.json({
            days: rows.map((r) => ({
                date: r.date,
                requests: r.requests || 0,
                errors4xx: r.errors4xx || 0,
                errors5xx: r.errors5xx || 0,
                blockedRequests: r.blockedRequests || 0,
                logins: r.logins || 0,
                byArea: Object.fromEntries(Object.entries(r.byArea || {}).sort((a, b) => b[1] - a[1])),
                activeUsers: (r.activeUsers || []).map((u) => ({ id: u, ...(names.get(String(u)) || { name: 'Unknown', kind: 'unknown' }) })),
            })),
        });
    } catch (error) {
        console.error('[Platform] usage', error);
        res.status(500).json({ message: 'Failed to load usage' });
    }
};

/** GET /platform/businesses/:businessId/bills-summary?date=YYYY-MM-DD (default today) */
export const getBillsSummary = async (req, res) => {
    try {
        const date = req.query.date || toLocalDateString(new Date());
        if (!isRealDate(date)) return res.status(400).json({ message: 'date must be a real date (YYYY-MM-DD)' });
        const from = startOfDay(date);
        const to = endOfDay(date);
        const tz = getTimezone();
        const match = { business: req.shop._id, type: 'sale', createdAt: { $gte: from, $lte: to } };
        // A payment counts as money taken that day only if it was taken that
        // day and is real money (not store credit moved from another bill)
        const paidOn = { $ifNull: ['$$p.paidAt', '$createdAt'] };
        const isCredit = { $ifNull: ['$$p.creditFrom', false] };
        const sumPayments = (cond) => ({
            $sum: { $map: { input: { $filter: { input: { $ifNull: ['$payments', []] }, as: 'p', cond } }, as: 'p', in: '$$p.amount' } },
        });
        const takenThatDay = { $and: [{ $gte: [paidOn, from] }, { $lte: [paidOn, to] }, { $not: [isCredit] }] };

        const [r] = await Bill.aggregate([
            { $match: match },
            {
                $facet: {
                    byStatus: [{ $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$total' } } }],
                    completed: [
                        { $match: { status: 'completed' } },
                        {
                            $group: {
                                _id: null, count: { $sum: 1 }, total: { $sum: '$total' },
                                paid: { $sum: sumPayments(takenThatDay) },
                                storeCredit: { $sum: sumPayments(isCredit) },
                                credit: { $sum: { $cond: [{ $gt: ['$amountDue', 0] }, '$amountDue', 0] } },
                                profit: { $sum: '$netProfit' }, discount: { $sum: '$totalDiscount' }, items: { $sum: '$totalQty' },
                                withCustomer: { $sum: { $cond: [{ $ifNull: ['$customer', false] }, 1, 0] } },
                                first: { $min: '$createdAt' }, last: { $max: '$createdAt' },
                            },
                        },
                    ],
                    byHour: [
                        { $match: { status: 'completed' } },
                        { $group: { _id: { $hour: { date: '$createdAt', timezone: tz } }, count: { $sum: 1 }, total: { $sum: '$total' } } },
                        { $sort: { _id: 1 } },
                    ],
                    byCashier: [
                        { $match: { status: 'completed' } },
                        { $group: { _id: { $ifNull: ['$cashierName', 'Unknown'] }, count: { $sum: 1 }, total: { $sum: '$total' } } },
                        { $sort: { total: -1 } },
                    ],
                    byMethod: [
                        { $match: { status: 'completed' } },
                        { $unwind: '$payments' },
                        {
                            $match: {
                                'payments.creditFrom': { $in: [null] },
                                $expr: {
                                    $and: [
                                        { $gte: [{ $ifNull: ['$payments.paidAt', '$createdAt'] }, from] },
                                        { $lte: [{ $ifNull: ['$payments.paidAt', '$createdAt'] }, to] },
                                    ],
                                },
                            },
                        },
                        { $group: { _id: { $ifNull: ['$payments.method', 'cash'] }, count: { $sum: 1 }, amount: { $sum: '$payments.amount' } } },
                        { $sort: { amount: -1 } },
                    ],
                },
            },
        ]);
        const c = r.completed[0] || {};
        const st = (s) => r.byStatus.find((x) => x._id === s) || {};
        res.json({
            date,
            bills: c.count || 0,
            sales: round2(c.total),
            paid: round2(c.paid),                // real money taken that day on these bills
            paidByStoreCredit: round2(c.storeCredit), // store credit moved in from other bills (not money)
            creditGiven: round2(c.credit),
            profit: round2(c.profit),
            discount: round2(c.discount),
            itemsSold: c.items || 0,
            billsWithCustomer: c.withCustomer || 0,
            firstBillAt: c.first || null,
            lastBillAt: c.last || null,
            cancelled: st('cancelled').count || 0,
            onHold: st('hold').count || 0,
            byHour: r.byHour.map((h) => ({ hour: h._id, bills: h.count, sales: round2(h.total) })),
            byCashier: r.byCashier.map((x) => ({ cashier: x._id, bills: x.count, sales: round2(x.total) })),
            byPaymentMethod: r.byMethod.map((x) => ({ method: x._id, payments: x.count, amount: round2(x.amount) })),
        });
    } catch (error) {
        console.error('[Platform] bills summary', error);
        res.status(500).json({ message: 'Failed to load bills summary' });
    }
};

// ═══ Subscription / block (superadmin) ═══════════════════════════════════════

const changeSubscription = async (req, res, { action, set, reason, details = {} }) => {
    try {
        const entry = { action, reason: reason || '', details, at: new Date(), byId: req.platformAdmin.id, byName: req.platformAdmin.name };
        const updated = await Business.findByIdAndUpdate(
            req.shop._id,
            { $set: Object.fromEntries(Object.entries(set).map(([k, v]) => [`subscription.${k}`, v])), $push: { 'subscription.history': entry } },
            { new: true }
        ).lean();
        invalidateBusinessStatus(req.shop._id);
        await audit(req, `business.${action}`, { business: req.shop, details: { reason: reason || '', ...details } });
        res.json({ businessId: updated._id, name: updated.name, subscription: subscriptionView(updated) });
    } catch (error) {
        console.error(`[Platform] ${action}`, error);
        res.status(500).json({ message: 'Failed to update the business' });
    }
};

const paidUntilOf = (v) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !isRealDate(v)) return 'invalid';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? endOfDay(String(v)) : new Date(v);
    return Number.isNaN(d.getTime()) ? 'invalid' : d;
};

/** POST /platform/businesses/:businessId/block { reason, message?, contact? } */
export const blockBusiness = (req, res) => {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ message: 'A reason is required' });
    if (statusOf(req.shop) === 'blocked') return res.status(400).json({ message: 'This business is already blocked' });
    const set = { status: 'blocked', message: String(req.body.message ?? reason).trim() };
    if (req.body.contact !== undefined) set.contact = String(req.body.contact).trim();
    return changeSubscription(req, res, { action: 'block', set, reason, details: { message: set.message, contact: set.contact } });
};

/** POST /platform/businesses/:businessId/unblock { reason? } */
export const unblockBusiness = (req, res) => {
    if (statusOf(req.shop) !== 'blocked') return res.status(400).json({ message: "This business isn't blocked" });
    return changeSubscription(req, res, { action: 'unblock', set: { status: 'active', message: '' }, reason: String(req.body.reason || '').trim() });
};

/** POST /platform/businesses/:businessId/warn { message, paidUntil?, contact? } — banner, app keeps working */
export const warnBusiness = (req, res) => {
    const message = String(req.body.message || '').trim();
    if (!message) return res.status(400).json({ message: 'A message is required' });
    const set = { status: 'warning', message };
    const paidUntil = paidUntilOf(req.body.paidUntil);
    if (paidUntil === 'invalid') return res.status(400).json({ message: 'paidUntil must be a date (YYYY-MM-DD)' });
    if (paidUntil !== undefined) set.paidUntil = paidUntil;
    if (req.body.contact !== undefined) set.contact = String(req.body.contact).trim();
    return changeSubscription(req, res, { action: 'warn', set, reason: message, details: { message, paidUntil: set.paidUntil, contact: set.contact } });
};

/** POST /platform/businesses/:businessId/clear-warning — back to active (only from warning) */
export const clearWarning = (req, res) => {
    if (statusOf(req.shop) !== 'warning') return res.status(400).json({ message: "This business doesn't have a warning" });
    return changeSubscription(req, res, { action: 'clear_warning', set: { status: 'active', message: '' }, reason: String(req.body.reason || '').trim() });
};

/** PATCH /platform/businesses/:businessId/subscription { paidUntil?, plan?, monthlyFee?, notes?, contact? } */
export const updateSubscription = (req, res) => {
    const set = {};
    const paidUntil = paidUntilOf(req.body.paidUntil);
    if (paidUntil === 'invalid') return res.status(400).json({ message: 'paidUntil must be a date (YYYY-MM-DD)' });
    if (paidUntil !== undefined) set.paidUntil = paidUntil;
    if (req.body.plan !== undefined) set.plan = String(req.body.plan).trim();
    if (req.body.monthlyFee !== undefined) {
        const fee = Number(req.body.monthlyFee);
        if (!Number.isFinite(fee) || fee < 0) return res.status(400).json({ message: 'monthlyFee must be 0 or more' });
        set.monthlyFee = fee;
    }
    if (req.body.notes !== undefined) set.notes = String(req.body.notes);
    if (req.body.contact !== undefined) set.contact = String(req.body.contact).trim();
    if (Object.keys(set).length === 0) return res.status(400).json({ message: 'Nothing to update' });
    return changeSubscription(req, res, { action: 'update', set, details: set });
};

/** POST /platform/businesses/:businessId/revoke-sessions { reason? } — logs everyone in this shop out */
export const revokeSessions = async (req, res) => {
    let at;
    let deletedCount = 0;
    try {
        // 1) Mark the time first: from now on every token issued before it —
        //    access or refresh — is refused, so nothing slips through step 2
        at = new Date();
        await Business.updateOne({ _id: req.shop._id }, { $set: { 'subscription.sessionsRevokedAt': at } });
        invalidateBusinessStatus(req.shop._id);
        // 2) Then remove the refresh tokens issued before it
        ({ deletedCount } = await RefreshToken.deleteMany({ businessId: req.shop._id, createdAt: { $lte: at } }));
    } catch (error) {
        console.error('[Platform] revoke sessions', error);
        return res.status(500).json({ message: 'Failed to end sessions' });
    }
    return changeSubscription(req, res, {
        action: 'revoke_sessions',
        set: { sessionsRevokedAt: at },
        reason: String(req.body.reason || '').trim(),
        details: { refreshTokensRemoved: deletedCount },
    });
};

// ═══ Audit log ═══════════════════════════════════════════════════════════════

/** GET /platform/audit-log?businessId=&action=&page=&limit= */
export const getAuditLog = async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
        const filter = {};
        if (req.query.businessId) {
            if (!isId(req.query.businessId)) return res.status(400).json({ message: 'Invalid businessId' });
            filter.business = oid(req.query.businessId);
        }
        if (req.query.action) filter.action = String(req.query.action);
        const [total, entries] = await Promise.all([
            PlatformAudit.countDocuments(filter),
            PlatformAudit.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        ]);
        res.json({ entries, pagination: { page, limit, total, pages: Math.ceil(total / limit), hasMore: page * limit < total } });
    } catch (error) {
        console.error('[Platform] audit log', error);
        res.status(500).json({ message: 'Failed to load audit log' });
    }
};

// ═══ Panel users (superadmin) ════════════════════════════════════════════════

/** GET /platform/admins */
export const listPlatformAdmins = async (req, res) => {
    try {
        const admins = await PlatformAdmin.find({}).sort({ createdAt: 1 }).lean();
        res.json({ admins: admins.map(publicAdmin) });
    } catch (error) {
        console.error('[Platform] list admins', error);
        res.status(500).json({ message: 'Failed to load panel users' });
    }
};

/** POST /platform/admins { name, email, password, role } */
export const createPlatformAdmin = async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        const email = String(req.body.email || '').trim().toLowerCase();
        const password = String(req.body.password || '');
        const role = req.body.role || 'support';
        if (!name || !email) return res.status(400).json({ message: 'Name and email are required' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: 'Email is not valid' });
        if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' });
        if (!['superadmin', 'support'].includes(role)) return res.status(400).json({ message: 'role must be superadmin or support' });
        if (await PlatformAdmin.exists({ email })) return res.status(409).json({ message: 'A panel user with this email already exists' });

        const admin = await PlatformAdmin.create({ name, email, role, password: await bcrypt.hash(password, 10) });
        await audit(req, 'admin.create', { details: { email, role } });
        res.status(201).json({ admin: publicAdmin(admin) });
    } catch (error) {
        console.error('[Platform] create admin', error);
        res.status(500).json({ message: 'Failed to create panel user' });
    }
};

/** PATCH /platform/admins/:adminId { name?, role?, isActive?, password? } */
export const updatePlatformAdmin = async (req, res) => {
    try {
        if (!isId(req.params.adminId)) return res.status(404).json({ message: 'Panel user not found' });
        const admin = await PlatformAdmin.findById(req.params.adminId);
        if (!admin) return res.status(404).json({ message: 'Panel user not found' });

        const changes = {};
        if (req.body.name !== undefined) changes.name = String(req.body.name).trim();
        if (req.body.role !== undefined) {
            if (!['superadmin', 'support'].includes(req.body.role)) return res.status(400).json({ message: 'role must be superadmin or support' });
            changes.role = req.body.role;
        }
        if (req.body.isActive !== undefined) {
            if (typeof req.body.isActive !== 'boolean') return res.status(400).json({ message: 'isActive must be true or false' });
            changes.isActive = req.body.isActive;
        }
        if (req.body.password !== undefined) {
            if (String(req.body.password).length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' });
        }

        // Never leave the panel without an active superadmin
        const losesSuper = admin.role === 'superadmin' && admin.isActive && (changes.role === 'support' || changes.isActive === false);
        if (losesSuper && (await PlatformAdmin.countDocuments({ role: 'superadmin', isActive: true })) <= 1) {
            return res.status(400).json({ message: 'There must be at least one active superadmin' });
        }

        // Disabled, role changed or password reset → their current sessions end
        const endSessions = req.body.password !== undefined || changes.isActive === false
            || (changes.role !== undefined && changes.role !== admin.role);
        Object.assign(admin, changes);
        if (req.body.password !== undefined) admin.password = await bcrypt.hash(String(req.body.password), 10);
        if (endSessions) admin.tokenVersion = (admin.tokenVersion || 0) + 1;
        await admin.save();
        invalidatePlatformUser(admin._id);
        await audit(req, 'admin.update', { details: { adminId: String(admin._id), email: admin.email, ...changes, passwordChanged: req.body.password !== undefined } });
        res.json({ admin: publicAdmin(admin) });
    } catch (error) {
        console.error('[Platform] update admin', error);
        res.status(500).json({ message: 'Failed to update panel user' });
    }
};
