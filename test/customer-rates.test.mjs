/**
 * Integration tests for Customer Special Rates (BACKEND_SPEC §9 checklist).
 *
 * Runs against the configured MongoDB (MONGODB_URI), same pattern as the other
 * suites: each test gets its own throwaway Business and cleans up after itself.
 * Controllers are invoked directly with mock req/res; Joi schemas are checked
 * separately where the route's validation is part of the behaviour.
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
import Access from "../models/access.mjs";
import Employee from "../models/employee.mjs";
import Counter from "../models/counter.mjs";
import StockMovement from "../models/stockMovement.mjs";

import {
    getCustomerRates,
    upsertCustomerRate,
    deleteCustomerRate,
    replaceCustomerRates,
} from "../controllers/customerRates.mjs";
import {
    createOrGetCustomer,
    getCustomers,
    getCustomer,
    searchCustomers,
    updateCustomer,
} from "../controllers/customer.mjs";
import { createProduct as createProductController, updateProduct, deleteProduct } from "../controllers/product.mjs";
import { createBill } from "../controllers/bill.mjs";
import { getMyAccess, updateEmployeeAccess } from "../controllers/access.mjs";
import { invalidateAccessCache } from "../middleware/accessControl.mjs";
import {
    updateCustomerSchema,
    createBillSchema,
    upsertCustomerRateSchema,
    createProductSchema,
    updateProductSchema,
} from "../middleware/validationSchemas.mjs";

// ─── Infrastructure ──────────────────────────────────────────────────────────

before(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
});

after(async () => {
    await mongoose.connection.close();
});

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_ADMIN_ID = new mongoose.Types.ObjectId();

const createBusiness = async (settings = {}) => {
    const suffix = uid();
    const b = await Business.create({
        name: `Rates Test ${suffix}`,
        businessType: new mongoose.Types.ObjectId(),
        email: `rates-${suffix}@example.test`,
        settings,
    });
    return b._id;
};

const cleanupBusiness = async (businessId) => {
    await Promise.all([
        Bill.deleteMany({ business: businessId }),
        Customer.deleteMany({ business: businessId }),
        Product.deleteMany({ business: businessId }),
        Access.deleteMany({ business: businessId }),
        Employee.deleteMany({ business: businessId }),
        StockMovement.deleteMany({ business: businessId }),
        Counter.deleteMany({ _id: new RegExp(`:${businessId}$`) }),
        Business.deleteOne({ _id: businessId }),
    ]);
};

const adminReq = (businessId, { params = {}, body = {}, query = {} } = {}) => ({
    params,
    body,
    query,
    user: { adminId: TEST_ADMIN_ID.toString(), id: TEST_ADMIN_ID.toString(), businessId: businessId.toString(), name: "Test Admin" },
});

/** Employee with an Access doc; `pos` overrides the pos permissions. */
const createEmployeeUser = async (businessId, pos = {}) => {
    const employeeId = new mongoose.Types.ObjectId();
    await Access.create({
        employee: employeeId,
        business: businessId,
        permissions: { pos: { view: true, create: true, viewProfit: false, ...pos } },
    });
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
            json(body) { resolve({ statusCode, body }); return this; },
            status(code) { statusCode = code; return this; },
        };
        Promise.resolve(controllerFn(req, res)).catch(reject);
    });

const createProduct = (businessId, overrides = {}) =>
    Product.create({
        name: `Pepsi ${uid()}`,
        barcode: uid(),
        sku: `SKU-${uid()}`,
        sellingPrice: 100,
        costPrice: 80,
        maxDiscountPercent: 50,
        trackStock: false,
        business: businessId,
        ...overrides,
    });

const createCustomer = (businessId) =>
    Customer.create({ name: "Ali", phone: uid(), business: businessId });

const withBusiness = (fn, settings) => async () => {
    const businessId = await createBusiness(settings);
    try {
        await fn(businessId);
    } finally {
        await cleanupBusiness(businessId);
    }
};

// ═══ §4.2 PUT /customer/:id/rates/:productId ═══════════════════════════════

