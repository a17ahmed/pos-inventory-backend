/**
 * Integration tests for "add items to today's credit bill":
 *   GET  /bill/open-for-customer/:customerId
 *   POST /bill/:id/add-items
 *
 * Bills are made with the real createBill / processReturn / cancelSaleBill
 * controllers. Same pattern as the other suites: real configured MongoDB, one
 * throwaway Business per test, cleaned up afterwards.
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

import { createBill, processReturn, cancelReturn, cancelSaleBill, getOpenBillsForCustomer, addItemsToBill } from "../controllers/bill.mjs";
import { accessControl, invalidateAccessCache } from "../middleware/accessControl.mjs";
import { validate } from "../middleware/validate.mjs";
import { addBillItemsSchema } from "../middleware/validationSchemas.mjs";

// ─── Infrastructure ──────────────────────────────────────────────────────────

before(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
});

after(async () => {
    await mongoose.connection.close();
});

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_ADMIN_ID = new mongoose.Types.ObjectId();

const withBusiness = (fn, { allowBillAmend = true } = {}) => async () => {
    const suffix = uid();
    const business = await Business.create({
        name: `Add To Bill Test ${suffix}`,
        businessType: new mongoose.Types.ObjectId(),
        email: `add-to-bill-${suffix}@example.test`,
        settings: { allowBillAmend },
    });
    const businessId = business._id;
    try {
        await fn(businessId);
    } finally {
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
    }
};

const adminUser = (businessId) => ({
    adminId: TEST_ADMIN_ID.toString(), id: TEST_ADMIN_ID.toString(), businessId: businessId.toString(), name: "Owner",
});

const run = (chain, req) =>
    new Promise((resolve, reject) => {
        let statusCode = 200;
        const res = {
            headersSent: false,
            json(body) { this.headersSent = true; resolve({ statusCode, body }); return this; },
            status(code) { statusCode = code; return this; },
        };
        const step = (i) => () => Promise.resolve(chain[i](req, res, step(i + 1))).catch(reject);
        step(0)();
    });

const call = (fn, user, { params = {}, body = {}, query = {} } = {}) => run([fn], { params, body, query, user });

const product = (businessId, name, price, stock = 50, cost = Math.round(price * 0.6)) =>
    Product.create({ name, sku: `SKU-${uid()}`, sellingPrice: price, costPrice: cost, stockQuantity: stock, trackStock: true, business: businessId });

const newCustomer = async (businessId, extra = {}) =>
    (await Customer.create({ business: businessId, name: "Ali", phone: uid(), ...extra }))._id;

const line = (p, qty, extra = {}) => ({ product: p._id.toString(), name: p.name, qty, price: p.sellingPrice, ...extra });

/** A completed sale through the real createBill controller. */
const sale = async (businessId, customer, lines, { payments = [], billDiscountAmount } = {}) => {
    const r = await call(createBill, adminUser(businessId), {
        body: { items: lines, customer: customer ? String(customer) : null, payments, ...(billDiscountAmount && { billDiscountAmount }) },
    });
    assert.equal(r.statusCode, 201, JSON.stringify(r.body));
    return r.body;
};

/** POST /bill/:id/add-items through validate → controller (like the router). */
const addItems = (businessId, bill, customer, items, { revision = bill.revisionCount || 0, key = uid(), payment, note, user } = {}) =>
    run([validate(addBillItemsSchema), addItemsToBill], {
        method: "POST",
        originalUrl: `/bill/${bill._id}/add-items`,
        params: { id: String(bill._id) },
        query: {},
        body: { customer: String(customer), revision, idempotencyKey: key, items, ...(payment && { payment }), ...(note && { note }) },
        user: user || adminUser(businessId),
    });

const billOf = (b) => Bill.findById(b._id).lean();
const stockOf = async (p) => (await Product.findById(p._id).lean()).stockQuantity;
const balanceOf = async (c) => (await Customer.findById(c).lean()).balance;
const cashIn = async (businessId) =>
    (await CashBook.find({ business: businessId, direction: "in" }).lean()).reduce((s, e) => s + e.amount, 0);

