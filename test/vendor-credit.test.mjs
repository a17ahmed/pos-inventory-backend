/**
 * Integration tests for vendor credit (utils/vendorCredit.mjs) and the supply
 * safety rules around it: returns on paid supplies, Pay / Pay vendor, edit,
 * delete, vendor totals and the vendor ledger.
 *
 * Same pattern as the other suites: real configured MongoDB, one throwaway
 * Business per test, cleaned up afterwards.
 */

process.env.TZ = "Asia/Karachi";

import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import Business from "../models/business.mjs";
import Vendor from "../models/vendor.mjs";
import Supply from "../models/supply.mjs";
import Product from "../models/product.mjs";
import CashBook from "../models/cashbook.mjs";
import Counter from "../models/counter.mjs";
import StockMovement from "../models/stockMovement.mjs";

import {
    createSupply, updateSupply, recordPayment, deleteSupply, processSupplyReturn, computeSupplyStats,
} from "../controllers/supply.mjs";
import { getVendor, getAllVendors, getVendorLedger, payVendor, deleteVendor } from "../controllers/vendor.mjs";
import { recordCashEntry } from "../controllers/cashbook.mjs";

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
        name: `Vendor Credit Test ${suffix}`,
        businessType: new mongoose.Types.ObjectId(),
        email: `vendor-credit-${suffix}@example.test`,
    });
    return b._id;
};

const cleanupBusiness = async (businessId) => {
    await Promise.all([
        Supply.deleteMany({ business: businessId }),
        Vendor.deleteMany({ business: businessId }),
        Product.deleteMany({ business: businessId }),
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
            headersSent: false,
            json(body) { this.headersSent = true; resolve({ statusCode, body }); return this; },
            status(code) { statusCode = code; return this; },
        };
        Promise.resolve(controllerFn(request, res)).catch(reject);
    });

const ok = (r) => assert.ok(r.statusCode < 300, `${r.statusCode} ${JSON.stringify(r.body)}`);

const deposit = (businessId, amount) =>
    recordCashEntry({ type: "manual_deposit", amount, direction: "in", businessId, description: "test float" });

const cashInHand = async (businessId) =>
    (await CashBook.findOne({ business: businessId }).sort({ createdAt: -1, entryNumber: -1 }).lean())?.runningBalance ?? 0;

const newVendor = (businessId) => Vendor.create({ name: `Vendor ${uid()}`, business: businessId });

const newProduct = (businessId) =>
    Product.create({ name: `Ketchup ${uid()}`, sku: `SKU-${uid()}`, sellingPrice: 200, costPrice: 100, stockQuantity: 0, trackStock: true, business: businessId });

/** Receive `qty` × `price` from the vendor through the real createSupply. */
const receive = async (businessId, vendor, product, { qty, price, paid = 0, method = "cash", billDate }) => {
    const r = await invoke(createSupply, req(businessId, {
        body: {
            vendor: vendor._id.toString(),
            billDate,
            items: [{ product: product._id.toString(), quantity: qty, unitPrice: price }],
            paidAmount: paid,
            paymentMethod: method,
        },
    }));
    ok(r);
    return r.body;
};

const returnQty = (businessId, supply, product, quantity) =>
    invoke(processSupplyReturn, req(businessId, {
        params: { id: supply._id.toString() },
        body: { items: [{ product: product._id.toString(), quantity, reason: "defective" }] },
    }));

const supplyOf = (s) => Supply.findById(s._id).lean();
const stockOf = async (p) => (await Product.findById(p._id).lean()).stockQuantity;
const totalsOf = async (businessId, vendor) => (await invoke(getVendor, req(businessId, { params: { id: vendor._id.toString() } }))).body;

// ═══ Return on a paid supply ═════════════════════════════════════════════════

