/**
 * Integration tests for the performance/correctness fixes made across the
 * controller audit:
 *
 *   getReturns (bill.mjs)      — startDate timezone fix + safety ceiling
 *   getCustomers (customer.mjs) — limit cap [1,100] + parallel count/find
 *   getExpenseStats (expense.mjs) — parallel stats/byCategory/pendingCount
 *   getVendor (vendor.mjs)     — parallel supplies + totals aggregate
 *
 * Runs against the real configured MongoDB, same pattern as return.test.mjs.
 * Each test uses its own isolated Business. TZ pinned to Asia/Karachi (matching
 * index.mjs) BEFORE imports so the start-of-day boundary tests are deterministic.
 */

process.env.TZ = "Asia/Karachi";

import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import Bill from "../models/bill.mjs";
import Business from "../models/business.mjs";
import Customer from "../models/customer.mjs";
import Expense from "../models/expense.mjs";
import Vendor from "../models/vendor.mjs";
import Supply from "../models/supply.mjs";

import { getReturns } from "../controllers/bill.mjs";
import { getCustomers, getCustomerSummary } from "../controllers/customer.mjs";
import { getExpenseStats, getAllExpenses } from "../controllers/expense.mjs";
import { getVendor } from "../controllers/vendor.mjs";

// ─── Infrastructure ──────────────────────────────────────────────────────────

before(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
});

after(async () => {
    await mongoose.connection.close();
});

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_ADMIN_ID = new mongoose.Types.ObjectId();

const createBusiness = async () => {
    const suffix = uid();
    const b = await Business.create({
        name: `Audit Test ${suffix}`,
        businessType: new mongoose.Types.ObjectId(),
        email: `audit-${suffix}@example.test`,
    });
    return b._id;
};

const cleanupBusiness = async (businessId) => {
    await Promise.all([
        Bill.deleteMany({ business: businessId }),
        Customer.deleteMany({ business: businessId }),
        Expense.deleteMany({ business: businessId }),
        Vendor.deleteMany({ business: businessId }),
        Supply.deleteMany({ business: businessId }),
        Business.deleteOne({ _id: businessId }),
    ]);
};

/** Mock Express req; adminId set so canViewProfit() short-circuits to true. */
const mockReq = (businessId, { query = {}, params = {} } = {}) => ({
    query,
    params,
    user: { adminId: TEST_ADMIN_ID.toString(), id: TEST_ADMIN_ID, businessId, name: "Test Admin" },
});

/** Invoke a controller, capturing the raw JSON body + status (body may be an array). */
const invoke = (controllerFn, req) =>
    new Promise((resolve) => {
        let statusCode = 200;
        const res = {
            json(body) { resolve({ statusCode, body }); return this; },
            status(code) { statusCode = code; return this; },
        };
        controllerFn(req, res);
    });

let billNo = 0;
/** Insert a completed sale bill, optionally with a forced createdAt / returnStatus. */
const seedBill = async (businessId, { createdAt, returnStatus } = {}) => {
    const bill = new Bill({
        billNumber: ++billNo,
        business: businessId,
        type: "sale",
        status: "completed",
        items: [{ name: "Widget", qty: 1, price: 100, costPrice: 60 }],
        payments: [{ amount: 100, method: "cash" }],
    });
    await bill.save();
    const set = {};
    if (createdAt) set.createdAt = createdAt;       // timestamps hook overwrites — set directly
    if (returnStatus) set.returnStatus = returnStatus;
    if (Object.keys(set).length) {
        await Bill.collection.updateOne({ _id: bill._id }, { $set: set });
    }
    return bill;
};

// ═══ getReturns — timezone fix ══════════════════════════════════════════════

