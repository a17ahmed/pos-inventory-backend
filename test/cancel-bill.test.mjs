/**
 * Integration tests for cancelling a completed sale (POST /bill/:id/cancel).
 *
 * Same pattern as the other suites: real configured MongoDB, one throwaway
 * Business per test, cleaned up afterwards. Bills are created through the
 * real createBill controller so cashbook and stock entries exist.
 */

process.env.TZ = "Asia/Karachi";

import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import Bill from "../models/bill.mjs";
import Business from "../models/business.mjs";
import Customer from "../models/customer.mjs";
import Product from "../models/product.mjs";
import CashBook from "../models/cashbook.mjs";
import Counter from "../models/counter.mjs";
import StockMovement from "../models/stockMovement.mjs";
import Access from "../models/access.mjs";

import { createBill, cancelSaleBill, processReturn } from "../controllers/bill.mjs";
import { getCustomerLedger } from "../controllers/customer.mjs";
import { invalidateAccessCache } from "../middleware/accessControl.mjs";

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
        name: `Cancel Test ${suffix}`,
        businessType: new mongoose.Types.ObjectId(),
        email: `cancel-${suffix}@example.test`,
    });
    return b._id;
};

const cleanupBusiness = async (businessId) => {
    await Promise.all([
        Bill.deleteMany({ business: businessId }),
        Customer.deleteMany({ business: businessId }),
        Product.deleteMany({ business: businessId }),
        CashBook.deleteMany({ business: businessId }),
        StockMovement.deleteMany({ business: businessId }),
        Access.deleteMany({ business: businessId }),
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
    }
};

const adminReq = (businessId, { params = {}, body = {}, query = {} } = {}) => ({
    params,
    body,
    query,
    user: { adminId: TEST_ADMIN_ID.toString(), id: TEST_ADMIN_ID.toString(), businessId: businessId.toString(), name: "Test Admin" },
});

const employeeReq = async (businessId, pos = {}) => {
    const employeeId = new mongoose.Types.ObjectId();
    await Access.create({ employee: employeeId, business: businessId, permissions: { pos: { view: true, create: true, ...pos } } });
    invalidateAccessCache(employeeId.toString(), businessId.toString());
    return (opts = {}) => ({
        params: opts.params || {},
        body: opts.body || {},
        query: opts.query || {},
        user: { id: employeeId.toString(), employeeId: employeeId.toString(), businessId: businessId.toString(), name: "Cashier", role: "employee" },
    });
};

const invoke = (controllerFn, req) =>
    new Promise((resolve, reject) => {
        let statusCode = 200;
        const res = {
            headersSent: false,
            json(body) { this.headersSent = true; resolve({ statusCode, body }); return this; },
            status(code) { statusCode = code; return this; },
        };
        Promise.resolve(controllerFn(req, res)).catch(reject);
    });

const createProduct = (businessId, overrides = {}) =>
    Product.create({
        name: `Rice ${uid()}`,
        sku: `SKU-${uid()}`,
        sellingPrice: 10000,
        costPrice: 8000,
        stockQuantity: 10,
        trackStock: true,
        business: businessId,
        ...overrides,
    });

/** Sell 1 unit through the real createBill controller. */
const sell = async (businessId, product, { customer = null, payments = [{ amount: 10000, method: "cash" }], req } = {}) => {
    const body = {
        items: [{ product: product._id.toString(), name: product.name, qty: 1, price: product.sellingPrice }],
        payments,
        ...(customer && { customer: customer.toString() }),
    };
    const r = await invoke(createBill, req ? req({ body }) : adminReq(businessId, { body }));
    assert.equal(r.statusCode, 201, JSON.stringify(r.body));
    return r.body;
};

/** A customer who already owes `owes` from an earlier unpaid bill. */
const customerOwing = async (businessId, owes) => {
    const customer = await Customer.create({ business: businessId, name: "Ali", phone: uid() });
    await new Bill({
        billNumber: 9000 + Math.floor(Math.random() * 1000),
        business: businessId,
        customer: customer._id,
        type: "sale",
        status: "completed",
        items: [{ name: "Old purchase", qty: 1, price: owes }],
    }).save();
    return customer._id;
};

const balanceOf = async (customerId) => (await Customer.findById(customerId).lean()).balance;
const stockOf = async (product) => (await Product.findById(product._id).lean()).stockQuantity;

const cancel = (businessId, billId, reason = "Created by mistake", req) =>
    invoke(cancelSaleBill, req
        ? req({ params: { id: billId.toString() }, body: { reason } })
        : adminReq(businessId, { params: { id: billId.toString() }, body: { reason } }));

// ═══ The scenario that motivated the feature ════════════════════════════════

test("cancelling a mistaken paid customer bill leaves the balance untouched (unlike a full return)", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);
    const customer = await customerOwing(businessId, 13000);

    await sell(businessId, product, { customer });                // bill 1 — real
    const mistake = await sell(businessId, product, { customer }); // bill 2 — mistake
    assert.equal(await balanceOf(customer), 13000);
    assert.equal(await stockOf(product), 8);

    const r = await cancel(businessId, mistake._id);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.cashReversed, 10000);
    assert.equal(r.body.bill.status, "cancelled");
    assert.equal(r.body.bill.cancelReason, "Created by mistake");

    assert.equal(await balanceOf(customer), 13000, "customer still owes 13,000");
    assert.equal(await stockOf(product), 9, "stock restored");

    const cashOut = await CashBook.findOne({ business: businessId, type: "sale_cancel", referenceId: mistake._id }).lean();
    assert.equal(cashOut.amount, 10000);
    assert.equal(cashOut.direction, "out");
    const cashIn = await CashBook.find({ business: businessId, type: "sale_collection" }).lean();
    const net = cashIn.reduce((s, e) => s + e.amount, 0) - cashOut.amount;
    assert.equal(net, 10000, "only bill 1's cash remains");

    const movement = await StockMovement.findOne({ business: businessId, type: "bill_cancel" }).lean();
    assert.equal(movement.quantity, 1);
}));