test("upsert: creates then updates in place (no duplicate), priceWhenSaved from product, client value ignored", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);
    const customer = await createCustomer(businessId);
    const params = { id: customer._id.toString(), productId: product._id.toString() };

    const first = await invoke(upsertCustomerRate, adminReq(businessId, { params, body: { rate: 95, note: " wholesale ", priceWhenSaved: 1 } }));
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.rate.rate, 95);
    assert.equal(first.body.rate.priceWhenSaved, 100, "server sets priceWhenSaved from sellingPrice");
    assert.equal(first.body.rate.note, "wholesale");
    assert.equal(first.body.rate.updatedByName, "Test Admin");
    assert.deepEqual(first.body.warnings, []);

    const second = await invoke(upsertCustomerRate, adminReq(businessId, { params, body: { rate: 92.456 } }));
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.specialRates.length, 1, "second call must update, not duplicate");
    assert.equal(second.body.specialRates[0].rate, 92.46, "money rounded to 2 decimals");

    const stored = await Customer.findById(customer._id).lean();
    assert.equal(stored.specialRates.length, 1);
}));

test("upsert: warnings BELOW_COST / BEYOND_LIMIT, save still succeeds", withBusiness(async (businessId) => {
    // price 100, cost 80, 50% → max Rs 10 off per unit (50% of profit 20)
    const product = await createProduct(businessId);
    const customer = await createCustomer(businessId);
    const params = { id: customer._id.toString(), productId: product._id.toString() };

    const atLimit = await invoke(upsertCustomerRate, adminReq(businessId, { params, body: { rate: 90 } }));
    assert.deepEqual(atLimit.body.warnings, [], "exactly at the cap is not beyond it");

    const beyond = await invoke(upsertCustomerRate, adminReq(businessId, { params, body: { rate: 85 } }));
    assert.equal(beyond.statusCode, 200);
    assert.deepEqual(beyond.body.warnings, ["BEYOND_LIMIT"]);

    const below = await invoke(upsertCustomerRate, adminReq(businessId, { params, body: { rate: 75 } }));
    assert.equal(below.statusCode, 200);
    assert.deepEqual(below.body.warnings, ["BELOW_COST", "BEYOND_LIMIT"]);

    // No maxDiscountPercent → cap is the full profit (Rs 20)
    const noPct = await createProduct(businessId, { maxDiscountPercent: null });
    const r = await invoke(upsertCustomerRate, adminReq(businessId, {
        params: { id: customer._id.toString(), productId: noPct._id.toString() }, body: { rate: 80 },
    }));
    assert.deepEqual(r.body.warnings, []);
}));

test("upsert: rate >= selling price, negative or NaN → 400", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);
    const customer = await createCustomer(businessId);
    const params = { id: customer._id.toString(), productId: product._id.toString() };

    for (const rate of [100, 150, -1, "abc", null]) {
        const r = await invoke(upsertCustomerRate, adminReq(businessId, { params, body: { rate } }));
        assert.equal(r.statusCode, 400, `rate ${rate}`);
        assert.equal(r.body.message, "Rate must be lower than the selling price");
    }
}));

test("upsert: customer/product from another business → 404", withBusiness(async (businessId) => {
    const otherBusiness = await createBusiness();
    try {
        const product = await createProduct(businessId);
        const customer = await createCustomer(businessId);
        const foreignProduct = await createProduct(otherBusiness);
        const foreignCustomer = await createCustomer(otherBusiness);

        const r1 = await invoke(upsertCustomerRate, adminReq(businessId, {
            params: { id: foreignCustomer._id.toString(), productId: product._id.toString() }, body: { rate: 90 },
        }));
        assert.equal(r1.statusCode, 404);
        assert.equal(r1.body.message, "Customer not found");

        const r2 = await invoke(upsertCustomerRate, adminReq(businessId, {
            params: { id: customer._id.toString(), productId: foreignProduct._id.toString() }, body: { rate: 90 },
        }));
        assert.equal(r2.statusCode, 404);
        assert.equal(r2.body.message, "Product not found");
    } finally {
        await cleanupBusiness(otherBusiness);
    }
}));

test("upsert schema: accepts and ignores client priceWhenSaved", () => {
    assert.equal(upsertCustomerRateSchema.validate({ rate: 90, note: "", priceWhenSaved: 5 }).error, undefined);
});

// ═══ Permissions ════════════════════════════════════════════════════════════

