/**
 * One-time cleanup: settle store credit that is stuck on returned bills.
 *
 * For each customer whose unpaid bills (what Record Payment shows) don't add
 * up to their balance (what the ledger shows), report why and — with --apply —
 * move the credit onto their oldest unpaid bills using the SAME code the app
 * uses (utils/storeCredit.mjs). The balance never changes.
 *
 * The preview runs the real settlement inside a transaction that is always
 * rolled back, so it shows the exact moves without writing anything.
 *
 * Usage (pass the database for this command only — leave .env on dev):
 *   MONGODB_URI='mongodb+srv://…/pos-production…' node scripts/settle-store-credit.mjs --business <id>
 *       report + preview, writes nothing
 *   … --business <id> --apply [--customer <id>] [--batch cleanup-2026-10-12]
 *       settle every unflagged customer (or one customer) in its own transaction
 *   … --business <id> --apply --customer <id> --include-flagged
 *       settle a flagged customer after you've reviewed it
 *   … --business <id> --undo cleanup-2026-10-12 [--customer <id>]
 *       remove exactly the moves made by that batch
 *   Add --out report.json to also save the report as JSON.
 */

import "dotenv/config";
import fs from "fs";
import mongoose from "mongoose";

import Bill from "../models/bill.mjs";
import Business from "../models/business.mjs";
import Customer from "../models/customer.mjs";
import { settleCustomerCredit, undoSettlementBatch } from "../utils/storeCredit.mjs";

const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);

const BUSINESS_ID = arg("business");
const ONLY_CUSTOMER = arg("customer");
const APPLY = flag("apply");
const UNDO_BATCH = arg("undo");
const INCLUDE_FLAGGED = flag("include-flagged");
const OUT = arg("out");
const BATCH = arg("batch") || `cleanup-${new Date().toISOString().slice(0, 10)}`;

const EPSILON = 0.01;
const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;
const REMADE_WINDOW_MS = 60 * 60 * 1000;
const round2 = (x) => Math.round(x * 100) / 100;
const fmt = (d) => new Date(d).toLocaleString("en-GB", { timeZone: process.env.TIMEZONE || "Asia/Karachi" });

const itemSignature = (bill) =>
    bill.items.map((i) => `${i.product || i.name}|${i.qty}|${i.price}|${i.discountAmount || 0}`).sort().join(";");