test("return on a paid supply: credit pays the vendor's oldest unpaid supply; no cash moves", withBusiness(async (businessId) => {
    await deposit(businessId, 10000);
    const vendor = await newVendor(businessId);
    const product = await newProduct(businessId);

    const a = await receive(businessId, vendor, product, { qty: 50, price: 100, billDate: "2026-01-01" });            // 5,000 unpaid
    const b = await receive(businessId, vendor, product, { qty: 30, price: 100, paid: 3000, billDate: "2026-01-02" }); // 3,000 paid
    assert.equal(await cashInHand(businessId), 7000);

    const r = await returnQty(businessId, b, product, 10); // 1,000 back
    ok(r);
    assert.deepEqual(r.body.creditSettlement.map((m) => [m.fromNumber, m.toNumber, m.amount]), [[b.supplyNumber, a.supplyNumber, 1000]]);
    assert.equal(r.body.supply.creditUsed, 1000);

    const A = await supplyOf(a);
    const B = await supplyOf(b);
    assert.equal(A.remainingAmount, 4000);
    assert.equal(A.paymentStatus, "partial");
    assert.equal(A.payments[0].method, "vendor_credit");
    assert.equal(String(A.payments[0].creditFrom), String(b._id));
    assert.equal(A.creditApplied, 1000);
    assert.equal(B.balance, 0);
    assert.equal(B.paymentStatus, "paid");
    assert.equal(B.creditTransfers[0].amount, 1000);

    assert.equal(await cashInHand(businessId), 7000, "no cash refund from the vendor");
    assert.equal(await stockOf(product), 70);

    const t = await totalsOf(businessId, vendor);
    assert.equal(t.totalBusiness, 8000);
    assert.equal(t.totalPaid, 3000, "real money only — credit is not a payment");
    assert.equal(t.totalReturned, 1000);
    assert.equal(t.totalRemaining, 4000);
    assert.equal(t.totalCredit, 0);
    assert.equal(t.netBalance, 4000);
}));

test("vendor ledger shows credit as a transfer + credit payment pair; balance and summary stay right", withBusiness(async (businessId) => {
    await deposit(businessId, 10000);
    const vendor = await newVendor(businessId);
    const product = await newProduct(businessId);
    const a = await receive(businessId, vendor, product, { qty: 50, price: 100, billDate: "2026-01-01" });
    const b = await receive(businessId, vendor, product, { qty: 30, price: 100, paid: 3000, billDate: "2026-01-02" });
    ok(await returnQty(businessId, b, product, 10));

    const r = await invoke(getVendorLedger, req(businessId, { params: { id: vendor._id.toString() } }));
    ok(r);
    const rows = r.body.ledger.map((e) => [e.type, e.supplyNumber, e.debit, e.credit, e.balance, !!e.fromCredit]);
    assert.deepEqual(rows, [
        ["supply", a.supplyNumber, 5000, 0, 5000, false],
        ["supply", b.supplyNumber, 3000, 0, 8000, false],
        ["payment", b.supplyNumber, 0, 3000, 5000, false],
        ["return", b.supplyNumber, 0, 1000, 4000, false],
        ["credit_transfer", b.supplyNumber, 1000, 0, 5000, false],
        ["payment", a.supplyNumber, 0, 1000, 4000, true],
    ]);
    const s = r.body.summary;
    assert.equal(s.totalSupplies, 8000);
    assert.equal(s.totalPaid, 3000);
    assert.equal(s.totalReturns, 1000);
    assert.equal(s.currentBalance, 4000);
    assert.equal(s.amountDue, 4000);
    assert.equal(s.vendorCredit, 0);
}));

test("return with nothing unpaid: credit is kept, blocks vendor delete, then pays the next supply", withBusiness(async (businessId) => {
    await deposit(businessId, 10000);
    const vendor = await newVendor(businessId);
    const product = await newProduct(businessId);
    const a = await receive(businessId, vendor, product, { qty: 30, price: 100, paid: 3000, billDate: "2026-01-01" });

    const r = await returnQty(businessId, a, product, 10);
    ok(r);
    assert.deepEqual(r.body.creditSettlement, []);
    assert.equal((await supplyOf(a)).balance, -1000);

    let t = await totalsOf(businessId, vendor);
    assert.equal(t.totalCredit, 1000);
    assert.equal(t.totalRemaining, 0);
    assert.equal(t.netBalance, -1000);

    const list = (await invoke(getAllVendors, req(businessId))).body.find((v) => String(v._id) === String(vendor._id));
    assert.equal(list.totalCredit, 1000);

    const del = await invoke(deleteVendor, req(businessId, { params: { id: vendor._id.toString() } }));
    assert.equal(del.statusCode, 400);
    assert.match(del.body.message, /owe you Rs 1000/);

    const cashBefore = await cashInHand(businessId);
    const b = await receive(businessId, vendor, product, { qty: 25, price: 100, billDate: "2026-01-05" }); // 2,500
    assert.equal(b.paidAmount, 1000, "credit paid part of the new supply straight away");
    assert.equal(b.remainingAmount, 1500);
    assert.equal(b.payments[0].method, "vendor_credit");
    assert.equal(await cashInHand(businessId), cashBefore);

    t = await totalsOf(businessId, vendor);
    assert.equal(t.totalCredit, 0);
    assert.equal(t.totalRemaining, 1500);
}));

