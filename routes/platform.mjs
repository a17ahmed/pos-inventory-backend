import express from 'express';
import rateLimit from 'express-rate-limit';
import { platformAuth, requireSuperadmin } from '../middleware/platformAuth.mjs';
import {
    platformLogin, platformLogout, platformMe, platformChangePassword,
    getOverview, listBusinesses, loadBusiness, getBusinessDetail, getBusinessActivity,
    getBusinessUsers, getBusinessUsage, getBillsSummary,
    blockBusiness, unblockBusiness, warnBusiness, clearWarning, updateSubscription, revokeSessions,
    getAuditLog, listPlatformAdmins, createPlatformAdmin, updatePlatformAdmin, isRealDate,
} from '../controllers/platform.mjs';

// Shop read endpoints, reused as-is (same numbers the shop sees)
import {
    getAllBills, getBill, getHoldBills, getBillStats, getTopProducts, getReturns, getReturnsSummary,
    salesByProduct, salesByCategory, salesByCashier, paymentMethodReport, taxReport,
    customerSalesReport, discountReport, returnAnalysis, salesTimeline, profitReport,
} from '../controllers/bill.mjs';
import {
    getAllProducts, getProduct, getCategories, getLowStockProducts, getStockMovements,
    getInventoryValuation, getDeadStock, getStockReport,
} from '../controllers/product.mjs';
import { getCustomers, getCustomerSummary, getCustomer, getCustomerLedger } from '../controllers/customer.mjs';
import { getCustomerStatement, getPendingBills } from '../controllers/customerStatement.mjs';
import { getCustomerRates } from '../controllers/customerRates.mjs';
import { getAllVendors, getVendor, getVendorLedger } from '../controllers/vendor.mjs';
import { getAllSupplies, getSupply, getSupplyStats } from '../controllers/supply.mjs';
import { getAllExpenses, getExpense, getExpenseStats } from '../controllers/expense.mjs';
import { getCashBook, getCurrentBalance, getCashBookSummary } from '../controllers/cashbook.mjs';
import { getClosings, getLastClosing, getClosingById } from '../controllers/closing.mjs';
import { getAllEmployees, getEmployeeById } from '../controllers/employee.mjs';
import { getAllAccess } from '../controllers/access.mjs';
import { getDashboardSummary } from '../controllers/dashboard.mjs';
import { getBusinessSettings } from '../controllers/admin.mjs';

/**
 * Run a shop GET handler as that shop's admin (full view, profit included).
 * `params` maps the handler's param names to this route's, e.g. { id: 'billId' }.
 * Only read-only handlers are wired below — nothing here can change shop data.
 */
const DATE_PARAMS = ['startDate', 'endDate', 'from', 'to', 'date'];
const isDateParam = (v) =>
    isRealDate(v) || (/^\d{4}-\d{2}-\d{2}T/.test(String(v)) && !Number.isNaN(new Date(v).getTime()));

const asShop = (handler, params = {}) => (req, res) => {
    // A bad date would otherwise reach the shop handler and fail with a 500
    const bad = DATE_PARAMS.find((k) => req.query[k] !== undefined && req.query[k] !== '' && !isDateParam(req.query[k]));
    if (bad) return res.status(400).json({ message: `${bad} must be a real date (YYYY-MM-DD)` });

    const routeParams = req.params;
    req.user = {
        adminId: req.platformAdmin.id,
        id: req.platformAdmin.id,
        businessId: String(req.shop._id),
        name: `Platform: ${req.platformAdmin.name}`,
        role: 'admin',
        platform: true,
    };
    req.params = Object.fromEntries(Object.entries(params).map(([to, from]) => [to, routeParams[from]]));
    return handler(req, res);
};

/**
 * Optional paging for a shop endpoint that returns a bare array (products).
 * Only when ?page= or ?limit= is sent → { [key]: [...], pagination }; otherwise
 * the plain array, exactly as the shop app gets it.
 */
const withPaging = (handler, key) => (req, res) => {
    if (req.query.page === undefined && req.query.limit === undefined) return handler(req, res);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const json = res.json.bind(res);
    res.json = (body) => {
        if (!Array.isArray(body)) return json(body);
        const total = body.length;
        return json({
            [key]: body.slice((page - 1) * limit, page * limit),
            pagination: { page, limit, total, pages: Math.ceil(total / limit), hasMore: page * limit < total },
        });
    };
    return handler(req, res);
};

const platformRouter = express.Router();

// Rate limits are per panel user (and per email for sign-in), not per IP: all
// panel traffic arrives from the panel's own server, i.e. one IP.
const limitHeaders = { standardHeaders: true, legacyHeaders: false };
const loginLimiter = rateLimit({
    ...limitHeaders,
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.PLATFORM_LOGIN_RATE_LIMIT_MAX) || 10,
    keyGenerator: (req) => `login:${String(req.body?.email || '').trim().toLowerCase()}`,
    message: { message: 'Too many sign-in attempts. Please try again later.', code: 'RATE_LIMITED' },
});
const userLimiter = rateLimit({
    ...limitHeaders,
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.PLATFORM_RATE_LIMIT_MAX) || 3000,
    keyGenerator: (req) => `panel:${req.platformAdmin.id}`,
    message: { message: 'Too many requests. Please slow down.', code: 'RATE_LIMITED' },
});

