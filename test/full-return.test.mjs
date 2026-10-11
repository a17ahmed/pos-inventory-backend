/**
 * Integration tests for "full return" on POST /bill/:id/return
 * ({ fullReturn: true }) and the last-return rounding correction.
 *
 * Same pattern as return.test.mjs: real configured MongoDB, one throwaway
 * Business per test, cleaned up afterwards.
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
import { processReturn } from "../controllers/bill.mjs";
import { processReturnSchema } from "../middleware/validationSchemas.mjs";

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
        name: `Full Return Test ${suffix}`,
        businessType: new mongoose.Types.ObjectId(),
        email: `full-return-${suffix}@example.test`,
    });
    return b._id;
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

let billNo = 0;
const saveBill = async ({ business, customer = null, items, payments = [], billDiscountAmount = 0 }) => {
    const bill = new Bill({
        billNumber: ++billNo,
        business,
        customer,
        type: "sale",
        status: "completed",
        items,
        payments,
        billDiscountAmount,
    });
    await bill.save();
    return bill;
};

const mkItem = (overrides = {}) => ({
    name: "Widget",
    qty: 1,
    price: 100,
    costPrice: 60,
    gst: 0,
    discountAmount: 0,
    ...overrides,
});

const mockReq = (billId, body, businessId) => ({
    params: { id: billId.toString() },
    body,
    user: { adminId: TEST_ADMIN_ID.toString(), id: TEST_ADMIN_ID, businessId, name: "Test Admin" },
});

const callController = (controllerFn, req) =>
    new Promise((resolve) => {
        let statusCode = 200;
        const res = {
            json(data) { resolve({ statusCode, ...data }); return this; },
            status(code) { statusCode = code; return this; },
        };
        controllerFn(req, res);
    });

const withBusiness = (fn) => async () => {
    const businessId = await createBusiness();
    try {
        await fn(businessId);
    } finally {
        await cleanupBusiness(businessId);
    }
};

const threeItemBill = (businessId, extra = {}) =>
    saveBill({
        business: businessId,
        items: [
            mkItem({ name: "A", qty: 2 }),
            mkItem({ name: "B", qty: 1 }),
            mkItem({ name: "C", qty: 3 }),
        ],
        payments: [{ amount: 600, method: "cash" }],
        ...extra,
    });

// ─── Full return ─────────────────────────────────────────────────────────────

test("fullReturn on a fresh bill returns every item and marks it full", withBusiness(async (businessId) => {
    const bill = await threeItemBill(businessId);

    const r = await callController(processReturn, mockReq(bill._id, { fullReturn: true, reason: "defective" }, businessId));
    assert.equal(r.statusCode, 200, r.message);
    assert.equal(r.refundAmount, 600);

    const updated = await Bill.findById(bill._id).lean();
    assert.equal(updated.returnStatus, "full");
    assert.equal(updated.returns.length, 1);
    assert.deepEqual(updated.returns[0].items.map((i) => [i.name, i.quantity, i.reason]), [
        ["A", 2, "defective"],
        ["B", 1, "defective"],
        ["C", 3, "defective"],
    ]);
    assert.ok(updated.items.every((i) => i.returnedQty === i.qty));
}));

test("fullReturn on a partially-returned bill returns only what's left", withBusiness(async (businessId) => {
    const bill = await threeItemBill(businessId);

    // Return 1 of A and all of B first
    const partial = await callController(processReturn, mockReq(bill._id, {
        items: [
            { itemId: bill.items[0]._id.toString(), quantity: 1 },
            { itemId: bill.items[1]._id.toString(), quantity: 1 },
        ],
    }, businessId));
    assert.equal(partial.statusCode, 200);
    assert.equal((await Bill.findById(bill._id).lean()).returnStatus, "partial");

    const full = await callController(processReturn, mockReq(bill._id, { fullReturn: true }, businessId));
    assert.equal(full.statusCode, 200, full.message);
    assert.equal(full.refundAmount, 400, "1 of A + 3 of C");

    const updated = await Bill.findById(bill._id).lean();
    assert.equal(updated.returnStatus, "full");
    assert.equal(updated.returns.length, 2);
    assert.deepEqual(updated.returns[1].items.map((i) => [i.name, i.quantity, i.reason]), [
        ["A", 1, "changed_mind"],
        ["C", 3, "changed_mind"],
    ]);
}));

test("fullReturn on an already fully returned bill → 400", withBusiness(async (businessId) => {
    const bill = await threeItemBill(businessId);
    await callController(processReturn, mockReq(bill._id, { fullReturn: true }, businessId));

    const again = await callController(processReturn, mockReq(bill._id, { fullReturn: true }, businessId));
    assert.equal(again.statusCode, 400);
    assert.equal(again.message, "This bill has already been fully returned");
}));

test("fullReturn together with items → 400; neither → 400", withBusiness(async (businessId) => {
    const bill = await threeItemBill(businessId);

    const both = await callController(processReturn, mockReq(bill._id, {
        fullReturn: true,
        items: [{ itemId: bill.items[0]._id.toString(), quantity: 1 }],
    }, businessId));
    assert.equal(both.statusCode, 400);
    assert.equal(both.message, "Send either items or fullReturn, not both");

    const neither = await callController(processReturn, mockReq(bill._id, {}, businessId));
    assert.equal(neither.statusCode, 400);
    assert.equal(neither.message, "No items to return");

    const untouched = await Bill.findById(bill._id).lean();
    assert.equal(untouched.returnStatus, "none");
}));

test("fullReturn on a customer bill uses ledger_adjust like an item return", withBusiness(async (businessId) => {
    const customer = await Customer.create({ business: businessId, name: "Ali", phone: uid() });
    const bill = await threeItemBill(businessId, { customer: customer._id, payments: [] });

    const r = await callController(processReturn, mockReq(bill._id, { fullReturn: true }, businessId));
    assert.equal(r.statusCode, 200, r.message);

    const updated = await Bill.findById(bill._id).lean();
    assert.equal(updated.returns[0].refundMethod, "ledger_adjust");
    const after = await Customer.findById(customer._id).lean();
    assert.equal(after.balance, 0, "unpaid bill fully returned → nothing owed");
}));

// ─── Rounding on the last return ─────────────────────────────────────────────

test("item-by-item returns with a bill discount refund exactly the bill total", withBusiness(async (businessId) => {
    // 3 × Rs 100 with Rs 10 bill discount → total 290; each item ≈ 96.666…
    const bill = await saveBill({
        business: businessId,
        items: [mkItem({ name: "A" }), mkItem({ name: "B" }), mkItem({ name: "C" })],
        payments: [{ amount: 290, method: "cash" }],
        billDiscountAmount: 10,
    });
    assert.equal(bill.total, 290);

    const first = await callController(processReturn, mockReq(bill._id, {
        items: [{ itemId: bill.items[0]._id.toString(), quantity: 1 }],
    }, businessId));
    assert.equal(first.refundAmount, 96.67);

    const last = await callController(processReturn, mockReq(bill._id, { fullReturn: true }, businessId));
    assert.equal(last.statusCode, 200, last.message);
    assert.equal(last.refundAmount, 193.33, "290 - 96.67, not 96.67 + 96.67");

    const updated = await Bill.findById(bill._id).lean();
    const refunded = updated.returns.reduce((sum, r) => sum + r.refundAmount, 0);
    assert.equal(Math.round(refunded * 100) / 100, 290);
    const lastItems = updated.returns[1].items;
    assert.equal(Math.round(lastItems.reduce((s, i) => s + i.refundAmount, 0) * 100) / 100, 193.33,
        "item refunds add up to the entry refund");
    assert.equal(updated.amountDue, 0);
}));

// ─── Schema ──────────────────────────────────────────────────────────────────

test("schema: accepts fullReturn with a top-level reason; items payload unchanged", () => {
    assert.equal(processReturnSchema.validate({ fullReturn: true, reason: "damaged", reasonNote: "" }).error, undefined);
    assert.equal(processReturnSchema.validate({
        items: [{ itemId: new mongoose.Types.ObjectId().toString(), quantity: 1, reason: "other" }],
    }).error, undefined);
    assert.ok(processReturnSchema.validate({ fullReturn: true, reason: "nope" }).error);
});