// ═══ Happy path ══════════════════════════════════════════════════════════════

test("adds new lines to today's credit bill: totals, stock, badges, history, customer balance", withBusiness(async (businessId) => {
    const ketchup = await product(businessId, "Ketchup", 150);
    const box = await product(businessId, "Pizza box", 25);
    const mayo = await product(businessId, "Mayo", 200);
    const ali = await newCustomer(businessId);
    const bill = await sale(businessId, ali, [line(ketchup, 2)]);
    assert.equal(bill.amountDue, 300);

    const r = await addItems(businessId, bill, ali, [line(box, 10), line(mayo, 1)], { note: "Came back for boxes" });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));

    const b = r.body.bill;
    assert.equal(b.billNumber, bill.billNumber, "same bill number");
    assert.equal(b.total, 750);
    assert.equal(b.amountDue, 750);
    assert.equal(b.revisionCount, 1);
    assert.deepEqual(b.items.map((i) => [i.name, i.qty, i.revision, i.addedBy]), [
        ["Ketchup", 2, 0, ""],
        ["Pizza box", 10, 1, "Admin"],
        ["Mayo", 1, 1, "Admin"],
    ]);
    assert.equal(b.items[0].price, 150, "earlier line untouched");

    const c = r.body.change;
    assert.equal(c.number, 1);
    assert.equal(c.addedTotal, 450);
    assert.deepEqual([c.totalBefore, c.totalAfter, c.dueBefore, c.dueAfter], [300, 750, 300, 750]);
    assert.equal(c.note, "Came back for boxes");
    assert.equal(c.idempotencyKey, undefined, "key not echoed");
    assert.equal(r.body.customerBalance, 750);
    assert.equal(await balanceOf(ali), 750);

    assert.equal(await stockOf(ketchup), 48);
    assert.equal(await stockOf(box), 40);
    assert.equal(await stockOf(mayo), 49);
    const mv = await StockMovement.findOne({ business: businessId, product: box._id }).lean();
    assert.equal(mv.type, "bill_sold");
    assert.equal(mv.quantity, -10);
    assert.equal(mv.reason, `Added to Bill #${bill.billNumber} (update 1)`);

    const saved = await billOf(bill);
    assert.equal(saved.revisions.length, 1);
    assert.equal(saved.revisions[0].items.length, 2);
    assert.equal(await CashBook.countDocuments({ business: businessId }), 0, "no payment → no cash entry");
}));

test("payment with the new items: cash book entry; overpaying is rejected and nothing changes", withBusiness(async (businessId) => {
    const ketchup = await product(businessId, "Ketchup", 150);
    const mayo = await product(businessId, "Mayo", 200);
    const ali = await newCustomer(businessId);
    const bill = await sale(businessId, ali, [line(ketchup, 2)]);

    let r = await addItems(businessId, bill, ali, [line(mayo, 1)], { payment: { amount: 600, method: "cash" } });
    assert.equal(r.statusCode, 400);
    assert.equal(r.body.message, "Payment exceeds the amount due on this bill (Rs 500)");
    assert.equal((await billOf(bill)).items.length, 1, "rolled back");
    assert.equal(await stockOf(mayo), 50);

    r = await addItems(businessId, bill, ali, [line(mayo, 1)], { payment: { amount: 400, method: "cash" } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.bill.amountDue, 100);
    assert.equal(r.body.bill.paymentStatus, "partial");
    assert.equal(r.body.change.paymentAmount, 400);
    assert.equal(await cashIn(businessId), 400);
    assert.equal(await balanceOf(ali), 100);

    r = await addItems(businessId, (await billOf(bill)), ali, [line(mayo, 1)], { payment: { amount: 300, method: "online" } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.bill.amountDue, 0, "can be paid in full");
    assert.equal(await cashIn(businessId), 400, "online isn't cash");
}));

test("second update on the same bill: revision 2, needs the latest revision", withBusiness(async (businessId) => {
    const ketchup = await product(businessId, "Ketchup", 150);
    const ali = await newCustomer(businessId);
    const bill = await sale(businessId, ali, [line(ketchup, 1)]);

    assert.equal((await addItems(businessId, bill, ali, [line(ketchup, 1)])).statusCode, 200);
    const stale = await addItems(businessId, bill, ali, [line(ketchup, 1)], { revision: 0 });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.message, "This bill was just changed. Reload it and try again.");
    assert.equal(stale.body.revision, 1);

    const r = await addItems(businessId, bill, ali, [line(ketchup, 2)], { revision: 1 });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body.bill.items.map((i) => [i.qty, i.revision]), [[1, 0], [1, 1], [2, 2]]);
    assert.equal(r.body.bill.total, 600);
    assert.equal(await stockOf(ketchup), 46);
}));

