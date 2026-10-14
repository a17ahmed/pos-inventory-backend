/**
 * Integration tests for store credit settlement (utils/storeCredit.mjs) and
 * the flows that trigger it: customer returns, FIFO collection, add payment,
 * new bills, cancelling a return and cancelling a bill.
 *
 * Same pattern as the other suites: real configured MongoDB, one throwaway
 * Business per test, cleaned up afterwards.
 */

process.env.TZ = "Asia/Karachi";

import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import Bill from "../models/bill.mjs";
import Business from "../models/business.mjs";
import Customer from "../models/customer.mjs";
import CashBook from "../models/cashbook.mjs";
import Counter from "../models/counter.mjs";
import StockMovement from "../models/stockMovement.mjs";

import { processReturn, cancelReturn, cancelSaleBill, createBill, addPayment } from "../controllers/bill.mjs";
import { collectFromCustomer, getCustomerLedger } from "../controllers/customer.mjs";
import { computeClosing } from "../controllers/closing.mjs";
import { settleCustomerCredit, undoSettlementBatch } from "../utils/storeCredit.mjs";

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
        name: `Store Credit Test ${suffix}`,
        businessType: new mongoose.Types.ObjectId(),
        email: `store-credit-${suffix}@example.test`,
    });
    return b._id;
};

const cleanupBusiness = async (businessId) => {
    await Promise.all([
        Bill.deleteMany({ business: businessId }),
        Customer.deleteMany({ business: businessId }),
        CashBook.deleteMany({ business: businessId }),
        StockMovement.deleteMany({ business: businessId }),
        Counter.deleteMany({ _id: { $regex: businessId.toString() } }),
        Business.deleteOne({ _id: businessId }),
    ]);
};

const withBusiness = (fn) => async () => {
    const businessId = await createBusiness();
    try {
        await fn(businessId);
    } finally {
        await cleanupBusiness(businessId);
        delete process.env.AUTO_SETTLE_CREDIT;
    }
};

const req = (businessId, { params = {}, body = {}, query = {} } = {}) => ({
    params,
    body,
    query,
    user: { adminId: TEST_ADMIN_ID.toString(), id: TEST_ADMIN_ID.toString(), businessId: businessId.toString(), name: "Test Admin" },
});

const invoke = (controllerFn, request) =>
    new Promise((resolve, reject) => {
        let statusCode = 200;
        const res = {
            json(body) { resolve({ statusCode, body }); return this; },
            status(code) { statusCode = code; return this; },
        };
        Promise.resolve(controllerFn(request, res)).catch(reject);
    });

let billNo = 0;
let minute = 0;
/** A completed sale, created in time order (oldest first). */
const sale = async (businessId, customer, total, paid = 0) => {
    const bill = new Bill({
        billNumber: ++billNo,
        business: businessId,
        customer,
        customerName: "Ali",
        type: "sale",
        status: "completed",
        items: [{ name: `Item ${billNo}`, qty: 1, price: total, costPrice: 0 }],
        payments: paid ? [{ amount: paid, method: "cash" }] : [],
    });
    await bill.save();
    await Bill.collection.updateOne({ _id: bill._id }, { $set: { createdAt: new Date(Date.UTC(2026, 0, 1, 0, ++minute)) } });
    return bill;
};

const newCustomer = async (businessId) =>
    (await Customer.create({ business: businessId, name: "Ali", phone: uid() }))._id;

const fullReturn = (businessId, bill) =>
    invoke(processReturn, req(businessId, { params: { id: bill._id.toString() }, body: { fullReturn: true } }));

const dueOf = async (bill) => Math.round((await Bill.findById(bill._id).lean()).amountDue * 100) / 100;
const balanceOf = async (customerId) => (await Customer.findById(customerId).lean()).balance;
const recordPaymentTotal = async (businessId, customerId) => {
    const open = await Bill.find({ business: businessId, customer: customerId, status: "completed", amountDue: { $gt: 0.005 } }).lean();
    return Math.round(open.reduce((s, b) => s + b.amountDue, 0) * 100) / 100;
};

// ═══ Return → settlement ═════════════════════════════════════════════════════