test("credit bigger than one supply spreads over several, oldest first", withBusiness(async (businessId) => {
    await deposit(businessId, 20000);
    const vendor = await newVendor(businessId);
    const product = await newProduct(businessId);
    const a = await receive(businessId, vendor, product, { qty: 5, price: 100, billDate: "2026-01-01" });  // 500
    const b = await receive(businessId, vendor, product, { qty: 8, price: 100, billDate: "2026-01-02" });  // 800
    const c = await receive(businessId, vendor, product, { qty: 100, price: 100, paid: 10000, billDate: "2026-01-03" });

    const r = await returnQty(businessId, c, product, 20); // 2,000 credit
    ok(r);
    assert.deepEqual(r.body.creditSettlement.map((m) => [m.toNumber, m.amount]), [[a.supplyNumber, 500], [b.supplyNumber, 800]]);
    assert.equal((await supplyOf(a)).paymentStatus, "paid");
    assert.equal((await supplyOf(b)).paymentStatus, "paid");
    assert.equal((await supplyOf(c)).balance, -700, "700 credit left over");
    assert.equal((await totalsOf(businessId, vendor)).netBalance, -700);
}));

// ═══ Pay / Pay vendor ════════════════════════════════════════════════════════

test("Pay vendor uses credit first and caps at what is really still owed", withBusiness(async (businessId) => {
    await deposit(businessId, 10000);
    const vendor = await newVendor(businessId);
    const product = await newProduct(businessId);
    const a = await receive(businessId, vendor, product, { qty: 30, price: 100, paid: 3000, billDate: "2026-01-01" });
    const b = await receive(businessId, vendor, product, { qty: 20, price: 100, billDate: "2026-01-02" });
    // Old data: a return recorded before settlement existed → credit sitting next to an unpaid supply
    await Supply.collection.updateOne({ _id: new mongoose.Types.ObjectId(a._id) }, {
        $push: { returns: { _id: new mongoose.Types.ObjectId(), items: [], totalRefund: 1000, returnedAt: new Date("2026-01-03"), returnedBy: "Admin", note: "" } },
        $set: { totalReturned: 1000 },
    });

    const over = await invoke(payVendor, req(businessId, { params: { id: vendor._id.toString() }, body: { amount: 2000, method: "cash" } }));
    assert.equal(over.statusCode, 400);
    assert.match(over.body.message, /exceeds total outstanding \(Rs 1000\).*1000 vendor credit was applied first/);
    assert.equal((await supplyOf(b)).payments.length, 0, "rejected → credit move rolled back too");
    assert.equal(await cashInHand(businessId), 7000);

    const r = await invoke(payVendor, req(businessId, { params: { id: vendor._id.toString() }, body: { amount: 1000, method: "cash" } }));
    ok(r);
    assert.deepEqual(r.body.creditApplied.map((m) => m.amount), [1000]);
    assert.equal(r.body.summary.outstandingBefore, 1000);
    assert.equal(r.body.summary.outstandingAfter, 0);
    assert.equal((await supplyOf(b)).paymentStatus, "paid");
    assert.equal(await cashInHand(businessId), 6000, "only the real 1,000 left the drawer");
}));