test("full return on the same bill shows the old problem (balance drops to 3,000)", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);
    const customer = await customerOwing(businessId, 13000);
    await sell(businessId, product, { customer });
    const mistake = await sell(businessId, product, { customer });

    await invoke(processReturn, adminReq(businessId, { params: { id: mistake._id.toString() }, body: { fullReturn: true } }));
    assert.equal(await balanceOf(customer), 3000, "return credits the customer — use cancel for mistakes");
}));

test("walk-in cash bill: cancel reverses the cash and restores stock", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);
    const bill = await sell(businessId, product);

    const r = await cancel(businessId, bill._id);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.cashReversed, 10000);
    assert.equal(await stockOf(product), 10);
}));

test("card payment: nothing to reverse in the cashbook", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);
    const bill = await sell(businessId, product, { payments: [{ amount: 10000, method: "card" }] });

    const r = await cancel(businessId, bill._id);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.cashReversed, 0);
    assert.equal(await CashBook.countDocuments({ business: businessId, type: "sale_cancel" }), 0);
}));

// ═══ Blocks ══════════════════════════════════════════════════════════════════

test("blocked: missing reason, already cancelled, hold bill, unknown bill", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);
    const bill = await sell(businessId, product);

    const noReason = await cancel(businessId, bill._id, "   ");
    assert.equal(noReason.statusCode, 400);
    assert.equal(noReason.body.message, "A reason is required to cancel a bill");

    assert.equal((await cancel(businessId, bill._id)).statusCode, 200);
    const again = await cancel(businessId, bill._id);
    assert.equal(again.statusCode, 400);
    assert.equal(again.body.message, "This bill is already cancelled");

    const hold = await invoke(createBill, adminReq(businessId, {
        body: { status: "hold", items: [{ product: product._id.toString(), name: product.name, qty: 1, price: 10000 }] },
    }));
    const holdCancel = await cancel(businessId, hold.body._id);
    assert.equal(holdCancel.statusCode, 400);
    assert.equal(holdCancel.body.message, "Only completed sale bills can be cancelled");

    const missing = await cancel(businessId, new mongoose.Types.ObjectId());
    assert.equal(missing.statusCode, 404);
}));