test("customer return: credit pays the oldest unpaid bills; balance unchanged; Record Payment = balance", withBusiness(async (businessId) => {
    const customer = await newCustomer(businessId);
    const b100 = await sale(businessId, customer, 4000);
    const b120 = await sale(businessId, customer, 6000);
    const b150 = await sale(businessId, customer, 3000, 3000);
    assert.equal(await balanceOf(customer), 10000);

    const r = await fullReturn(businessId, b150);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.creditSettlement.map((m) => [m.fromNumber, m.toNumber, m.amount]), [[b150.billNumber, b100.billNumber, 3000]]);

    assert.equal(await balanceOf(customer), 7000, "balance = 10,000 - 3,000 return");
    assert.equal(await recordPaymentTotal(businessId, customer), 7000, "Record Payment now matches");
    assert.equal(await dueOf(b100), 1000);
    assert.equal(await dueOf(b120), 6000);
    assert.equal(await dueOf(b150), 0);

    const target = await Bill.findById(b100._id).lean();
    const credit = target.payments.find((p) => p.creditFrom);
    assert.equal(credit.method, "store_credit");
    assert.equal(credit.creditFromBillNumber, b150.billNumber);
    assert.equal(target.paymentStatus, "partial");

    const cust = await Customer.findById(customer).lean();
    assert.equal(cust.totalPaid, 3000, "totalPaid counts real money only");
    assert.equal(await CashBook.countDocuments({ business: businessId, type: { $ne: "opening_balance" } }), 0, "no cash moved");
}));

test("credit spreads across several bills, oldest first, from several sources", withBusiness(async (businessId) => {
    const customer = await newCustomer(businessId);
    const a = await sale(businessId, customer, 1000);
    const b = await sale(businessId, customer, 2000);
    const c = await sale(businessId, customer, 5000);
    const s1 = await sale(businessId, customer, 1500, 1500);
    const s2 = await sale(businessId, customer, 2000, 2000);

    await fullReturn(businessId, s1);
    await fullReturn(businessId, s2);

    assert.equal(await dueOf(a), 0);
    assert.equal(await dueOf(b), 0);
    assert.equal(await dueOf(c), 4500);
    assert.equal(await dueOf(s1), 0);
    assert.equal(await dueOf(s2), 0);
    assert.equal(await balanceOf(customer), 4500);
    assert.equal(await recordPaymentTotal(businessId, customer), 4500);
}));

test("no unpaid bills: credit stays as advance, then pays the next bill on account", withBusiness(async (businessId) => {
    const customer = await newCustomer(businessId);
    const paid = await sale(businessId, customer, 2000, 2000);
    await fullReturn(businessId, paid);
    assert.equal(await balanceOf(customer), -2000, "advance credit");
    assert.equal(await dueOf(paid), -2000);

    const r = await invoke(createBill, req(businessId, {
        body: { customer: customer.toString(), items: [{ name: "Rice", qty: 1, price: 5000 }] },
    }));
    assert.equal(r.statusCode, 201, JSON.stringify(r.body));
    assert.equal(Math.round(r.body.amountDue), 3000, "credit applied to the new bill");
    assert.ok(r.body.payments.some((p) => p.creditFrom && p.amount === 2000));
    assert.equal(await balanceOf(customer), 3000);
    assert.equal(await dueOf(paid), 0);
}));

// ═══ Record Payment / collect ════════════════════════════════════════════════

test("collect: settles credit first and can't collect more than the balance", withBusiness(async (businessId) => {
    const customer = await newCustomer(businessId);
    const b1 = await sale(businessId, customer, 4000);
    const b2 = await sale(businessId, customer, 6000);
    const ret = await sale(businessId, customer, 3000, 3000);

    // Old-style stuck credit: return processed with auto-settlement off
    process.env.AUTO_SETTLE_CREDIT = "false";
    await fullReturn(businessId, ret);
    delete process.env.AUTO_SETTLE_CREDIT;
    assert.equal(await recordPaymentTotal(businessId, customer), 10000, "stuck: Record Payment shows 10,000");
    assert.equal(await balanceOf(customer), 7000);

    const over = await invoke(collectFromCustomer, req(businessId, { params: { id: customer.toString() }, body: { amount: 10000, method: "cash" } }));
    assert.equal(over.statusCode, 400);
    assert.match(over.body.message, /exceeds total outstanding \(Rs 7000\.00\)/);

    const ok = await invoke(collectFromCustomer, req(businessId, { params: { id: customer.toString() }, body: { amount: 7000, method: "cash" } }));
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.creditSettlement.length, 1);
    assert.equal(await balanceOf(customer), 0);
    assert.equal(await dueOf(b1), 0);
    assert.equal(await dueOf(b2), 0);
}));

test("collect: settlement survives a rejected collection (rolled back together)", withBusiness(async (businessId) => {
    const customer = await newCustomer(businessId);
    await sale(businessId, customer, 4000);
    const ret = await sale(businessId, customer, 3000, 3000);
    process.env.AUTO_SETTLE_CREDIT = "false";
    await fullReturn(businessId, ret);
    delete process.env.AUTO_SETTLE_CREDIT;

    const over = await invoke(collectFromCustomer, req(businessId, { params: { id: customer.toString() }, body: { amount: 5000 } }));
    assert.equal(over.statusCode, 400);
    assert.equal(await recordPaymentTotal(businessId, customer), 4000, "nothing written when the collection is rejected");
}));

