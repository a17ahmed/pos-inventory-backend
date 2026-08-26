/**
 * Comprehensive integration tests for the bill return / refund flow.
 *
 * Tests run against the real configured MongoDB (no mocking layer) following
 * the same pattern as closing.test.mjs. Each test creates its own isolated
 * Business so tests never touch each other's data.
 *
 * Coverage:
 *  BLOCK 1 — Model hooks: debtCancelled → totalLedgerRefunded → amountDue
 *  BLOCK 2 — Fully-paid walk-in bills (cash refund)
 *  BLOCK 3 — Partially-paid walk-in bills (the main financial-integrity bug)
 *  BLOCK 4 — Fully-unpaid walk-in bills
 *  BLOCK 5 — Customer bills (ledger_adjust, no cash moves)
 *  BLOCK 6 — Multi-item / discount / sequential-return scenarios
 *  BLOCK 7 — Validation & error paths
 *  BLOCK 8 — cancelReturn reversal
 */

import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import Bill from "../models/bill.mjs";
import Business from "../models/business.mjs";
import Customer from "../models/customer.mjs";
import CashBook from "../models/cashbook.mjs";
import Counter from "../models/counter.mjs";
import { processReturn, cancelReturn } from "../controllers/bill.mjs";

// ─── Infrastructure ──────────────────────────────────────────────────────────

before(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
});

after(async () => {
    await mongoose.connection.close();
});

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const createBusiness = async () => {
    const suffix = uid();
    const b = await Business.create({
        name: `Return Test ${suffix}`,
        businessType: new mongoose.Types.ObjectId(),
        email: `return-test-${suffix}@example.test`,
    });
    return b._id;
};

const createCustomer = async (businessId, overrides = {}) => {
    const suffix = uid();
    const c = await Customer.create({
        business: businessId,
        name: overrides.name || "Test Customer",
        phone: overrides.phone || `test-${suffix}`,
    });
    return c._id;
};

const cleanupBusiness = async (businessId) => {
    await Promise.all([
        Bill.deleteMany({ business: businessId }),
        Customer.deleteMany({ business: businessId }),
        CashBook.deleteMany({ business: businessId }),
        Counter.deleteMany({ _id: { $regex: businessId.toString() } }),
        Business.deleteOne({ _id: businessId }),
    ]);
};

const billNumberCounters = new Map();
const nextBillNumber = (businessId) => {
    const key = businessId.toString();
    const next = (billNumberCounters.get(key) || 0) + 1;
    billNumberCounters.set(key, next);
    return next;
};

/**
 * Create and save a sale bill. Pre/post-save hooks run (totals, customer
 * ledger sync) exactly as in production.
 */
const saveBill = async ({ business, customer = null, customerName = "Walk-in", items, payments = [] }) => {
    const bill = new Bill({
        billNumber: nextBillNumber(business),
        business,
        customer,
        customerName,
        type: "sale",
        status: "completed",
        items,
        payments,
    });
    await bill.save();
    return bill;
};

/** Build a bill item (pre-save hook computes itemTotal / itemProfit). */
const mkItem = (overrides = {}) => ({
    name: "Widget",
    qty: 1,
    price: 100,
    costPrice: 60,
    gst: 0,
    discountAmount: 0,
    ...overrides,
});

// A stable ObjectId used as the "logged-in admin" across all controller tests.
// Must be a real ObjectId so Mongoose's processedBy cast succeeds.
const TEST_ADMIN_ID = new mongoose.Types.ObjectId();

/**
 * Mock Express req for processReturn / cancelReturn.
 * adminId set so canViewProfit() short-circuits to true without a DB hit.
 */
const mockReq = (billId, body, businessId) => ({
    params: { id: billId.toString() },
    body,
    user: {
        adminId: TEST_ADMIN_ID.toString(),
        id: TEST_ADMIN_ID,
        businessId,
        name: "Test Admin",
    },
});

const mockReqReturn = (billId, returnItems, businessId) =>
    mockReq(billId, { items: returnItems }, businessId);

const mockReqCancelReturn = (billId, returnId, businessId) => ({
    params: { id: billId.toString(), returnId: returnId.toString() },
    user: {
        adminId: TEST_ADMIN_ID.toString(),
        id: TEST_ADMIN_ID,
        businessId,
        name: "Test Admin",
    },
});

/** Capture the JSON response from a controller function. */
const callController = (controllerFn, req) =>
    new Promise((resolve) => {
        let statusCode = 200;
        const res = {
            json(data) { resolve({ statusCode, ...data }); return this; },
            status(code) { statusCode = code; return this; },
        };
        controllerFn(req, res);
    });

/** Find the cashbook entry created for a bill return. */
const findCashRefundEntry = (businessId, billId) =>
    CashBook.findOne({
        business: businessId,
        referenceId: billId,
        type: "customer_refund",
        direction: "out",
    }).lean();

// ─── BLOCK 1: Model hook — debtCancelled feeds totalLedgerRefunded ───────────