test("same save sent twice (idempotency key): applied once", withBusiness(async (businessId) => {
    const ketchup = await product(businessId, "Ketchup", 150);
    const ali = await newCustomer(businessId);
    const bill = await sale(businessId, ali, [line(ketchup, 1)]);

    const first = await addItems(businessId, bill, ali, [line(ketchup, 3)], { key: "retry-1", payment: { amount: 100, method: "cash" } });
    assert.equal(first.statusCode, 200);
    const again = await addItems(businessId, bill, ali, [line(ketchup, 3)], { key: "retry-1", payment: { amount: 100, method: "cash" } });
    assert.equal(again.statusCode, 409);
    assert.equal(again.body.alreadyApplied, true);
    assert.equal(again.body.bill.total, 600);
    assert.equal((await billOf(bill)).items.length, 2);
    assert.equal(await stockOf(ketchup), 46);
    assert.equal(await cashIn(businessId), 100);
}));

// ═══ Bills with returns / credit ═════════════════════════════════════════════

test("partial return: new items add on top, the returned line stays as it was", withBusiness(async (businessId) => {
    const ketchup = await product(businessId, "Ketchup", 150);
    const mayo = await product(businessId, "Mayo", 200);
    const ali = await newCustomer(businessId);
    const bill = await sale(businessId, ali, [line(ketchup, 3)]);
    const ret = await call(processReturn, adminUser(businessId), {
        params: { id: bill._id }, body: { items: [{ itemId: String(bill.items[0]._id), quantity: 1, reason: "changed_mind" }] },
    });
    assert.equal(ret.statusCode, 200, JSON.stringify(ret.body));
    const before = await billOf(bill);
    assert.equal(before.amountDue, 300);

    const r = await addItems(businessId, before, ali, [line(mayo, 1)]);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.bill.amountDue, 500);
    assert.equal(r.body.bill.returnStatus, "partial");
    assert.equal(r.body.bill.items[0].returnedQty, 1);
    assert.equal(r.body.bill.items[1].returnedQty, 0);
    assert.equal(await balanceOf(ali), 500);
}));

test("bill in credit after a return: the new items use that credit", withBusiness(async (businessId) => {
    const ketchup = await product(businessId, "Ketchup", 150);
    const mayo = await product(businessId, "Mayo", 200);
    const ali = await newCustomer(businessId);
    const bill = await sale(businessId, ali, [line(ketchup, 2)], { payments: [{ amount: 300, method: "cash" }] });
    await call(processReturn, adminUser(businessId), {
        params: { id: bill._id }, body: { items: [{ itemId: String(bill.items[0]._id), quantity: 1, reason: "changed_mind" }] },
    });
    const before = await billOf(bill);
    assert.equal(before.amountDue, -150, "customer has Rs 150 credit on this bill");

    const r = await addItems(businessId, before, ali, [line(mayo, 1)]);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.change.dueBefore, -150);
    assert.equal(r.body.bill.amountDue, 50);
    assert.equal(await balanceOf(ali), 50);
}));