test("employee without pos.saveCustomerRates → 403 on every write; with it → allowed", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);
    const customer = await createCustomer(businessId);
    const params = { id: customer._id.toString(), productId: product._id.toString() };
    const message = "You are not allowed to save customer rates";

    const denied = await createEmployeeUser(businessId);
    for (const [fn, req] of [
        [upsertCustomerRate, denied({ params, body: { rate: 90 } })],
        [deleteCustomerRate, denied({ params })],
        [replaceCustomerRates, denied({ params: { id: params.id }, body: { rates: [] } })],
        [createOrGetCustomer, denied({ body: { name: "New", phone: uid(), specialRates: [{ product: params.productId, rate: 90 }] } })],
    ]) {
        const r = await invoke(fn, req);
        assert.equal(r.statusCode, 403, fn.name);
        assert.equal(r.body.message, message, fn.name);
    }

    const allowed = await createEmployeeUser(businessId, { saveCustomerRates: true });
    const ok = await invoke(upsertCustomerRate, allowed({ params, body: { rate: 90 } }));
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.rate.updatedByName, "Cashier");
}));

// ═══ §4.3 DELETE ═══════════════════════════════════════════════════════════

test("delete: removes one rate and is idempotent", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);
    const customer = await createCustomer(businessId);
    const params = { id: customer._id.toString(), productId: product._id.toString() };
    await invoke(upsertCustomerRate, adminReq(businessId, { params, body: { rate: 90 } }));

    const first = await invoke(deleteCustomerRate, adminReq(businessId, { params }));
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.body.specialRates, []);

    const again = await invoke(deleteCustomerRate, adminReq(businessId, { params }));
    assert.equal(again.statusCode, 200);
}));

// ═══ §4.4 PUT /customer/:id/rates ══════════════════════════════════════════

test("replace: keeps priceWhenSaved for unchanged rates, restamps changed ones, drops missing", withBusiness(async (businessId) => {
    const a = await createProduct(businessId);
    const b = await createProduct(businessId);
    const c = await createProduct(businessId);
    const customer = await createCustomer(businessId);
    const id = customer._id.toString();

    for (const p of [a, b, c]) {
        await invoke(upsertCustomerRate, adminReq(businessId, { params: { id, productId: p._id.toString() }, body: { rate: 90 } }));
    }
    const before = (await Customer.findById(id).lean()).specialRates;
    const savedAtA = before.find((r) => r.product.equals(a._id)).updatedAt;

    // Selling prices change after the rates were saved
    await Product.updateMany({ _id: { $in: [a._id, b._id] } }, { sellingPrice: 120 });

    const r = await invoke(replaceCustomerRates, adminReq(businessId, {
        params: { id },
        body: { rates: [
            { product: a._id.toString(), rate: 90, note: "same rate" },   // unchanged
            { product: b._id.toString(), rate: 95 },                      // changed
        ] },
    }));
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.specialRates.length, 2, "c was not in the payload → removed");

    const ra = r.body.specialRates.find((x) => String(x.product) === a._id.toString());
    const rb = r.body.specialRates.find((x) => String(x.product) === b._id.toString());
    assert.equal(ra.priceWhenSaved, 100, "unchanged rate keeps its priceWhenSaved");
    assert.equal(new Date(ra.updatedAt).getTime(), new Date(savedAtA).getTime());
    assert.equal(ra.note, "same rate");
    assert.equal(rb.priceWhenSaved, 120, "changed rate is restamped from the current price");
    assert.equal(rb.rate, 95);
}));

test("replace: duplicate product → 400; unknown product / bad rate → 400 naming the product", withBusiness(async (businessId) => {
    const a = await createProduct(businessId);
    const customer = await createCustomer(businessId);
    const id = customer._id.toString();

    const dup = await invoke(replaceCustomerRates, adminReq(businessId, {
        params: { id }, body: { rates: [{ product: a._id.toString(), rate: 90 }, { product: a._id.toString(), rate: 91 }] },
    }));
    assert.equal(dup.statusCode, 400);
    assert.equal(dup.body.message, "Duplicate product in rates");

    const ghost = new mongoose.Types.ObjectId().toString();
    const unknown = await invoke(replaceCustomerRates, adminReq(businessId, {
        params: { id }, body: { rates: [{ product: ghost, rate: 90 }] },
    }));
    assert.equal(unknown.statusCode, 400);
    assert.ok(unknown.body.message.includes(ghost));

    const bad = await invoke(replaceCustomerRates, adminReq(businessId, {
        params: { id }, body: { rates: [{ product: a._id.toString(), rate: 100 }] },
    }));
    assert.equal(bad.statusCode, 400);
    assert.ok(bad.body.message.startsWith("Rate must be lower than the selling price"));
    assert.ok(bad.body.message.includes(a._id.toString()));
}));