test("blocked: bill with returns", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);
    const bill = await sell(businessId, product);
    await invoke(processReturn, adminReq(businessId, { params: { id: bill._id.toString() }, body: { fullReturn: true } }));

    const r = await cancel(businessId, bill._id);
    assert.equal(r.statusCode, 400);
    assert.match(r.body.message, /has returns/);
}));

test("blocked: payment received after the sale", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);
    const customer = await Customer.create({ business: businessId, name: "Ali", phone: uid() });
    const bill = await sell(businessId, product, { customer: customer._id, payments: [] });

    await Bill.collection.updateOne({ _id: new mongoose.Types.ObjectId(bill._id) }, {
        $push: { payments: { _id: new mongoose.Types.ObjectId(), amount: 5000, method: "cash", paidAt: new Date(Date.now() + 60 * 60 * 1000) } },
    });

    const r = await cancel(businessId, bill._id);
    assert.equal(r.statusCode, 400);
    assert.equal(r.body.message, "This bill has payments received after the sale and can't be cancelled");
}));

test("blocked: bill inside a closed period", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);
    const bill = await sell(businessId, product);
    await Business.updateOne({ _id: businessId }, { lastClosingAt: new Date(Date.now() + 1000) });

    const r = await cancel(businessId, bill._id);
    assert.equal(r.statusCode, 400);
    assert.equal(r.body.message, "This bill is in a closed period and can't be cancelled");
    assert.equal((await Bill.findById(bill._id).lean()).status, "completed", "nothing changed");
}));

// ═══ Permissions ═════════════════════════════════════════════════════════════

test("employee needs pos.cancelBill and can only cancel today's bills; admin any day", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);

    const cashier = await employeeReq(businessId);
    const bill = await sell(businessId, product);
    const denied = await cancel(businessId, bill._id, "mistake", cashier);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.message, "You are not allowed to cancel bills");

    const supervisor = await employeeReq(businessId, { cancelBill: true });
    const old = await sell(businessId, product);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await Bill.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(old._id) },
        { $set: { createdAt: twoDaysAgo, "payments.$[].paidAt": twoDaysAgo } }
    );
    const oldDenied = await cancel(businessId, old._id, "mistake", supervisor);
    assert.equal(oldDenied.statusCode, 403);
    assert.equal(oldDenied.body.message, "Only an admin can cancel a bill from a previous day");

    const today = await cancel(businessId, bill._id, "mistake", supervisor);
    assert.equal(today.statusCode, 200, JSON.stringify(today.body));

    const adminOld = await cancel(businessId, old._id);
    assert.equal(adminOld.statusCode, 200, JSON.stringify(adminOld.body));
}));

// ═══ Customer ledger ═════════════════════════════════════════════════════════

test("ledger hides cancelled bills by default; includeCancelled shows them with no balance effect", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);
    const customer = await customerOwing(businessId, 13000);
    await sell(businessId, product, { customer });
    const mistake = await sell(businessId, product, { customer });
    await cancel(businessId, mistake._id);

    const plain = await invoke(getCustomerLedger, adminReq(businessId, { params: { id: customer.toString() } }));
    assert.equal(plain.statusCode, 200);
    assert.ok(plain.body.ledger.every((e) => e.type !== "cancelled"));
    assert.equal(plain.body.summary.currentBalance, 13000);
    assert.equal(plain.body.summary.cancelledCount, 0);

    const full = await invoke(getCustomerLedger, adminReq(businessId, {
        params: { id: customer.toString() }, query: { includeCancelled: "true" },
    }));
    const row = full.body.ledger.find((e) => e.type === "cancelled");
    assert.ok(row, "cancelled bill is listed");
    assert.equal(row.debit, 0);
    assert.equal(row.credit, 0);
    assert.equal(row.billTotal, 10000);
    assert.equal(row.cancelReason, "Created by mistake");
    assert.equal(full.body.summary.currentBalance, 13000);
    assert.equal(full.body.summary.cancelledCount, 1);
    assert.equal(full.body.ledger[full.body.ledger.length - 1].balance, 13000);
}));