test("getReturns: startDate includes an early-morning return that raw-UTC parsing would drop", async () => {
    const businessId = await createBusiness();
    try {
        // Return at 02:00 local Asia/Karachi on 2026-08-30 == 2026-08-29T21:00:00Z.
        // Old code (new Date("2026-08-30") = 2026-08-30T00:00:00Z = 05:00 local) drops it;
        // fixed code (startOfDay = 00:00 local) includes it.
        await seedBill(businessId, {
            createdAt: new Date("2026-08-29T21:00:00.000Z"),
            returnStatus: "partial",
        });

        const { statusCode, body } = await invoke(
            getReturns,
            mockReq(businessId, { query: { startDate: "2026-08-30", endDate: "2026-08-30" } })
        );

        assert.equal(statusCode, 200);
        assert.ok(Array.isArray(body), "getReturns returns a bare array");
        assert.equal(body.length, 1, "early-morning return must be inside 'Today'");
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("getReturns: only bills with returnStatus != none, scoped to the date window", async () => {
    const businessId = await createBusiness();
    try {
        await seedBill(businessId, { createdAt: new Date("2026-08-30T06:00:00.000Z"), returnStatus: "partial" });
        await seedBill(businessId, { createdAt: new Date("2026-08-30T07:00:00.000Z"), returnStatus: "full" });
        await seedBill(businessId, { createdAt: new Date("2026-08-30T06:00:00.000Z") }); // no return → excluded
        await seedBill(businessId, { createdAt: new Date("2026-08-25T06:00:00.000Z"), returnStatus: "partial" }); // out of range

        const { body } = await invoke(
            getReturns,
            mockReq(businessId, { query: { startDate: "2026-08-30", endDate: "2026-08-30" } })
        );

        assert.equal(body.length, 2, "only the two in-range returned bills");
    } finally {
        await cleanupBusiness(businessId);
    }
});

// ═══ getCustomers — limit cap + parallel count/find ═════════════════════════

test("getCustomers: limit is capped at 100 even when a huge value is requested", async () => {
    const businessId = await createBusiness();
    try {
        // 101 customers so a 100-cap is observable.
        const docs = Array.from({ length: 101 }, (_, i) => ({
            name: `Cust ${String(i).padStart(3, "0")}`,
            phone: `p-${uid()}-${i}`,
            business: businessId,
        }));
        await Customer.insertMany(docs);

        const { body } = await invoke(getCustomers, mockReq(businessId, { query: { limit: "100000" } }));

        assert.equal(body.total, 101, "total reflects all customers");
        assert.equal(body.customers.length, 100, "returned page is capped at 100");
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("getCustomers: negative limit clamps to 1; pagination math stays correct", async () => {
    const businessId = await createBusiness();
    try {
        await Customer.insertMany([
            { name: "A", phone: `p-${uid()}-a`, business: businessId },
            { name: "B", phone: `p-${uid()}-b`, business: businessId },
        ]);

        const neg = await invoke(getCustomers, mockReq(businessId, { query: { limit: "-5" } }));
        assert.equal(neg.body.customers.length, 1, "negative limit clamps up to 1");
        assert.equal(neg.body.total, 2);
        assert.equal(neg.body.totalPages, 2, "ceil(2/1) = 2 pages");

        const page2 = await invoke(getCustomers, mockReq(businessId, { query: { limit: "1", page: "2" } }));
        assert.equal(page2.body.customers.length, 1);
        assert.equal(page2.body.page, 2);
    } finally {
        await cleanupBusiness(businessId);
    }
});

// ═══ getCustomerSummary — server-side KPI totals ════════════════════════════

test("getCustomerSummary: active count + summed outstanding dues (no full download)", async () => {
    const businessId = await createBusiness();
    try {
        await Customer.insertMany([
            { name: "Owes 300", phone: `p-${uid()}-1`, business: businessId, balance: 300, isActive: true },
            { name: "Owes 200", phone: `p-${uid()}-2`, business: businessId, balance: 200, isActive: true },
            { name: "Paid up", phone: `p-${uid()}-3`, business: businessId, balance: 0, isActive: true },
            { name: "Credit (neg)", phone: `p-${uid()}-4`, business: businessId, balance: -50, isActive: true },
            { name: "Inactive", phone: `p-${uid()}-5`, business: businessId, balance: 0, isActive: false },
        ]);

        const { statusCode, body } = await invoke(getCustomerSummary, mockReq(businessId));

        assert.equal(statusCode, 200);
        assert.equal(body.totalCustomers, 4, "counts active customers only");
        assert.equal(body.totalOutstandingDues, 500, "sums positive balances only (300+200)");
        assert.equal(body.customersWithDues, 2, "two customers owe money");
    } finally {
        await cleanupBusiness(businessId);
    }
});

// ═══ getExpenseStats — parallel stats/byCategory/pendingCount correctness ════

let expenseNo = 0;
const seedExpense = (businessId, { category, amount, status, date }) => ({
    expenseNumber: ++expenseNo,
    business: businessId,
    category,
    amount,
    status,
    date: date || new Date(),
});

test("getExpenseStats: totals, category breakdown, and pending count are correct", async () => {
    const businessId = await createBusiness();
    try {
        await Expense.insertMany([
            seedExpense(businessId, { category: "rent", amount: 1000, status: "approved" }),
            seedExpense(businessId, { category: "utilities", amount: 250, status: "approved" }),
            seedExpense(businessId, { category: "utilities", amount: 150, status: "approved" }),
            seedExpense(businessId, { category: "wages", amount: 5000, status: "pending" }), // not in approved totals
            seedExpense(businessId, { category: "transport", amount: 800, status: "pending" }),
        ]);

        const { body } = await invoke(getExpenseStats, mockReq(businessId));

        assert.equal(body.totalExpenses, 1400, "sum of approved only (1000+250+150)");
        assert.equal(body.expenseCount, 3, "approved count");
        assert.equal(body.pendingCount, 2, "two pending expenses");
        assert.equal(body.pendingTotal, 5800, "pending rupee total (5000+800)");

        const util = body.byCategory.find((c) => c.category === "utilities");
        assert.equal(util.total, 400, "utilities = 250+150");
        assert.equal(util.count, 2);
    } finally {
        await cleanupBusiness(businessId);
    }
});

// ═══ getAllExpenses — server-side description search ════════════════════════

test("getAllExpenses: search filters by description across the whole dataset", async () => {
    const businessId = await createBusiness();
    try {
        await Expense.insertMany([
            { ...seedExpense(businessId, { category: "rent", amount: 100, status: "approved" }), description: "Shop rent August" },
            { ...seedExpense(businessId, { category: "utilities", amount: 50, status: "approved" }), description: "Electricity bill" },
            { ...seedExpense(businessId, { category: "other", amount: 20, status: "approved" }), description: "Rent deposit refund" },
        ]);

        const { body } = await invoke(getAllExpenses, mockReq(businessId, { query: { search: "rent" } }));

        assert.equal(body.total, 2, "case-insensitive match on 'rent' (2 of 3)");
        assert.equal(body.expenses.length, 2);
        assert.ok(body.expenses.every((e) => /rent/i.test(e.description)));
    } finally {
        await cleanupBusiness(businessId);
    }
});

// ═══ getVendor — parallel supplies + totals aggregate correctness ═══════════

let supplyNo = 0;
/** Insert a supply directly (bypass hooks/validation) with pre-computed money fields. */
const seedSupply = (businessId, vendorId, { totalAmount, paidAmount }) => ({
    supplyNumber: ++supplyNo,
    business: businessId,
    vendor: vendorId,
    type: "purchase",
    billDate: new Date(),
    totalAmount,
    paidAmount,
    remainingAmount: totalAmount - paidAmount,
    items: [],
    createdAt: new Date(),
    updatedAt: new Date(),
});

test("getVendor: returns the vendor's supplies plus correctly aggregated totals", async () => {
    const businessId = await createBusiness();
    try {
        const vendor = await Vendor.create({ name: `Vendor ${uid()}`, business: businessId });
        await Supply.collection.insertMany([
            seedSupply(businessId, vendor._id, { totalAmount: 1000, paidAmount: 400 }),
            seedSupply(businessId, vendor._id, { totalAmount: 500, paidAmount: 500 }),
        ]);

        const { statusCode, body } = await invoke(
            getVendor,
            mockReq(businessId, { params: { id: vendor._id.toString() } })
        );

        assert.equal(statusCode, 200);
        assert.equal(body.supplies.length, 2, "both supplies listed");
        assert.equal(body.totalBusiness, 1500, "1000 + 500");
        assert.equal(body.totalPaid, 900, "400 + 500");
        assert.equal(body.totalRemaining, 600, "600 + 0");
        assert.equal(body.supplyCount, 2);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("getVendor: 404 for a vendor that does not belong to the business", async () => {
    const businessId = await createBusiness();
    try {
        const { statusCode } = await invoke(
            getVendor,
            mockReq(businessId, { params: { id: new mongoose.Types.ObjectId().toString() } })
        );
        assert.equal(statusCode, 404);
    } finally {
        await cleanupBusiness(businessId);
    }
});
