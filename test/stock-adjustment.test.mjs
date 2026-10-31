/**
 * Integration tests for manual stock adjustment (PATCH /product/:id/stock)
 * and the movement history (GET /product/stock-movements).
 *
 * Requests run through the same chain as the real router:
 * accessControl → validate(updateStockSchema) → controller.
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
import Product from "../models/product.mjs";
import StockMovement from "../models/stockMovement.mjs";
import Access from "../models/access.mjs";
import CashBook from "../models/cashbook.mjs";
import Bill from "../models/bill.mjs";
import Expense from "../models/expense.mjs";

import { updateStock, getStockMovements } from "../controllers/product.mjs";
import { accessControl, invalidateAccessCache } from "../middleware/accessControl.mjs";
import { validate } from "../middleware/validate.mjs";
import { updateStockSchema } from "../middleware/validationSchemas.mjs";

// ─── Infrastructure ──────────────────────────────────────────────────────────

before(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
});

after(async () => {
    await mongoose.connection.close();
});

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_ADMIN_ID = new mongoose.Types.ObjectId();

const withBusiness = (fn) => async () => {
    const suffix = uid();
    const business = await Business.create({
        name: `Stock Adjust Test ${suffix}`,
        businessType: new mongoose.Types.ObjectId(),
        email: `stock-adjust-${suffix}@example.test`,
    });
    const businessId = business._id;
    try {
        await fn(businessId);
        // Nothing here ever touches money
        assert.equal(await CashBook.countDocuments({ business: businessId }), 0, "no cash book entry");
        assert.equal(await Bill.countDocuments({ business: businessId }), 0, "no bill");
        assert.equal(await Expense.countDocuments({ business: businessId }), 0, "no expense");
    } finally {
        await Promise.all([
            Product.deleteMany({ business: businessId }),
            StockMovement.deleteMany({ business: businessId }),
            Access.deleteMany({ business: businessId }),
            Business.deleteOne({ _id: businessId }),
        ]);
    }
};

const admin = (businessId) => ({
    adminId: TEST_ADMIN_ID.toString(), id: TEST_ADMIN_ID.toString(), businessId: businessId.toString(), name: "Owner",
});

const employee = async (businessId, products = {}) => {
    const employeeId = new mongoose.Types.ObjectId();
    await Access.create({ employee: employeeId, business: businessId, permissions: { products } });
    invalidateAccessCache(employeeId.toString(), businessId.toString());
    return { id: employeeId.toString(), employeeId: employeeId.toString(), businessId: businessId.toString(), name: "Bilal", role: "employee" };
};

/** Run req through a middleware chain like Express (each step may answer instead of calling next). */
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

const adjust = (product, body, user) =>
    run([accessControl, validate(updateStockSchema, { readableMessage: true }), updateStock], {
        method: "PATCH",
        originalUrl: `/product/${product._id}/stock`,
        params: { id: product._id.toString() },
        query: {},
        body,
        user,
    });

const movementsList = (businessId, query = {}) =>
    run([accessControl, getStockMovements], {
        method: "GET",
        originalUrl: `/product/stock-movements?${new URLSearchParams(query)}`,
        params: {},
        query,
        body: {},
        user: admin(businessId),
    });

const newProduct = (businessId, overrides = {}) =>
    Product.create({
        name: `Ketchup ${uid()}`, sku: `SKU-${uid()}`, sellingPrice: 150, costPrice: 100,
        stockQuantity: 20, trackStock: true, business: businessId, ...overrides,
    });

const stockOf = async (p) => (await Product.findById(p._id).lean()).stockQuantity;
const movementsOf = (p) => StockMovement.find({ product: p._id }).sort({ createdAt: 1 }).lean();

// ═══ Happy paths ═════════════════════════════════════════════════════════════

