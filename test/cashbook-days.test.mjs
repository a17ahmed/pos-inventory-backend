/**
 * Cash book day / range totals (GET /cashbook dailySummary + rangeSummary).
 * Day figures must come from ALL of a day's entries, whatever page or type
 * filter is shown.
 */

process.env.TZ = "Asia/Karachi";

import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import Business from "../models/business.mjs";
import CashBook from "../models/cashbook.mjs";
import Counter from "../models/counter.mjs";
import { recordCashEntry, getCashBook } from "../controllers/cashbook.mjs";

before(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
});

after(async () => {
    await mongoose.connection.close();
});

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const withBusiness = (fn) => async () => {
    const suffix = uid();
    const b = await Business.create({ name: `Cash Days ${suffix}`, businessType: new mongoose.Types.ObjectId(), email: `cash-days-${suffix}@example.test` });
    try {
        await fn(b._id);
    } finally {
        await Promise.all([
            CashBook.deleteMany({ business: b._id }),
            Counter.deleteMany({ _id: { $regex: b._id.toString() } }),
            Business.deleteOne({ _id: b._id }),
        ]);
    }
};

const call = (businessId, query) =>
    new Promise((resolve, reject) => {
        let statusCode = 200;
        const res = { status(c) { statusCode = c; return this; }, json(body) { resolve({ statusCode, body }); return this; } };
        Promise.resolve(getCashBook({ query, user: { businessId: String(businessId) } }, res)).catch(reject);
    });

/**
 * Day 1 (2 days ago): opening 1,000, then +500, −200            → closing 1,300
 * Day 2 (yesterday):  +400, +300, −100, −50, +250, −700 (6 rows) → closing 1,400
 * Day 3 (today):      +100                                       → closing 1,500
 */
const seed = async (businessId) => {
    const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(10, 0, 0, 0); return d; };
    const plan = [
        [2, "opening_balance", 1000, "in"], [2, "sale_collection", 500, "in"], [2, "expense", 200, "out"],
        [1, "sale_collection", 400, "in"], [1, "sale_collection", 300, "in"], [1, "expense", 100, "out"],
        [1, "vendor_payment", 50, "out"], [1, "sale_collection", 250, "in"], [1, "vendor_payment", 700, "out"],
        [0, "sale_collection", 100, "in"],
    ];
    let i = 0;
    for (const [n, type, amount, direction] of plan) {
        const e = await recordCashEntry({ type, amount, direction, businessId, description: `row ${++i}` });
        const when = day(n);
        when.setMinutes(i);
        await CashBook.collection.updateOne({ _id: e._id }, { $set: { createdAt: when } });
    }
    return { d1: ymd(day(2)), d2: ymd(day(1)), d3: ymd(day(0)) };
};

test("a day split across pages shows the same full-day figures on every page", withBusiness(async (businessId) => {
    const { d2 } = await seed(businessId);
    const expected = { date: d2, openingBalance: 1300, totalIn: 950, totalOut: 850, closingBalance: 1400, entryCount: 6 };
    for (const page of [1, 2, 3]) {
        const r = await call(businessId, { startDate: d2, endDate: d2, limit: 2, page });
        assert.equal(r.statusCode, 200);
        assert.deepEqual(r.body.dailySummary, [expected], `page ${page}`);
        assert.equal(r.body.entries.length, 2);
    }
}));

test("week view paged at 4: every day summary is the true day, opening = previous closing", withBusiness(async (businessId) => {
    const { d1, d2, d3 } = await seed(businessId);
    const truth = {
        [d1]: { openingBalance: 0, totalIn: 1500, totalOut: 200, closingBalance: 1300, entryCount: 3 },
        [d2]: { openingBalance: 1300, totalIn: 950, totalOut: 850, closingBalance: 1400, entryCount: 6 },
        [d3]: { openingBalance: 1400, totalIn: 100, totalOut: 0, closingBalance: 1500, entryCount: 1 },
    };
    const seen = new Set();
    for (let page = 1; page <= 3; page++) {
        const r = await call(businessId, { startDate: d1, endDate: d3, limit: 4, page });
        for (const s of r.body.dailySummary) {
            assert.deepEqual(s, { date: s.date, ...truth[s.date] });
            seen.add(s.date);
        }
    }
    assert.equal(seen.size, 3);
}));

test("type filter lists only that type, but day figures stay the real cash day", withBusiness(async (businessId) => {
    const { d2 } = await seed(businessId);
    const r = await call(businessId, { startDate: d2, endDate: d2, type: "vendor_payment" });
    assert.ok(r.body.entries.every((e) => e.type === "vendor_payment"));
    assert.equal(r.body.entries.length, 2);
    assert.equal(r.body.dailySummary[0].closingBalance, 1400);
    assert.equal(r.body.dailySummary[0].totalOut, 850);
    assert.deepEqual(r.body.rangeSummary.type, { type: "vendor_payment", totalIn: 0, totalOut: 750, entryCount: 2 });
}));

test("range summary: opening before the range, totals inside it, closing at its end", withBusiness(async (businessId) => {
    const { d1, d2, d3 } = await seed(businessId);
    const r = (await call(businessId, { startDate: d2, endDate: d3, limit: 1 })).body.rangeSummary;
    assert.equal(r.openingBalance, 1300);
    assert.equal(r.totalIn, 1050);
    assert.equal(r.totalOut, 850);
    assert.equal(r.net, 200);
    assert.equal(r.closingBalance, 1500);
    assert.equal(r.entryCount, 7);

    const all = (await call(businessId, {})).body.rangeSummary;
    assert.equal(all.openingBalance, 0);
    assert.equal(all.closingBalance, 1500);
    assert.equal(all.entryCount, 10);

    // a range with no entries: opening = closing = balance before it
    const future = new Date(); future.setDate(future.getDate() + 3);
    const empty = (await call(businessId, { startDate: ymd(future), endDate: ymd(future) })).body;
    assert.deepEqual(empty.dailySummary, []);
    assert.equal(empty.rangeSummary.openingBalance, 1500);
    assert.equal(empty.rangeSummary.closingBalance, 1500);
    assert.equal(empty.rangeSummary.entryCount, 0);
    void d1;
}));
