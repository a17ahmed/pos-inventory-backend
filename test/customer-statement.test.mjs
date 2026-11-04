/**
 * Integration tests for GET /customer/:id/statement and /pending-bills
 * (controllers/customerStatement.mjs).
 *
 * Same pattern as the other suites: real configured MongoDB, one throwaway
 * Business per test, cleaned up afterwards. Bill dates are set relative to
 * "now" so the period presets (today, custom, …) are exercised for real.
 */

process.env.TZ = "Asia/Karachi";

import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import Bill from "../models/bill.mjs";
import Business from "../models/business.mjs";
import Customer from "../models/customer.mjs";
import Counter from "../models/counter.mjs";
import { getCustomerStatement, getPendingBills } from "../controllers/customerStatement.mjs";
import { getCustomerLedger } from "../controllers/customer.mjs";
import { settleCustomerCredit } from "../utils/storeCredit.mjs";

before(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
});

after(async () => {
    await mongoose.connection.close();
});

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => {
    const d = new Date(Date.now() - n * DAY);
    d.setHours(12, 0, 0, 0);
    return d;
};
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const withBusiness = (fn) => async () => {
    const suffix = uid();
    const business = await Business.create({
        name: `Statement Test ${suffix}`,
        businessType: new mongoose.Types.ObjectId(),
        email: `statement-${suffix}@example.test`,
    });
    try {
        await fn(business._id);
    } finally {
        await Promise.all([
            Bill.deleteMany({ business: business._id }),
            Customer.deleteMany({ business: business._id }),
            Counter.deleteMany({ _id: { $regex: business._id.toString() } }),
            Business.deleteOne({ _id: business._id }),
        ]);
    }
};

const call = (fn, businessId, id, query = {}) =>
    new Promise((resolve, reject) => {
        let statusCode = 200;
        const res = {
            status(c) { statusCode = c; return this; },
            json(body) { resolve({ statusCode, body }); return this; },
        };
        Promise.resolve(fn({ params: { id: String(id) }, query, user: { businessId: String(businessId) } }, res)).catch(reject);
    });

let billNo = 0;
/** Save a bill, then force its dates (createdAt, paidAt of sale-time payments). */
const bill = async (businessId, customer, { total, paid = 0, at, status = "completed", type = "sale" }) => {
    const b = new Bill({
        billNumber: ++billNo,
        business: businessId,
        customer,
        customerName: "Ali",
        type,
        status,
        items: type === "sale" ? [{ name: `Item ${billNo}`, qty: 1, price: total, costPrice: 0 }] : [],
        total: type === "opening_balance" ? total : undefined,
        payments: paid ? [{ amount: paid, method: "cash" }] : [],
    });
    await b.save();
    await Bill.collection.updateOne(
        { _id: b._id },
        { $set: { createdAt: at, ...(paid ? { "payments.0.paidAt": new Date(at.getTime() - 500) } : {}) } }
    );
    return b;
};

const addPayment = async (b, amount, at) => {
    const doc = await Bill.findById(b._id);
    doc.payments.push({ amount, method: "cash", paidAt: at, note: "later payment" });
    await doc.save();
};

const addReturn = async (b, amount, at) => {
    const doc = await Bill.findById(b._id);
    doc.returns.push({
        returnNumber: `RET-${uid()}`,
        refundMethod: "ledger_adjust",
        refundAmount: amount,
        returnedAt: at,
        items: [{ name: doc.items[0].name, quantity: 1, price: amount, refundAmount: amount, reason: "changed_mind" }],
    });
    await doc.save();
};

/**
 * Standard customer:
 *   B1  10 days ago  10,000  unpaid;      4,000 paid on it TODAY
 *   B2   3 days ago   5,000  paid at sale; 1,000 returned TODAY (→ 1,000 credit)
 *   B3  today         2,000  unpaid
 *   B4   2 days ago   1,500  cancelled
 * All-time: billed 17,000 · paid 9,000 · returns 1,000 · due 7,000
 * Before today: 10,000 + 5,000 − 5,000 = 10,000
 */
const setup = async (businessId) => {
    const customer = (await Customer.create({ business: businessId, name: "Ali", phone: uid() }))._id;
    const b1 = await bill(businessId, customer, { total: 10000, at: daysAgo(10) });
    const b2 = await bill(businessId, customer, { total: 5000, paid: 5000, at: daysAgo(3) });
    const b4 = await bill(businessId, customer, { total: 1500, at: daysAgo(2), status: "cancelled" });
    const b3 = await bill(businessId, customer, { total: 2000, at: new Date() });
    await addPayment(b1, 4000, new Date());
    await addReturn(b2, 1000, new Date());
    return { customer, b1, b2, b3, b4 };
};

