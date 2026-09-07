/**
 * Idempotency smoke test for the 4 offline-sync write endpoints.
 *
 *   1. POST /bill                  — same key twice → ONE bill
 *   2. POST /customer/:id/collect  — same key twice → ONE payment applied
 *   3. POST /customer              — same key twice → ONE customer
 *   4. PATCH /customer/:id         — replay is a safe no-op, returns the record
 *
 * Also verifies that an offline bill is dated by clientCreatedAt.
 *
 * Runs the real controllers against the configured MongoDB, creating an
 * isolated Business and deleting everything it made at the end.
 *
 *   ⚠️  Point MONGODB_URI at a TEST database, not production:
 *       MONGODB_URI="mongodb+srv://.../pos-test" node scripts/test-bill-idempotency.mjs
 *
 * Exit code 0 = all assertions passed, 1 = a failure (details printed).
 */

process.env.TZ = process.env.TZ || "Asia/Karachi";

import "dotenv/config";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import Business from "../models/business.mjs";
import Bill from "../models/bill.mjs";
import Customer from "../models/customer.mjs";
import Product from "../models/product.mjs";
import Payment from "../models/payment.mjs";
import CashBook from "../models/cashbook.mjs";
import Counter from "../models/counter.mjs";

import { createBill } from "../controllers/bill.mjs";
import { createOrGetCustomer, collectFromCustomer, updateCustomer } from "../controllers/customer.mjs";

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const newKey = () => `test-${uid()}-${Math.random().toString(36).slice(2, 10)}`;

const ADMIN_ID = new mongoose.Types.ObjectId();

const mkReq = ({ params = {}, body = {}, businessId }) => ({
    params,
    body,
    // adminId set so canViewProfit() short-circuits without a DB lookup
    user: { adminId: ADMIN_ID.toString(), id: ADMIN_ID, businessId, name: "Test Admin" },
});

// Invoke a controller and capture { statusCode, body }.
const call = (fn, req) =>
    new Promise((resolve, reject) => {
        let statusCode = 200;
        const res = {
            status(code) { statusCode = code; return this; },
            json(data) { resolve({ statusCode, body: data }); return this; },
        };
        Promise.resolve(fn(req, res)).catch(reject);
    });

// Read the server-assigned id from any of the shapes the contract allows.
const idOf = (b) =>
    b?._id || b?.id || b?.bill?._id || b?.customer?._id || b?.data?._id;

let passed = 0;
const ok = (label) => { passed++; console.log(`  ✓ ${label}`); };

