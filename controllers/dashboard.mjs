import { computeBillStats, computeTopProducts, computeSalesByProduct, computeSalesByCashier, computePaymentMethodReport } from './bill.mjs';
import { computeDeadStock, computeLowStockProducts } from './product.mjs';
import { computeCashBalance } from './cashbook.mjs';
import { computeEmployeeCount } from './employee.mjs';
import { computeSupplyStats } from './supply.mjs';
import { computeApprovedExpensesForPeriod } from './expense.mjs';

/**
 * Resolve the exact same [startDate, endDate] window the admin dashboard
 * frontend currently computes client-side and sends to the report
 * endpoints (sales-by-product, sales-by-cashier, payment-methods) and uses
 * to client-filter the expense list:
 *   today -> today 00:00:00.000 local .. now
 *   week  -> now minus 7 days (exact instant, not day-truncated) .. now
 *   month -> 1st of current month 00:00:00.000 local .. now
 *
 * Returned as Date instances. Callers that hand these to helpers built
 * around startOfDay/endOfDay (which re-parse non "YYYY-MM-DD" input via
 * `new Date(str)`) must pass `.toISOString()`, not the bare Date — string
 * coercion of a Date via template/String() drops milliseconds (its
 * toString() has second precision), which would shift the boundary by up
 * to 999ms relative to what the original endpoints compute from a raw
 * ISO string. Round-tripping through toISOString() carries full precision
 * and reconstructs the identical instant regardless of server timezone.
 */
const resolveReportWindow = (filter) => {
    const now = new Date();
    let startDate;

    switch (filter) {
        case 'week':
            startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            break;
        case 'month':
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            break;
        default: // today
            startDate = new Date(now);
            startDate.setHours(0, 0, 0, 0);
    }

    return { startDate, endDate: now };
};

/**
 * GET /v1/dashboard/summary?filter=today|week|month
 *
 * Consolidates the 11 separate calls the Admin/Owner dashboard fires on
 * load (bill stats, sales-by-product/cashier/payment-methods, expenses,
 * top products, dead stock, low stock, cash balance, employee count,
 * supply stats) into a single response.
 *
 * Every figure here is produced by calling the exact same compute*
 * function the original single-purpose endpoint uses internally, so this
 * endpoint cannot drift from GET /bill/stats, GET /product/low-stock, etc.
 * — see the compute* exports in bill.mjs / product.mjs / cashbook.mjs /
 * employee.mjs / supply.mjs / expense.mjs. None of those original routes
 * were changed; they were only refactored to share their logic with this
 * endpoint via an extracted function.
 *
 * topProducts, deadStock, lowStock, cashBalance and supplyStats are not
 * period-filtered today either (matching current behavior) — only stats,
 * expenses, salesByProduct, salesByCashier and paymentMethods vary with
 * `filter`.
 */
export const getDashboardSummary = async (req, res) => {
    try {
        const businessId = req.user.businessId;
        const filter = req.query.filter || 'today';
        const { startDate, endDate } = resolveReportWindow(filter);
        const range = { startDate: startDate.toISOString(), endDate: endDate.toISOString() };

        const [
            stats,
            expenses,
            salesByProductResult,
            salesByCashierResult,
            paymentMethodsResult,
            topProducts,
            deadStockResult,
            lowStock,
            cashBalance,
            employeeCount,
            supplyStats,
        ] = await Promise.all([
            computeBillStats(businessId, filter, true),
            computeApprovedExpensesForPeriod(businessId, startDate),
            computeSalesByProduct(businessId, range),
            computeSalesByCashier(businessId, range),
            computePaymentMethodReport(businessId, range),
            computeTopProducts(businessId, 10),
            computeDeadStock(businessId, 30),
            computeLowStockProducts(businessId),
            computeCashBalance(businessId),
            computeEmployeeCount(businessId),
            computeSupplyStats(businessId),
        ]);

        res.json({
            stats,
            expenses,
            salesByProduct: salesByProductResult.products,
            salesByCashier: salesByCashierResult.cashiers,
            paymentMethods: paymentMethodsResult.methods,
            topProducts,
            deadStock: deadStockResult,
            lowStock,
            cashBalance,
            employeeCount,
            supplyStats: { overall: supplyStats.overall },
        });
    } catch (error) {
        console.error('Error building dashboard summary:', error);
        res.status(500).json({ message: 'Failed to fetch dashboard summary' });
    }
};