// ═══ Summary cards ═══════════════════════════════════════════════════════════

test("summary is all-time and identical for every period / type / sort / page", withBusiness(async (businessId) => {
    const { customer } = await setup(businessId);
    const expected = { totalBilled: 17000, totalPaid: 9000, totalReturns: 1000, totalBills: 3, amountDue: 7000, availableCredit: 0 };

    for (const q of [{}, { period: "all" }, { period: "yesterday" }, { type: "payment" }, { sort: "newest" }, { period: "all", limit: 1, page: 3 }]) {
        const r = await call(getCustomerStatement, businessId, customer, q);
        assert.equal(r.statusCode, 200, JSON.stringify(r.body));
        assert.deepEqual(r.body.summary, expected, JSON.stringify(q));
    }
    const stored = await Customer.findById(customer).lean();
    assert.equal(stored.balance, 7000, "Amount Due = stored customer balance");
}));

// ═══ Periods and opening/closing ════════════════════════════════════════════

test("today: opening = before today, closing = Amount Due, payment on an old bill is listed today", withBusiness(async (businessId) => {
    const { customer, b1, b2, b3 } = await setup(businessId);
    const r = await call(getCustomerStatement, businessId, customer, { period: "today" });
    const p = r.body.period;
    assert.equal(p.preset, "today");
    assert.equal(p.openingBalance, 10000);
    assert.equal(p.bills, 2000);
    assert.equal(p.payments, 4000);
    assert.equal(p.returns, 1000);
    assert.equal(p.closingBalance, 7000);
    assert.equal(p.entryCount, 3);

    const types = r.body.entries.map((e) => `${e.type}#${e.billNumber}`);
    assert.ok(types.includes(`payment#${b1.billNumber}`), "today's payment on a 10-day-old bill is shown today");
    assert.ok(types.includes(`return#${b2.billNumber}`));
    assert.ok(types.includes(`bill#${b3.billNumber}`));
    assert.equal(r.body.entries.at(-1).balance, 7000);
}));

test("all time: closing = Amount Due; balances match the old ledger line by line", withBusiness(async (businessId) => {
    const { customer } = await setup(businessId);
    const r = await call(getCustomerStatement, businessId, customer, { period: "all", limit: 200 });
    assert.equal(r.body.period.openingBalance, 0);
    assert.equal(r.body.period.closingBalance, 7000);

    const old = await call(getCustomerLedger, businessId, customer);
    assert.deepEqual(
        r.body.entries.map((e) => [e.type, e.billNumber, e.debit, e.credit, e.balance]),
        old.body.ledger.map((e) => [e.type, e.billNumber, e.debit, e.credit, e.balance])
    );
}));

test("custom range: opening carries everything before it", withBusiness(async (businessId) => {
    const { customer, b2 } = await setup(businessId);
    const day = localDate(daysAgo(3));
    const r = await call(getCustomerStatement, businessId, customer, { period: "custom", from: day, to: day });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.period.openingBalance, 10000, "B1 from 10 days ago");
    assert.equal(r.body.period.bills, 5000);
    assert.equal(r.body.period.payments, 5000);
    assert.equal(r.body.period.closingBalance, 10000);
    assert.deepEqual(r.body.entries.map((e) => e.type), ["bill", "payment"], "sale-time payment comes after its bill");
    assert.ok(r.body.entries.every((e) => e.billNumber === b2.billNumber));
}));

test("other presets work and validation errors are 400 / 404", withBusiness(async (businessId) => {
    const { customer } = await setup(businessId);
    for (const period of ["yesterday", "week", "month", "lastMonth"]) {
        const r = await call(getCustomerStatement, businessId, customer, { period });
        assert.equal(r.statusCode, 200, period);
        const p = r.body.period;
        assert.equal(Math.round((p.openingBalance + p.bills - p.payments - p.returns) * 100), Math.round(p.closingBalance * 100), period);
    }
    assert.equal((await call(getCustomerStatement, businessId, customer, { period: "custom", from: "2026-01-01" })).statusCode, 400);
    assert.equal((await call(getCustomerStatement, businessId, customer, { period: "custom", from: "2026-02-01", to: "2026-01-01" })).statusCode, 400);
    assert.equal((await call(getCustomerStatement, businessId, customer, { period: "decade" })).statusCode, 400);
    assert.equal((await call(getCustomerStatement, businessId, customer, { type: "nope" })).statusCode, 400);
    assert.equal((await call(getCustomerStatement, businessId, new mongoose.Types.ObjectId())).statusCode, 404);
    assert.equal((await call(getCustomerStatement, businessId, "not-an-id")).statusCode, 404);
}));

