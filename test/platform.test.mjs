/**
 * Integration tests for the platform admin panel and the "block a business"
 * control, over real HTTP with the same middleware chain as index.mjs:
 *   shop:     jwtAuth → checkBusinessStatus → trackUsage → accessControl → router
 *   platform: /platform (own login, own tokens)
 *
 * Real configured MongoDB (dev), one throwaway Business per test, cleaned up.
 */

process.env.TZ = "Asia/Karachi";

import "dotenv/config";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { json } from "express";
import mongoose from "mongoose";
import bcrypt from "bcrypt";

import Business from "../models/business.mjs";
import Admin from "../models/admin.mjs";
import Employee from "../models/employee.mjs";
import Access from "../models/access.mjs";
import Bill from "../models/bill.mjs";
import Product from "../models/product.mjs";
import Customer from "../models/customer.mjs";
import CashBook from "../models/cashbook.mjs";
import Counter from "../models/counter.mjs";
import RefreshToken from "../models/refreshToken.mjs";
import UsageDaily from "../models/usageDaily.mjs";
import PlatformAdmin from "../models/platformAdmin.mjs";
import PlatformAudit from "../models/platformAudit.mjs";

import platformRouter from "../routes/platform.mjs";
import billRouter from "../routes/bill.mjs";
import productRouter from "../routes/product.mjs";
import authRouter from "../routes/auth.mjs";
import adminAuthRouter from "../routes/adminAuth.mjs";
import businessRouter from "../routes/business.mjs";
import adminRouter from "../routes/admin.mjs";
import { authorize } from "../middleware/rbac.mjs";
import { employeeAuthRouter } from "../routes/employee.mjs";
import { jwtAuth } from "../middleware/jwtAuth.mjs";
import { checkBusinessStatus, accountStatus } from "../middleware/businessStatus.mjs";
import { trackUsage } from "../middleware/usageTracker.mjs";
import { accessControl } from "../middleware/accessControl.mjs";

// ─── App + server (same wiring as index.mjs) ─────────────────────────────────

let server;
let base;
const panelUsers = [];

before(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const app = express();
    app.use(json());
    const shopAuth = [jwtAuth, trackUsage, checkBusinessStatus];
    app.use("/adminAuth", adminAuthRouter);
    app.use("/employeeAuth", employeeAuthRouter);
    app.use("/auth", authRouter);
    app.use("/business", businessRouter);
    app.use("/platform", platformRouter);
    app.get("/account/status", jwtAuth, accountStatus);
    app.use("/admin", ...shopAuth, authorize("admin", "owner"), adminRouter);
    app.use("/bill", ...shopAuth, accessControl, billRouter);
    app.use("/product", ...shopAuth, accessControl, productRouter);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await PlatformAdmin.deleteMany({ _id: { $in: panelUsers } });
    await PlatformAudit.deleteMany({ "actor.id": { $in: panelUsers } });
    await mongoose.connection.close();
});

