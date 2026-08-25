import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import Bill from "../models/bill.mjs";
import Business from "../models/business.mjs";
import Customer from "../models/customer.mjs";
import CashBook from "../models/cashbook.mjs";
import Counter from "../models/counter.mjs";
import { computeClosing, withTenderCounts } from "../controllers/closing.mjs";
import { recordCashEntry } from "../controllers/cashbook.mjs";

// ─── Test infra ─────────────────────────────────────────────────────────────
// Integration tests against the real configured MongoDB (no mocking layer in
// this codebase). Every test creates its own disposable Business (and
// Customers/Bills under it) with a unique id, and tears it down in a
// try/finally — never touches any other business's data.

before(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
});

after(async () => {
    await mongoose.connection.close();
});

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const createBusiness = async () => {
    const suffix = uid();
    const business = await Business.create({
        name: `Closing Test ${suffix}`,
        businessType: new mongoose.Types.ObjectId(),
        email: `closing-test-${suffix}@example.test`,
    });
    return business._id;
};

const createCustomer = async (businessId, overrides = {}) => {
    const suffix = uid();
    const customer = await Customer.create({
        business: businessId,
        name: overrides.name || "Test Customer",
        phone: overrides.phone || `test-${suffix}`,
    });
    return customer._id;
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
 * Saves a real Bill through the model (pre/post-save hooks run, so totals,
 * amountPaid/amountDue, and Customer.balance are computed exactly as in
 * production) with an explicit createdAt for deterministic period placement.
 *
 * Payments without an explicit paidAt default to the bill's own createdAt —
 * NOT Mongoose's real Date.now(), which would stamp them with the actual
 * wall-clock test-run time regardless of the historical createdAt these
 * fixtures use.
 */
const saveBill = async ({ business, customer = null, customerName = "Walk-in", createdAt, items, payments = [], returns = [] }) => {
    const normalizedPayments = payments.map((p) => ({ paidAt: createdAt, ...p }));
    const bill = new Bill({
        billNumber: nextBillNumber(business),
        business,
        customer,
        customerName,
        type: "sale",
        status: "completed",
        items,
        payments: normalizedPayments,
        returns,
        createdAt,
    });
    await bill.save();
    return bill;
};

// Force a payment's stored paidAt to a specific instant, bypassing hooks —
// simulates the exact sub-document-construction-vs-save timing skew that
// production code produces naturally (see effectivePaidAt in closing.mjs).
const forcePaymentPaidAt = async (billId, paymentIndex, paidAt) => {
    await Bill.updateOne({ _id: billId }, { $set: { [`payments.${paymentIndex}.paidAt`]: paidAt } });
};

const addReturn = async (billId, returnEntry) => {
    const bill = await Bill.findById(billId);
    bill.returns.push(returnEntry);
    await bill.save();
    return bill;
};

const addPayment = async (billId, payment) => {
    const bill = await Bill.findById(billId);
    bill.payments.push(payment);
    await bill.save();
    return bill;
};

const item = (overrides = {}) => ({
    name: "Widget",
    qty: 1,
    price: 100,
    costPrice: 60,
    ...overrides,
});

// ─── Tests ──────────────────────────────────────────────────────────────────

test("regression: same-request payment stamped before the bill's own createdAt is not excluded from creditExtended", async () => {
    const businessId = await createBusiness();
    try {
        const customerId = await createCustomer(businessId);
        const createdAt = new Date("2026-01-10T10:00:00.000Z");
        const bill = await saveBill({
            business: businessId,
            customer: customerId,
            createdAt,
            items: [item({ price: 1000, costPrice: 600, qty: 1 })],
            payments: [{ amount: 1000, method: "cash" }],
        });

        // Reproduce the exact skew: payment recorded 500ms before the bill's
        // own createdAt (mirrors what createBill's shared `now` variable
        // naturally produces relative to Mongoose's save-time timestamp).
        const skewedPaidAt = new Date(createdAt.getTime() - 500);
        await forcePaymentPaidAt(bill._id, 0, skewedPaidAt);

        // periodStart set exactly to the bill's own createdAt — the exact
        // boundary condition that triggered the reported bug.
        const result = await computeClosing(businessId, createdAt, new Date(createdAt.getTime() + 60000));

        assert.equal(result.totalOrders, 1);
        assert.equal(result.creditExtended, 0, "the at-sale payment must still count as in-period despite the ms-level clock skew");
        assert.equal(result.bills[0].amountPaid, 1000);
        assert.equal(result.bills[0].creditAmount, 0);
        assert.equal(result.settlementTotal, result.netSales);
        assert.equal(result.reconciled, true);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("regression: reproduces the exact reported scenario end-to-end (creditExtended == outstandingReceivable on a first-ever closing)", async () => {
    const businessId = await createBusiness();
    try {
        const customerId = await createCustomer(businessId, { name: "test C" });
        const base = new Date("2026-02-01T09:00:00.000Z");

        // Bill 1: walk-in, fully paid, payment stamped just before its own
        // createdAt (the boundary bill — mirrors the original bug report).
        const b1 = await saveBill({
            business: businessId,
            createdAt: base,
            items: [item({ price: 400, costPrice: 360, qty: 1 })],
            payments: [{ amount: 400, method: "cash" }],
        });
        await forcePaymentPaidAt(b1._id, 0, new Date(base.getTime() - 324));

        // Several customer bills, some fully paid, some partial/unpaid credit.
        await saveBill({
            business: businessId, customer: customerId, customerName: "test C",
            createdAt: new Date(base.getTime() + 1000),
            items: [item({ price: 200, costPrice: 180, qty: 1 })],
        }); // fully unpaid credit: 200
        await saveBill({
            business: businessId, customer: customerId, customerName: "test C",
            createdAt: new Date(base.getTime() + 2000),
            items: [item({ price: 2750, costPrice: 2500, qty: 1 })],
            payments: [{ amount: 1000, method: "cash" }],
        }); // partial: 1750 credit
        await saveBill({
            business: businessId, customer: customerId, customerName: "test C",
            createdAt: new Date(base.getTime() + 3000),
            items: [item({ price: 500, costPrice: 400, qty: 1 })],
            payments: [{ amount: 500, method: "cash" }],
        }); // fully paid: 0 credit

        const periodStart = base;
        const periodEnd = new Date(base.getTime() + 3600000);
        const result = await computeClosing(businessId, periodStart, periodEnd);

        const customer = await Customer.findById(customerId).lean();

        assert.equal(result.creditExtended, customer.balance, "creditExtended must match the real customer ledger balance");
        assert.equal(result.outstandingReceivable, customer.balance);
        assert.equal(result.collectionsReceived, 0, "no pre-period bills exist, so nothing to collect against");
        assert.equal(result.creditExtended - result.collectionsReceived, result.outstandingReceivable);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("walk-in bill with an unpaid remainder is excluded from creditExtended/outstandingReceivable but still visible in bills[]", async () => {
    const businessId = await createBusiness();
    try {
        const createdAt = new Date("2026-03-01T12:00:00.000Z");
        await saveBill({
            business: businessId,
            createdAt,
            items: [item({ price: 500, costPrice: 300, qty: 1 })],
            payments: [{ amount: 300, method: "cash" }],
        });

        const result = await computeClosing(businessId, createdAt, new Date(createdAt.getTime() + 60000));

        assert.equal(result.creditExtended, 0, "walk-in credit has no ledger to collect against");
        assert.equal(result.outstandingReceivable, 0);
        assert.equal(result.cashSales, 300);
        assert.equal(result.netSales, 500);
        // The unpaid 200 has nowhere to go — it surfaces as an honest gap.
        assert.equal(result.reconciliationDifference, 200);
        assert.equal(result.reconciled, false);

        assert.equal(result.bills.length, 1);
        assert.equal(result.bills[0].billTotal, 500);
        assert.equal(result.bills[0].amountPaid, 300);
        assert.equal(result.bills[0].creditAmount, 200, "line-item detail stays truthful even though excluded from the aggregate");
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("a later same-period top-up payment reduces creditExtended to zero once the bill is fully paid", async () => {
    const businessId = await createBusiness();
    try {
        const customerId = await createCustomer(businessId);
        const createdAt = new Date("2026-04-01T08:00:00.000Z");
        const bill = await saveBill({
            business: businessId,
            customer: customerId,
            createdAt,
            items: [item({ price: 1000, costPrice: 700, qty: 1 })],
            payments: [{ amount: 400, method: "cash" }],
        });

        await addPayment(bill._id, { amount: 600, method: "card", paidAt: new Date(createdAt.getTime() + 2 * 86400000) });

        const periodStart = createdAt;
        const periodEnd = new Date(createdAt.getTime() + 10 * 86400000);
        const result = await computeClosing(businessId, periodStart, periodEnd);

        assert.equal(result.creditExtended, 0);
        assert.equal(result.cashSales, 400);
        assert.equal(result.cardSales, 600);
        assert.equal(result.bills[0].amountPaid, 1000);
        assert.equal(result.settlementTotal, result.netSales);
        assert.equal(result.reconciled, true);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("a payment collected this period against a PRIOR-period bill counts as collectionsReceived, not creditExtended, and doesn't touch settlementTotal", async () => {
    const businessId = await createBusiness();
    try {
        const customerId = await createCustomer(businessId);
        const oldCreatedAt = new Date("2026-01-01T00:00:00.000Z");
        const bill = await saveBill({
            business: businessId,
            customer: customerId,
            createdAt: oldCreatedAt,
            items: [item({ price: 500, costPrice: 300, qty: 1 })],
        }); // fully unpaid credit at creation

        const periodStart = new Date("2026-05-01T00:00:00.000Z");
        const periodEnd = new Date("2026-05-02T00:00:00.000Z");
        const collectionAt = new Date("2026-05-01T12:00:00.000Z");
        await addPayment(bill._id, { amount: 500, method: "cash", paidAt: collectionAt });

        const result = await computeClosing(businessId, periodStart, periodEnd);

        assert.equal(result.totalOrders, 0, "the old bill was not created in this period");
        assert.equal(result.creditExtended, 0, "no NEW credit was extended this period");
        assert.equal(result.cashSales, 0, "collections against old bills are not a period sale settlement");
        assert.equal(result.netSales, 0);
        assert.equal(result.settlementTotal, 0);
        assert.equal(result.reconciled, true);
        assert.equal(result.collectionsReceived, 500);
        assert.equal(result.outstandingReceivable, 0, "the old bill is now fully paid as of periodEnd");
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("a ledger_adjust return on a period-created bill reduces creditExtended by the refund amount", async () => {
    const businessId = await createBusiness();
    try {
        const customerId = await createCustomer(businessId);
        const createdAt = new Date("2026-06-01T00:00:00.000Z");
        const bill = await saveBill({
            business: businessId,
            customer: customerId,
            createdAt,
            items: [item({ price: 500, costPrice: 300, qty: 1 })],
        }); // fully unpaid credit: 500

        await addReturn(bill._id, {
            returnNumber: "RET-TEST-1",
            items: [{ name: "Widget", quantity: 1, price: 500, costPrice: 300, refundAmount: 200, profitLost: 0 }],
            refundMethod: "ledger_adjust",
            refundAmount: 200,
            returnedAt: new Date(createdAt.getTime() + 3600000),
        });

        const result = await computeClosing(businessId, createdAt, new Date(createdAt.getTime() + 7200000));

        assert.equal(result.creditExtended, 300, "500 credit minus the 200 ledger_adjust refund");
        assert.equal(result.totalReturns, 200);
        assert.equal(result.netSales, 300);
        assert.equal(result.settlementTotal, 300);
        assert.equal(result.reconciled, true);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("creditExtendedByCustomer breaks the total down per customer, sorted highest first, with phone included, excluding walk-ins and fully-paid customers", async () => {
    const businessId = await createBusiness();
    try {
        const alice = await createCustomer(businessId, { name: "Alice", phone: "0300-1111111" });
        const bob = await createCustomer(businessId, { name: "Bob", phone: "0300-2222222" });
        const createdAt = new Date("2027-03-01T00:00:00.000Z");

        // Alice: two bills, 300 + 200 credit = 500 total, across 2 bills.
        await saveBill({
            business: businessId, customer: alice, customerName: "Alice", createdAt,
            items: [item({ price: 300, costPrice: 200, qty: 1 })],
        });
        await saveBill({
            business: businessId, customer: alice, customerName: "Alice",
            createdAt: new Date(createdAt.getTime() + 1000),
            items: [item({ price: 200, costPrice: 100, qty: 1 })],
        });

        // Bob: one bill, 900 credit — the largest single contributor.
        await saveBill({
            business: businessId, customer: bob, customerName: "Bob",
            createdAt: new Date(createdAt.getTime() + 2000),
            items: [item({ price: 900, costPrice: 500, qty: 1 })],
        });

        // A customer who paid in full this period contributes zero — must
        // not appear in the breakdown at all.
        const carol = await createCustomer(businessId, { name: "Carol", phone: "0300-3333333" });
        await saveBill({
            business: businessId, customer: carol, customerName: "Carol",
            createdAt: new Date(createdAt.getTime() + 3000),
            items: [item({ price: 400, costPrice: 250, qty: 1 })],
            payments: [{ amount: 400, method: "cash" }],
        });

        // A walk-in with unpaid credit must not appear either (no ledger to
        // collect against — see the walk-in exclusion test above).
        await saveBill({
            business: businessId,
            createdAt: new Date(createdAt.getTime() + 4000),
            items: [item({ price: 150, costPrice: 100, qty: 1 })],
            payments: [{ amount: 50, method: "cash" }],
        });

        const result = await computeClosing(businessId, createdAt, new Date(createdAt.getTime() + 60000));

        assert.equal(result.creditExtended, 1400, "500 (Alice) + 900 (Bob)");
        assert.equal(result.creditExtendedByCustomer.length, 2);

        const [first, second] = result.creditExtendedByCustomer;
        assert.equal(first.customerName, "Bob");
        assert.equal(first.amount, 900);
        assert.equal(first.billCount, 1);
        assert.equal(first.customerPhone, "0300-2222222");

        assert.equal(second.customerName, "Alice");
        assert.equal(second.amount, 500);
        assert.equal(second.billCount, 2);
        assert.equal(second.customerPhone, "0300-1111111");

        const names = result.creditExtendedByCustomer.map((c) => c.customerName);
        assert.ok(!names.includes("Carol"), "fully-paid customer must not appear");
        assert.ok(!names.includes("Walk-in"), "walk-in credit has no customer ledger to break down");
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("a cash refund processed this period against an OLDER period's bill is recognized by returnedAt, not the sale's own period, and still reconciles", async () => {
    const businessId = await createBusiness();
    try {
        const oldCreatedAt = new Date("2026-01-01T00:00:00.000Z");
        const bill = await saveBill({
            business: businessId,
            createdAt: oldCreatedAt,
            items: [item({ price: 500, costPrice: 300, qty: 1 })],
            payments: [{ amount: 500, method: "cash" }],
        });

        const periodStart = new Date("2026-07-01T00:00:00.000Z");
        const periodEnd = new Date("2026-07-02T00:00:00.000Z");
        await addReturn(bill._id, {
            returnNumber: "RET-TEST-2",
            items: [{ name: "Widget", quantity: 1, price: 500, costPrice: 300, refundAmount: 150, profitLost: 0 }],
            refundMethod: "cash",
            refundAmount: 150,
            returnedAt: new Date("2026-07-01T10:00:00.000Z"),
        });

        const result = await computeClosing(businessId, periodStart, periodEnd);

        assert.equal(result.totalOrders, 0);
        assert.equal(result.totalReturns, 150);
        assert.equal(result.netSales, -150);
        assert.equal(result.cashSales, -150);
        assert.equal(result.settlementTotal, -150);
        assert.equal(result.reconciliationDifference, 0);
        assert.equal(result.reconciled, true);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("store_credit tender and a same-period store_credit refund both flow through storeCreditUsed", async () => {
    const businessId = await createBusiness();
    try {
        const customerId = await createCustomer(businessId);
        const createdAt = new Date("2026-08-01T00:00:00.000Z");
        const bill = await saveBill({
            business: businessId,
            customer: customerId,
            createdAt,
            items: [item({ price: 800, costPrice: 500, qty: 1 })],
            payments: [{ amount: 800, method: "store_credit" }],
        });

        await addReturn(bill._id, {
            returnNumber: "RET-TEST-3",
            items: [{ name: "Widget", quantity: 1, price: 800, costPrice: 500, refundAmount: 100, profitLost: 0 }],
            refundMethod: "store_credit",
            refundAmount: 100,
            returnedAt: new Date(createdAt.getTime() + 3600000),
        });

        const result = await computeClosing(businessId, createdAt, new Date(createdAt.getTime() + 7200000));

        assert.equal(result.storeCreditUsed, 700);
        assert.equal(result.netSales, 700);
        assert.equal(result.creditExtended, 0);
        assert.equal(result.settlementTotal, 700);
        assert.equal(result.reconciled, true);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("empty period: everything zeroes out and reconciled is true", async () => {
    const businessId = await createBusiness();
    try {
        const result = await computeClosing(businessId, new Date("2026-09-01"), new Date("2026-09-02"));

        assert.equal(result.totalOrders, 0);
        assert.equal(result.grossSales, 0);
        assert.equal(result.netSales, 0);
        assert.equal(result.settlementTotal, 0);
        assert.equal(result.creditExtended, 0);
        assert.equal(result.collectionsReceived, 0);
        assert.equal(result.outstandingReceivable, 0);
        assert.deepEqual(result.bills, []);
        assert.equal(result.reconciled, true);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("a bill paid via two tenders is classified 'mixed' in the line-item snapshot", async () => {
    const businessId = await createBusiness();
    try {
        const customerId = await createCustomer(businessId);
        const createdAt = new Date("2026-10-01T00:00:00.000Z");
        await saveBill({
            business: businessId,
            customer: customerId,
            createdAt,
            items: [item({ price: 500, costPrice: 300, qty: 1 })],
            payments: [
                { amount: 300, method: "cash" },
                { amount: 200, method: "card" },
            ],
        });

        const result = await computeClosing(businessId, createdAt, new Date(createdAt.getTime() + 60000));

        assert.equal(result.bills[0].paymentMethod, "mixed");
        assert.equal(result.cashSales, 300);
        assert.equal(result.cardSales, 200);
        assert.equal(result.creditExtended, 0);
        assert.equal(result.reconciled, true);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("general ledger identity holds across two sequential periods: outstandingReceivable(T2) == outstandingReceivable(T1) + creditExtended(B) - collectionsReceived(B)", async () => {
    const businessId = await createBusiness();
    try {
        const customerId = await createCustomer(businessId);
        const start = new Date("2026-11-01T00:00:00.000Z");
        const t1 = new Date("2026-11-08T00:00:00.000Z");
        const t2 = new Date("2026-11-15T00:00:00.000Z");

        // Period A: one fully paid bill, one partially paid bill (900 credit remains).
        await saveBill({
            business: businessId, customer: customerId,
            createdAt: new Date(start.getTime() + 86400000),
            items: [item({ price: 400, costPrice: 250, qty: 1 })],
            payments: [{ amount: 400, method: "cash" }],
        });
        const partial = await saveBill({
            business: businessId, customer: customerId,
            createdAt: new Date(start.getTime() + 2 * 86400000),
            items: [item({ price: 1000, costPrice: 600, qty: 1 })],
            payments: [{ amount: 100, method: "cash" }],
        }); // 900 credit remains

        const periodA = await computeClosing(businessId, start, t1);
        assert.equal(periodA.creditExtended, 900);
        assert.equal(periodA.outstandingReceivable, 900);

        // Period B: collect part of the old credit, and extend new credit.
        await addPayment(partial._id, { amount: 500, method: "cash", paidAt: new Date(t1.getTime() + 86400000) }); // 500 collected against Period A's bill
        await saveBill({
            business: businessId, customer: customerId,
            createdAt: new Date(t1.getTime() + 2 * 86400000),
            items: [item({ price: 300, costPrice: 200, qty: 1 })],
        }); // 300 new credit in Period B

        const periodB = await computeClosing(businessId, t1, t2);
        assert.equal(periodB.creditExtended, 300);
        assert.equal(periodB.collectionsReceived, 500);

        const outstandingAtT2 = await computeClosing(businessId, start, t2);
        assert.equal(
            outstandingAtT2.outstandingReceivable,
            periodA.outstandingReceivable + periodB.creditExtended - periodB.collectionsReceived
        );

        const customer = await Customer.findById(customerId).lean();
        assert.equal(outstandingAtT2.outstandingReceivable, customer.balance, "must always agree with the live customer ledger");
    } finally {
        await cleanupBusiness(businessId);
    }
});

// ─── Cash reconciliation (till count vs. the cashbook ledger) ──────────────
// Unlike settlementTotal (which is algebraically guaranteed to equal netSales
// — it's just a re-partition of the same bill totals), expectedCash comes
// from an independent ledger built from real recorded cash events. Comparing
// it against a physically-counted drawer amount can genuinely disagree.

test("expectedCash is the cashbook running balance as of periodEnd, ignoring entries recorded after it", async () => {
    const businessId = await createBusiness();
    try {
        const t0 = new Date("2027-01-01T00:00:00.000Z");
        await recordCashEntry({
            type: "opening_balance", amount: 1000, direction: "in",
            description: "Opening float", businessId, performedBy: "Test",
        });
        // Mongoose's updateOne/updateMany middleware silently re-stamps
        // createdAt via its `timestamps` plugin even when it's explicitly
        // $set — go through the raw driver (.collection) to bypass that and
        // actually persist a custom historical createdAt.
        await CashBook.collection.updateMany({ business: businessId }, { $set: { createdAt: t0 } });

        await recordCashEntry({
            type: "sale_collection", amount: 500, direction: "in",
            description: "Cash sale", businessId, performedBy: "Test",
        });
        await CashBook.collection.updateOne(
            { business: businessId, type: "sale_collection" },
            { $set: { createdAt: new Date(t0.getTime() + 3600000) } }
        );

        // A withdrawal recorded AFTER periodEnd must not affect this period's
        // expected cash.
        await recordCashEntry({
            type: "manual_withdrawal", amount: 200, direction: "out",
            description: "Bank deposit", businessId, performedBy: "Test",
        });
        await CashBook.collection.updateOne(
            { business: businessId, type: "manual_withdrawal" },
            { $set: { createdAt: new Date(t0.getTime() + 2 * 86400000) } }
        );

        const periodEnd = new Date(t0.getTime() + 86400000); // 1 day in, before the withdrawal
        const result = await computeClosing(businessId, t0, periodEnd);

        assert.equal(result.expectedCash, 1500, "opening float + cash sale, excluding the later withdrawal");
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("withTenderCounts: cash — matching physical count reconciles; a shortfall surfaces as a real, non-zero variance", async () => {
    const businessId = await createBusiness();
    try {
        await recordCashEntry({
            type: "sale_collection", amount: 1000, direction: "in",
            description: "Cash sale", businessId, performedBy: "Test",
        });
        await recordCashEntry({
            type: "manual_withdrawal", amount: 300, direction: "out",
            description: "Bank deposit", businessId, performedBy: "Test",
        });

        const computed = await computeClosing(businessId, new Date(0), new Date());
        assert.equal(computed.expectedCash, 700);

        const exact = withTenderCounts(computed, { cash: 700 });
        assert.equal(exact.tenderReconciliation.cash.expected, 700);
        assert.equal(exact.tenderReconciliation.cash.variance, 0);
        assert.equal(exact.tenderReconciliation.cash.reconciled, true);

        const short = withTenderCounts(computed, { cash: 650 });
        assert.equal(short.tenderReconciliation.cash.variance, -50, "till is short by 50 — a genuine discrepancy, not a rounding artifact");
        assert.equal(short.tenderReconciliation.cash.reconciled, false);

        const over = withTenderCounts(computed, { cash: 720 });
        assert.equal(over.tenderReconciliation.cash.variance, 20);
        assert.equal(over.tenderReconciliation.cash.reconciled, false);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("withTenderCounts: card and online each check against THIS PERIOD's own settlement figure, independently of cash", async () => {
    const businessId = await createBusiness();
    try {
        const customerId = await createCustomer(businessId);
        const createdAt = new Date("2027-02-01T00:00:00.000Z");
        await saveBill({
            business: businessId, customer: customerId, createdAt,
            items: [item({ price: 1000, costPrice: 600, qty: 1 })],
            payments: [
                { amount: 400, method: "card" },
                { amount: 300, method: "online" },
                { amount: 300, method: "cash" },
            ],
        });

        const computed = await computeClosing(businessId, createdAt, new Date(createdAt.getTime() + 60000));
        assert.equal(computed.cardSales, 400);
        assert.equal(computed.upiSales, 300);

        // Bank statement matches the card total exactly, but the payment
        // gateway dashboard shows 20 less than the books expect for online.
        const result = withTenderCounts(computed, { card: 400, online: 280 });

        assert.equal(result.tenderReconciliation.card.expected, 400);
        assert.equal(result.tenderReconciliation.card.variance, 0);
        assert.equal(result.tenderReconciliation.card.reconciled, true);

        assert.equal(result.tenderReconciliation.online.expected, 300);
        assert.equal(result.tenderReconciliation.online.variance, -20);
        assert.equal(result.tenderReconciliation.online.reconciled, false);

        // Cash wasn't counted in this call — must stay unset, not silently pass.
        assert.equal(result.tenderReconciliation.cash.counted, null);
        assert.equal(result.tenderReconciliation.cash.reconciled, null);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("withTenderCounts: no counts supplied leaves every channel unset, not falsely reconciled", async () => {
    const businessId = await createBusiness();
    try {
        const computed = await computeClosing(businessId, new Date(0), new Date());
        const result = withTenderCounts(computed, {});

        for (const channel of ["cash", "card", "online"]) {
            assert.equal(result.tenderReconciliation[channel].counted, null);
            assert.equal(result.tenderReconciliation[channel].variance, null);
            assert.equal(result.tenderReconciliation[channel].reconciled, null);
        }
    } finally {
        await cleanupBusiness(businessId);
    }
});