// ═══ Sort, type, search, paging ═════════════════════════════════════════════

test("sort newest only flips the order; every line keeps its balance", withBusiness(async (businessId) => {
    const { customer } = await setup(businessId);
    const asc = (await call(getCustomerStatement, businessId, customer, { period: "all" })).body.entries;
    const desc = (await call(getCustomerStatement, businessId, customer, { period: "all", sort: "newest" })).body.entries;
    assert.deepEqual(desc.map((e) => e.id), asc.map((e) => e.id).reverse());
    const byId = new Map(asc.map((e) => [e.id, e.balance]));
    assert.ok(desc.every((e) => byId.get(e.id) === e.balance));
}));

test("type filter shows only that type; opening/closing unchanged", withBusiness(async (businessId) => {
    const { customer } = await setup(businessId);
    const all = (await call(getCustomerStatement, businessId, customer, { period: "all" })).body;
    const pays = (await call(getCustomerStatement, businessId, customer, { period: "all", type: "payment" })).body;
    assert.ok(pays.entries.length > 0 && pays.entries.every((e) => e.type === "payment"));
    assert.deepEqual(pays.period, all.period);
    const byId = new Map(all.entries.map((e) => [e.id, e.balance]));
    assert.ok(pays.entries.every((e) => byId.get(e.id) === e.balance), "filtered lines keep their true balance");
}));

test("cancelled bills: hidden by default, counted, and listed only with type=cancelled", withBusiness(async (businessId) => {
    const { customer, b4 } = await setup(businessId);
    const all = (await call(getCustomerStatement, businessId, customer, { period: "all" })).body;
    assert.ok(all.entries.every((e) => e.type !== "cancelled"));
    assert.equal(all.period.cancelledCount, 1);
    const c = (await call(getCustomerStatement, businessId, customer, { period: "all", type: "cancelled" })).body;
    assert.equal(c.entries.length, 1);
    assert.equal(c.entries[0].billNumber, b4.billNumber);
    assert.equal(c.entries[0].debit, 0);
    assert.equal(c.entries[0].billTotal, 1500);
}));

test("search by bill number", withBusiness(async (businessId) => {
    const { customer, b1 } = await setup(businessId);
    const r = (await call(getCustomerStatement, businessId, customer, { period: "all", search: `#${b1.billNumber}` })).body;
    assert.ok(r.entries.length >= 2);
    assert.ok(r.entries.every((e) => String(e.billNumber).includes(String(b1.billNumber))));
}));

test("paging: pages joined equal the full list, balances continue across pages", withBusiness(async (businessId) => {
    const { customer } = await setup(businessId);
    const full = (await call(getCustomerStatement, businessId, customer, { period: "all", limit: 200 })).body;
    const joined = [];
    for (let page = 1; ; page++) {
        const r = (await call(getCustomerStatement, businessId, customer, { period: "all", limit: 2, page })).body;
        joined.push(...r.entries);
        assert.equal(r.pagination.total, full.entries.length);
        if (!r.pagination.hasMore) break;
    }
    assert.deepEqual(joined.map((e) => [e.id, e.balance]), full.entries.map((e) => [e.id, e.balance]));
}));

// ═══ Returns, credit moves, pending bills ═══════════════════════════════════

test("return line carries the store-credit / unpaid-reduced split", withBusiness(async (businessId) => {
    const { customer } = await setup(businessId);
    const ret = (await call(getCustomerStatement, businessId, customer, { type: "return" })).body.entries[0];
    assert.equal(ret.credit, 1000);
    assert.equal(ret.storeCredit, 1000, "bill was fully paid → all of it is credit");
    assert.equal(ret.debtWriteOff, 0);
    assert.equal(ret.notes, "changed_mind");
}));