const uid = () => `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
const PASSWORD = "secret-pass-123";

const http = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
        method,
        headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
};
const get = (path, token) => http("GET", path, { token });
const post = (path, body, token) => http("POST", path, { body, token });

/** A shop with an owner (admin), one counter user, a product and two bills. */
const withShop = (fn) => async () => {
    const suffix = uid();
    const business = await Business.create({ name: `Platform Test ${suffix}`, businessType: new mongoose.Types.ObjectId(), email: `shop-${suffix}@example.com` });
    const hash = await bcrypt.hash(PASSWORD, 4);
    const owner = await Admin.create({ name: "Owner", email: `owner-${suffix}@example.com`, password: hash, business: business._id });
    const employee = await Employee.create({ name: "Bilal", employeeId: `emp${suffix}`, password: hash, business: business._id });
    await Access.create({ employee: employee._id, business: business._id });
    const product = await Product.create({ name: "Ketchup", sku: `SKU-${suffix}`, sellingPrice: 150, costPrice: 100, stockQuantity: 20, business: business._id });
    const bill = (n, total, paid, cashierName) => new Bill({
        billNumber: n, business: business._id, type: "sale", status: "completed", cashierName,
        items: [{ product: product._id, name: "Ketchup", qty: total / 150, price: 150, costPrice: 100 }],
        payments: paid ? [{ amount: paid, method: "cash" }] : [],
    }).save();
    const bills = [await bill(1, 300, 300, "Owner"), await bill(2, 450, 0, "Bilal")];
    const shop = { business, owner, employee, product, bills, suffix };
    try {
        await fn(shop);
    } finally {
        const id = business._id;
        await Promise.all([
            Bill.deleteMany({ business: id }), Product.deleteMany({ business: id }), Customer.deleteMany({ business: id }),
            CashBook.deleteMany({ business: id }), Admin.deleteMany({ business: id }), Employee.deleteMany({ business: id }),
            Access.deleteMany({ business: id }), RefreshToken.deleteMany({ businessId: id }), UsageDaily.deleteMany({ business: id }),
            PlatformAudit.deleteMany({ business: id }), Counter.deleteMany({ _id: { $regex: id.toString() } }), Business.deleteOne({ _id: id }),
        ]);
    }
};

const panelUser = async (role = "superadmin") => {
    const email = `panel-${uid()}@example.com`;
    const user = await PlatformAdmin.create({ name: role === "superadmin" ? "Ahmed" : "Support", email, role, password: await bcrypt.hash(PASSWORD, 4) });
    panelUsers.push(user._id);
    const r = await post("/platform/auth/login", { email, password: PASSWORD });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { user, token: r.body.token };
};

const ownerLogin = (shop) => post("/adminAuth/login", { email: shop.owner.email, password: PASSWORD });
const employeeLogin = (shop) => post("/employeeAuth/login", { employeeId: shop.employee.employeeId, password: PASSWORD });
const settle = () => new Promise((r) => setTimeout(r, 400)); // usage counters are written after the response

// ═══ Token separation ════════════════════════════════════════════════════════

test("panel tokens and shop tokens never cross", withShop(async (shop) => {
    const { token: panel } = await panelUser();
    const owner = (await ownerLogin(shop)).body.token;

    assert.equal((await get("/bill", panel)).status, 401, "panel token on the shop API");
    assert.equal((await get("/platform/overview", owner)).status, 401, "shop token on the panel");
    assert.equal((await get("/platform/overview")).status, 401);
    assert.equal((await get("/platform/overview", panel)).status, 200);
}));

test("panel login: wrong password 401; disabled user locked out; support is read-only", withShop(async (shop) => {
    const { user } = await panelUser();
    assert.equal((await post("/platform/auth/login", { email: user.email, password: "nope" })).status, 401);

    const support = await panelUser("support");
    assert.equal((await get(`/platform/businesses/${shop.business._id}`, support.token)).status, 200);
    const block = await post(`/platform/businesses/${shop.business._id}/block`, { reason: "x" }, support.token);
    assert.equal(block.status, 403);
    assert.equal(block.body.code, "PLATFORM_FORBIDDEN");
    assert.equal((await get("/platform/admins", support.token)).status, 403);

    const boss = await panelUser();
    const r = await http("PATCH", `/platform/admins/${support.user._id}`, { token: boss.token, body: { isActive: false } });
    assert.equal(r.status, 200);
    const locked = await get("/platform/overview", support.token);
    assert.equal(locked.status, 401);
    assert.equal(locked.body.code, "PLATFORM_USER_DISABLED");
}));

// ═══ Block / unblock ═════════════════════════════════════════════════════════

test("block: logins, refresh and every request rejected for owner and counter users; data untouched; unblock restores", withShop(async (shop) => {
    const { token: panel } = await panelUser();
    const ownerSession = (await ownerLogin(shop)).body;
    const empSession = (await employeeLogin(shop)).body;
    const first = await get("/bill", ownerSession.token);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal((await get("/product", empSession.token)).status, 403, "employee without products.view (normal)");
    assert.equal((await get("/bill/top-products", empSession.token)).status, 200);

    const block = await post(`/platform/businesses/${shop.business._id}/block`, {
        reason: "Unpaid November", message: "Payment due for November", contact: "Call 0300-1234567",
    }, panel);
    assert.equal(block.status, 200, JSON.stringify(block.body));
    assert.equal(block.body.subscription.status, "blocked");

    for (const [path, token] of [["/bill", ownerSession.token], ["/bill/top-products", empSession.token], ["/product", ownerSession.token], [`/business/${shop.business._id}`, ownerSession.token]]) {
        const r = await get(path, token);
        assert.equal(r.status, 403, path);
        assert.deepEqual(r.body, { code: "BUSINESS_BLOCKED", message: "Your account is suspended. Payment due for November", contact: "Call 0300-1234567" });
    }
    const write = await post("/bill", { items: [{ name: "x", qty: 1, price: 1 }] }, ownerSession.token);
    assert.equal(write.status, 403);

    for (const login of [ownerLogin, employeeLogin]) {
        const r = await login(shop);
        assert.equal(r.status, 403);
        assert.equal(r.body.code, "BUSINESS_BLOCKED");
        assert.equal(r.body.token, undefined);
    }
    const refresh = await post("/auth/refresh", { refreshToken: ownerSession.refreshToken });
    assert.equal(refresh.status, 403);
    assert.ok(await RefreshToken.exists({ token: ownerSession.refreshToken }), "session kept for after unblock");

    const status = await get("/account/status", ownerSession.token);
    assert.equal(status.status, 200);
    assert.equal(status.body.status, "blocked");
    assert.equal(status.body.contact, "Call 0300-1234567");

    assert.equal(await Bill.countDocuments({ business: shop.business._id }), 2, "no data touched");
    assert.equal((await Product.findById(shop.product._id).lean()).stockQuantity, 20);

    assert.equal((await post(`/platform/businesses/${shop.business._id}/block`, { reason: "again" }, panel)).status, 400);
    const unblock = await post(`/platform/businesses/${shop.business._id}/unblock`, { reason: "Paid" }, panel);
    assert.equal(unblock.status, 200);
    assert.equal(unblock.body.subscription.status, "active");

    assert.equal((await get("/bill", ownerSession.token)).status, 200, "old token works again");
    assert.equal((await post("/auth/refresh", { refreshToken: ownerSession.refreshToken })).status, 200);
    assert.equal((await employeeLogin(shop)).status, 200);

    const history = (await get(`/platform/businesses/${shop.business._id}`, panel)).body.subscriptionHistory;
    assert.deepEqual(history.map((h) => [h.action, h.reason, h.byName]), [["unblock", "Paid", "Ahmed"], ["block", "Unpaid November", "Ahmed"]]);
    const log = (await get(`/platform/audit-log?businessId=${shop.business._id}`, panel)).body.entries;
    assert.deepEqual(log.map((e) => e.action), ["business.unblock", "business.block"]);
    assert.equal(log[0].actor.name, "Ahmed");
}));

test("block needs a reason; unknown shop is 404", withShop(async (shop) => {
    const { token } = await panelUser();
    const r = await post(`/platform/businesses/${shop.business._id}/block`, {}, token);
    assert.equal(r.status, 400);
    assert.equal(r.body.message, "A reason is required");
    assert.equal((await get(`/platform/businesses/${new mongoose.Types.ObjectId()}`, token)).status, 404);
    assert.equal((await get("/platform/businesses/not-an-id", token)).status, 404);
}));

test("warning: app keeps working with an X-Account-Status header; clear-warning; subscription fields", withShop(async (shop) => {
    const { token: panel } = await panelUser();
    const owner = (await ownerLogin(shop)).body.token;

    const warn = await post(`/platform/businesses/${shop.business._id}/warn`, { message: "Payment due by 10 Nov", paidUntil: "2026-11-10" }, panel);
    assert.equal(warn.status, 200, JSON.stringify(warn.body));
    assert.equal(warn.body.subscription.status, "warning");

    const r = await get("/bill", owner);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-account-status"), "warning");
    const status = (await get("/account/status", owner)).body;
    assert.equal(status.status, "warning");
    assert.equal(status.message, "Payment due by 10 Nov");

    const sub = await http("PATCH", `/platform/businesses/${shop.business._id}/subscription`, { token: panel, body: { plan: "Basic", monthlyFee: 3000, notes: "Pays late", paidUntil: "2026-12-10" } });
    assert.equal(sub.status, 200);
    assert.deepEqual([sub.body.subscription.plan, sub.body.subscription.monthlyFee, sub.body.subscription.notes], ["Basic", 3000, "Pays late"]);
    assert.equal((await http("PATCH", `/platform/businesses/${shop.business._id}/subscription`, { token: panel, body: { monthlyFee: -1 } })).status, 400);

    // The shop never sees internal notes / history, and can't change the status itself
    const own = (await get(`/business/${shop.business._id}`, owner)).body;
    assert.equal(own.subscription.notes, undefined);
    assert.equal(own.subscription.history, undefined);
    const hack = await http("PATCH", `/business/${shop.business._id}`, { token: owner, body: { subscription: { status: "active" } } });
    assert.equal(hack.status, 400);

    assert.equal((await post(`/platform/businesses/${shop.business._id}/clear-warning`, {}, panel)).body.subscription.status, "active");
    assert.equal((await get("/bill", owner)).headers.get("x-account-status"), null);
}));

test("revoke sessions: old tokens get SESSION_REVOKED, refresh tokens removed, fresh login works", withShop(async (shop) => {
    const { token: panel } = await panelUser();
    const session = (await ownerLogin(shop)).body;
    await new Promise((r) => setTimeout(r, 1100)); // token iat is in seconds

    const r = await post(`/platform/businesses/${shop.business._id}/revoke-sessions`, { reason: "Lost phone" }, panel);
    assert.equal(r.status, 200);
    const old = await get("/bill", session.token);
    assert.equal(old.status, 401);
    assert.equal(old.body.code, "SESSION_REVOKED");
    assert.equal((await post("/auth/refresh", { refreshToken: session.refreshToken })).status, 401);

    await new Promise((r) => setTimeout(r, 1100));
    const fresh = (await ownerLogin(shop)).body.token;
    assert.equal((await get("/bill", fresh)).status, 200);
}));

// ═══ Reading a shop ══════════════════════════════════════════════════════════

test("detail, users, bills summary, activity and usage for one shop", withShop(async (shop) => {
    const { token: panel } = await panelUser();
    const owner = (await ownerLogin(shop)).body.token;
    await employeeLogin(shop);
    await get("/bill", owner);
    await get("/bill/stats", owner);
    await settle();
    const id = shop.business._id;

    const d = (await get(`/platform/businesses/${id}`, panel)).body;
    assert.equal(d.business.name, shop.business.name);
    assert.equal(d.subscription.status, "active");
    assert.equal(d.owners[0].email, shop.owner.email);
    assert.equal(d.owners[0].password, undefined);
    assert.equal(d.counts.employees, 1);
    assert.equal(d.counts.products, 1);
    assert.equal(d.counts.completedBills, 2);
    assert.equal(d.inventory.units, 20);
    assert.equal(d.inventory.costValue, 2000);
    assert.ok(d.counts.activeSessions >= 2);
    assert.ok(d.today.stats, "today's bill stats (same as the shop dashboard)");

    const users = (await get(`/platform/businesses/${id}/users`, panel)).body;
    assert.equal(users.admins[0].email, shop.owner.email);
    assert.ok(users.admins[0].lastLoginAt);
    assert.equal(users.employees[0].name, "Bilal");
    assert.equal(users.employees[0].password, undefined);
    assert.ok(users.employees[0].lastLoginAt);
    assert.equal(users.employees[0].permissions.pos.view, true);

    const s = (await get(`/platform/businesses/${id}/bills-summary`, panel)).body;
    assert.equal(s.bills, 2);
    assert.equal(s.sales, 750);
    assert.equal(s.paid, 300);
    assert.equal(s.creditGiven, 450);
    assert.equal(s.itemsSold, 5);
    assert.deepEqual(s.byCashier.map((c) => [c.cashier, c.bills, c.sales]), [["Bilal", 1, 450], ["Owner", 1, 300]]);
    assert.deepEqual(s.byPaymentMethod, [{ method: "cash", payments: 1, amount: 300 }]);
    assert.equal(s.byHour.reduce((n, h) => n + h.bills, 0), 2);
    assert.equal((await get(`/platform/businesses/${id}/bills-summary?date=31-10-2026`, panel)).status, 400);

    const a = (await get(`/platform/businesses/${id}/activity?days=7`, panel)).body;
    assert.equal(a.days.length, 7);
    const today = a.days.at(-1);
    assert.equal(today.bills, 2);
    assert.equal(today.sales, 750);
    assert.equal(today.logins, 2);
    assert.ok(today.requests >= 2);
    assert.equal(a.days[0].bills, 0, "empty days are filled with zeros");

    const u = (await get(`/platform/businesses/${id}/usage?days=1`, panel)).body.days[0];
    assert.ok(u.requests >= 2);
    assert.ok(u.byArea.bill >= 2);
    assert.equal(u.logins, 2);
    assert.deepEqual(u.activeUsers.map((x) => x.name).sort(), ["Bilal", "Owner"]);
}));

test("shop data through the panel: bills, one bill, products, reports, cash book — only that shop's", withShop(async (shop) => {
    const { token: panel } = await panelUser();
    const id = shop.business._id;

    const bills = (await get(`/platform/businesses/${id}/bills`, panel)).body;
    const list = bills.bills || bills.data || bills;
    assert.equal(list.length, 2);
    const one = await get(`/platform/businesses/${id}/bills/${shop.bills[1]._id}`, panel);
    assert.equal(one.status, 200);
    assert.equal(one.body.total, 450);
    assert.equal(one.body.items[0].costPrice, 100, "full view incl. cost");

    const products = (await get(`/platform/businesses/${id}/products`, panel)).body;
    assert.equal((products.products || products).length, 1);
    assert.equal((await get(`/platform/businesses/${id}/reports/sales-by-product`, panel)).status, 200);
    assert.equal((await get(`/platform/businesses/${id}/cashbook/balance`, panel)).status, 200);
    assert.equal((await get(`/platform/businesses/${id}/bills/stats`, panel)).status, 200);
    assert.equal((await get(`/platform/businesses/${id}/dashboard`, panel)).status, 200);
    assert.equal((await get(`/platform/businesses/${id}/employees`, panel)).body.length, 1);
    assert.equal((await get(`/platform/businesses/${id}/nothing-here`, panel)).status, 404);
    assert.equal((await http("DELETE", `/platform/businesses/${id}/bills/${shop.bills[0]._id}`, { token: panel })).status, 404, "no write routes");

    // another shop's bill id → not found (no cross-shop reads)
    const foreign = await Bill.create({ billNumber: 9, business: new mongoose.Types.ObjectId(), type: "sale", status: "completed", items: [{ name: "x", qty: 1, price: 1 }] });
    try {
        assert.equal((await get(`/platform/businesses/${id}/bills/${foreign._id}`, panel)).status, 404);
    } finally {
        await Bill.deleteOne({ _id: foreign._id });
    }
}));

test("businesses list and overview", withShop(async (shop) => {
    const { token: panel } = await panelUser();
    const list = (await get(`/platform/businesses?search=${encodeURIComponent(shop.business.name)}`, panel)).body;
    assert.equal(list.businesses.length, 1);
    const row = list.businesses[0];
    assert.equal(row.owner.email, shop.owner.email);
    assert.deepEqual([row.today.bills, row.today.sales, row.today.creditGiven], [2, 750, 450]);
    assert.deepEqual([row.counts.employees, row.counts.products], [1, 1]);
    assert.equal(list.pagination.total, 1);
    assert.equal((await get("/platform/businesses?status=nope", panel)).status, 400);
    assert.equal((await get("/platform/businesses?sort=nope", panel)).status, 400);

    await post(`/platform/businesses/${shop.business._id}/block`, { reason: "test" }, panel);
    const blocked = (await get(`/platform/businesses?status=blocked&search=${encodeURIComponent(shop.business.name)}`, panel)).body;
    assert.equal(blocked.businesses.length, 1);
    const active = (await get(`/platform/businesses?status=active&search=${encodeURIComponent(shop.business.name)}`, panel)).body;
    assert.equal(active.businesses.length, 0);

    const o = (await get("/platform/overview", panel)).body;
    assert.ok(o.shops.total >= 1);
    assert.ok(o.shops.blocked >= 1);
    assert.ok(o.today.bills >= 2);
    assert.ok(Array.isArray(o.paymentsDue));
}));

// ═══ Panel users ═════════════════════════════════════════════════════════════

test("panel users: create, duplicate, last superadmin can't be removed", async () => {
    const boss = await panelUser();
    const email = `support-${uid()}@example.com`;
    const created = await post("/platform/admins", { name: "Sara", email, password: "longenough1", role: "support" }, boss.token);
    assert.equal(created.status, 201);
    panelUsers.push(created.body.admin.id);
    assert.equal(created.body.admin.password, undefined);
    assert.equal((await post("/platform/admins", { name: "Sara", email, password: "longenough1" }, boss.token)).status, 409);
    assert.equal((await post("/platform/admins", { name: "X", email: `x-${uid()}@example.com`, password: "short" }, boss.token)).status, 400);

    // only superadmin standing → can't demote/disable
    const others = await PlatformAdmin.find({ role: "superadmin", isActive: true, _id: { $ne: boss.user._id } }).select("_id").lean();
    await PlatformAdmin.updateMany({ _id: { $in: others.map((o) => o._id) } }, { $set: { isActive: false } });
    try {
        const r = await http("PATCH", `/platform/admins/${boss.user._id}`, { token: boss.token, body: { role: "support" } });
        assert.equal(r.status, 400);
        assert.equal(r.body.message, "There must be at least one active superadmin");
    } finally {
        await PlatformAdmin.updateMany({ _id: { $in: others.map((o) => o._id) } }, { $set: { isActive: true } });
    }
});

// ═══ Fixes from the panel team's questions ═══════════════════════════════════

test("logout ends the session; change-password returns a new token and ends the old ones", async () => {
    const { user, token } = await panelUser();
    // second session of the same user
    const other = (await post("/platform/auth/login", { email: user.email, password: PASSWORD })).body.token;

    const out = await post("/platform/auth/logout", {}, token);
    assert.equal(out.status, 200);
    for (const t of [token, other]) {
        const r = await get("/platform/auth/me", t);
        assert.equal(r.status, 401);
        assert.equal(r.body.code, "TOKEN_REVOKED");
    }

    const fresh = (await post("/platform/auth/login", { email: user.email, password: PASSWORD })).body.token;
    const changed = await post("/platform/auth/change-password", { currentPassword: PASSWORD, newPassword: "another-pass-456" }, fresh);
    assert.equal(changed.status, 200);
    assert.ok(changed.body.token);
    assert.equal((await get("/platform/auth/me", fresh)).body.code, "TOKEN_REVOKED");
    assert.equal((await get("/platform/auth/me", changed.body.token)).status, 200, "this session continues");
});

test("strict params: bad days / impossible dates / bad startDate are 400, not defaults or 500", withShop(async (shop) => {
    const { token } = await panelUser();
    const P = `/platform/businesses/${shop.business._id}`;
    for (const path of [
        `${P}/activity?days=0`, `${P}/activity?days=abc`, `${P}/activity?days=181`, `${P}/usage?days=2.5`,
        `${P}/bills-summary?date=2026-02-31`, `${P}/bills-summary?date=bad`,
        `${P}/bills?startDate=bad`, `${P}/bills?endDate=2026-13-01`, `${P}/reports/sales-by-product?startDate=31-10-2026`,
    ]) {
        const r = await get(path, token);
        assert.equal(r.status, 400, `${path} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.equal((await get(`${P}/activity?days=180`, token)).status, 200);
    assert.equal((await get(`${P}/bills?startDate=2026-10-01&endDate=2026-11-02`, token)).status, 200);
    assert.equal((await get(`${P}/bills?startDate=2026-10-01T00:00:00.000Z`, token)).status, 200);
}));

