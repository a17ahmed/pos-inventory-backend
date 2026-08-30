/**
 * Integration tests for the GET /bill list handler (getAllBills).
 *
 * Covers the three changes made to the handler:
 *   FIX 1 — page/limit guards (limit clamped to [1,100], page >= 1)
 *   FIX 2b — startDate parsed as local start-of-day (not raw UTC)
 *   FIX 3 — count + find run in parallel (response shape unchanged)
 *
 * Runs against the real configured MongoDB, same pattern as return.test.mjs.
 * Each test uses its own isolated Business so data never overlaps.
 *
 * TZ is pinned to Asia/Karachi (matching index.mjs startup) BEFORE any import
 * so the start-of-day boundary test is deterministic regardless of host TZ.
 */

process.env.TZ = "Asia/Karachi";

import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import Bill from "../models/bill.mjs";
import Business from "../models/business.mjs";
import { getAllBills } from "../controllers/bill.mjs";

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
        name: `GetAllBills Test ${suffix}`,
        businessType: new mongoose.Types.ObjectId(),
        email: `getallbills-${suffix}@example.test`,
    });
    return b._id;
};

const cleanupBusiness = async (businessId) => {
    await Promise.all([
        Bill.deleteMany({ business: businessId }),
        Business.deleteOne({ _id: businessId }),
    ]);
};

let billNo = 0;
/** Insert a completed sale bill. If createdAt is given, force it past the timestamps hook. */
const seedBill = async (businessId, { createdAt } = {}) => {
    const bill = new Bill({
        billNumber: ++billNo,
        business: businessId,
        type: "sale",
        status: "completed",
        items: [{ name: "Widget", qty: 1, price: 100, costPrice: 60 }],
        payments: [{ amount: 100, method: "cash" }],
    });
    await bill.save();
    if (createdAt) {
        // timestamps:true overwrites createdAt on save — set it directly on the collection.
        await Bill.collection.updateOne({ _id: bill._id }, { $set: { createdAt } });
    }
    return bill;
};

/** Mock Express req; adminId set so canViewProfit() short-circuits to true. */
const mockReq = (businessId, query = {}) => ({
    query,
    user: { adminId: TEST_ADMIN_ID.toString(), id: TEST_ADMIN_ID, businessId, name: "Test Admin" },
});

/** Invoke getAllBills, capturing the JSON body + status. */
const callGetAllBills = (req) =>
    new Promise((resolve) => {
        let statusCode = 200;
        const res = {
            json(data) { resolve({ statusCode, ...data }); return this; },
            status(code) { statusCode = code; return this; },
        };
        getAllBills(req, res);
    });

// ─── FIX 1: page / limit guards ──────────────────────────────────────────────

test("limit is clamped to 100 when a huge value is requested", async () => {
    const businessId = await createBusiness();
    try {
        await Promise.all(Array.from({ length: 3 }, () => seedBill(businessId)));
        const r = await callGetAllBills(mockReq(businessId, { limit: "100000" }));

        assert.equal(r.statusCode, 200);
        assert.equal(r.pagination.perPage, 100, "perPage should be clamped to 100");
        assert.equal(r.pagination.total, 3);
        assert.ok(r.bills.length <= 100);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("limit defaults to 30 when absent or zero", async () => {
    const businessId = await createBusiness();
    try {
        await seedBill(businessId);
        const noLimit = await callGetAllBills(mockReq(businessId, {}));
        const zeroLimit = await callGetAllBills(mockReq(businessId, { limit: "0" }));

        assert.equal(noLimit.pagination.perPage, 30);
        assert.equal(zeroLimit.pagination.perPage, 30, "limit=0 falls back to the 30 default");
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("negative limit is clamped up to 1", async () => {
    const businessId = await createBusiness();
    try {
        await Promise.all(Array.from({ length: 2 }, () => seedBill(businessId)));
        const r = await callGetAllBills(mockReq(businessId, { limit: "-5" }));

        assert.equal(r.pagination.perPage, 1);
        assert.equal(r.bills.length, 1);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("negative page is guarded to 1 (no negative-skip error)", async () => {
    const businessId = await createBusiness();
    try {
        await seedBill(businessId);
        const r = await callGetAllBills(mockReq(businessId, { page: "-5" }));

        assert.equal(r.statusCode, 200, "must not 500 from a negative skip");
        assert.equal(r.pagination.page, 1);
    } finally {
        await cleanupBusiness(businessId);
    }
});

// ─── FIX 3: response shape unchanged + pagination math ───────────────────────

test("pagination fields are correct across pages", async () => {
    const businessId = await createBusiness();
    try {
        await Promise.all(Array.from({ length: 3 }, () => seedBill(businessId)));

        const p1 = await callGetAllBills(mockReq(businessId, { page: "1", limit: "2" }));
        assert.deepEqual(Object.keys(p1.pagination).sort(),
            ["hasMore", "page", "perPage", "total", "totalPages"]);
        assert.equal(p1.pagination.total, 3);
        assert.equal(p1.pagination.totalPages, 2);
        assert.equal(p1.pagination.hasMore, true);
        assert.equal(p1.bills.length, 2);

        const p2 = await callGetAllBills(mockReq(businessId, { page: "2", limit: "2" }));
        assert.equal(p2.pagination.hasMore, false);
        assert.equal(p2.bills.length, 1);
    } finally {
        await cleanupBusiness(businessId);
    }
});

// ─── FIX 2b: startDate is local start-of-day, not raw UTC ────────────────────

test("startDate includes an early-morning bill that raw-UTC parsing would drop", async () => {
    const businessId = await createBusiness();
    try {
        // A bill at 02:00 local Asia/Karachi on 2026-08-30 == 2026-08-29T21:00:00Z.
        // Old code: query.$gte = new Date("2026-08-30") = 2026-08-30T00:00:00Z (05:00 local)
        //           → this bill (21:00Z Aug-29) is BEFORE the bound → wrongly excluded.
        // New code: query.$gte = startOfDay("2026-08-30") = 2026-08-29T19:00:00Z (00:00 local)
        //           → bill is AFTER the bound → correctly included.
        const earlyLocal = new Date("2026-08-29T21:00:00.000Z");
        await seedBill(businessId, { createdAt: earlyLocal });

        const r = await callGetAllBills(mockReq(businessId, {
            startDate: "2026-08-30",
            endDate: "2026-08-30",
        }));

        assert.equal(r.pagination.total, 1, "early-morning bill must be inside 'Today'");
        assert.equal(r.bills.length, 1);
    } finally {
        await cleanupBusiness(businessId);
    }
});

test("date range excludes bills outside the window and paginates the rest", async () => {
    const businessId = await createBusiness();
    try {
        // Two bills on 2026-08-30 (local), one on 2026-08-28 (local, out of range).
        await seedBill(businessId, { createdAt: new Date("2026-08-30T05:00:00.000Z") });
        await seedBill(businessId, { createdAt: new Date("2026-08-30T06:00:00.000Z") });
        await seedBill(businessId, { createdAt: new Date("2026-08-28T05:00:00.000Z") });

        const r = await callGetAllBills(mockReq(businessId, {
            startDate: "2026-08-30",
            endDate: "2026-08-30",
            page: "1",
            limit: "30",
        }));

        assert.equal(r.pagination.total, 2, "only the two in-range bills count");
        assert.equal(r.bills.length, 2);
    } finally {
        await cleanupBusiness(businessId);
    }
});
