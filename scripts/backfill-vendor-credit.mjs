/**
 * One-time backfill after the vendor-credit release.
 *
 * 1. Supplies saved before the release have no `balance` / `creditUsed` /
 *    `creditApplied` fields. They are filled from the supply's own numbers
 *    (balance = total − returned − paid), so nothing about the supply changes.
 * 2. Vendors that have credit (returns on paid supplies) next to unpaid
 *    supplies get that credit moved onto their oldest unpaid supplies, using
 *    the SAME code the app uses (utils/vendorCredit.mjs). What we owe each
 *    vendor never changes, and no cash moves.
 *
 * It also reports supplies whose paidAmount doesn't match their payments
 * (old direct edits) — those are listed, never changed.
 *
 * Usage (pass the database for this command only — leave .env on dev):
 *   MONGODB_URI='mongodb+srv://…/pos-production…' node scripts/backfill-vendor-credit.mjs --business <id>
 *       report only, writes nothing
 *   … --business <id> --apply [--batch vendor-credit-2026-10-19]
 *       fill the fields and settle each vendor in its own transaction
 */

import "dotenv/config";
import mongoose from "mongoose";

import Business from "../models/business.mjs";
import Vendor from "../models/vendor.mjs";
import Supply from "../models/supply.mjs";
import { settleVendorCredit, supplyBalance, SUPPLY_BALANCE_EXPR } from "../utils/vendorCredit.mjs";

const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);

const BUSINESS_ID = arg("business");
const APPLY = flag("apply");
const BATCH = arg("batch") || `vendor-credit-${new Date().toISOString().slice(0, 10)}`;

const EPSILON = 0.005;
const round2 = (x) => Math.round(x * 100) / 100;

const main = async () => {
    if (!BUSINESS_ID) throw new Error("--business <id> is required");
    await mongoose.connect(process.env.MONGODB_URI);
    const dbName = mongoose.connection.db.databaseName;
    const business = await Business.findById(BUSINESS_ID).lean();
    if (!business) throw new Error(`Business ${BUSINESS_ID} not found in database "${dbName}"`);

    console.log(`Database: ${dbName}`);
    console.log(`Business: ${business.name} (${BUSINESS_ID})`);
    console.log(APPLY ? `Mode: APPLY (batch ${BATCH})\n` : "Mode: report only — nothing is written\n");

    const bizId = new mongoose.Types.ObjectId(BUSINESS_ID);
    const supplies = await Supply.find({ business: bizId }).sort({ billDate: 1, createdAt: 1 }).lean();

    // ── 1. Missing fields ────────────────────────────────────────────────
    const missing = supplies.filter((s) => s.balance === undefined || s.creditUsed === undefined || s.creditApplied === undefined);
    console.log(`Supplies: ${supplies.length}, missing the new fields: ${missing.length}`);

    // ── Report: paidAmount vs payments ───────────────────────────────────
    const paidMismatch = supplies.filter((s) => {
        const sum = (s.payments || []).reduce((t, p) => t + p.amount, 0);
        return Math.abs(sum - (s.paidAmount || 0)) > EPSILON;
    });
    if (paidMismatch.length) {
        console.log(`\n⚠ ${paidMismatch.length} supplies where paidAmount ≠ Σ payments (left as is — check by hand):`);
        for (const s of paidMismatch) {
            const sum = round2((s.payments || []).reduce((t, p) => t + p.amount, 0));
            console.log(`  Supply #${s.supplyNumber} ${s.vendorName}: paidAmount ${s.paidAmount}, payments ${sum}`);
        }
    }

    // ── 2. Vendors with credit next to unpaid supplies ───────────────────
    const byVendor = new Map();
    for (const s of supplies) {
        const key = String(s.vendor);
        if (!byVendor.has(key)) byVendor.set(key, []);
        byVendor.get(key).push(s);
    }
    const vendors = await Vendor.find({ business: bizId }).lean();
    const vendorName = new Map(vendors.map((v) => [String(v._id), v.name]));

    const toSettle = [];
    console.log("\nVendor positions (owe = we owe them, credit = they owe us):");
    for (const [vendorId, list] of byVendor) {
        const owe = round2(list.reduce((t, s) => t + Math.max(0, supplyBalance(s)), 0));
        const credit = round2(list.reduce((t, s) => t + Math.max(0, -supplyBalance(s)), 0));
        const mark = owe > EPSILON && credit > EPSILON ? "  ← will settle" : "";
        if (credit > EPSILON || mark) {
            console.log(`  ${vendorName.get(vendorId) || vendorId}: owe ${owe}, credit ${credit}, net ${round2(owe - credit)}${mark}`);
        }
        if (mark) toSettle.push(vendorId);
    }
    if (!toSettle.length) console.log("  (no vendor has credit next to unpaid supplies)");

    if (!APPLY) {
        console.log("\nReport only. Re-run with --apply to write.");
        return;
    }

    // ── Apply ────────────────────────────────────────────────────────────
    if (missing.length) {
        const r = await Supply.updateMany(
            { business: bizId, $or: [{ balance: { $exists: false } }, { creditUsed: { $exists: false } }, { creditApplied: { $exists: false } }] },
            [{
                $set: {
                    creditUsed: { $ifNull: ["$creditUsed", 0] },
                    creditApplied: { $ifNull: ["$creditApplied", 0] },
                    creditTransfers: { $ifNull: ["$creditTransfers", []] },
                    balance: { $round: [SUPPLY_BALANCE_EXPR, 2] },
                },
            }]
        );
        console.log(`\nFilled fields on ${r.modifiedCount} supplies`);
    }

    for (const vendorId of toSettle) {
        const session = await mongoose.startSession();
        try {
            session.startTransaction();
            const moves = await settleVendorCredit({ vendorId, businessId: bizId, session, actor: { name: "System" }, batch: BATCH });
            await session.commitTransaction();
            console.log(`Settled ${vendorName.get(vendorId) || vendorId}:`);
            for (const m of moves) console.log(`  Rs ${m.amount}: Supply #${m.fromNumber} → Supply #${m.toNumber}`);
        } catch (e) {
            await session.abortTransaction();
            console.error(`✗ ${vendorName.get(vendorId) || vendorId}: ${e.message} — nothing changed for this vendor`);
        } finally {
            session.endSession();
        }
    }
    console.log("\nDone.");
};

main()
    .catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