test("products can be paged on request (plain array otherwise)", withShop(async (shop) => {
    const { token } = await panelUser();
    await Product.insertMany([1, 2, 3].map((i) => ({ name: `Item ${i}`, sku: `SKU-${shop.suffix}-${i}`, sellingPrice: 10, business: shop.business._id })));
    const P = `/platform/businesses/${shop.business._id}/products`;
    assert.ok(Array.isArray((await get(P, token)).body));
    const r = (await get(`${P}?page=2&limit=3`, token)).body;
    assert.equal(r.products.length, 1);
    assert.deepEqual(r.pagination, { page: 2, limit: 3, total: 4, pages: 2, hasMore: false });
}));

test("sorting: name is case-insensitive, shops without paid-until come last; history keeps contact", withShop(async (shop) => {
    const { token } = await panelUser();
    const tag = uid();
    const made = await Business.insertMany([
        { name: `zeta ${tag}`, businessType: new mongoose.Types.ObjectId(), email: `z${tag}@example.com` },
        { name: `Alpha ${tag}`, businessType: new mongoose.Types.ObjectId(), email: `a${tag}@example.com`, subscription: { paidUntil: new Date("2026-12-01") } },
        { name: `beta ${tag}`, businessType: new mongoose.Types.ObjectId(), email: `b${tag}@example.com`, subscription: { paidUntil: new Date("2026-11-15") } },
    ]);
    try {
        const names = async (sort) => (await get(`/platform/businesses?search=${tag}&sort=${sort}`, token)).body.businesses.map((b) => b.name.split(" ")[0]);
        assert.deepEqual(await names("name"), ["Alpha", "beta", "zeta"]);
        assert.deepEqual(await names("paidUntil"), ["beta", "Alpha", "zeta"]);

        await post(`/platform/businesses/${shop.business._id}/warn`, { message: "Due soon", paidUntil: "2026-11-10", contact: "Call 0300" }, token);
        const h = (await get(`/platform/businesses/${shop.business._id}`, token)).body.subscriptionHistory[0];
        assert.equal(h.details.contact, "Call 0300");
        assert.equal(h.details.message, "Due soon");
        assert.equal((await post(`/platform/businesses/${shop.business._id}/warn`, { message: "x", paidUntil: "2026-02-31" }, token)).status, 400);
    } finally {
        await Business.deleteMany({ _id: { $in: made.map((b) => b._id) } });
    }
}));