test("store_credit can't be entered by hand anywhere", withBusiness(async (businessId) => {
    const customer = await newCustomer(businessId);
    const bill = await sale(businessId, customer, 4000);
    const msg = /applied automatically/;

    const c = await invoke(collectFromCustomer, req(businessId, { params: { id: customer.toString() }, body: { amount: 100, method: "store_credit" } }));
    assert.equal(c.statusCode, 400);
    assert.match(c.body.message, msg);

    const p = await invoke(addPayment, req(businessId, { params: { id: bill._id.toString() }, body: { amount: 100, method: "store_credit" } }));
    assert.equal(p.statusCode, 400);
    assert.match(p.body.message, msg);

    const n = await invoke(createBill, req(businessId, {
        body: { customer: customer.toString(), items: [{ name: "X", qty: 1, price: 100 }], payments: [{ amount: 100, method: "store_credit" }] },
    }));
    assert.equal(n.statusCode, 400);
    assert.match(n.body.message, msg);
}));

test("add payment: settles credit first and caps at what's due", withBusiness(async (businessId) => {
    const customer = await newCustomer(businessId);
    const bill = await sale(businessId, customer, 4000);
    const ret = await sale(businessId, customer, 3000, 3000);
    process.env.AUTO_SETTLE_CREDIT = "false";
    await fullReturn(businessId, ret);
    delete process.env.AUTO_SETTLE_CREDIT;

    const over = await invoke(addPayment, req(businessId, { params: { id: bill._id.toString() }, body: { amount: 4000 } }));
    assert.equal(over.statusCode, 400);
    assert.equal(over.body.message, "Payment exceeds the amount due on this bill (Rs 1000)");

    const ok = await invoke(addPayment, req(businessId, { params: { id: bill._id.toString() }, body: { amount: 1000 } }));
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
    assert.equal(await dueOf(bill), 0);
    assert.equal(await balanceOf(customer), 0);
}));

// ═══ Undo paths ══════════════════════════════════════════════════════════════

test("cancel return: credit is taken back from the bills it paid", withBusiness(async (businessId) => {
    const customer = await newCustomer(businessId);
    const b100 = await sale(businessId, customer, 4000);
    const b150 = await sale(businessId, customer, 3000, 3000);
    await fullReturn(businessId, b150);
    assert.equal(await dueOf(b100), 1000);

    const returnId = (await Bill.findById(b150._id).lean()).returns[0]._id.toString();
    const r = await invoke(cancelReturn, req(businessId, { params: { id: b150._id.toString(), returnId } }));
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));

    assert.equal(await dueOf(b100), 4000, "credit payment removed");
    assert.equal(await dueOf(b150), 0);
    assert.equal((await Bill.findById(b100._id).lean()).payments.length, 0);
    assert.equal((await Bill.findById(b150._id).lean()).creditTransfers.length, 0);
    assert.equal(await balanceOf(customer), 4000);
}));

test("cancel a bill paid by credit: the credit goes to the next unpaid bill", withBusiness(async (businessId) => {
    const customer = await newCustomer(businessId);
    const first = await sale(businessId, customer, 2000);
    const second = await sale(businessId, customer, 5000);
    const ret = await sale(businessId, customer, 2000, 2000);
    await fullReturn(businessId, ret);
    assert.equal(await dueOf(first), 0, "credit paid the oldest bill");

    const r = await invoke(cancelSaleBill, req(businessId, { params: { id: first._id.toString() }, body: { reason: "mistake" } }));
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));

    assert.equal(await dueOf(second), 3000, "released credit moved on");
    assert.equal(await dueOf(ret), 0);
    assert.equal(await balanceOf(customer), 3000);
    assert.equal(await recordPaymentTotal(businessId, customer), 3000);
}));

// ═══ Ledger ══════════════════════════════════════════════════════════════════