// ═══ §4.1 GET /customer/:id/rates + §6 product delete ══════════════════════

test("get rates: populates product, computes flags, drops deleted products", withBusiness(async (businessId) => {
    const a = await createProduct(businessId);
    const gone = await createProduct(businessId);
    const customer = await createCustomer(businessId);
    const id = customer._id.toString();
    await invoke(upsertCustomerRate, adminReq(businessId, { params: { id, productId: a._id.toString() }, body: { rate: 85, note: "w" } }));
    await invoke(upsertCustomerRate, adminReq(businessId, { params: { id, productId: gone._id.toString() }, body: { rate: 90 } }));

    await Product.updateOne({ _id: a._id }, { sellingPrice: 120 });
    // Soft-deleted without going through deleteProduct → still in specialRates
    await Product.updateOne({ _id: gone._id }, { isActive: false });

    const r = await invoke(getCustomerRates, adminReq(businessId, { params: { id } }));
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.rates.length, 1);
    const [rate] = r.body.rates;
    assert.equal(rate.product.name, a.name);
    assert.equal(rate.product.sellingPrice, 120);
    assert.equal(rate.product.costPrice, 80);
    assert.equal(rate.product.maxDiscountPercent, 50);
    assert.equal(rate.priceChanged, true);
    assert.equal(rate.belowCost, false);
    // 120 - 85 = 35 off > 50% of (120 - 80) = 20
    assert.equal(rate.beyondLimit, true);
}));

test("deleteProduct removes it from customers' specialRates in the same business", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);
    const c1 = await createCustomer(businessId);
    const c2 = await createCustomer(businessId);
    for (const c of [c1, c2]) {
        await invoke(upsertCustomerRate, adminReq(businessId, { params: { id: c._id.toString(), productId: product._id.toString() }, body: { rate: 90 } }));
    }

    const r = await invoke(deleteProduct, adminReq(businessId, { params: { id: product._id.toString() } }));
    assert.equal(r.statusCode, 200);

    const left = await Customer.countDocuments({ business: businessId, "specialRates.product": product._id });
    assert.equal(left, 0);
}));

// ═══ §3 customer responses + §4.5 ══════════════════════════════════════════

test("specialRates appears in list, search, get, create and patch responses; PATCH ignores it", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);
    const phone = uid();

    const created = await invoke(createOrGetCustomer, adminReq(businessId, {
        body: { name: "Ali", phone, specialRates: [{ product: product._id.toString(), rate: 90, priceWhenSaved: 1 }] },
    }));
    assert.equal(created.statusCode, 200);
    const id = created.body._id.toString();
    const createdRates = created.body.toObject ? created.body.toObject().specialRates : created.body.specialRates;
    assert.equal(createdRates.length, 1);
    assert.equal(createdRates[0].priceWhenSaved, 100, "client priceWhenSaved ignored on create");

    // Existing customer matched by phone: rates are NOT overwritten
    const again = await invoke(createOrGetCustomer, adminReq(businessId, {
        body: { name: "Ali", phone, specialRates: [{ product: product._id.toString(), rate: 50 }] },
    }));
    assert.equal(again.body.specialRates[0].rate, 90);

    const list = await invoke(getCustomers, adminReq(businessId));
    assert.equal(list.body.customers[0].specialRates.length, 1);

    const search = await invoke(searchCustomers, adminReq(businessId, { query: { q: "Ali" } }));
    assert.equal(search.body[0].specialRates.length, 1);

    const one = await invoke(getCustomer, adminReq(businessId, { params: { id } }));
    assert.equal(one.body.specialRates.length, 1);

    const patchBody = { name: "Ali Khan", specialRates: [] };
    assert.equal(updateCustomerSchema.validate(patchBody).error, undefined, "PATCH must not 400 on specialRates");
    const patched = await invoke(updateCustomer, adminReq(businessId, { params: { id }, body: patchBody }));
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.body.name, "Ali Khan");
    assert.equal(patched.body.specialRates.length, 1, "PATCH must not touch specialRates");
}));

