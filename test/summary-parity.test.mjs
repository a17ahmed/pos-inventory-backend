/**
 * PARITY tests — the whole point of the server-side summary/stats endpoints is
 * that the frontend can STOP downloading every row and summing client-side.
 * That only works if the server totals EXACTLY equal what "accumulate every
 * page and sum" would produce. These tests assert that equality directly:
 *
 *   getCustomerSummary  vs  paginate GET /customer + sum dues / count
 *   getExpenseStats     vs  paginate GET /expense   + sum approved / pending / month
 *
 * Covered scenarios: multi-page datasets (boundary correctness), mixed
 * statuses, active/inactive, date scoping, decimals (rounding), empty sets.
 *
 * TZ pinned to Asia/Karachi (matches index.mjs) so month/day boundaries are
 * deterministic. Runs against the real configured MongoDB.
 */

process.env.TZ = "Asia/Karachi";

import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import Business from "../models/business.mjs";
import Customer from "../models/customer.mjs";
import Expense from "../models/expense.mjs";
import { getCustomers, getCustomerSummary } from "../controllers/customer.mjs";
import { getAllExpenses, getExpenseStats } from "../controllers/expense.mjs";

before(async () => { await mongoose.connect(process.env.MONGODB_URI); });
after(async () => { await mongoose.connection.close(); });

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_ADMIN_ID = new mongoose.Types.ObjectId();

const createBusiness = async () => {
    const suffix = uid();
    const b = await Business.create({
        name: `Parity ${suffix}`,
        businessType: new mongoose.Types.ObjectId(),
        email: `parity-${suffix}@example.test`,
    });
    return b._id;
};

const cleanupBusiness = async (businessId) => {
    await Promise.all([
        Customer.deleteMany({ business: businessId }),
        Expense.deleteMany({ business: businessId }),
        Business.deleteOne({ _id: businessId }),
    ]);
};

const mockReq = (businessId, { query = {}, params = {} } = {}) => ({
    query,
    params,
    user: { adminId: TEST_ADMIN_ID.toString(), id: TEST_ADMIN_ID, businessId, name: "Test Admin" },
});

const invoke = (controllerFn, req) =>
    new Promise((resolve) => {
        let statusCode = 200;
        const res = {
            json(body) { resolve({ statusCode, body }); return this; },
            status(code) { statusCode = code; return this; },
        };
        controllerFn(req, res);
    });

/**
 * Mirror exactly what the frontend does: walk pages of 100 until done,
 * accumulating every row. Returns the full list + the server's reported total.
 */
const accumulateAll = async (controllerFn, businessId, itemsKey, extraQuery = {}) => {
    let page = 1;
    let all = [];
    let total = 0;
    let totalPages = 1;
    do {
        const { body } = await invoke(
            controllerFn,
            mockReq(businessId, { query: { ...extraQuery, page: String(page), limit: "100" } })
        );
        all = all.concat(body[itemsKey]);
        total = body.total;
        totalPages = body.totalPages;
        page++;
    } while (page <= totalPages);
    return { all, total };
};

const round2 = (n) => Math.round(n * 100) / 100;

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOMERS — getCustomerSummary vs accumulate GET /customer
// ═══════════════════════════════════════════════════════════════════════════

const seedCustomers = (businessId, rows) =>
    Customer.insertMany(rows.map((r, i) => ({
        name: `C${String(i).padStart(4, "0")}`,
        phone: `p-${uid()}-${i}`,
        business: businessId,
        balance: r.balance,
        isActive: r.isActive !== false,
    })));