test("pending bills: age is in calendar days, not 24-hour periods", withBusiness(async (businessId) => {
    const customer = (await Customer.create({ business: businessId, name: "Age", phone: uid() }))._id;
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const lateYesterday = await bill(businessId, customer, { total: 100, at: new Date(midnight.getTime() - 60 * 60 * 1000) }); // 11 PM yesterday
    const thisMorning = await bill(businessId, customer, { total: 100, at: midnight }); // 00:00 today
    const p = (await call(getPendingBills, businessId, customer)).body;
    assert.deepEqual(p.bills.map((b) => [b.billNumber, b.ageDays]), [[lateYesterday.billNumber, 1], [thisMorning.billNumber, 0]]);
}));

test("pending bills: listed oldest first and total = Amount Due (with and without credit)", withBusiness(async (businessId) => {
    const { customer, b1, b3 } = await setup(businessId);
    let p = (await call(getPendingBills, businessId, customer)).body;
    assert.deepEqual(p.bills.map((b) => [b.billNumber, b.due]), [[b1.billNumber, 6000], [b3.billNumber, 2000]]);
    assert.equal(p.totalDue, 8000);
    assert.equal(p.availableCredit, 1000, "B2's unused return credit");
    assert.equal(p.amountDue, 7000);
    assert.equal(p.bills[0].ageDays, 10);

    // Apply the credit (as the app does on returns) → still 7,000, no credit left
    const session = await mongoose.startSession();
    session.startTransaction();
    await settleCustomerCredit({ customerId: customer, businessId, session, force: true });
    await session.commitTransaction();
    session.endSession();

    p = (await call(getPendingBills, businessId, customer)).body;
    assert.deepEqual(p.bills.map((b) => [b.billNumber, b.due]), [[b1.billNumber, 5000], [b3.billNumber, 2000]]);
    assert.equal(p.availableCredit, 0);
    assert.equal(p.amountDue, 7000);

    const s = (await call(getCustomerStatement, businessId, customer, { period: "all" })).body;
    assert.equal(s.summary.amountDue, 7000, "credit move nets to zero");
    assert.equal(s.summary.totalPaid, 9000, "credit move isn't real money");
    const pair = s.entries.filter((e) => e.type === "credit_transfer" || e.fromCredit);
    assert.equal(pair.length, 2);
    assert.equal(s.period.closingBalance, 7000);

    const newest = (await call(getCustomerStatement, businessId, customer, { sort: "amount" })).statusCode;
    assert.equal(newest, 400);
    const byAmount = (await call(getPendingBills, businessId, customer, { sort: "amount" })).body.bills;
    assert.ok(byAmount[0].due >= byAmount[1].due);
}));

test("customer with credit: amountDue negative → availableCredit", withBusiness(async (businessId) => {
    const customer = (await Customer.create({ business: businessId, name: "Credit", phone: uid() }))._id;
    const b = await bill(businessId, customer, { total: 2000, paid: 2000, at: daysAgo(1) });
    await addReturn(b, 2000, new Date());
    const s = (await call(getCustomerStatement, businessId, customer)).body;
    assert.equal(s.summary.amountDue, -2000);
    assert.equal(s.summary.availableCredit, 2000);
    assert.equal(s.period.closingBalance, -2000);
    const p = (await call(getPendingBills, businessId, customer)).body;
    assert.deepEqual(p.bills, []);
    assert.equal(p.availableCredit, 2000);
    assert.equal(p.amountDue, -2000);
}));

test("opening-balance bill is a dated line; empty period still shows opening = closing", withBusiness(async (businessId) => {
    const customer = (await Customer.create({ business: businessId, name: "OB", phone: uid() }))._id;
    await bill(businessId, customer, { total: 3000, at: daysAgo(30), type: "opening_balance" });
    const all = (await call(getCustomerStatement, businessId, customer, { period: "all" })).body;
    assert.equal(all.entries[0].type, "opening_balance");
    assert.equal(all.entries[0].debit, 3000);
    const today = (await call(getCustomerStatement, businessId, customer, { period: "today" })).body;
    assert.equal(today.entries.length, 0);
    assert.equal(today.period.openingBalance, 3000);
    assert.equal(today.period.closingBalance, 3000);
    assert.equal(today.summary.amountDue, 3000);
}));

// ═══ Since last zero (default period) ═════════════════════════════════════

const at = (days, minutes = 0) => new Date(daysAgo(days).getTime() + minutes * 60 * 1000);