test("admin: transfer out 5 to Branch 2 → stock −5 and one movement with reason, note, who", withBusiness(async (businessId) => {
    const p = await newProduct(businessId);
    const r = await adjust(p, { quantity: 5, operation: "subtract", reason: "transfer_out", note: "  Branch 2 " }, admin(businessId));
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.product.stockQuantity, 15);
    assert.equal(await stockOf(p), 15);

    const m = r.body.movement;
    assert.equal(m.type, "manual_adjustment");
    assert.equal(m.referenceType, "manual");
    assert.equal(m.quantity, -5);
    assert.equal(m.previousStock, 20);
    assert.equal(m.newStock, 15);
    assert.equal(m.adjustmentReason, "transfer_out");
    assert.equal(m.note, "Branch 2", "note is trimmed");
    assert.equal(m.reason, "Transferred to another branch — Branch 2");
    assert.equal(m.performedBy, "Admin");
    assert.equal(String(m.performedById), TEST_ADMIN_ID.toString());
    assert.equal(m.unitPrice, 100, "cost price");
    assert.equal(m.productName, p.name);
    assert.equal((await movementsOf(p)).length, 1);
}));

test("transfer in adds; count correction 'set' records new − old (up and down)", withBusiness(async (businessId) => {
    const p = await newProduct(businessId);
    let r = await adjust(p, { quantity: 8, operation: "add", reason: "transfer_in", note: "From Branch 3" }, admin(businessId));
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.product.stockQuantity, 28);
    assert.equal(r.body.movement.quantity, 8);
    assert.equal(r.body.movement.reason, "Received from another branch — From Branch 3");

    r = await adjust(p, { quantity: 25, operation: "set", reason: "count_correction" }, admin(businessId));
    assert.equal(r.statusCode, 200);
    assert.deepEqual([r.body.movement.quantity, r.body.movement.previousStock, r.body.movement.newStock], [-3, 28, 25]);
    assert.equal(r.body.movement.reason, "Stock count correction", "no note → just the label");
    assert.equal(r.body.movement.note, "");

    r = await adjust(p, { quantity: 30, operation: "set", reason: "count_correction", note: "Counted shelf on 31 Oct" }, admin(businessId));
    assert.equal(r.body.movement.quantity, 5);
    r = await adjust(p, { quantity: 0, operation: "set", reason: "other", note: "Shelf cleared" }, admin(businessId));
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.movement.quantity, -30);
    assert.equal(r.body.movement.reason, "Other — Shelf cleared");
    assert.equal(await stockOf(p), 0);
    assert.equal((await movementsOf(p)).length, 4);
}));

// ═══ Rejections (nothing changes) ════════════════════════════════════════════

test("rejected requests: clear 400 message, stock and movements unchanged", withBusiness(async (businessId) => {
    const p = await newProduct(businessId);
    const cases = [
        [{ quantity: 5, operation: "add", reason: "transfer_out" }, 'Transferred to another branch can only remove stock'],
        [{ quantity: 5, operation: "subtract", reason: "transfer_in" }, 'Received from another branch can only add stock'],
        [{ quantity: 5, operation: "set", reason: "transfer_in" }, 'Received from another branch can only add stock'],
        [{ quantity: 5, operation: "add", reason: "other" }, 'A note is required when the reason is Other'],
        [{ quantity: 5, operation: "add", reason: "other", note: "   " }, 'A note is required when the reason is Other'],
        [{ quantity: 5, operation: "add" }, "Reason is required"],
        [{ quantity: 5, operation: "add", reason: "damaged" }, "Reason must be one of: transfer_out, transfer_in, count_correction, other"],
        [{ quantity: 5, operation: "add", reason: "count_correction", note: "x".repeat(201) }, "Note can be at most 200 characters"],
        [{ quantity: 2.5, operation: "add", reason: "count_correction" }, "Quantity must be a whole number"],
        [{ quantity: 0, operation: "add", reason: "count_correction" }, "Quantity must be more than 0"],
        [{ quantity: -1, operation: "set", reason: "count_correction" }, "Quantity can't be negative"],
        [{ quantity: 20, operation: "set", reason: "count_correction" }, "No change: stock is already 20"],
        [{ quantity: 21, operation: "subtract", reason: "transfer_out", note: "Branch 2" }, "Insufficient stock for this operation"],
        [{ quantity: 5, operation: "add", reason: "count_correction", extra: 1 }, "extra is not allowed"],
    ];
    for (const [body, message] of cases) {
        const r = await adjust(p, body, admin(businessId));
        assert.equal(r.statusCode, 400, JSON.stringify(body));
        assert.equal(r.body.message, message, JSON.stringify(body));
    }
    assert.equal(await stockOf(p), 20);
    assert.equal((await movementsOf(p)).length, 0);

    const max = await adjust(p, { quantity: 1, operation: "add", reason: "count_correction", note: "x".repeat(200) }, admin(businessId));
    assert.equal(max.statusCode, 200, "200 characters is fine");
}));