test("Pay on one supply: settles credit first, caps, needs cash in hand; online works", withBusiness(async (businessId) => {
    await deposit(businessId, 1000);
    const vendor = await newVendor(businessId);
    const product = await newProduct(businessId);
    const a = await receive(businessId, vendor, product, { qty: 30, price: 100, billDate: "2026-01-01" }); // 3,000

    const pay = (body) => invoke(recordPayment, req(businessId, { params: { id: a._id.toString() }, body }));

    let r = await pay({ amount: 3500, method: "bank_transfer" });
    assert.equal(r.statusCode, 400);
    assert.match(r.body.message, /cannot exceed remaining balance of Rs 3000/);

    r = await pay({ amount: 2000, method: "cash" });
    assert.equal(r.statusCode, 400);
    assert.match(r.body.message, /Insufficient cash in hand/);

    r = await pay({ amount: 2000, method: "online" });
    ok(r);
    assert.equal(r.body.remainingAmount, 1000);
    assert.equal(await cashInHand(businessId), 1000, "non-cash payment doesn't touch the cash book");

    r = await pay({ amount: 1000, method: "cash" });
    ok(r);
    assert.equal(r.body.paymentStatus, "paid");
    assert.equal(await cashInHand(businessId), 0);

    r = await pay({ amount: 1, method: "cash" });
    assert.equal(r.statusCode, 400);
    assert.match(r.body.message, /already fully paid/);
}));

// ═══ Create / edit / delete safety ═══════════════════════════════════════════