test("customers parity: 250 rows across pages — summary == accumulate-and-sum", async () => {
    const businessId = await createBusiness();
    try {
        // 250 active customers with a deterministic spread of balances,
        // plus 10 inactive (must be excluded from BOTH count and dues).
        const rows = [];
        for (let i = 0; i < 250; i++) {
            // pattern: some owe, some paid, some in credit (negative)
            const mod = i % 5;
            const balance = mod === 0 ? 0 : mod === 1 ? 100 : mod === 2 ? 250 : mod === 3 ? -30 : 75;
            rows.push({ balance, isActive: true });
        }
        for (let i = 0; i < 10; i++) rows.push({ balance: 999, isActive: false }); // owes but inactive → excluded
        await seedCustomers(businessId, rows);

        const { statusCode, body: summary } = await invoke(getCustomerSummary, mockReq(businessId));
        assert.equal(statusCode, 200);

        // Reproduce the client-side computation over the accumulated active list.
        const { all, total } = await accumulateAll(getCustomers, businessId, "customers");
        const clientDues = all.reduce((s, c) => s + (c.balance > 0 ? c.balance : 0), 0);
        const clientWithDues = all.filter((c) => c.balance > 0).length;

        assert.equal(all.length, 250, "accumulate got all active rows (inactive excluded by default filter)");
        assert.equal(summary.totalCustomers, total, "summary count == GET /customer total");
        assert.equal(summary.totalCustomers, all.length, "summary count == accumulated active rows");
        assert.equal(summary.totalOutstandingDues, clientDues, "summary dues == client-summed dues");
        assert.equal(summary.customersWithDues, clientWithDues);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("customers parity: decimal balances agree to 2dp (currency rounding)", async () => {
    const businessId = await createBusiness();
    try {
        const rows = [
            { balance: 100.25 }, { balance: 50.75 }, { balance: 0.1 },
            { balance: 0.2 }, { balance: 999.99 }, { balance: -5.55 },
        ];
        await seedCustomers(businessId, rows);

        const { body: summary } = await invoke(getCustomerSummary, mockReq(businessId));
        const { all } = await accumulateAll(getCustomers, businessId, "customers");
        const clientDues = all.reduce((s, c) => s + (c.balance > 0 ? c.balance : 0), 0);

        assert.equal(round2(summary.totalOutstandingDues), round2(clientDues),
            "server and client dues match at 2 decimal places");
        assert.ok(Math.abs(summary.totalOutstandingDues - clientDues) < 0.005,
            "raw float difference is negligible");
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("customers parity: empty business → zeros, matches empty accumulate", async () => {
    const businessId = await createBusiness();
    try {
        const { body: summary } = await invoke(getCustomerSummary, mockReq(businessId));
        const { all, total } = await accumulateAll(getCustomers, businessId, "customers");

        assert.equal(summary.totalCustomers, 0);
        assert.equal(summary.totalOutstandingDues, 0);
        assert.equal(summary.customersWithDues, 0);
        assert.equal(total, 0);
        assert.equal(all.length, 0);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("customers parity: all balances zero/negative → dues 0 but count is right", async () => {
    const businessId = await createBusiness();
    try {
        await seedCustomers(businessId, [
            { balance: 0 }, { balance: -100 }, { balance: -0.5 }, { balance: 0 },
        ]);

        const { body: summary } = await invoke(getCustomerSummary, mockReq(businessId));
        const { all, total } = await accumulateAll(getCustomers, businessId, "customers");
        const clientDues = all.reduce((s, c) => s + (c.balance > 0 ? c.balance : 0), 0);

        assert.equal(summary.totalCustomers, total);
        assert.equal(summary.totalCustomers, 4);
        assert.equal(summary.totalOutstandingDues, 0);
        assert.equal(summary.totalOutstandingDues, clientDues);
        assert.equal(summary.customersWithDues, 0);
    } finally {
        await cleanupBusiness(businessId);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// EXPENSES — getExpenseStats vs accumulate GET /expense
// ═══════════════════════════════════════════════════════════════════════════

let expenseNo = 0;
const seedExpenses = (businessId, rows) =>
    Expense.insertMany(rows.map((r) => ({
        expenseNumber: ++expenseNo,
        business: businessId,
        category: r.category || "other",
        amount: r.amount,
        status: r.status,
        date: r.date,
    })));

// Recompute stats client-side over an accumulated expense list, using the
// SAME definitions the controller uses.
const clientExpenseStats = (all, { today, monthStart }) => {
    const approved = all.filter((e) => e.status === "approved");
    return {
        totalExpenses: approved.reduce((s, e) => s + e.amount, 0),
        expenseCount: approved.length,
        pendingCount: all.filter((e) => e.status === "pending").length,
        pendingTotal: all.filter((e) => e.status === "pending").reduce((s, e) => s + e.amount, 0),
        monthExpenses: approved
            .filter((e) => new Date(e.date) >= monthStart)
            .reduce((s, e) => s + e.amount, 0),
        todayExpenses: approved
            .filter((e) => new Date(e.date) >= today)
            .reduce((s, e) => s + e.amount, 0),
    };
};

test("expenses parity: 150 rows, mixed status/date — stats == accumulate-and-sum", async () => {
    const businessId = await createBusiness();
    try {
        const now = new Date();
        const today = new Date(now); today.setHours(0, 0, 0, 0);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const prevMonth = new Date(now.getFullYear(), now.getMonth() - 2, 15);
        const earlierThisMonth = new Date(now.getFullYear(), now.getMonth(), 1, 9, 0, 0); // 1st, 09:00

        const rows = [];
        for (let i = 0; i < 150; i++) {
            const mod = i % 3;
            const status = mod === 0 ? "approved" : mod === 1 ? "pending" : "rejected";
            // half this-month, half previous-month
            const date = i % 2 === 0 ? earlierThisMonth : prevMonth;
            rows.push({ amount: 10 + (i % 7), status, date });
        }
        await seedExpenses(businessId, rows);

        const { statusCode, body: stats } = await invoke(getExpenseStats, mockReq(businessId));
        assert.equal(statusCode, 200);

        const { all } = await accumulateAll(getAllExpenses, businessId, "expenses");
        const expected = clientExpenseStats(all, { today, monthStart });

        assert.equal(stats.totalExpenses, expected.totalExpenses, "approved total matches");
        assert.equal(stats.expenseCount, expected.expenseCount, "approved count matches");
        assert.equal(stats.pendingCount, expected.pendingCount, "pending count matches");
        assert.equal(stats.pendingTotal, expected.pendingTotal, "pending rupee total matches");
        assert.equal(stats.monthExpenses, expected.monthExpenses, "this-month approved matches");
        assert.equal(stats.todayExpenses, expected.todayExpenses, "today approved matches");
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("expenses parity: date-scoped stats == accumulate the same date-scoped list", async () => {
    const businessId = await createBusiness();
    try {
        const y = 2026, m = 5; // June 2026 (month index 5)
        await seedExpenses(businessId, [
            { amount: 100, status: "approved", date: new Date(y, m, 5) },   // in range
            { amount: 200, status: "approved", date: new Date(y, m, 20) },  // in range
            { amount: 999, status: "approved", date: new Date(y, m, 25) },  // OUT of range (after endDate)
            { amount: 50, status: "pending", date: new Date(y, m, 10) },    // in range, not approved
        ]);

        const query = { startDate: "2026-06-01", endDate: "2026-06-21" };
        const { body: stats } = await invoke(getExpenseStats, mockReq(businessId, { query }));

        // Accumulate the list with the SAME date scope, then sum approved.
        const { all } = await accumulateAll(getAllExpenses, businessId, "expenses", query);
        const clientApproved = all
            .filter((e) => e.status === "approved")
            .reduce((s, e) => s + e.amount, 0);

        assert.equal(stats.totalExpenses, 300, "only in-range approved (100+200)");
        assert.equal(stats.totalExpenses, clientApproved, "server stat == client sum over same date scope");
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("expenses parity: decimal amounts agree to 2dp", async () => {
    const businessId = await createBusiness();
    try {
        const now = new Date();
        const inMonth = new Date(now.getFullYear(), now.getMonth(), 2, 10);
        await seedExpenses(businessId, [
            { amount: 10.1, status: "approved", date: inMonth },
            { amount: 20.2, status: "approved", date: inMonth },
            { amount: 0.05, status: "approved", date: inMonth },
            { amount: 5.55, status: "pending", date: inMonth },
        ]);

        const { body: stats } = await invoke(getExpenseStats, mockReq(businessId));
        const { all } = await accumulateAll(getAllExpenses, businessId, "expenses");
        const clientApproved = all
            .filter((e) => e.status === "approved")
            .reduce((s, e) => s + e.amount, 0);

        assert.equal(round2(stats.totalExpenses), round2(clientApproved));
        assert.ok(Math.abs(stats.totalExpenses - clientApproved) < 0.005);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("expenses parity: empty business → zeros", async () => {
    const businessId = await createBusiness();
    try {
        const { body: stats } = await invoke(getExpenseStats, mockReq(businessId));
        const { all, total } = await accumulateAll(getAllExpenses, businessId, "expenses");

        assert.equal(stats.totalExpenses, 0);
        assert.equal(stats.expenseCount, 0);
        assert.equal(stats.pendingCount, 0);
        assert.equal(stats.monthExpenses, 0);
        assert.equal(total, 0);
        assert.equal(all.length, 0);
    } finally {
        await cleanupBusiness(businessId);
    }
});