test("since last zero is the default: starts after the last time the customer owed nothing", withBusiness(async (businessId) => {
    const customer = (await Customer.create({ business: businessId, name: "Zero", phone: uid() }))._id;
    const b1 = await bill(businessId, customer, { total: 5000, at: at(20) });
    await addPayment(b1, 5000, at(15));                                  // balance 0 ← last zero
    const b2 = await bill(businessId, customer, { total: 3000, at: at(10) });
    const b3 = await bill(businessId, customer, { total: 4000, at: at(5) });
    await addPayment(b3, 2000, at(2));                                   // owes 5,000

    const r = (await call(getCustomerStatement, businessId, customer)).body;
    assert.equal(r.period.preset, "sinceZero");
    assert.deepEqual(r.period.sinceZero, { status: "open", zeroAt: at(15), settledAt: null });
    assert.equal(r.period.openingBalance, 0);
    assert.deepEqual(r.entries.map((e) => [e.type, e.billNumber, e.balance]), [
        ["bill", b2.billNumber, 3000],
        ["bill", b3.billNumber, 7000],
        ["payment", b3.billNumber, 5000],
    ]);
    assert.equal(r.period.bills, 7000);
    assert.equal(r.period.payments, 2000);
    assert.equal(r.period.closingBalance, 5000);
    assert.equal(r.summary.amountDue, 5000);

    // filters still work inside the period; opening/closing unchanged
    const bills = (await call(getCustomerStatement, businessId, customer, { type: "bill" })).body;
    assert.deepEqual(bills.entries.map((e) => e.billNumber), [b2.billNumber, b3.billNumber]);
    assert.equal(bills.period.closingBalance, 5000);
}));

test("since last zero cuts by position, not date: a bill minutes after the zero on the same day is shown, the settled one isn't", withBusiness(async (businessId) => {
    const customer = (await Customer.create({ business: businessId, name: "SameDay", phone: uid() }))._id;
    const b1 = await bill(businessId, customer, { total: 1000, at: at(0, -30) });
    await addPayment(b1, 1000, at(0, -20));                              // 0
    const b2 = await bill(businessId, customer, { total: 500, at: at(0, -10) });

    const r = (await call(getCustomerStatement, businessId, customer)).body;
    assert.deepEqual(r.entries.map((e) => [e.type, e.billNumber]), [["bill", b2.billNumber]]);
    assert.equal(r.period.openingBalance, 0);
    assert.equal(r.period.closingBalance, 500);
}));

test("overpaid counts as settled: opening shows the credit", withBusiness(async (businessId) => {
    const customer = (await Customer.create({ business: businessId, name: "Over", phone: uid() }))._id;
    const b1 = await bill(businessId, customer, { total: 5000, at: at(10) });
    await addPayment(b1, 5200, at(8));                                   // −200, never exactly 0
    const b2 = await bill(businessId, customer, { total: 1000, at: at(3) });

    const r = (await call(getCustomerStatement, businessId, customer)).body;
    assert.equal(r.period.sinceZero.status, "open");
    assert.equal(r.period.openingBalance, -200);
    assert.deepEqual(r.entries.map((e) => e.billNumber), [b2.billNumber]);
    assert.equal(r.period.closingBalance, 800);
}));

test("never settled: shows everything", withBusiness(async (businessId) => {
    const { customer } = await setup(businessId);
    const r = (await call(getCustomerStatement, businessId, customer)).body;
    const all = (await call(getCustomerStatement, businessId, customer, { period: "all" })).body;
    assert.deepEqual(r.period.sinceZero, { status: "neverSettled", zeroAt: null, settledAt: null });
    assert.equal(r.period.openingBalance, 0);
    assert.deepEqual(r.entries, all.entries);
    assert.equal(r.period.closingBalance, 7000);
}));

test("owes nothing now: shows the last completed cycle and when it was settled", withBusiness(async (businessId) => {
    const customer = (await Customer.create({ business: businessId, name: "Done", phone: uid() }))._id;
    const b1 = await bill(businessId, customer, { total: 5000, at: at(20) });
    await addPayment(b1, 5000, at(15));                                  // 0 (older cycle)
    const b2 = await bill(businessId, customer, { total: 3000, at: at(10) });
    await addPayment(b2, 3000, at(3));                                   // 0 now

    const r = (await call(getCustomerStatement, businessId, customer)).body;
    assert.deepEqual(r.period.sinceZero, { status: "settled", zeroAt: at(15), settledAt: at(3) });
    assert.deepEqual(r.entries.map((e) => [e.type, e.billNumber, e.balance]), [
        ["bill", b2.billNumber, 3000],
        ["payment", b2.billNumber, 0],
    ]);
    assert.equal(r.period.openingBalance, 0);
    assert.equal(r.period.closingBalance, 0);
}));