test("bill part-paid by store credit from another bill: still open, adding keeps the balance right", withBusiness(async (businessId) => {
    const ketchup = await product(businessId, "Ketchup", 150);
    const ali = await newCustomer(businessId);
    const open = await sale(businessId, ali, [line(ketchup, 4)]);                                         // due 600
    // Another bill paid 300 then fully returned → its 300 credit pays `open` straight away
    const paid = await sale(businessId, ali, [line(ketchup, 2)], { payments: [{ amount: 300, method: "cash" }] });
    await call(processReturn, adminUser(businessId), { params: { id: paid._id }, body: { fullReturn: true } });
    const before = await billOf(open);
    assert.equal(before.amountDue, 300);
    assert.equal(before.creditApplied, 300);

    const r = await addItems(businessId, before, ali, [line(ketchup, 2)]);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.bill.amountDue, 600);
    assert.equal(r.body.bill.creditApplied, 300, "the credit payment stays");
    assert.equal(await balanceOf(ali), 600);
}));

// ═══ Blocked ═════════════════════════════════════════════════════════════════

test("blocked bills: clear 400 and nothing changes", withBusiness(async (businessId) => {
    const ketchup = await product(businessId, "Ketchup", 150);
    const ali = await newCustomer(businessId);
    const other = await newCustomer(businessId);
    const add = (b, c = ali) => addItems(businessId, b, c, [line(ketchup, 1)]);

    const yesterday = await sale(businessId, ali, [line(ketchup, 1)]);
    await Bill.collection.updateOne({ _id: new mongoose.Types.ObjectId(yesterday._id) }, { $set: { createdAt: new Date(Date.now() - 26 * 3600 * 1000) } });
    assert.equal((await add(yesterday)).body.message, "This bill isn't from today. Make a new bill.");

    const paid = await sale(businessId, ali, [line(ketchup, 1)], { payments: [{ amount: 150, method: "cash" }] });
    assert.equal((await add(paid)).body.message, "This bill is fully paid. Make a new bill.");

    const full = await sale(businessId, ali, [line(ketchup, 1)]);
    await call(processReturn, adminUser(businessId), { params: { id: full._id }, body: { fullReturn: true } });
    assert.equal((await add(await billOf(full))).body.message, "This bill was fully returned. Make a new bill.");

    const walkIn = await sale(businessId, null, [line(ketchup, 1)]);
    assert.equal((await add(walkIn)).body.message, "Only a registered customer's bill can take more items");

    const ok = await sale(businessId, ali, [line(ketchup, 1)]);
    assert.equal((await add(ok, other)).body.message, "This bill belongs to another customer");

    const cancelled = await sale(businessId, ali, [line(ketchup, 1)]);
    await call(cancelSaleBill, adminUser(businessId), { params: { id: cancelled._id }, body: { reason: "mistake" } });
    assert.equal((await add(await billOf(cancelled))).body.message, "Only completed bills can take more items");

    const stock = await stockOf(ketchup);
    await Business.updateOne({ _id: businessId }, { $set: { lastClosingAt: new Date() } });
    const afterClosing = await add(ok);
    assert.equal(afterClosing.statusCode, 400);
    assert.equal(afterClosing.body.message, "Store closing was done after this bill. Make a new bill.");
    assert.equal(await stockOf(ketchup), stock, "nothing deducted by any blocked request");
    assert.equal((await billOf(ok)).items.length, 1);
}));

test("shop setting off → 403", withBusiness(async (businessId) => {
    const ketchup = await product(businessId, "Ketchup", 150);
    const ali = await newCustomer(businessId);
    const bill = await sale(businessId, ali, [line(ketchup, 1)]);
    const r = await addItems(businessId, bill, ali, [line(ketchup, 1)]);
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.message, "Adding to an earlier bill is turned off for this shop");
    const open = await call(getOpenBillsForCustomer, adminUser(businessId), { params: { customerId: String(ali) } });
    assert.equal(open.body.enabled, false);
    assert.equal(open.body.bills[0].canAmend, false);
}, { allowBillAmend: false }));