async function run() {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
    await mongoose.connect(process.env.MONGODB_URI);

    const business = await Business.create({
        name: `Idempotency Test ${uid()}`,
        businessType: new mongoose.Types.ObjectId(),
        email: `idem-${uid()}@example.test`,
    });
    const businessId = business._id;

    try {
        const product = await Product.create({
            business: businessId,
            name: "Test Widget",
            sellingPrice: 100,
            costPrice: 40,
            stockQuantity: 1000,
            trackStock: true,
        });

        // ── 1. POST /bill — same key twice → ONE bill ──────────────
        console.log("POST /bill");
        {
            const key = newKey();
            const clientCreatedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
            const body = {
                items: [{ product: product._id.toString(), name: "Test Widget", qty: 2, price: 100, gst: 0 }],
                amountPaid: 200,
                paymentMethod: "cash",
                source: "offline",
                clientCreatedAt: clientCreatedAt.toISOString(),
                idempotencyKey: key,
            };

            const first = await call(createBill, mkReq({ body, businessId }));
            assert.ok([200, 201].includes(first.statusCode), `first bill status ${first.statusCode}`);
            const firstId = idOf(first.body);
            assert.ok(firstId, "first bill response exposes an id");
            ok(`first create → ${first.statusCode}, id present`);

            const second = await call(createBill, mkReq({ body, businessId }));
            assert.ok([200, 201, 409].includes(second.statusCode), `replay status ${second.statusCode}`);
            const secondId = idOf(second.body);
            assert.equal(String(secondId), String(firstId), "replay returns the same bill id");
            ok(`replay → ${second.statusCode}, same id`);

            const count = await Bill.countDocuments({ business: businessId, idempotencyKey: key });
            assert.equal(count, 1, `expected exactly 1 bill for the key, found ${count}`);
            ok("exactly ONE bill persisted for the key");

            const bill = await Bill.findById(firstId).lean();
            assert.equal(bill.source, "offline", "bill.source stored");
            assert.ok(bill.clientCreatedAt, "bill.clientCreatedAt stored");
            assert.equal(
                new Date(bill.createdAt).getTime(),
                clientCreatedAt.getTime(),
                "bill dated by clientCreatedAt (createdAt backdated)"
            );
            ok("bill dated by clientCreatedAt, source persisted");
        }

        // ── 3. POST /customer — same key twice → ONE customer ──────
        console.log("POST /customer");
        let customerId;
        {
            const key = newKey();
            const body = { name: "Jane Offline", phone: `off-${uid()}`, idempotencyKey: key };

            const first = await call(createOrGetCustomer, mkReq({ body, businessId }));
            assert.ok([200, 201].includes(first.statusCode), `first customer status ${first.statusCode}`);
            customerId = idOf(first.body);
            assert.ok(customerId, "customer response exposes real _id (for temp-id mapping)");
            ok(`first create → ${first.statusCode}, _id present`);

            const second = await call(createOrGetCustomer, mkReq({ body, businessId }));
            assert.ok([200, 201, 409].includes(second.statusCode), `replay status ${second.statusCode}`);
            assert.equal(String(idOf(second.body)), String(customerId), "replay returns same customer _id");
            ok(`replay → ${second.statusCode}, same _id`);

            const count = await Customer.countDocuments({ business: businessId, idempotencyKey: key });
            assert.equal(count, 1, `expected exactly 1 customer for the key, found ${count}`);
            ok("exactly ONE customer persisted for the key");
        }

        // Seed a credit bill so there is something to collect against.
        await call(createBill, mkReq({
            body: {
                items: [{ product: product._id.toString(), name: "Test Widget", qty: 5, price: 100, gst: 0 }],
                customer: customerId.toString(),
                amountPaid: 0, // fully on credit
            },
            businessId,
        }));

        // ── 2. POST /customer/:id/collect — same key twice → ONE payment ──
        console.log("POST /customer/:id/collect");
        {
            const key = newKey();
            const body = { amount: 300, method: "cash", idempotencyKey: key };
            const req = () => mkReq({ params: { id: customerId.toString() }, body, businessId });

            const first = await call(collectFromCustomer, req());
            assert.ok([200, 201].includes(first.statusCode), `first collect status ${first.statusCode}`);
            ok(`first collect → ${first.statusCode}`);

            const balAfterFirst = (await Customer.findById(customerId).lean()).balance;

            const second = await call(collectFromCustomer, req());
            assert.ok([200, 201, 409].includes(second.statusCode), `replay collect status ${second.statusCode}`);
            ok(`replay → ${second.statusCode} (not a 400 "no outstanding bills")`);

            const balAfterSecond = (await Customer.findById(customerId).lean()).balance;
            assert.equal(balAfterSecond, balAfterFirst, "replay did NOT apply the payment twice");
            ok(`balance unchanged by replay (Rs ${balAfterSecond})`);

            const count = await Payment.countDocuments({ business: businessId, idempotencyKey: key });
            assert.equal(count, 1, `expected exactly 1 payment record for the key, found ${count}`);
            ok("exactly ONE payment record persisted for the key");
        }

        // ── 4. PATCH /customer/:id — replay is a safe no-op ────────
        console.log("PATCH /customer/:id");
        {
            const key = newKey();
            const body = { name: "Jane Renamed", idempotencyKey: key };
            const req = () => mkReq({ params: { id: customerId.toString() }, body, businessId });

            const first = await call(updateCustomer, req());
            assert.ok([200, 201].includes(first.statusCode), `first patch status ${first.statusCode}`);
            const second = await call(updateCustomer, req());
            assert.ok([200, 201, 409].includes(second.statusCode), `replay patch status ${second.statusCode}`);
            assert.equal(String(idOf(second.body)), String(customerId), "patch returns the customer _id");
            assert.equal((await Customer.findById(customerId).lean()).name, "Jane Renamed", "patch applied");
            ok(`patch + replay → ${first.statusCode}/${second.statusCode}, idempotent`);
        }

        // ── Online writes unaffected: no key → normal behavior ─────
        console.log("Online writes (no key)");
        {
            const body = {
                items: [{ product: product._id.toString(), name: "Test Widget", qty: 1, price: 100, gst: 0 }],
                amountPaid: 100,
            };
            const r1 = await call(createBill, mkReq({ body, businessId }));
            const r2 = await call(createBill, mkReq({ body, businessId }));
            assert.ok([200, 201].includes(r1.statusCode) && [200, 201].includes(r2.statusCode), "online creates succeed");
            assert.notEqual(String(idOf(r1.body)), String(idOf(r2.body)), "two keyless creates → two distinct bills");
            ok("keyless writes still create distinct records");
        }

        console.log(`\n✅ ALL ${passed} ASSERTIONS PASSED`);
    } finally {
        await Promise.all([
            Bill.deleteMany({ business: businessId }),
            Customer.deleteMany({ business: businessId }),
            Product.deleteMany({ business: businessId }),
            Payment.deleteMany({ business: businessId }),
            CashBook.deleteMany({ business: businessId }),
            Counter.deleteMany({ _id: { $regex: businessId.toString() } }),
            Business.deleteOne({ _id: businessId }),
        ]);
        await mongoose.connection.close();
    }
}

run().catch((err) => {
    console.error("\n❌ TEST FAILED:", err.message);
    console.error(err);
    mongoose.connection.close().finally(() => process.exit(1));
});