test("ledger: credit move shows as 'moved from' (debit) + 'Payment for Bill' (credit); balance counts the return once", withBusiness(async (businessId) => {
    const customer = await newCustomer(businessId);
    const unpaid = await sale(businessId, customer, 4000);
    const ret = await sale(businessId, customer, 3000, 3000);
    await fullReturn(businessId, ret);

    const r = await invoke(getCustomerLedger, req(businessId, { params: { id: customer.toString() } }));
    assert.equal(r.statusCode, 200);
    const rows = r.body.ledger;

    const moved = rows.find((e) => e.type === "credit_transfer");
    assert.ok(moved, "credit-moved row");
    assert.equal(moved.debit, 3000);
    assert.equal(String(moved.billId), String(ret._id), "debit sits on the returned bill");

    const paid = rows.find((e) => e.type === "payment" && e.fromCredit);
    assert.ok(paid, "payment row from credit");
    assert.equal(paid.credit, 3000);
    assert.equal(paid.method, "store_credit");
    assert.equal(String(paid.billId), String(unpaid._id));
    assert.match(paid.description, new RegExp(`Payment for Bill #${unpaid.billNumber} \\(credit from Bill #${ret.billNumber}\\)`));

    // Per-bill debit - credit (how the desktop Record Payment window works)
    const perBill = {};
    for (const e of rows) {
        if (!e.billId) continue;
        const k = String(e.billId);
        perBill[k] = (perBill[k] || 0) + (["bill", "opening_balance"].includes(e.type) ? e.debit : 0) - (e.credit || 0);
    }
    assert.equal(perBill[String(unpaid._id)], 1000, "unpaid bill shows 1,000 left");

    // 4,000 + 3,000 - 3,000 paid - 3,000 returned = 1,000; the pair nets to zero
    assert.equal(rows[rows.length - 1].balance, 1000);
    assert.equal(r.body.summary.currentBalance, 1000);
    assert.equal(r.body.summary.totalBilled, 7000, "moved credit not counted as billed");
    assert.equal(r.body.summary.totalPaid, 3000, "only the real cash payment");
    assert.equal(r.body.summary.creditApplied, 3000);
}));

// ═══ Switch, cleanup batch and undo ══════════════════════════════════════════

test("AUTO_SETTLE_CREDIT=false: nothing moves until the cleanup runs; batch undo restores", withBusiness(async (businessId) => {
    const customer = await newCustomer(businessId);
    const b1 = await sale(businessId, customer, 4000);
    const ret = await sale(businessId, customer, 3000, 3000);

    process.env.AUTO_SETTLE_CREDIT = "false";
    const r = await fullReturn(businessId, ret);
    assert.deepEqual(r.body.creditSettlement, []);
    assert.equal(await dueOf(ret), -3000, "stuck credit, like today");

    const session = await mongoose.startSession();
    session.startTransaction();
    const moves = await settleCustomerCredit({ customerId: customer, businessId, session, batch: "cleanup-test", force: true });
    await session.commitTransaction();
    session.endSession();
    assert.equal(moves.length, 1);
    assert.equal(await dueOf(b1), 1000);
    assert.equal(await balanceOf(customer), 1000);

    const s2 = await mongoose.startSession();
    s2.startTransaction();
    const removed = await undoSettlementBatch({ customerId: customer, businessId, batch: "cleanup-test", session: s2 });
    await s2.commitTransaction();
    s2.endSession();
    assert.equal(removed, 1);
    assert.equal(await dueOf(b1), 4000);
    assert.equal(await dueOf(ret), -3000);
    assert.equal(await balanceOf(customer), 1000, "balance never changed");
}));

// ═══ Store closing ═══════════════════════════════════════════════════════════

test("store closing still reconciles with settlement (same difference as without)", withBusiness(async (businessId) => {
    const customer = await newCustomer(businessId);
    const start = new Date(Date.now() - 60 * 1000);
    const mk = async (total, paid) => {
        const b = new Bill({
            billNumber: ++billNo, business: businessId, customer, type: "sale", status: "completed",
            items: [{ name: "X", qty: 1, price: total, costPrice: 0 }],
            payments: paid ? [{ amount: paid, method: "cash" }] : [],
        });
        return b.save();
    };
    await mk(4000, 0);
    const ret = await mk(3000, 3000);

    process.env.AUTO_SETTLE_CREDIT = "false";
    await fullReturn(businessId, ret);
    const end = new Date(Date.now() + 60 * 1000);
    const without = await computeClosing(businessId, start, end);

    const session = await mongoose.startSession();
    session.startTransaction();
    await settleCustomerCredit({ customerId: customer, businessId, session, force: true });
    await session.commitTransaction();
    session.endSession();
    const withSettlement = await computeClosing(businessId, start, end);

    assert.equal(withSettlement.netSales, without.netSales);
    assert.equal(withSettlement.outstandingReceivable, without.outstandingReceivable, "moved credit not counted twice in outstanding");
    assert.equal(withSettlement.outstandingReceivable, 1000, "4,000 + 3,000 - 3,000 paid - 3,000 returned");
    assert.equal(
        Math.round(withSettlement.reconciliationDifference * 100),
        Math.round(without.reconciliationDifference * 100),
        "reconciliation unchanged by settlement"
    );
}));