test("stock, discount and credit-limit rules apply to the new lines", withBusiness(async (businessId) => {
    const ketchup = await product(businessId, "Ketchup", 150, 50, 100);
    const mayo = await product(businessId, "Mayo", 100, 3, 60);
    const ali = await newCustomer(businessId, { creditLimit: 1000 });
    const bill = await sale(businessId, ali, [line(ketchup, 2)]);

    let r = await addItems(businessId, bill, ali, [line(mayo, 2), line(mayo, 2)]);
    assert.equal(r.statusCode, 400);
    assert.deepEqual(r.body.outOfStock, [{ name: "Mayo", requested: 4, available: 3 }], "same product counted together");

    r = await addItems(businessId, bill, ali, [line(mayo, 1, { discountAmount: 90 })]);
    assert.equal(r.statusCode, 400);
    assert.equal(r.body.message, "Discount on Mayo exceeds the allowed limit", "profit is only 40");

    r = await addItems(businessId, bill, ali, [line(ketchup, 6)]);   // 300 + 900 > limit 1000
    assert.equal(r.statusCode, 400);
    assert.match(r.body.message, /^Credit limit exceeded/);

    r = await addItems(businessId, bill, ali, [line(ketchup, 6)], { payment: { amount: 300, method: "cash" } });
    assert.equal(r.statusCode, 200, "paying part keeps it under the limit");

    const sara = await newCustomer(businessId);
    const withBillDiscount = await sale(businessId, sara, [line(ketchup, 2)], { billDiscountAmount: 20 });
    r = await addItems(businessId, withBillDiscount, sara, [line(ketchup, 1, { discountAmount: 10 })]);
    assert.equal(r.statusCode, 400);
    assert.equal(r.body.message, "This bill has a bill discount, so new items can't have their own discount");
    assert.equal(await stockOf(mayo), 3);
}));

test("validation: items, revision, key and customer are required", withBusiness(async (businessId) => {
    const ketchup = await product(businessId, "Ketchup", 150);
    const ali = await newCustomer(businessId);
    const bill = await sale(businessId, ali, [line(ketchup, 1)]);
    const r = await run([validate(addBillItemsSchema), addItemsToBill], {
        params: { id: bill._id }, query: {}, user: adminUser(businessId),
        body: { customer: String(ali), items: [] },
    });
    assert.equal(r.statusCode, 400);
    assert.deepEqual(r.body.errors.map((e) => e.field).sort(), ["idempotencyKey", "items", "revision"]);
    const storeCredit = await addItems(businessId, bill, ali, [line(ketchup, 1)], { payment: { amount: 10, method: "store_credit" } });
    assert.equal(storeCredit.statusCode, 400);
}));

// ═══ Permissions ═════════════════════════════════════════════════════════════

test("permissions: pos.amendBill off → 403; older employee without the field → allowed", withBusiness(async (businessId) => {
    const ketchup = await product(businessId, "Ketchup", 150);
    const ali = await newCustomer(businessId);
    const bill = await sale(businessId, ali, [line(ketchup, 1)]);

    const mk = async (pos, raw = false) => {
        const id = new mongoose.Types.ObjectId();
        if (raw) await Access.collection.insertOne({ employee: id, business: businessId, permissions: { pos } });
        else await Access.create({ employee: id, business: businessId, permissions: { pos } });
        invalidateAccessCache(id.toString(), businessId.toString());
        return { id: id.toString(), employeeId: id.toString(), businessId: businessId.toString(), name: "Bilal", role: "employee" };
    };
    const viaRouter = (user, rev) =>
        run([accessControl, validate(addBillItemsSchema), addItemsToBill], {
            method: "POST", originalUrl: `/bill/${bill._id}/add-items`, params: { id: String(bill._id) }, query: {}, user,
            body: { customer: String(ali), revision: rev, idempotencyKey: uid(), items: [line(ketchup, 1)] },
        });

    let r = await viaRouter(await mk({ view: true, create: true, amendBill: false }), 0);
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.message, "You don't have permission to add items to a bill");

    r = await viaRouter(await mk({ view: true, create: false }), 0);
    assert.equal(r.statusCode, 403, "can't make sales → can't add either");

    r = await viaRouter(await mk({ view: true, create: true }, true), 0);  // access doc saved before this feature
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.bill.items[1].addedBy, "Bilal");
}));

// ═══ Open bills list ═════════════════════════════════════════════════════════