test("model: debtCancelled = 0 on a ledger_adjust return — existing behaviour unchanged", async () => {
    const businessId = await createBusiness();
    try {
        const bill = await saveBill({
            business: businessId,
            items: [mkItem({ price: 1000, qty: 1 })],
            payments: [{ amount: 1000, method: "cash" }],
        });

        // Simulate ledger_adjust return (customer bill path)
        bill.returns.push({
            returnNumber: "RET-MODEL-1",
            items: [{ name: "Widget", quantity: 1, price: 1000, costPrice: 60, refundAmount: 1000, profitLost: 0 }],
            refundMethod: "ledger_adjust",
            refundAmount: 1000,
            debtCancelled: 0,
            returnedAt: new Date(),
        });
        const saved = await bill.save();

        assert.equal(saved.totalRefunded, 1000, "full item value");
        assert.equal(saved.totalLedgerRefunded, 1000, "ledger_adjust refundAmount contributes");
        assert.equal(saved.amountDue, -1000, "amountDue = effectiveTotal(0) - amountPaid(1000)");
        assert.equal(saved.netAmount, 0);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("model: debtCancelled > 0 on a cash return zeroes amountDue on a fully-returned partially-paid bill", async () => {
    const businessId = await createBusiness();
    try {
        // Bill: PKR 2,630 total, PKR 1,400 paid — the bug's exact reproduction case
        const bill = await saveBill({
            business: businessId,
            items: [mkItem({ price: 2630, qty: 1 })],
            payments: [{ amount: 1400, method: "cash" }],
        });

        assert.equal(bill.amountDue, 1230, "pre-return: outstanding is 1,230");

        bill.returns.push({
            returnNumber: "RET-MODEL-2",
            items: [{ name: "Widget", quantity: 1, price: 2630, costPrice: 60, refundAmount: 2630, profitLost: 0 }],
            refundMethod: "cash",
            refundAmount: 2630,
            debtCancelled: 1230,   // unpaid portion — written off
            returnedAt: new Date(),
        });
        const saved = await bill.save();

        // totalLedgerRefunded = sum(ledger_adjust refunds) + sum(debtCancelled) = 0 + 1230 = 1230
        assert.equal(saved.totalLedgerRefunded, 1230);
        // effectiveTotal = max(0, 2630 - 1230) = 1400
        // amountDue = 1400 - 1400 = 0
        assert.equal(saved.amountDue, 0, "after full return: no debt remaining");
        // netAmount uses full refundAmount
        assert.equal(saved.totalRefunded, 2630);
        assert.equal(saved.netAmount, 0);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("model: debtCancelled on a partial return reduces amountDue proportionally", async () => {
    const businessId = await createBusiness();
    try {
        // Bill: 900 total (3 items × 300), 600 paid (66.7%)
        // Return 1 item (300): debtCancelled = 300 × 33.3% = 100
        const bill = await saveBill({
            business: businessId,
            items: [
                mkItem({ name: "A", price: 300, qty: 1 }),
                mkItem({ name: "B", price: 300, qty: 1 }),
                mkItem({ name: "C", price: 300, qty: 1 }),
            ],
            payments: [{ amount: 600, method: "cash" }],
        });

        bill.returns.push({
            returnNumber: "RET-MODEL-3",
            items: [{ name: "A", quantity: 1, price: 300, costPrice: 60, refundAmount: 300, profitLost: 0 }],
            refundMethod: "cash",
            refundAmount: 300,
            debtCancelled: 100,  // 300 × (1 - 600/900)
            returnedAt: new Date(),
        });
        const saved = await bill.save();

        // effectiveTotal = max(0, 900 - 100) = 800
        // amountDue = 800 - 600 = 200
        assert.equal(saved.totalLedgerRefunded, 100);
        assert.equal(saved.amountDue, 200, "still owes for 2 remaining items, minus debt write-off");
        assert.equal(saved.netAmount, 600, "900 - 300 returned");
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("model: debtCancelled accumulates correctly across sequential returns", async () => {
    const businessId = await createBusiness();
    try {
        // Bill: 900 total, 600 paid (66.7%) — 3 items × 300
        const bill = await saveBill({
            business: businessId,
            items: [
                mkItem({ name: "A", price: 300, qty: 1 }),
                mkItem({ name: "B", price: 300, qty: 1 }),
                mkItem({ name: "C", price: 300, qty: 1 }),
            ],
            payments: [{ amount: 600, method: "cash" }],
        });

        // Return 1 (item A): debtCancelled = 100
        bill.returns.push({
            returnNumber: "RET-MODEL-4a",
            items: [{ name: "A", quantity: 1, price: 300, costPrice: 60, refundAmount: 300, profitLost: 0 }],
            refundMethod: "cash",
            refundAmount: 300,
            debtCancelled: 100,
            returnedAt: new Date(),
        });
        await bill.save();

        // Return 2 (item B): debtCancelled = 100
        const bill2 = await Bill.findById(bill._id);
        bill2.returns.push({
            returnNumber: "RET-MODEL-4b",
            items: [{ name: "B", quantity: 1, price: 300, costPrice: 60, refundAmount: 300, profitLost: 0 }],
            refundMethod: "cash",
            refundAmount: 300,
            debtCancelled: 100,
            returnedAt: new Date(),
        });
        const saved = await bill2.save();

        // totalLedgerRefunded = 100 + 100 = 200
        // effectiveTotal = 900 - 200 = 700
        // amountDue = 700 - 600 = 100
        assert.equal(saved.totalLedgerRefunded, 200);
        assert.equal(saved.amountDue, 100);
        assert.equal(saved.totalRefunded, 600);  // 300 + 300
        assert.equal(saved.netAmount, 300);       // 900 - 600
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("model: customer balance syncs via post-save hook after a return", async () => {
    const businessId = await createBusiness();
    try {
        const customerId = await createCustomer(businessId);
        const bill = await saveBill({
            business: businessId,
            customer: customerId,
            items: [mkItem({ price: 1000, qty: 1 })],
            payments: [],  // fully unpaid credit
        });

        // Customer owes 1000
        let cust = await Customer.findById(customerId).lean();
        assert.equal(cust.balance, 1000);

        // ledger_adjust return for 400 (partial return)
        bill.returns.push({
            returnNumber: "RET-MODEL-5",
            items: [{ name: "Widget", quantity: 1, price: 1000, costPrice: 60, refundAmount: 400, profitLost: 0 }],
            refundMethod: "ledger_adjust",
            refundAmount: 400,
            debtCancelled: 0,
            returnedAt: new Date(),
        });
        await bill.save();

        cust = await Customer.findById(customerId).lean();
        // effectiveTotal = 1000 - 400 = 600, amountDue = 600 - 0 = 600
        assert.equal(cust.balance, 600, "customer now owes 600");
    } finally {
        await cleanupBusiness(businessId);
    }
});

// ─── BLOCK 2: Fully-paid walk-in bills (cash refund) ─────────────────────────

test("fully-paid walk-in, full return: cashRefundAmount = full item value, debtCancelled = 0", async () => {
    const businessId = await createBusiness();
    try {
        const bill = await saveBill({
            business: businessId,
            items: [mkItem({ price: 500, qty: 2, costPrice: 200 })],
            payments: [{ amount: 1000, method: "cash" }],
        });
        assert.equal(bill.amountPaid, 1000);

        const returnItems = [{ itemId: bill.items[0]._id.toString(), quantity: 2 }];
        const result = await callController(processReturn, mockReqReturn(bill._id, returnItems, businessId));

        assert.equal(result.message, "Return processed successfully");
        assert.equal(result.refundAmount, 1000);
        assert.equal(result.cashRefundAmount, 1000, "fully paid: hand back full amount");
        assert.equal(result.debtCancelled, 0);

        const entry = await findCashRefundEntry(businessId, bill._id);
        assert.ok(entry, "cashbook entry must exist");
        assert.equal(entry.amount, 1000, "cashbook records the full 1,000");
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("fully-paid walk-in, partial return: cashRefundAmount = proportional item value", async () => {
    const businessId = await createBusiness();
    try {
        // 2 items × 300 = 600 total, fully paid
        const bill = await saveBill({
            business: businessId,
            items: [
                mkItem({ name: "A", price: 300, qty: 1 }),
                mkItem({ name: "B", price: 300, qty: 1 }),
            ],
            payments: [{ amount: 600, method: "cash" }],
        });

        // Return only item A (300)
        const returnItems = [{ itemId: bill.items[0]._id.toString(), quantity: 1 }];
        const result = await callController(processReturn, mockReqReturn(bill._id, returnItems, businessId));

        assert.equal(result.cashRefundAmount, 300, "only returning item A — 300 cash back");
        assert.equal(result.debtCancelled, 0);

        const entry = await findCashRefundEntry(businessId, bill._id);
        assert.equal(entry.amount, 300);

        // Remaining bill state
        const updated = await Bill.findById(bill._id).lean();
        assert.equal(updated.items[0].returnedQty, 1, "A is marked returned");
        assert.equal(updated.items[1].returnedQty, 0, "B is untouched");
        assert.equal(updated.returnStatus, "partial");
    } finally {
        await cleanupBusiness(businessId);
    }
});

// ─── BLOCK 3: Partially-paid walk-in bills (financial-integrity bug) ──────────

test("partially-paid walk-in, full return: cashRefundAmount capped at amountPaid, debtCancelled covers outstanding", async () => {
    const businessId = await createBusiness();
    try {
        // Exact reproduction case from the bug report
        // Bill: PKR 2,630 | paid: PKR 1,000 + PKR 400 = PKR 1,400 | outstanding: PKR 1,230
        const bill = await saveBill({
            business: businessId,
            items: [mkItem({ price: 2630, qty: 1, costPrice: 1000 })],
            payments: [
                { amount: 1000, method: "cash" },
                { amount: 400, method: "cash" },
            ],
        });
        assert.equal(bill.amountPaid, 1400);
        assert.equal(bill.amountDue, 1230);

        const returnItems = [{ itemId: bill.items[0]._id.toString(), quantity: 1 }];
        const result = await callController(processReturn, mockReqReturn(bill._id, returnItems, businessId));

        // refundAmount = full item value (drives ledger / netAmount math)
        assert.equal(result.refundAmount, 2630);
        // cashRefundAmount = only what was physically received
        assert.equal(result.cashRefundAmount, 1400, "must not hand back more than was received");
        // debtCancelled = the portion they never paid
        assert.equal(result.debtCancelled, 1230, "outstanding balance written off");

        // Cashbook: only 1,400 leaves the drawer (not 2,630)
        const entry = await findCashRefundEntry(businessId, bill._id);
        assert.ok(entry, "cashbook entry must exist");
        assert.equal(entry.amount, 1400, "cashbook must not record the never-received 1,230");

        // Bill amountDue must be 0 — no phantom debt remains
        const updated = await Bill.findById(bill._id).lean();
        assert.equal(updated.amountDue, 0, "after full return: amountDue must reach zero");
        assert.equal(updated.netAmount, 0);
        assert.equal(updated.returnStatus, "full");
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("partially-paid walk-in, partial return: cashRefundAmount is proportional to paidRatio", async () => {
    const businessId = await createBusiness();
    try {
        // Bill: 1,000 total (2 items × 500), 600 paid (60%), 400 outstanding
        const bill = await saveBill({
            business: businessId,
            items: [
                mkItem({ name: "A", price: 500, qty: 1, costPrice: 200 }),
                mkItem({ name: "B", price: 500, qty: 1, costPrice: 200 }),
            ],
            payments: [{ amount: 600, method: "cash" }],
        });

        // Return only item A (500 value).
        // paidRatio = 600/1000 = 0.6
        // cashRefundAmount = 500 × 0.6 = 300
        // debtCancelled = 500 × 0.4 = 200
        const returnItems = [{ itemId: bill.items[0]._id.toString(), quantity: 1 }];
        const result = await callController(processReturn, mockReqReturn(bill._id, returnItems, businessId));

        assert.equal(result.refundAmount, 500, "full item value for ledger");
        assert.equal(result.cashRefundAmount, 300, "60% of 500");
        assert.equal(result.debtCancelled, 200, "40% of 500");

        const entry = await findCashRefundEntry(businessId, bill._id);
        assert.equal(entry.amount, 300);

        // After returning item A:
        // effectiveTotal = 1000 - 200(debtCancelled) = 800
        // amountDue = 800 - 600 = 200  (still owe 200 for item B's unpaid portion)
        const updated = await Bill.findById(bill._id).lean();
        assert.equal(updated.amountDue, 200);
        assert.equal(updated.returnStatus, "partial");
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("partially-paid walk-in, sequential returns: second return also uses correct paidRatio", async () => {
    const businessId = await createBusiness();
    try {
        // Bill: 900 total (3 items × 300), 600 paid (66.7%)
        const bill = await saveBill({
            business: businessId,
            items: [
                mkItem({ name: "A", price: 300, qty: 1 }),
                mkItem({ name: "B", price: 300, qty: 1 }),
                mkItem({ name: "C", price: 300, qty: 1 }),
            ],
            payments: [{ amount: 600, method: "cash" }],
        });

        // Return 1: item A
        // cashRefundAmount = 300 × (600/900) = 200, debtCancelled = 100
        const r1 = await callController(
            processReturn,
            mockReqReturn(bill._id, [{ itemId: bill.items[0]._id.toString(), quantity: 1 }], businessId)
        );
        assert.equal(r1.cashRefundAmount, 200);
        assert.equal(r1.debtCancelled, 100);

        // After return 1: amountDue = max(0, 900-100) - 600 = 200
        let updated = await Bill.findById(bill._id).lean();
        assert.equal(updated.amountDue, 200);

        // Return 2: item B
        // paidRatio is still 600/900 (amountPaid unchanged)
        // cashRefundAmount = 300 × (600/900) = 200, debtCancelled = 100
        const r2 = await callController(
            processReturn,
            mockReqReturn(bill._id, [{ itemId: bill.items[1]._id.toString(), quantity: 1 }], businessId)
        );
        assert.equal(r2.cashRefundAmount, 200);
        assert.equal(r2.debtCancelled, 100);

        // After return 2: totalLedgerRefunded = 200, effectiveTotal = 700, amountDue = 700-600 = 100
        // Wait — 2 returns, each debtCancelled=100, total=200. effectiveTotal=900-200=700, amountDue=100
        updated = await Bill.findById(bill._id).lean();
        assert.equal(updated.amountDue, 100);
        assert.equal(updated.totalRefunded, 600);  // two 300-refunds
        assert.equal(updated.returnStatus, "partial");
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("partially-paid walk-in, partial qty return on a multi-qty item", async () => {
    const businessId = await createBusiness();
    try {
        // 5 units × 200 = 1000 total, 600 paid (60%)
        const bill = await saveBill({
            business: businessId,
            items: [mkItem({ name: "Widget", price: 200, qty: 5, costPrice: 80 })],
            payments: [{ amount: 600, method: "cash" }],
        });

        // Return 2 of 5 units
        // effectiveUnitPrice = 200 (no discount/tax, billRatio=1)
        // refundAmount = 2 × 200 = 400
        // cashRefundAmount = 400 × 0.6 = 240, debtCancelled = 160
        const returnItems = [{ itemId: bill.items[0]._id.toString(), quantity: 2 }];
        const result = await callController(processReturn, mockReqReturn(bill._id, returnItems, businessId));

        assert.equal(result.refundAmount, 400);
        assert.equal(result.cashRefundAmount, 240);
        assert.equal(result.debtCancelled, 160);

        const updated = await Bill.findById(bill._id).lean();
        assert.equal(updated.items[0].returnedQty, 2);
        assert.equal(updated.returnStatus, "partial");
    } finally {
        await cleanupBusiness(businessId);
    }
});

// ─── BLOCK 4: Fully-unpaid walk-in bills ─────────────────────────────────────

test("fully-unpaid walk-in, full return: cashRefundAmount = 0, no cash entry, amountDue zeroed", async () => {
    const businessId = await createBusiness();
    try {
        // Customer took items on credit (walk-in with 0 paid)
        const bill = await saveBill({
            business: businessId,
            items: [mkItem({ price: 500, qty: 1 })],
            payments: [],
        });
        assert.equal(bill.amountPaid, 0);
        assert.equal(bill.amountDue, 500);

        const returnItems = [{ itemId: bill.items[0]._id.toString(), quantity: 1 }];
        const result = await callController(processReturn, mockReqReturn(bill._id, returnItems, businessId));

        assert.equal(result.refundAmount, 500);
        assert.equal(result.cashRefundAmount, 0, "nothing was paid — nothing to hand back");
        assert.equal(result.debtCancelled, 500, "full outstanding debt written off");

        // No cashbook entry at all (cashRefundAmount = 0)
        const entry = await findCashRefundEntry(businessId, bill._id);
        assert.equal(entry, null, "no cash should leave the drawer");

        const updated = await Bill.findById(bill._id).lean();
        assert.equal(updated.amountDue, 0, "debt fully cancelled — nothing owed");
        assert.equal(updated.netAmount, 0);
    } finally {
        await cleanupBusiness(businessId);
    }
});

// ─── BLOCK 5: Customer bills (ledger_adjust — no cash moves) ─────────────────

test("customer bill, fully-paid, full return: debtCancelled = 0, customer gets store credit", async () => {
    const businessId = await createBusiness();
    try {
        const customerId = await createCustomer(businessId);
        const bill = await saveBill({
            business: businessId,
            customer: customerId,
            items: [mkItem({ price: 1000, qty: 1 })],
            payments: [{ amount: 1000, method: "cash" }],
        });

        const returnItems = [{ itemId: bill.items[0]._id.toString(), quantity: 1 }];
        const result = await callController(processReturn, mockReqReturn(bill._id, returnItems, businessId));

        assert.equal(result.debtCancelled, 0, "fully paid — no debt to cancel");
        assert.equal(result.refundAmount, 1000);
        // For ledger_adjust, cashRefundAmount equals refundAmount (no cash leaves anyway)
        assert.equal(result.cashRefundAmount, 1000);

        // No cashbook entry for ledger_adjust
        const entry = await findCashRefundEntry(businessId, bill._id);
        assert.equal(entry, null, "ledger_adjust never touches the cash drawer");

        // Customer balance: -1000 (store owes customer 1,000 in store credit)
        const cust = await Customer.findById(customerId).lean();
        assert.equal(cust.balance, -1000);

        const updated = await Bill.findById(bill._id).lean();
        assert.equal(updated.amountDue, -1000, "bill amountDue also reflects the credit");
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("customer bill, partially-paid, full return: debtCancelled = 0, customer gets credit only for what they paid", async () => {
    const businessId = await createBusiness();
    try {
        const customerId = await createCustomer(businessId);
        const bill = await saveBill({
            business: businessId,
            customer: customerId,
            items: [mkItem({ price: 2630, qty: 1, costPrice: 1000 })],
            payments: [{ amount: 1400, method: "cash" }],
        });
        assert.equal(bill.amountPaid, 1400);
        assert.equal(bill.amountDue, 1230);

        const returnItems = [{ itemId: bill.items[0]._id.toString(), quantity: 1 }];
        const result = await callController(processReturn, mockReqReturn(bill._id, returnItems, businessId));

        // ledger_adjust path: debtCancelled is always 0; the formula handles everything
        assert.equal(result.debtCancelled, 0);
        assert.equal(result.refundAmount, 2630);

        // amountDue = effectiveTotal(0) - amountPaid(1400) = -1400
        const updated = await Bill.findById(bill._id).lean();
        assert.equal(updated.amountDue, -1400, "store owes customer 1,400 (only what they paid)");

        // Customer balance = -1,400 (not -2,630; the 1,230 outstanding debt is cancelled)
        const cust = await Customer.findById(customerId).lean();
        assert.equal(cust.balance, -1400, "customer gets back exactly what they paid — no windfall");

        // No cash entry
        const entry = await findCashRefundEntry(businessId, bill._id);
        assert.equal(entry, null);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("customer bill, partially-paid, partial return: amountDue reduces correctly", async () => {
    const businessId = await createBusiness();
    try {
        const customerId = await createCustomer(businessId);
        // Bill: 2 items × 500 = 1,000 total, 600 paid
        const bill = await saveBill({
            business: businessId,
            customer: customerId,
            items: [
                mkItem({ name: "A", price: 500, qty: 1 }),
                mkItem({ name: "B", price: 500, qty: 1 }),
            ],
            payments: [{ amount: 600, method: "cash" }],
        });
        assert.equal(bill.amountDue, 400);

        // Return item A (500 value)
        const returnItems = [{ itemId: bill.items[0]._id.toString(), quantity: 1 }];
        await callController(processReturn, mockReqReturn(bill._id, returnItems, businessId));

        const updated = await Bill.findById(bill._id).lean();
        // effectiveTotal = 1000 - 500(ledger_adjust refundAmount) = 500
        // amountDue = 500 - 600 = -100 (small store credit)
        assert.equal(updated.amountDue, -100);

        const cust = await Customer.findById(customerId).lean();
        assert.equal(cust.balance, -100);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("customer bill, fully-unpaid, full return: customer balance goes to 0 — no phantom credit", async () => {
    const businessId = await createBusiness();
    try {
        const customerId = await createCustomer(businessId);
        const bill = await saveBill({
            business: businessId,
            customer: customerId,
            items: [mkItem({ price: 800, qty: 1 })],
            payments: [],  // nothing paid
        });

        let cust = await Customer.findById(customerId).lean();
        assert.equal(cust.balance, 800, "pre-return: customer owes 800");

        const returnItems = [{ itemId: bill.items[0]._id.toString(), quantity: 1 }];
        await callController(processReturn, mockReqReturn(bill._id, returnItems, businessId));

        cust = await Customer.findById(customerId).lean();
        // effectiveTotal = 800 - 800(ledger_adjust) = 0
        // amountDue = 0 - 0(amountPaid) = 0
        assert.equal(cust.balance, 0, "debt cancelled — customer owes nothing and gets nothing");

        const updated = await Bill.findById(bill._id).lean();
        assert.equal(updated.amountDue, 0);
    } finally {
        await cleanupBusiness(businessId);
    }
});

// ─── BLOCK 6: Multi-item / discount / sequential-return scenarios ─────────────

test("bill with bill-level discount: return respects effective (post-discount) unit price", async () => {
    const businessId = await createBusiness();
    try {
        // 2 items × 500 = 1,000 subtotal, 10% bill-level discount → total = 900
        // Fully paid with 900
        const bill = new Bill({
            billNumber: nextBillNumber(businessId),
            business: businessId,
            type: "sale",
            status: "completed",
            items: [
                mkItem({ name: "A", price: 500, qty: 1 }),
                mkItem({ name: "B", price: 500, qty: 1 }),
            ],
            billDiscountAmount: 100,
            payments: [{ amount: 900, method: "cash" }],
        });
        await bill.save();
        assert.equal(bill.total, 900);
        assert.equal(bill.amountPaid, 900);

        // Return item A.
        // effectiveUnitPrice for A = (500 × (900/1000)) / 1 = 450
        // refundAmount = 450
        const returnItems = [{ itemId: bill.items[0]._id.toString(), quantity: 1 }];
        const result = await callController(processReturn, mockReqReturn(bill._id, returnItems, businessId));

        assert.equal(result.refundAmount, 450, "discount is distributed — not full 500");
        assert.equal(result.cashRefundAmount, 450, "fully paid bill: cash = full item refund");
        assert.equal(result.debtCancelled, 0);

        const entry = await findCashRefundEntry(businessId, bill._id);
        assert.equal(entry.amount, 450);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("bill with GST: return includes the tax portion in refundAmount", async () => {
    const businessId = await createBusiness();
    try {
        // Item: price=100, qty=1, gst=10% (10 PKR tax) → itemTotal=100, total=110, fully paid
        const bill = new Bill({
            billNumber: nextBillNumber(businessId),
            business: businessId,
            type: "sale",
            status: "completed",
            items: [mkItem({ price: 100, qty: 1, gst: 10, costPrice: 60 })],
            payments: [{ amount: 110, method: "cash" }],
        });
        await bill.save();
        assert.equal(bill.total, 110);

        const returnItems = [{ itemId: bill.items[0]._id.toString(), quantity: 1 }];
        const result = await callController(processReturn, mockReqReturn(bill._id, returnItems, businessId));

        // itemGrossWithTax = 100 + 10 = 110, billRatio = 110/110 = 1
        // effectiveUnitPrice = 110, refundAmount = 110
        assert.equal(result.refundAmount, 110, "GST included in refund");
        assert.equal(result.cashRefundAmount, 110);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("multiple independent return events on the same bill: returnStatus transitions correctly", async () => {
    const businessId = await createBusiness();
    try {
        const bill = await saveBill({
            business: businessId,
            items: [
                mkItem({ name: "A", price: 300, qty: 1 }),
                mkItem({ name: "B", price: 300, qty: 1 }),
                mkItem({ name: "C", price: 300, qty: 1 }),
            ],
            payments: [{ amount: 900, method: "cash" }],
        });

        // Return A
        await callController(
            processReturn,
            mockReqReturn(bill._id, [{ itemId: bill.items[0]._id.toString(), quantity: 1 }], businessId)
        );
        let updated = await Bill.findById(bill._id).lean();
        assert.equal(updated.returnStatus, "partial");
        assert.equal(updated.returns.length, 1);

        // Return B
        await callController(
            processReturn,
            mockReqReturn(bill._id, [{ itemId: bill.items[1]._id.toString(), quantity: 1 }], businessId)
        );
        updated = await Bill.findById(bill._id).lean();
        assert.equal(updated.returnStatus, "partial");
        assert.equal(updated.returns.length, 2);

        // Return C — now all items returned
        await callController(
            processReturn,
            mockReqReturn(bill._id, [{ itemId: bill.items[2]._id.toString(), quantity: 1 }], businessId)
        );
        updated = await Bill.findById(bill._id).lean();
        assert.equal(updated.returnStatus, "full");
        assert.equal(updated.returns.length, 3);
        assert.equal(updated.totalRefunded, 900);
        assert.equal(updated.netAmount, 0);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("partial qty return: returnedQty on item increments correctly across two calls", async () => {
    const businessId = await createBusiness();
    try {
        // 4 units of the same item, fully paid
        const bill = await saveBill({
            business: businessId,
            items: [mkItem({ price: 100, qty: 4 })],
            payments: [{ amount: 400, method: "cash" }],
        });

        await callController(
            processReturn,
            mockReqReturn(bill._id, [{ itemId: bill.items[0]._id.toString(), quantity: 2 }], businessId)
        );
        let updated = await Bill.findById(bill._id).lean();
        assert.equal(updated.items[0].returnedQty, 2);
        assert.equal(updated.items[0].remainingQty, 2);
        assert.equal(updated.returnStatus, "partial");

        await callController(
            processReturn,
            mockReqReturn(bill._id, [{ itemId: bill.items[0]._id.toString(), quantity: 2 }], businessId)
        );
        updated = await Bill.findById(bill._id).lean();
        assert.equal(updated.items[0].returnedQty, 4);
        assert.equal(updated.items[0].remainingQty, 0);
        assert.equal(updated.returnStatus, "full");
    } finally {
        await cleanupBusiness(businessId);
    }
});

// ─── BLOCK 7: Validation & error paths ───────────────────────────────────────

test("error: return quantity exceeds remaining — 400 with informative message", async () => {
    const businessId = await createBusiness();
    try {
        const bill = await saveBill({
            business: businessId,
            items: [mkItem({ price: 100, qty: 3 })],
            payments: [{ amount: 300, method: "cash" }],
        });

        // Return 2 (success)
        await callController(
            processReturn,
            mockReqReturn(bill._id, [{ itemId: bill.items[0]._id.toString(), quantity: 2 }], businessId)
        );

        // Attempt to return 2 more (only 1 remains)
        const result = await callController(
            processReturn,
            mockReqReturn(bill._id, [{ itemId: bill.items[0]._id.toString(), quantity: 2 }], businessId)
        );
        assert.equal(result.statusCode, 400);
        assert.match(result.message, /only 1 remaining/i);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("error: return all items and then attempt another return — 0 remaining", async () => {
    const businessId = await createBusiness();
    try {
        const bill = await saveBill({
            business: businessId,
            items: [mkItem({ price: 200, qty: 1 })],
            payments: [{ amount: 200, method: "cash" }],
        });

        // First return: success
        await callController(
            processReturn,
            mockReqReturn(bill._id, [{ itemId: bill.items[0]._id.toString(), quantity: 1 }], businessId)
        );

        // Second return: must fail — nothing left to return
        const result = await callController(
            processReturn,
            mockReqReturn(bill._id, [{ itemId: bill.items[0]._id.toString(), quantity: 1 }], businessId)
        );
        assert.equal(result.statusCode, 400);
        assert.match(result.message, /only 0 remaining/i);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("error: no items in request body — 400", async () => {
    const businessId = await createBusiness();
    try {
        const bill = await saveBill({
            business: businessId,
            items: [mkItem()],
            payments: [{ amount: 100, method: "cash" }],
        });

        const result = await callController(
            processReturn,
            mockReq(bill._id, { items: [] }, businessId)
        );
        assert.equal(result.statusCode, 400);
        assert.match(result.message, /no items/i);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("error: bill not found — 404", async () => {
    const businessId = await createBusiness();
    try {
        const nonExistentId = new mongoose.Types.ObjectId();
        const result = await callController(
            processReturn,
            mockReqReturn(nonExistentId, [{ itemId: new mongoose.Types.ObjectId().toString(), quantity: 1 }], businessId)
        );
        assert.equal(result.statusCode, 404);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("error: item not found in bill — 400", async () => {
    const businessId = await createBusiness();
    try {
        const bill = await saveBill({
            business: businessId,
            items: [mkItem()],
            payments: [{ amount: 100, method: "cash" }],
        });

        const wrongItemId = new mongoose.Types.ObjectId().toString();
        const result = await callController(
            processReturn,
            mockReqReturn(bill._id, [{ itemId: wrongItemId, quantity: 1 }], businessId)
        );
        assert.equal(result.statusCode, 400);
        assert.match(result.message, /item not found in bill/i);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("error: cannot return from another business's bill — 404", async () => {
    const businessA = await createBusiness();
    const businessB = await createBusiness();
    try {
        const bill = await saveBill({
            business: businessA,
            items: [mkItem()],
            payments: [{ amount: 100, method: "cash" }],
        });

        // businessB trying to return businessA's bill
        const result = await callController(
            processReturn,
            mockReqReturn(bill._id, [{ itemId: bill.items[0]._id.toString(), quantity: 1 }], businessB)
        );
        assert.equal(result.statusCode, 404, "must not find bills from another business");
    } finally {
        await Promise.all([cleanupBusiness(businessA), cleanupBusiness(businessB)]);
    }
});

// ─── BLOCK 8: cancelReturn reversal ──────────────────────────────────────────

test("cancelReturn: removes return entry, reverses returnedQty, recalculates all totals", async () => {
    const businessId = await createBusiness();
    try {
        const bill = await saveBill({
            business: businessId,
            items: [mkItem({ price: 500, qty: 2, costPrice: 200 })],
            payments: [{ amount: 1000, method: "cash" }],
        });

        // Process a partial return (1 of 2 units)
        const returnResult = await callController(
            processReturn,
            mockReqReturn(bill._id, [{ itemId: bill.items[0]._id.toString(), quantity: 1 }], businessId)
        );
        const returnId = returnResult.bill.returns[0]._id;

        let updated = await Bill.findById(bill._id).lean();
        assert.equal(updated.items[0].returnedQty, 1);
        assert.equal(updated.totalRefunded, 500);
        assert.equal(updated.returnStatus, "partial");

        // Cancel the return
        const cancelResult = await callController(
            cancelReturn,
            mockReqCancelReturn(bill._id, returnId, businessId)
        );
        assert.equal(cancelResult.message, "Return cancelled successfully");

        updated = await Bill.findById(bill._id).lean();
        assert.equal(updated.returns.length, 0, "return entry removed");
        assert.equal(updated.items[0].returnedQty, 0, "returnedQty restored to 0");
        assert.equal(updated.totalRefunded, 0, "no more refunds on record");
        assert.equal(updated.returnStatus, "none", "back to no-return state");
        assert.equal(updated.netAmount, 1000, "full sale value restored");
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("cancelReturn: after cancellation the same items can be returned again", async () => {
    const businessId = await createBusiness();
    try {
        const bill = await saveBill({
            business: businessId,
            items: [mkItem({ price: 300, qty: 1 })],
            payments: [{ amount: 300, method: "cash" }],
        });

        // Return → cancel → return again
        const r1 = await callController(
            processReturn,
            mockReqReturn(bill._id, [{ itemId: bill.items[0]._id.toString(), quantity: 1 }], businessId)
        );
        const returnId = r1.bill.returns[0]._id;

        await callController(cancelReturn, mockReqCancelReturn(bill._id, returnId, businessId));

        const r2 = await callController(
            processReturn,
            mockReqReturn(bill._id, [{ itemId: bill.items[0]._id.toString(), quantity: 1 }], businessId)
        );
        assert.equal(r2.message, "Return processed successfully");
        assert.equal(r2.refundAmount, 300);
        assert.equal(r2.cashRefundAmount, 300);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("cancelReturn: error on non-existent returnId — 404", async () => {
    const businessId = await createBusiness();
    try {
        const bill = await saveBill({
            business: businessId,
            items: [mkItem()],
            payments: [{ amount: 100, method: "cash" }],
        });

        const fakeReturnId = new mongoose.Types.ObjectId();
        const result = await callController(
            cancelReturn,
            mockReqCancelReturn(bill._id, fakeReturnId, businessId)
        );
        assert.equal(result.statusCode, 404);
        assert.match(result.message, /return entry not found/i);
    } finally {
        await cleanupBusiness(businessId);
    }
});