test("customer with no bills: empty, status noBalance", withBusiness(async (businessId) => {
    const customer = (await Customer.create({ business: businessId, name: "New", phone: uid() }))._id;
    const r = (await call(getCustomerStatement, businessId, customer)).body;
    assert.deepEqual(r.period.sinceZero, { status: "noBalance", zeroAt: null, settledAt: null });
    assert.deepEqual(r.entries, []);
    assert.equal(r.period.closingBalance, 0);
}));

// ═══ Since last zero + store-credit moves ═══════════════════════════════════

/** Run the real store-credit settlement (as the app does after a return). */
const settle = async (businessId, customerId) => {
    const session = await mongoose.startSession();
    try {
        let moves;
        await session.withTransaction(async () => {
            moves = await settleCustomerCredit({ customerId, businessId, session, force: true });
        });
        return moves;
    } finally {
        await session.endSession();
    }
};

test("since last zero ignores the credit-move blip: return credit paying another bill keeps that bill in view", withBusiness(async (businessId) => {
    const customer = (await Customer.create({ business: businessId, name: "Blip", phone: uid() }))._id;
    const a = await bill(businessId, customer, { total: 1000, at: at(10) });
    await addPayment(a, 1000, at(9));                                    // 0 ← real last zero
    const b = await bill(businessId, customer, { total: 1000, at: at(5) }); // owes 1,000
    await addReturn(a, 1000, at(2));                                     // back to 0 (A in credit)
    const moves = await settle(businessId, customer);                    // A's credit pays B → +1000 / −1000 pair
    assert.equal(moves.length, 1);

    const r = (await call(getCustomerStatement, businessId, customer)).body;
    assert.equal(r.period.sinceZero.status, "settled");
    assert.equal(r.period.openingBalance, 0);
    assert.deepEqual(r.entries.map((e) => [e.type, e.billNumber]), [
        ["bill", b.billNumber],
        ["return", a.billNumber],
        ["credit_transfer", a.billNumber],
        ["payment", b.billNumber],
    ], "Bill B and the return are shown, not only the credit pair");
    assert.equal(r.period.closingBalance, 0);
    assert.deepEqual(r.period.sinceZero.settledAt, at(2), "settled by the return");
}));

test("customer in credit buying less than the credit: never owed, the blip isn't a debt", withBusiness(async (businessId) => {
    const customer = (await Customer.create({ business: businessId, name: "Credit", phone: uid() }))._id;
    const a = await bill(businessId, customer, { total: 1000, paid: 1000, at: at(10) });
    await addReturn(a, 1000, at(8));                                     // credit 1,000
    await bill(businessId, customer, { total: 600, at: at(3) });         // −400
    await settle(businessId, customer);                                  // pair +600 / −600

    const r = (await call(getCustomerStatement, businessId, customer)).body;
    assert.equal(r.period.sinceZero.status, "settled");
    assert.equal(r.period.closingBalance, -400);
    const all = (await call(getCustomerStatement, businessId, customer, { period: "all" })).body;
    assert.deepEqual(r.entries.map((e) => e.id), all.entries.map((e) => e.id), "nothing hidden: the customer never owed after the start");
}));

test("still owing after a credit move: status open, not settled", withBusiness(async (businessId) => {
    const customer = (await Customer.create({ business: businessId, name: "Owes", phone: uid() }))._id;
    const a = await bill(businessId, customer, { total: 500, paid: 500, at: at(10) });   // 0
    const b = await bill(businessId, customer, { total: 2000, at: at(6) });              // owes 2,000
    await addReturn(a, 500, at(4));                                                      // 1,500
    await settle(businessId, customer);                                                  // pair +500 / −500 → still 1,500

    const r = (await call(getCustomerStatement, businessId, customer)).body;
    assert.equal(r.period.sinceZero.status, "open");
    assert.equal(r.period.closingBalance, 1500);
    assert.ok(r.entries.some((e) => e.type === "bill" && e.billNumber === b.billNumber));
}));

test("statement input: impossible custom dates are 400; huge page numbers don't crash", withBusiness(async (businessId) => {
    const { customer } = await setup(businessId);
    const bad = await call(getCustomerStatement, businessId, customer, { period: "custom", from: "2026-02-31", to: "2026-03-05" });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.message, "from and to must be real dates (YYYY-MM-DD)");
    const huge = await call(getCustomerStatement, businessId, customer, { period: "all", page: "100000000000000000000" });
    assert.equal(huge.statusCode, 200);
    assert.deepEqual(huge.body.entries, []);
}));