test("open-for-customer lists today's bills with canAmend and the reason when not", withBusiness(async (businessId) => {
    const ketchup = await product(businessId, "Ketchup", 150);
    const ali = await newCustomer(businessId);
    const old = await sale(businessId, ali, [line(ketchup, 1)]);
    await Bill.collection.updateOne({ _id: new mongoose.Types.ObjectId(old._id) }, { $set: { createdAt: new Date(Date.now() - 26 * 3600 * 1000) } });
    const credit = await sale(businessId, ali, [line(ketchup, 2)]);
    const paid = await sale(businessId, ali, [line(ketchup, 1)], { payments: [{ amount: 150, method: "cash" }] });
    await addItems(businessId, credit, ali, [line(ketchup, 1)]);

    const r = await call(getOpenBillsForCustomer, adminUser(businessId), { params: { customerId: String(ali) } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.enabled, true);
    assert.equal(r.body.canAmend, true);
    assert.deepEqual(r.body.bills.map((b) => [b.billNumber, b.canAmend, b.blockedReason]), [
        [paid.billNumber, false, "This bill is fully paid. Make a new bill."],
        [credit.billNumber, true, null],
    ], "newest first, yesterday's bill not listed");
    const c = r.body.bills[1];
    assert.deepEqual([c.total, c.paid, c.due, c.revision], [450, 0, 450, 1]);
    assert.deepEqual(c.items.map((i) => [i.qty, i.revision]), [[2, 0], [1, 1]]);
    assert.equal("costPrice" in c.items[0], false);

    assert.equal((await call(getOpenBillsForCustomer, adminUser(businessId), { params: { customerId: String(new mongoose.Types.ObjectId()) } })).statusCode, 404);
}));

// ═══ Works with the rest of the app ══════════════════════════════════════════

test("cancelling the bill later puts back stock for earlier AND added lines", withBusiness(async (businessId) => {
    const ketchup = await product(businessId, "Ketchup", 150);
    const mayo = await product(businessId, "Mayo", 200);
    const ali = await newCustomer(businessId);
    const bill = await sale(businessId, ali, [line(ketchup, 2)]);
    await addItems(businessId, bill, ali, [line(mayo, 3)]);

    const r = await call(cancelSaleBill, adminUser(businessId), { params: { id: bill._id }, body: { reason: "wrong customer" } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(await stockOf(ketchup), 50);
    assert.equal(await stockOf(mayo), 50);
    assert.equal(await balanceOf(ali), 0);
}));

// ═══ Review fixes ════════════════════════════════════════════════════════════

test("retry of a save that already went through → alreadyApplied, even if a rule changed in between", withBusiness(async (businessId) => {
    const ketchup = await product(businessId, "Ketchup", 150);
    const box = await product(businessId, "Pizza box", 25);
    const ali = await newCustomer(businessId);
    const bill = await sale(businessId, ali, [line(ketchup, 2)]);

    const first = await addItems(businessId, bill, ali, [line(box, 10)], { key: "lost-reply-1" });
    assert.equal(first.statusCode, 200);

    // reply lost; meanwhile the admin turns the feature off and changes the box price
    await Business.updateOne({ _id: businessId }, { $set: { "settings.allowBillAmend": false } });
    await Product.updateOne({ _id: box._id }, { $set: { costPrice: 30 } });

    const retry = await addItems(businessId, bill, ali, [line(box, 10)], { key: "lost-reply-1" });
    assert.equal(retry.statusCode, 409, JSON.stringify(retry.body));
    assert.equal(retry.body.alreadyApplied, true);
    assert.equal(retry.body.bill.total, 550);
    assert.equal((await billOf(bill)).items.length, 2, "added once");
    assert.equal(await stockOf(box), 40, "stock taken once");
}));

test("cancelling a return on a product that is on two lines fixes the right line", withBusiness(async (businessId) => {
    const ketchup = await product(businessId, "Ketchup", 150);
    const ali = await newCustomer(businessId);
    const bill = await sale(businessId, ali, [line(ketchup, 2)]);           // morning line ×2
    await addItems(businessId, bill, ali, [line(ketchup, 3)]);              // added line ×3
    let b = await billOf(bill);
    const added = b.items[1];

    const ret = await call(processReturn, adminUser(businessId), { params: { id: bill._id }, body: { items: [{ itemId: String(added._id), quantity: 3, reason: "changed_mind" }] } });
    assert.equal(ret.statusCode, 200, JSON.stringify(ret.body));
    b = await billOf(bill);
    assert.equal(String(b.returns[0].items[0].itemId), String(added._id), "the return records its line");
    assert.deepEqual(b.items.map((i) => i.returnedQty), [0, 3]);
    assert.equal(await stockOf(ketchup), 48, "3 back on the shelf");

    const cancel = await call(cancelReturn, adminUser(businessId), { params: { id: String(bill._id), returnId: String(b.returns[0]._id) } });
    assert.equal(cancel.statusCode, 200, JSON.stringify(cancel.body));
    b = await billOf(bill);
    assert.deepEqual(b.items.map((i) => i.returnedQty), [0, 0], "the added line is restored, not the morning one");
    assert.equal(b.amountDue, 750);
    assert.equal(b.returnStatus, "none");
    assert.equal(await stockOf(ketchup), 45);

    const again = await call(processReturn, adminUser(businessId), { params: { id: bill._id }, body: { items: [{ itemId: String(added._id), quantity: 3, reason: "changed_mind" }] } });
    assert.equal(again.statusCode, 200, "those 3 can be returned again");
}));

test("an older return without a recorded line still cancels the line that was really returned", withBusiness(async (businessId) => {
    const ketchup = await product(businessId, "Ketchup", 150);
    const ali = await newCustomer(businessId);
    const bill = await sale(businessId, ali, [line(ketchup, 2)]);
    await addItems(businessId, bill, ali, [line(ketchup, 3)]);
    let b = await billOf(bill);
    await call(processReturn, adminUser(businessId), { params: { id: bill._id }, body: { items: [{ itemId: String(b.items[1]._id), quantity: 3, reason: "changed_mind" }] } });
    // make it look like a return saved before this fix
    await Bill.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(bill._id)) }, { $unset: { "returns.0.items.0.itemId": "" } });
    b = await billOf(bill);
    assert.equal(b.returns[0].items[0].itemId, undefined);

    await call(cancelReturn, adminUser(businessId), { params: { id: String(bill._id), returnId: String(b.returns[0]._id) } });
    assert.deepEqual((await billOf(bill)).items.map((i) => i.returnedQty), [0, 0], "picks the line that has 3 returned");
}));