// ── Auth ───────────────────────────────────────────────────────
platformRouter.post('/auth/login', loginLimiter, platformLogin);

platformRouter.use(platformAuth, userLimiter);
platformRouter.post('/auth/logout', platformLogout);
platformRouter.get('/auth/me', platformMe);
platformRouter.post('/auth/change-password', platformChangePassword);

// ── Platform-wide ──────────────────────────────────────────────
platformRouter.get('/overview', getOverview);
platformRouter.get('/businesses', listBusinesses);
platformRouter.get('/audit-log', getAuditLog);

// ── Panel users (superadmin) ───────────────────────────────────
platformRouter.get('/admins', requireSuperadmin, listPlatformAdmins);
platformRouter.post('/admins', requireSuperadmin, createPlatformAdmin);
platformRouter.patch('/admins/:adminId', requireSuperadmin, updatePlatformAdmin);

// ── One shop ───────────────────────────────────────────────────
const shop = express.Router({ mergeParams: true });
platformRouter.use('/businesses/:businessId', loadBusiness, shop);

shop.get('/', getBusinessDetail);
shop.get('/activity', getBusinessActivity);
shop.get('/users', getBusinessUsers);
shop.get('/usage', getBusinessUsage);
shop.get('/bills-summary', getBillsSummary);

// Subscription controls (superadmin)
shop.post('/block', requireSuperadmin, blockBusiness);
shop.post('/unblock', requireSuperadmin, unblockBusiness);
shop.post('/warn', requireSuperadmin, warnBusiness);
shop.post('/clear-warning', requireSuperadmin, clearWarning);
shop.patch('/subscription', requireSuperadmin, updateSubscription);
shop.post('/revoke-sessions', requireSuperadmin, revokeSessions);

// Shop data (read-only, reused shop endpoints)
shop.get('/dashboard', asShop(getDashboardSummary));
shop.get('/settings', asShop(getBusinessSettings));

shop.get('/bills', asShop(getAllBills));
shop.get('/bills/stats', asShop(getBillStats));
shop.get('/bills/hold', asShop(getHoldBills));
shop.get('/bills/top-products', asShop(getTopProducts));
shop.get('/bills/:billId', asShop(getBill, { id: 'billId' }));
shop.get('/returns', asShop(getReturns));
shop.get('/returns/today-summary', asShop(getReturnsSummary));

const REPORTS = {
    'sales-by-product': salesByProduct,
    'sales-by-category': salesByCategory,
    'sales-by-cashier': salesByCashier,
    'payment-methods': paymentMethodReport,
    tax: taxReport,
    'customer-sales': customerSalesReport,
    discounts: discountReport,
    returns: returnAnalysis,
    timeline: salesTimeline,
    profit: profitReport,
};
for (const [name, handler] of Object.entries(REPORTS)) shop.get(`/reports/${name}`, asShop(handler));

shop.get('/products', asShop(withPaging(getAllProducts, 'products')));
shop.get('/products/categories', asShop(getCategories));
shop.get('/products/low-stock', asShop(getLowStockProducts));
shop.get('/products/stock-movements', asShop(getStockMovements));
shop.get('/products/report/valuation', asShop(getInventoryValuation));
shop.get('/products/report/dead-stock', asShop(getDeadStock));
shop.get('/products/report/stock', asShop(getStockReport));
shop.get('/products/:productId', asShop(getProduct, { id: 'productId' }));

shop.get('/customers', asShop(getCustomers));
shop.get('/customers/summary', asShop(getCustomerSummary));
shop.get('/customers/:customerId', asShop(getCustomer, { id: 'customerId' }));
shop.get('/customers/:customerId/ledger', asShop(getCustomerLedger, { id: 'customerId' }));
shop.get('/customers/:customerId/statement', asShop(getCustomerStatement, { id: 'customerId' }));
shop.get('/customers/:customerId/pending-bills', asShop(getPendingBills, { id: 'customerId' }));
shop.get('/customers/:customerId/rates', asShop(getCustomerRates, { id: 'customerId' }));

shop.get('/vendors', asShop(getAllVendors));
shop.get('/vendors/:vendorId', asShop(getVendor, { id: 'vendorId' }));
shop.get('/vendors/:vendorId/ledger', asShop(getVendorLedger, { id: 'vendorId' }));
shop.get('/supplies', asShop(getAllSupplies));
shop.get('/supplies/stats', asShop(getSupplyStats));
shop.get('/supplies/:supplyId', asShop(getSupply, { id: 'supplyId' }));

shop.get('/expenses', asShop(getAllExpenses));
shop.get('/expenses/stats', asShop(getExpenseStats));
shop.get('/expenses/:expenseId', asShop(getExpense, { id: 'expenseId' }));

shop.get('/cashbook', asShop(getCashBook));
shop.get('/cashbook/balance', asShop(getCurrentBalance));
shop.get('/cashbook/summary', asShop(getCashBookSummary));

shop.get('/closings', asShop(getClosings));
shop.get('/closings/last', asShop(getLastClosing));
shop.get('/closings/:closingId', asShop(getClosingById, { id: 'closingId' }));

shop.get('/employees', asShop(getAllEmployees));
shop.get('/employees/access', asShop(getAllAccess));
shop.get('/employees/:employeeId', asShop(getEmployeeById, { id: 'employeeId' }));

shop.use((req, res) => res.status(404).json({ message: 'Not found' }));

export default platformRouter;