// ═══ §5 POST /bill ═════════════════════════════════════════════════════════

const billItem = (product, overrides = {}) => ({
    product: product._id.toString(),
    name: product.name,
    qty: 2,
    price: 100,
    costPrice: 80,
    gst: 0,
    ...overrides,
});

test("bill: stores discountSource/customerRate/limitOverride; old clients get defaults", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);
    const customer = await createCustomer(businessId);

    const body = {
        customer: customer._id.toString(),
        items: [billItem(product, { discountAmount: 20, discountSource: "customerRate", customerRate: 90, limitOverride: false })],
        payments: [{ amount: 180, method: "cash" }],
    };
    assert.equal(createBillSchema.validate(body).error, undefined);
    const r = await invoke(createBill, adminReq(businessId, { body }));
    assert.equal(r.statusCode, 201, JSON.stringify(r.body));
    assert.equal(r.body.items[0].discountSource, "customerRate");
    assert.equal(r.body.items[0].customerRate, 90);
    assert.equal(r.body.items[0].limitOverride, false);
    assert.equal(r.body.items[0].discountAmount, 20, "server never re-derives the discount");

    const old = await invoke(createBill, adminReq(businessId, {
        body: { items: [billItem(product)], payments: [{ amount: 200, method: "cash" }] },
    }));
    assert.equal(old.statusCode, 201);
    assert.equal(old.body.items[0].discountSource, "manual");
    assert.equal(old.body.items[0].customerRate, null);
    assert.equal(old.body.items[0].limitOverride, false);

    const walkIn = await invoke(createBill, adminReq(businessId, {
        body: { items: [billItem(product, { discountAmount: 20, discountSource: "customerRate", customerRate: 90 })] },
    }));
    assert.equal(walkIn.statusCode, 201);
    assert.equal(walkIn.body.items[0].discountSource, "manual", "customerRate needs a customer");
    assert.equal(walkIn.body.items[0].customerRate, null);
}));

test("bill: cap is maxDiscountPercent of PROFIT (matches POS)", withBusiness(async (businessId) => {
    // price 100, cost 80, 50%, qty 2 → max Rs 20 off for the line
    const product = await createProduct(businessId);

    const ok = await invoke(createBill, adminReq(businessId, { body: { items: [billItem(product, { discountAmount: 20 })] } }));
    assert.equal(ok.statusCode, 201);

    const over = await invoke(createBill, adminReq(businessId, { body: { items: [billItem(product, { discountAmount: 30 })] } }));
    assert.equal(over.statusCode, 400);
    assert.match(over.body.message, /exceeds the allowed limit/);

    const billOver = await invoke(createBill, adminReq(businessId, {
        body: { items: [billItem(product)], billDiscountAmount: 30 },
    }));
    assert.equal(billOver.statusCode, 400);
    assert.equal(billOver.body.message, "Bill discount exceeds the allowed limit");
}));

test("bill: limitOverride needs pos.sellBeyondLimit, skips the % cap but not the cost floor by default", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);
    const beyond = { discountAmount: 30, limitOverride: true };   // Rs 85 each: beyond 50% cap, above cost

    const cashier = await createEmployeeUser(businessId);
    const denied = await invoke(createBill, cashier({ body: { items: [billItem(product, beyond)] } }));
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.message, "You are not allowed to sell beyond the discount limit");

    const supervisor = await createEmployeeUser(businessId, { sellBeyondLimit: true });
    const allowed = await invoke(createBill, supervisor({ body: { items: [billItem(product, beyond)] } }));
    assert.equal(allowed.statusCode, 201, JSON.stringify(allowed.body));
    assert.equal(allowed.body.items[0].limitOverride, true);

    // Rs 75 each = below cost → blocked even for admin while the setting is off
    const belowCost = await invoke(createBill, adminReq(businessId, {
        body: { items: [billItem(product, { discountAmount: 50, limitOverride: true })] },
    }));
    assert.equal(belowCost.statusCode, 400);
    assert.equal(belowCost.body.message, `Cannot sell ${product.name} below cost price`);

    // Discount larger than the line total is always rejected
    const negative = await invoke(createBill, adminReq(businessId, {
        body: { items: [billItem(product, { discountAmount: 201, limitOverride: true })] },
    }));
    assert.equal(negative.statusCode, 400);
    assert.match(negative.body.message, /exceeds the item total/);
}));

