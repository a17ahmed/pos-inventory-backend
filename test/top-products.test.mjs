/**
 * Integration tests for GET /bill/top-products (POS Quick Add grid).
 *
 * Requests go through the real accessControl middleware and then the
 * controller, so the 403s are the same ones the desktop app would see.
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
import Product from "../models/product.mjs";
import Access from "../models/access.mjs";

import { getTopProducts, salesByProduct } from "../controllers/bill.mjs";
import { accessControl, invalidateAccessCache } from "../middleware/accessControl.mjs";

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
        name: `Top Products Test ${suffix}`,
        businessType: new mongoose.Types.ObjectId(),
        email: `top-products-${suffix}@example.test`,
    });
    return b._id;
};

const cleanupBusiness = async (businessId) => {
    await Promise.all([
        Bill.deleteMany({ business: businessId }),
        Product.deleteMany({ business: businessId }),
        Access.deleteMany({ business: businessId }),
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

const adminUser = (businessId) => ({
    adminId: TEST_ADMIN_ID.toString(), id: TEST_ADMIN_ID.toString(), businessId: businessId.toString(), name: "Test Admin",
});

/** An employee whose Access doc has the model defaults plus `permissions` overrides. */
const newEmployee = async (businessId, permissions) => {
    const employeeId = new mongoose.Types.ObjectId();
    await Access.create({ employee: employeeId, business: businessId, ...(permissions && { permissions }) });
    invalidateAccessCache(employeeId.toString(), businessId.toString());
    return {
        employeeId,
        user: { id: employeeId.toString(), employeeId: employeeId.toString(), businessId: businessId.toString(), name: "Cashier", role: "employee" },
    };
};

const setPermission = async (businessId, employeeId, path, value) => {
    await Access.updateOne({ employee: employeeId, business: businessId }, { $set: { [`permissions.${path}`]: value } });
    invalidateAccessCache(employeeId.toString(), businessId.toString());
};

/** GET through accessControl → controller, like the real /bill router. */
const get = (url, user, controller) =>
    new Promise((resolve, reject) => {
        let statusCode = 200;
        const res = {
            headersSent: false,
            json(body) { this.headersSent = true; resolve({ statusCode, body }); return this; },
            status(code) { statusCode = code; return this; },
        };
        const query = Object.fromEntries(new URLSearchParams(url.split("?")[1] || ""));
        const req = { method: "GET", originalUrl: url, params: {}, body: {}, query, user };
        const next = () => Promise.resolve(controller(req, res)).catch(reject);
        Promise.resolve(accessControl(req, res, next)).catch(reject);
    });

/** `count` products, each sold once in a single completed sale (qty = its position, so order is stable). */
const seedSales = async (businessId, count) => {
    const products = await Product.insertMany(
        Array.from({ length: count }, (_, i) => ({
            name: `Item ${i + 1}`,
            sku: `SKU-${uid()}-${i}`,
            sellingPrice: 100,
            costPrice: 60,
            category: "Snacks",
            business: businessId,
        }))
    );
    await new Bill({
        billNumber: 1,
        business: businessId,
        type: "sale",
        status: "completed",
        items: products.map((p, i) => ({ product: p._id, name: p.name, qty: i + 1, price: 100, costPrice: 60 })),
        payments: [{ amount: products.reduce((s, _, i) => s + (i + 1) * 100, 0), method: "cash" }],
    }).save();
    return products;
};

const BASE_FIELDS = ["_id", "name", "price", "category", "totalQtySold", "transactionCount"];

// ═══ Permissions / profit ════════════════════════════════════════════════════

test("counter user with default permissions: 200, plain array, no totalProfit", withBusiness(async (businessId) => {
    await seedSales(businessId, 3);
    const { employeeId, user } = await newEmployee(businessId);

    const access = await Access.findOne({ employee: employeeId }).lean();
    assert.equal(access.permissions.pos.view, true);
    assert.equal(access.permissions.pos.viewProfit, false);
    assert.equal(access.permissions.reports.view, false);

    const r = await get("/bill/top-products?limit=12", user, getTopProducts);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body));
    assert.equal(r.body.length, 3);
    for (const item of r.body) {
        assert.equal("totalProfit" in item, false, "profit must not be sent at all");
        for (const f of BASE_FIELDS) assert.ok(f in item, `missing ${f}`);
        assert.ok("totalRevenue" in item, "revenue is kept");
    }
    assert.deepEqual(r.body.map((i) => i.name), ["Item 3", "Item 2", "Item 1"]);
    assert.equal(r.body[0].price, 100);
    assert.equal(r.body[0].category, "Snacks");
}));

test("same counter user with pos.viewProfit: totalProfit included", withBusiness(async (businessId) => {
    await seedSales(businessId, 2);
    const { employeeId, user } = await newEmployee(businessId);

    let r = await get("/bill/top-products", user, getTopProducts);
    assert.equal(r.statusCode, 200);
    assert.equal("totalProfit" in r.body[0], false);

    await setPermission(businessId, employeeId, "pos.viewProfit", true);
    r = await get("/bill/top-products", user, getTopProducts);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body[0].totalProfit, 80, "2 sold × (100 − 60)");
}));

test("employee without pos.view: 403", withBusiness(async (businessId) => {
    await seedSales(businessId, 1);
    const { user } = await newEmployee(businessId, { pos: { view: false } });

    const r = await get("/bill/top-products", user, getTopProducts);
    assert.equal(r.statusCode, 403);
    assert.match(r.body.message, /permission to view pos/);
}));

test("admin: 200 with every field", withBusiness(async (businessId) => {
    await seedSales(businessId, 2);
    const r = await get("/bill/top-products?limit=5", adminUser(businessId), getTopProducts);
    assert.equal(r.statusCode, 200);
    for (const f of [...BASE_FIELDS, "totalRevenue", "totalProfit"]) assert.ok(f in r.body[0], `missing ${f}`);
    assert.equal(r.body[0].totalRevenue, 200);
    assert.equal(r.body[0].totalProfit, 80);
}));

// ═══ Limit ═══════════════════════════════════════════════════════════════════

test("limit: capped at 50, default 12, minimum 1", withBusiness(async (businessId) => {
    await seedSales(businessId, 55);
    const admin = adminUser(businessId);

    let r = await get("/bill/top-products?limit=1000", admin, getTopProducts);
    assert.equal(r.body.length, 50);

    r = await get("/bill/top-products", admin, getTopProducts);
    assert.equal(r.body.length, 12);
    assert.equal(r.body[0].name, "Item 55", "best seller first");

    r = await get("/bill/top-products?limit=-5", admin, getTopProducts);
    assert.equal(r.body.length, 1);

    r = await get("/bill/top-products?limit=abc", admin, getTopProducts);
    assert.equal(r.body.length, 12);
}));

// ═══ Reports stay locked ═════════════════════════════════════════════════════

test("reports are still locked: sales-by-product is 403 without reports.view", withBusiness(async (businessId) => {
    const { employeeId, user } = await newEmployee(businessId);

    let r = await get("/bill/report/sales-by-product", user, salesByProduct);
    assert.equal(r.statusCode, 403);
    assert.match(r.body.message, /permission to view reports/);

    await setPermission(businessId, employeeId, "reports.view", true);
    r = await get("/bill/report/sales-by-product", user, salesByProduct);
    assert.equal(r.statusCode, 200);
}));