test("product that doesn't track stock: 400, nothing recorded", withBusiness(async (businessId) => {
    const p = await newProduct(businessId, { trackStock: false, stockQuantity: 0 });
    const r = await adjust(p, { quantity: 5, operation: "add", reason: "count_correction" }, admin(businessId));
    assert.equal(r.statusCode, 400);
    assert.equal(r.body.message, "This product doesn't track stock");
    assert.equal((await movementsOf(p)).length, 0);
}));

test("unknown product: 404", withBusiness(async (businessId) => {
    const r = await adjust({ _id: new mongoose.Types.ObjectId() }, { quantity: 1, operation: "add", reason: "count_correction" }, admin(businessId));
    assert.equal(r.statusCode, 404);
}));

// ═══ Permissions ═════════════════════════════════════════════════════════════

test("employee without products.updateStock: 403, nothing changed", withBusiness(async (businessId) => {
    const p = await newProduct(businessId);
    const user = await employee(businessId, { view: true, edit: true });
    const r = await adjust(p, { quantity: 5, operation: "subtract", reason: "transfer_out", note: "Branch 2" }, user);
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.message, "You don't have permission to updateStock products");
    assert.equal(await stockOf(p), 20);
    assert.equal((await movementsOf(p)).length, 0);
}));

test("employee with products.updateStock: 200, movement shows the employee", withBusiness(async (businessId) => {
    const p = await newProduct(businessId);
    const user = await employee(businessId, { updateStock: true });
    const r = await adjust(p, { quantity: 5, operation: "subtract", reason: "transfer_out", note: "Branch 2" }, user);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.movement.performedBy, "Bilal");
    assert.equal(String(r.body.movement.performedById), user.id);
    assert.equal(await stockOf(p), 15);
}));

// ═══ Movement history ════════════════════════════════════════════════════════

test("stock-movements: manual rows carry note + reason; filter by type and reason code", withBusiness(async (businessId) => {
    const p = await newProduct(businessId);
    await adjust(p, { quantity: 5, operation: "subtract", reason: "transfer_out", note: "Branch 2" }, admin(businessId));
    await adjust(p, { quantity: 18, operation: "set", reason: "count_correction" }, admin(businessId));
    // an older-style movement of another type, saved without the new fields
    await StockMovement.collection.insertOne({
        product: p._id, productName: p.name, type: "bill_sold", quantity: -1, previousStock: 19, newStock: 18,
        referenceType: "bill", business: businessId, createdAt: new Date(Date.now() - 60000),
    });

    let r = await movementsList(businessId, { type: "manual_adjustment" });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.total, 2);
    const transfer = r.body.movements.find((m) => m.adjustmentReason === "transfer_out");
    assert.equal(transfer.note, "Branch 2");
    assert.equal(transfer.reason, "Transferred to another branch — Branch 2");
    assert.equal(transfer.performedBy, "Admin");

    r = await movementsList(businessId, { reason: "transfer_out" });
    assert.deepEqual(r.body.movements.map((m) => m.quantity), [-5]);

    r = await movementsList(businessId, {});
    const sold = r.body.movements.find((m) => m.type === "bill_sold");
    assert.deepEqual([sold.note, sold.adjustmentReason, sold.performedBy], ["", null, ""], "other rows: empty fields");

    r = await movementsList(businessId, { reason: "lost" });
    assert.equal(r.statusCode, 400);
}));