/** Read-only analysis of one customer. */
const analyse = async (customer) => {
    const bills = await Bill.find({ customer: customer._id, business: BUSINESS_ID, status: { $ne: "cancelled" } })
        .sort({ createdAt: 1, billNumber: 1 })
        .lean();

    const balance = round2(bills.reduce((s, b) => s + (b.amountDue || 0), 0));
    const completed = bills.filter((b) => b.status === "completed");
    const openTotal = round2(completed.reduce((s, b) => s + Math.max(0, b.amountDue || 0), 0));
    const credits = completed.filter((b) => b.type === "sale" && b.amountDue < -0.005);
    const unpaid = completed.filter((b) => b.amountDue > 0.005);

    const flags = [];
    for (const c of credits) {
        const twin = bills.find((o) =>
            o._id.toString() !== c._id.toString() &&
            o.type === "sale" &&
            o.total === c.total &&
            Math.abs(new Date(o.createdAt) - new Date(c.createdAt)) <= DUPLICATE_WINDOW_MS &&
            itemSignature(o) === itemSignature(c)
        );
        if (twin) flags.push(`Possible duplicate bill: #${c.billNumber} looks like a copy of #${twin.billNumber} (same items and total, ${fmt(c.createdAt)} vs ${fmt(twin.createdAt)})`);
    }
    // Re-made bill: soon after the return, a new bill for this customer was
    // marked paid at the counter — the credit was probably used for it but
    // recorded as fresh money (e.g. an exchange). Settling would count it twice.
    for (const c of credits) {
        for (const r of c.returns || []) {
            const remade = bills.find((o) =>
                o._id.toString() !== c._id.toString() &&
                o.type === "sale" &&
                new Date(o.createdAt) >= new Date(r.returnedAt) &&
                new Date(o.createdAt) - new Date(r.returnedAt) <= REMADE_WINDOW_MS &&
                (o.payments || []).some((p) => !p.creditFrom && Math.abs(new Date(p.paidAt) - new Date(o.createdAt)) <= 5 * 60 * 1000)
            );
            if (remade) {
                flags.push(`Possible re-made bill / exchange: #${remade.billNumber} (Rs ${remade.total}) was made and paid ${Math.round((new Date(remade.createdAt) - new Date(r.returnedAt)) / 60000)} min after return ${r.returnNumber} on #${c.billNumber}`);
            }
        }
    }
    for (const b of bills) {
        for (const p of b.payments || []) {
            if (p.method === "store_credit" && !p.creditFrom) {
                flags.push(`Manual "Credit" payment: Rs ${p.amount} on #${b.billNumber}, ${fmt(p.paidAt)} by ${p.receivedByName || "?"}`);
            }
        }
    }
    if (Math.abs(round2(customer.balance || 0) - balance) > EPSILON) {
        flags.push(`Stored balance is wrong: customer says Rs ${round2(customer.balance || 0)}, bills add up to Rs ${balance}`);
    }
    const holds = bills.filter((b) => b.status === "hold" && Math.abs(b.amountDue || 0) > 0.005);
    if (holds.length) {
        flags.push(`Hold bills in the balance: ${holds.map((b) => `#${b.billNumber} (Rs ${round2(b.amountDue)})`).join(", ")}`);
    }

    return { customer, bills, balance, openTotal, credits, unpaid, flags };
};

/** Run the real settlement in a transaction; commit only when `commit` is true. */
const runSettlement = async (customerId, commit) => {
    const session = await mongoose.startSession();
    try {
        session.startTransaction();
        const moves = await settleCustomerCredit({
            customerId,
            businessId: BUSINESS_ID,
            session,
            actor: { name: "Store credit cleanup" },
            batch: BATCH,
            force: true,
        });
        if (commit) await session.commitTransaction();
        else await session.abortTransaction();
        return moves;
    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        throw err;
    } finally {
        session.endSession();
    }
};

const printCustomer = (a, moves) => {
    const diff = round2(a.openTotal - a.balance);
    console.log(`\nCustomer: ${a.customer.name} (${a.customer.phone})  id ${a.customer._id}`);
    console.log(`  Balance ${a.balance}   Record Payment ${a.openTotal}   Difference ${diff}`);
    if (a.credits.length) {
        console.log("  Credits:");
        for (const c of a.credits) {
            const rets = (c.returns || []).map((r) => `${r.returnNumber} (${fmt(r.returnedAt)}, ${r.processedByName || "?"})`).join(", ");
            console.log(`    Bill #${c.billNumber} (${fmt(c.createdAt)})  ${round2(c.amountDue)}  ← ${rets || "no return (overpaid?)"}`);
        }
    }
    if (a.unpaid.length) {
        console.log(`  Unpaid bills (oldest first): ${a.unpaid.map((b) => `#${b.billNumber} ${round2(b.amountDue)}`).join(" · ")}`);
    }
    if (moves) {
        console.log(moves.length ? "  Moves:" : "  Moves: none");
        for (const m of moves) console.log(`    #${m.fromNumber} → #${m.toNumber}  ${m.amount}`);
    }
    console.log(a.flags.length ? a.flags.map((f) => `  ⚠️  ${f}`).join("\n") : "  Flags: none");
};

const main = async () => {
    if (!BUSINESS_ID) throw new Error("--business <id> is required");
    await mongoose.connect(process.env.MONGODB_URI);
    const business = await Business.findById(BUSINESS_ID).select("name").lean();
    if (!business) throw new Error(`Business ${BUSINESS_ID} not found`);

    const mode = UNDO_BATCH ? `UNDO batch ${UNDO_BATCH}` : APPLY ? `APPLY (batch ${BATCH})` : "REPORT + PREVIEW (writes nothing)";
    console.log(`\nDatabase: ${mongoose.connection.name}   Business: ${business.name}   Mode: ${mode}`);

    const customerFilter = { business: BUSINESS_ID, ...(ONLY_CUSTOMER && { _id: ONLY_CUSTOMER }) };
    const customers = await Customer.find(customerFilter).select("name phone balance").sort({ name: 1 }).lean();

    // ── Undo ────────────────────────────────────────────────────
    if (UNDO_BATCH) {
        let total = 0;
        for (const c of customers) {
            const session = await mongoose.startSession();
            try {
                session.startTransaction();
                const removed = await undoSettlementBatch({ customerId: c._id, businessId: BUSINESS_ID, batch: UNDO_BATCH, session });
                await session.commitTransaction();
                if (removed) console.log(`  ${c.name}: removed ${removed} credit move(s)`);
                total += removed;
            } catch (err) {
                if (session.inTransaction()) await session.abortTransaction();
                console.log(`  ✗ ${c.name}: ${err.message} — unchanged`);
            } finally {
                session.endSession();
            }
        }
        console.log(`\nUndo done: ${total} move(s) removed.\n`);
        return;
    }

    // ── Report / preview / apply ────────────────────────────────
    const report = [];
    let settled = 0;
    let skipped = 0;
    let failed = 0;

    for (const c of customers) {
        const before = await analyse(c);
        const mismatch = Math.abs(before.openTotal - before.balance) > EPSILON || before.flags.length > 0;
        if (!mismatch && !ONLY_CUSTOMER) continue;

        const flagged = before.flags.some((f) => !f.startsWith("Hold bills"));
        let moves = null;
        let status;

        try {
            if (APPLY && flagged && !INCLUDE_FLAGGED) {
                moves = await runSettlement(c._id, false);
                status = "skipped (flagged — review, then rerun with --customer <id> --include-flagged)";
                skipped += 1;
            } else {
                moves = await runSettlement(c._id, APPLY);
                status = APPLY ? "settled" : "preview";
                if (APPLY) settled += 1;
            }
        } catch (err) {
            status = `failed: ${err.message}`;
            failed += 1;
        }

        printCustomer(before, moves);

        if (APPLY && status === "settled") {
            const after = await analyse(await Customer.findById(c._id).select("name phone balance").lean());
            const ok = Math.abs(after.balance - before.balance) <= EPSILON && Math.abs(after.openTotal - after.balance) <= EPSILON;
            console.log(`  After: Balance ${after.balance}   Record Payment ${after.openTotal}   ${ok ? "✅" : "❌ CHECK THIS CUSTOMER"}`);
            if (!ok) failed += 1;
        } else if (moves && !status.startsWith("failed")) {
            const moved = round2(moves.reduce((s, m) => s + m.amount, 0));
            console.log(`  After (preview): Balance ${before.balance}   Record Payment ${round2(before.openTotal - moved)}`);
        }
        console.log(`  Status: ${status}`);

        report.push({
            customerId: c._id,
            name: c.name,
            phone: c.phone,
            balance: before.balance,
            recordPayment: before.openTotal,
            credits: before.credits.map((b) => ({ bill: b.billNumber, amount: round2(b.amountDue), returns: (b.returns || []).map((r) => r.returnNumber) })),
            moves: (moves || []).map((m) => ({ from: m.fromNumber, to: m.toNumber, amount: m.amount })),
            flags: before.flags,
            status,
        });
    }

    console.log(`\nCustomers listed: ${report.length}` + (APPLY ? `   settled: ${settled}   skipped: ${skipped}   failed: ${failed}` : ""));
    if (APPLY && settled) console.log(`Undo with: --undo ${BATCH}`);
    if (OUT) {
        fs.writeFileSync(OUT, JSON.stringify({ business: business.name, mode, batch: BATCH, report }, null, 2));
        console.log(`Report saved to ${OUT}`);
    }
    console.log("");
    if (failed) process.exitCode = 1;
};

main()
    .catch((err) => {
        console.error(`\n${err.message}\n`);
        process.exitCode = 1;
    })
    .finally(() => mongoose.connection.close());