test("bill discount + an earlier return → can't add (leftover due); bill discount without a return → can", withBusiness(async (businessId) => {
    const A = await product(businessId, "Item A", 100, 50, 50);
    const B = await product(businessId, "Item B", 100, 50, 50);
    const C = await product(businessId, "Item C", 200, 50, 100);
    const ali = await newCustomer(businessId);

    const clean = await sale(businessId, ali, [line(A, 1), line(B, 1)], { billDiscountAmount: 20 });
    let r = await addItems(businessId, clean, ali, [line(C, 1)]);
    assert.equal(r.statusCode, 200, "no return yet → allowed");
    // returning everything afterwards adds up exactly
    const b1 = await billOf(clean);
    await call(processReturn, adminUser(businessId), { params: { id: clean._id }, body: { fullReturn: true } });
    assert.equal((await billOf(clean)).amountDue, 0, `full return of ${b1.total} leaves nothing due`);

    const withReturn = await sale(businessId, ali, [line(A, 1), line(B, 1)], { billDiscountAmount: 20 });
    await call(processReturn, adminUser(businessId), { params: { id: withReturn._id }, body: { items: [{ itemId: String(withReturn.items[0]._id), quantity: 1, reason: "changed_mind" }] } });
    r = await addItems(businessId, await billOf(withReturn), ali, [line(C, 1)]);
    assert.equal(r.statusCode, 400);
    assert.equal(r.body.message, "This bill has a bill discount and a return. Make a new bill.");

    const open = (await call(getOpenBillsForCustomer, adminUser(businessId), { params: { customerId: String(ali) } })).body;
    const row = open.bills.find((x) => x.billNumber === withReturn.billNumber);
    assert.equal(row.canAmend, false);
    assert.equal(row.blockedReason, "This bill has a bill discount and a return. Make a new bill.");
}));