test("private subscription fields never reach a shop (settings save, logins, business page)", withShop(async (shop) => {
    const { token: panel } = await panelUser();
    const id = shop.business._id;
    await post(`/platform/businesses/${id}/warn`, { message: "Payment due soon", paidUntil: "2026-12-01", contact: "Call 0300" }, panel);
    await http("PATCH", `/platform/businesses/${id}/subscription`, { token: panel, body: { notes: "Pays late, be strict", monthlyFee: 3000 } });

    const hidden = (label, sub) => {
        assert.ok(sub, `${label}: subscription present`);
        assert.equal(sub.notes, undefined, `${label}: notes`);
        assert.equal(sub.history, undefined, `${label}: history`);
        assert.equal(sub.monthlyFee, undefined, `${label}: monthlyFee`);
        assert.equal(sub.status, "warning", `${label}: the shop still sees its own status`);
    };

    const ownerLoginRes = await ownerLogin(shop);
    hidden("owner login", ownerLoginRes.body.business.subscription);
    hidden("employee login", (await employeeLogin(shop)).body.business.subscription);
    const owner = ownerLoginRes.body.token;
    hidden("GET /business/:id", (await get(`/business/${id}`, owner)).body.subscription);

    const saved = await http("PUT", "/admin/business/settings", { token: owner, body: { settings: { language: "en" }, taxLabel: "GST" } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    hidden("PUT /admin/business/settings", saved.body.subscription);
    assert.equal(saved.body.taxLabel, "GST");

    // Safety net: any full Business document serialised to JSON drops them too
    hidden("Business toJSON", JSON.parse(JSON.stringify(await Business.findById(id))).subscription);

    // …while the panel still sees everything
    const d = (await get(`/platform/businesses/${id}`, panel)).body;
    assert.equal(d.subscription.notes, "Pays late, be strict");
    assert.equal(d.subscription.monthlyFee, 3000);
    assert.ok(d.subscriptionHistory.length >= 2);
}));

test("viewing a customer's rates in the panel never deletes them (inactive product)", withShop(async (shop) => {
    const { token } = await panelUser();
    const customer = await Customer.create({
        business: shop.business._id, name: "Zed", phone: uid(),
        specialRates: [{ product: shop.product._id, rate: 120, priceWhenSaved: 150 }],
    });
    await Product.updateOne({ _id: shop.product._id }, { $set: { isActive: false } });

    const r = await get(`/platform/businesses/${shop.business._id}/customers/${customer._id}/rates`, token);
    assert.equal(r.status, 200);
    await new Promise((res) => setTimeout(res, 800)); // the old cleanup ran after the response
    assert.equal((await Customer.findById(customer._id).lean()).specialRates.length, 1, "rate kept");
}));

test("P2/P3 fixes: login spam isn't recorded, isActive must be boolean, revoked refresh tokens refused, blocked calls counted, day summary money", withShop(async (shop) => {
    const { token, user } = await panelUser();

    // unknown email → no audit row; known email with a wrong password → recorded
    const ghost = `ghost-${uid()}@example.com`;
    await post("/platform/auth/login", { email: ghost, password: "x" });
    assert.equal(await PlatformAudit.countDocuments({ "details.email": ghost }), 0);
    await post("/platform/auth/login", { email: user.email, password: "wrong" });
    assert.equal(await PlatformAudit.countDocuments({ action: "auth.login_failed", "details.email": user.email }), 1);

    // isActive must be a real boolean
    const support = await panelUser("support");
    const bad = await http("PATCH", `/platform/admins/${support.user._id}`, { token, body: { isActive: "true" } });
    assert.equal(bad.status, 400);
    assert.equal((await PlatformAdmin.findById(support.user._id).lean()).isActive, true, "not disabled by mistake");

    // a refresh token from before "revoke sessions" (e.g. created in the race) is refused
    const session = (await ownerLogin(shop)).body;
    await new Promise((r) => setTimeout(r, 50));
    await post(`/platform/businesses/${shop.business._id}/revoke-sessions`, {}, token);
    const before = new Date((await Business.findById(shop.business._id).lean()).subscription.sessionsRevokedAt.getTime() - 1000);
    const raced = { token: `race-${uid()}`, user: shop.owner._id, userType: "admin", businessId: shop.business._id, expiresAt: new Date(Date.now() + 86400000), createdAt: before, updatedAt: before };
    await RefreshToken.collection.insertOne({ ...raced });
    const refused = await post("/auth/refresh", { refreshToken: raced.token });
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, "SESSION_REVOKED");
    assert.equal((await post("/auth/refresh", { refreshToken: session.refreshToken })).status, 401);

    // blocked API calls are counted in usage
    await new Promise((r) => setTimeout(r, 1100));
    const owner = (await ownerLogin(shop)).body.token;
    await post(`/platform/businesses/${shop.business._id}/block`, { reason: "test" }, token);
    for (let i = 0; i < 3; i++) assert.equal((await get("/bill", owner)).status, 403);
    await settle();
    const usage = (await get(`/platform/businesses/${shop.business._id}/usage?days=1`, token)).body.days[0];
    assert.ok(usage.blockedRequests >= 3, JSON.stringify(usage));
    await post(`/platform/businesses/${shop.business._id}/unblock`, {}, token);

    // day summary: "paid" = real money taken that day only
    const yesterday = new Date(Date.now() - 86400000);
    const old = await new Bill({
        billNumber: 50, business: shop.business._id, type: "sale", status: "completed", cashierName: "Owner",
        items: [{ product: shop.product._id, name: "Ketchup", qty: 2, price: 150, costPrice: 100 }],
        payments: [
            { amount: 100, method: "cash", paidAt: yesterday },                                          // taken that day
            { amount: 50, method: "cash", paidAt: new Date() },                                          // collected later
            { amount: 30, method: "store_credit", paidAt: yesterday, creditFrom: shop.bills[0]._id },   // not money
        ],
    }).save();
    await Bill.collection.updateOne({ _id: old._id }, { $set: { createdAt: yesterday } });
    const day = new Date(yesterday.getTime());
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const s = (await get(`/platform/businesses/${shop.business._id}/bills-summary?date=${key}`, token)).body;
    assert.equal(s.bills, 1);
    assert.equal(s.paid, 100);
    assert.equal(s.paidByStoreCredit, 30);
    assert.deepEqual(s.byPaymentMethod, [{ method: "cash", payments: 1, amount: 100 }]);
}));