test("bill: allowSellBelowCost setting lets an override line go below cost", withBusiness(async (businessId) => {
    const product = await createProduct(businessId);

    const r = await invoke(createBill, adminReq(businessId, {
        body: { items: [billItem(product, { discountAmount: 50, limitOverride: true })] },
    }));
    assert.equal(r.statusCode, 201, JSON.stringify(r.body));
    assert.equal(r.body.items[0].itemTotal, 150);

    // Without limitOverride the cap still applies
    const plain = await invoke(createBill, adminReq(businessId, {
        body: { items: [billItem(product, { discountAmount: 50 })] },
    }));
    assert.equal(plain.statusCode, 400);
}, { allowSellBelowCost: true }));

// ═══ §2.3 access ═══════════════════════════════════════════════════════════

test("access: PUT persists the new pos keys; /access/me returns them (defaults for old docs)", withBusiness(async (businessId) => {
    const employee = await Employee.create({
        name: "Cashier", employeeId: `E-${uid()}`, password: "x".repeat(20), business: businessId,
    });
    const empId = employee._id.toString();

    // Old doc written before the keys existed
    await Access.collection.insertOne({
        employee: employee._id,
        business: businessId,
        permissions: { pos: { view: true, create: true, viewProfit: false } },
    });
    invalidateAccessCache(empId, businessId.toString());
    const meReq = { user: { id: empId, businessId: businessId.toString() } };
    const oldMe = await invoke(getMyAccess, meReq);
    assert.equal(oldMe.body.permissions.pos.saveCustomerRates, false);
    assert.equal(oldMe.body.permissions.pos.sellBeyondLimit, false);

    const put = await invoke(updateEmployeeAccess, adminReq(businessId, {
        params: { employeeId: empId },
        body: { permissions: { pos: { view: true, create: true, viewProfit: false, saveCustomerRates: true, sellBeyondLimit: true } } },
    }));
    assert.equal(put.statusCode, 200);
    assert.equal(put.body.access.permissions.pos.saveCustomerRates, true);
    assert.equal(put.body.access.permissions.pos.sellBeyondLimit, true);

    const me = await invoke(getMyAccess, meReq);
    assert.equal(me.body.permissions.pos.saveCustomerRates, true);
    assert.equal(me.body.permissions.pos.sellBeyondLimit, true);

    const adminMe = await invoke(getMyAccess, adminReq(businessId));
    assert.equal(adminMe.body.permissions, null);
}));

// ═══ Product maxDiscountPercent = % of PROFIT (no "below cost" check) ═══════

test("product: maxDiscountPercent above the margin % is accepted on create and update", withBusiness(async (businessId) => {
    for (const maxDiscountPercent of [50, 100]) {
        const body = { name: `Pepsi ${uid()}`, sku: `SKU-${uid()}`, sellingPrice: 100, costPrice: 80, maxDiscountPercent };
        assert.equal(createProductSchema.validate(body).error, undefined);
        const r = await invoke(createProductController, adminReq(businessId, { body }));
        assert.ok(r.statusCode < 300, `create ${maxDiscountPercent}%: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.maxDiscountPercent, maxDiscountPercent);
    }

    const product = await createProduct(businessId, { maxDiscountPercent: 10 });
    const patch = { maxDiscountPercent: 80 };
    assert.equal(updateProductSchema.validate(patch).error, undefined);
    const r = await invoke(updateProduct, adminReq(businessId, { params: { id: product._id.toString() }, body: patch }));
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.maxDiscountPercent, 80);

    const missing = await invoke(updateProduct, adminReq(businessId, {
        params: { id: new mongoose.Types.ObjectId().toString() }, body: patch,
    }));
    assert.equal(missing.statusCode, 404);
}));

test("product schema: maxDiscountPercent must be null or 0–100", () => {
    const base = { name: "Pepsi", sellingPrice: 100, costPrice: 80 };
    for (const bad of [-1, 101, "abc"]) {
        assert.ok(createProductSchema.validate({ ...base, maxDiscountPercent: bad }).error, `create ${bad}`);
        assert.ok(updateProductSchema.validate({ maxDiscountPercent: bad }).error, `update ${bad}`);
    }
    assert.equal(createProductSchema.validate({ ...base, maxDiscountPercent: null }).error, undefined);
});