test("new supply: can't pay more than the total, and cash paid must be in hand", withBusiness(async (businessId) => {
    await deposit(businessId, 500);
    const vendor = await newVendor(businessId);
    const product = await newProduct(businessId);
    const body = (paid) => ({
        vendor: vendor._id.toString(),
        items: [{ product: product._id.toString(), quantity: 10, unitPrice: 100 }],
        paidAmount: paid,
        paymentMethod: "cash",
    });

    let r = await invoke(createSupply, req(businessId, { body: body(1500) }));
    assert.equal(r.statusCode, 400);
    assert.match(r.body.message, /can't be more than the supply total/);

    r = await invoke(createSupply, req(businessId, { body: body(800) }));
    assert.equal(r.statusCode, 400);
    assert.match(r.body.message, /Insufficient cash in hand/);
    assert.equal(await Supply.countDocuments({ business: businessId }), 0);
    assert.equal(await stockOf(product), 0, "nothing received when rejected");
}));

test("edit: paid amount can't be changed, items locked after a return, cut can't exceed stock", withBusiness(async (businessId) => {
    await deposit(businessId, 10000);
    const vendor = await newVendor(businessId);
    const product = await newProduct(businessId);
    const a = await receive(businessId, vendor, product, { qty: 30, price: 100, paid: 1000, billDate: "2026-01-01" });
    const edit = (body) => invoke(updateSupply, req(businessId, { params: { id: a._id.toString() }, body }));

    let r = await edit({ paidAmount: 3000 });
    assert.equal(r.statusCode, 400);
    assert.match(r.body.message, /Use "Pay"/);

    r = await edit({ paidAmount: 1000, notes: "same paid amount from the form is fine" });
    ok(r);

    // 25 of the 30 sold → only 5 left on the shelf
    await Product.updateOne({ _id: product._id }, { $inc: { stockQuantity: -25 } });
    r = await edit({ items: [{ product: product._id.toString(), quantity: 20, unitPrice: 100 }] });
    assert.equal(r.statusCode, 400);
    assert.deepEqual(r.body.outOfStock.map((o) => [o.requested, o.available]), [[10, 5]]);
    assert.equal(await stockOf(product), 5);

    r = await edit({ items: [{ product: product._id.toString(), quantity: 26, unitPrice: 100 }] });
    ok(r);
    assert.equal(await stockOf(product), 1);
    assert.equal(r.body.totalAmount, 2600);

    ok(await returnQty(businessId, a, product, 1));
    r = await edit({ items: [{ product: product._id.toString(), quantity: 30, unitPrice: 100 }] });
    assert.equal(r.statusCode, 400);
    assert.match(r.body.message, /has returns/);

    // The desktop edit form re-sends the same items with every save — that's not an item change
    const moves = await StockMovement.countDocuments({ business: businessId });
    r = await edit({ billNumber: "INV-9", paidAmount: 1000, items: [{ product: product._id.toString(), quantity: 26, unitPrice: 100 }] });
    ok(r);
    assert.equal(r.body.billNumber, "INV-9");
    assert.equal(await stockOf(product), 0);
    assert.equal(await StockMovement.countDocuments({ business: businessId }), moves, "no stock churn");
}));

test("edit that drops the total below what was paid turns the extra into vendor credit", withBusiness(async (businessId) => {
    await deposit(businessId, 10000);
    const vendor = await newVendor(businessId);
    const product = await newProduct(businessId);
    const a = await receive(businessId, vendor, product, { qty: 10, price: 100, billDate: "2026-01-01" });           // 1,000 unpaid
    const b = await receive(businessId, vendor, product, { qty: 30, price: 100, paid: 3000, billDate: "2026-01-02" });

    const r = await invoke(updateSupply, req(businessId, {
        params: { id: b._id.toString() },
        body: { items: [{ product: product._id.toString(), quantity: 25, unitPrice: 100 }] },
    }));
    ok(r);
    assert.equal(r.body.creditUsed, 500, "response is the settled supply");
    assert.equal((await supplyOf(a)).remainingAmount, 500);
    assert.equal((await totalsOf(businessId, vendor)).netBalance, 500);
}));

test("delete: blocked with payments, returns or sold stock; clean supply deletes and takes stock back", withBusiness(async (businessId) => {
    await deposit(businessId, 10000);
    const vendor = await newVendor(businessId);
    const product = await newProduct(businessId);
    const del = (s) => invoke(deleteSupply, req(businessId, { params: { id: s._id.toString() } }));

    const paid = await receive(businessId, vendor, product, { qty: 10, price: 100, paid: 500 });
    let r = await del(paid);
    assert.equal(r.statusCode, 400);
    assert.match(r.body.message, /has payments/);

    const returned = await receive(businessId, vendor, product, { qty: 10, price: 100 });
    ok(await returnQty(businessId, returned, product, 2));
    r = await del(returned);
    assert.equal(r.statusCode, 400);
    assert.match(r.body.message, /has returns/);

    const sold = await receive(businessId, vendor, product, { qty: 10, price: 100 });
    await Product.updateOne({ _id: product._id }, { $set: { stockQuantity: 4 } });
    r = await del(sold);
    assert.equal(r.statusCode, 400);
    assert.deepEqual(r.body.outOfStock.map((o) => [o.requested, o.available]), [[10, 4]]);
    assert.ok(await Supply.exists({ _id: sold._id }));

    await Product.updateOne({ _id: product._id }, { $set: { stockQuantity: 15 } });
    r = await del(sold);
    ok(r);
    assert.equal(await stockOf(product), 5);
    assert.equal(await Supply.exists({ _id: sold._id }), null);
}));

test("return can't take back more than is in stock (30 received, 24 sold → returning 10 blocked)", withBusiness(async (businessId) => {
    const vendor = await newVendor(businessId);
    const product = await newProduct(businessId);
    const a = await receive(businessId, vendor, product, { qty: 30, price: 100 });
    await Product.updateOne({ _id: product._id }, { $inc: { stockQuantity: -24 } });

    const r = await returnQty(businessId, a, product, 10);
    assert.equal(r.statusCode, 400);
    assert.deepEqual(r.body.outOfStock.map((o) => [o.requested, o.available]), [[10, 6]]);
    assert.equal((await supplyOf(a)).returns.length, 0);
    assert.equal(await stockOf(product), 6);
}));

// ═══ Stats / cash book ═══════════════════════════════════════════════════════

test("supply stats count real money paid, not credit moved between supplies", withBusiness(async (businessId) => {
    await deposit(businessId, 10000);
    const vendor = await newVendor(businessId);
    const product = await newProduct(businessId);
    await receive(businessId, vendor, product, { qty: 50, price: 100, billDate: "2026-01-01" });
    const b = await receive(businessId, vendor, product, { qty: 30, price: 100, paid: 3000, billDate: "2026-01-02" });
    ok(await returnQty(businessId, b, product, 10));

    const stats = await computeSupplyStats(businessId);
    assert.equal(stats.overall.totalPaid, 3000);
    assert.equal(stats.overall.totalRemaining, 4000);
}));

test("cash book accepts expense_reversal (deleting a cash expense no longer fails)", async () => {
    const entry = new CashBook({
        entryNumber: 1, type: "expense_reversal", amount: 100, direction: "in",
        runningBalance: 100, referenceType: "expense", business: new mongoose.Types.ObjectId(),
    });
    assert.equal(entry.validateSync(), undefined);
});
