/**
 * Undo a customer payment that was recorded by mistake, by its cash book entry number.
 *
 * Supports the two cash-in entries a customer payment creates:
 *   - "Collection from <customer> (N bills)" — Record Payment / FIFO collection
 *     (cash book references the customer; one payment per bill it paid)
 *   - "Payment received - Bill #N" — a payment added to one bill
 *
 * The payments the entry made are found by: same customer (or bill), cash,
 * paid within 15 seconds before the cash book entry, FIFO note for
 * collections — and they must add up to the entry amount EXACTLY, otherwise
 * nothing is changed.
 *
 * What --apply does, in ONE transaction:
 *   1. Removes those payments from the bills (bill hooks recalculate the
 *      bills and the customer balance).
 *   2. Deletes the cash book entry and lowers the running balance of every
 *      later entry by the same amount.
 * Refuses if a store closing already covers the entry, or if the cash book
 * balances aren't consistent before/after.
 *
 * Usage:
 *   node scripts/undo-cash-entry.mjs --business <id> --entry 356            # dry run
 *   node scripts/undo-cash-entry.mjs --business <id> --entry 356 --apply    # undo
 */

import "dotenv/config";
import mongoose from "mongoose";

import Bill from "../models/bill.mjs";
import Business from "../models/business.mjs";
import Customer from "../models/customer.mjs";
import CashBook from "../models/cashbook.mjs";

const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : undefined;
};
const BUSINESS_ID = arg("business");
const ENTRY_NUMBER = Number(arg("entry"));
const APPLY = process.argv.includes("--apply");
const MATCH_WINDOW_MS = 15 * 1000;

let committed = false;
const round2 = (x) => Math.round(x * 100) / 100;
const fmt = (d) => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Karachi" }) : "—");
const check = (cond, msg) => {
    if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
    console.log(`  ✓ ${msg}`);
};

/** Every entry's balance must equal the previous balance ± its amount. */
const checkChain = async (fromEntryNumber, session = null) => {
    const q = CashBook.find({ business: BUSINESS_ID, entryNumber: { $gte: fromEntryNumber } }).sort({ entryNumber: 1 }).lean();
    if (session) q.session(session);
    const rows = await q;
    for (let i = 1; i < rows.length; i++) {
        const expected = round2(rows[i - 1].runningBalance + (rows[i].direction === "in" ? rows[i].amount : -rows[i].amount));
        if (Math.abs(expected - round2(rows[i].runningBalance)) > 0.01) {
            return `entry #${rows[i].entryNumber}: balance ${round2(rows[i].runningBalance)} but expected ${expected}`;
        }
    }
    return null;
};

const main = async () => {
    if (!BUSINESS_ID || !ENTRY_NUMBER) throw new Error("Usage: --business <id> --entry <number> [--apply]");
    await mongoose.connect(process.env.MONGODB_URI);
    console.log(`\nMode: ${APPLY ? "APPLY (will write)" : "DRY RUN (read-only)"}\nDatabase: ${mongoose.connection.name}\n`);

    console.log("Pre-checks:");
    const business = await Business.findById(BUSINESS_ID).select("name lastClosingAt").lean();
    check(!!business, `business: ${business?.name}`);

    const entry = await CashBook.findOne({ business: BUSINESS_ID, entryNumber: ENTRY_NUMBER }).lean();
    check(!!entry, `cash book #${ENTRY_NUMBER} found: "${entry?.description}" ${entry?.direction?.toUpperCase()} ${entry?.amount} (${fmt(entry?.createdAt)}, by ${entry?.performedBy})`);
    check(entry.type === "sale_collection" && entry.direction === "in", "it is a customer payment (sale_collection, cash in)");
    check(["customer", "bill"].includes(entry.referenceType), `it references a ${entry.referenceType}`);
    check(!business.lastClosingAt || business.lastClosingAt < entry.createdAt,
        `no store closing covers it (last closing up to ${fmt(business.lastClosingAt)})`);

    // Find the bills this entry could have paid
    let bills;
    let customer = null;
    if (entry.referenceType === "customer") {
        customer = await Customer.findOne({ _id: entry.referenceId, business: BUSINESS_ID }).lean();
        check(!!customer, `customer: ${customer?.name}`);
        bills = await Bill.find({ business: BUSINESS_ID, customer: customer._id, status: { $ne: "cancelled" } }).lean();
    } else {
        const bill = await Bill.findOne({ _id: entry.referenceId, business: BUSINESS_ID }).lean();
        check(!!bill, `bill #${bill?.billNumber}`);
        bills = [bill];
        if (bill.customer) customer = await Customer.findById(bill.customer).lean();
    }

    const from = new Date(entry.createdAt).getTime() - MATCH_WINDOW_MS;
    const to = new Date(entry.createdAt).getTime();
    const matches = [];
    for (const b of bills) {
        for (const p of b.payments || []) {
            const t = new Date(p.paidAt).getTime();
            const fifoOk = entry.referenceType === "customer" ? (p.note || "").startsWith("FIFO collection") : true;
            if (p.method === "cash" && !p.creditFrom && t >= from && t <= to && fifoOk) {
                matches.push({ billId: b._id, billNumber: b.billNumber, paymentId: p._id.toString(), amount: p.amount, paidAt: p.paidAt, due: b.amountDue, status: b.paymentStatus });
            }
        }
    }
    matches.sort((a, b) => a.billNumber - b.billNumber);
    const total = round2(matches.reduce((s, m) => s + m.amount, 0));
    for (const m of matches) console.log(`      payment on #${m.billNumber}: ${m.amount} cash (${fmt(m.paidAt)})`);
    check(matches.length > 0 && total === round2(entry.amount), `the matching payments add up to exactly ${entry.amount} (found ${total})`);

    const chainError = await checkChain(ENTRY_NUMBER - 1);
    check(!chainError, `cash book balances are consistent from #${ENTRY_NUMBER - 1} onwards${chainError ? ` — ${chainError}` : ""}`);
    const later = await CashBook.find({ business: BUSINESS_ID, entryNumber: { $gt: ENTRY_NUMBER } }).sort({ entryNumber: 1 }).lean();
    check(later.every((e) => e.createdAt >= entry.createdAt), `all ${later.length} later entries are dated after #${ENTRY_NUMBER}`);
    const latest = later[later.length - 1] || entry;

    console.log("\nPlanned changes:");
    for (const m of matches) {
        console.log(`  Bill #${m.billNumber}: remove payment ${m.amount}   due ${round2(m.due)} → ${round2(m.due + m.amount)}`);
    }
    if (customer) console.log(`  Customer ${customer.name} balance: ${round2(customer.balance)} → ${round2(customer.balance + entry.amount)}`);
    console.log(`  Cash book: delete #${ENTRY_NUMBER} (IN ${entry.amount})`);
    if (later.length) console.log(`             ${later.length} later entries (#${later[0].entryNumber}–#${latest.entryNumber}): running balance −${entry.amount} each`);
    console.log(`             current balance ${round2(latest.runningBalance)} → ${round2(latest.runningBalance - entry.amount)}`);

    if (!APPLY) {
        console.log("\nDRY RUN — nothing was written. Re-run with --apply to perform the undo.\n");
        return;
    }

    const session = await mongoose.startSession();
    try {
        session.startTransaction();
        for (const m of matches) {
            const bill = await Bill.findById(m.billId).session(session);
            const pay = bill.payments.id(m.paymentId);
            if (!pay || pay.amount !== m.amount) throw new Error(`#${m.billNumber} payment changed since the checks — aborting`);
            bill.payments.pull(m.paymentId);
            await bill.save({ session }); // recalculates the bill and the customer
        }
        const del = await CashBook.deleteOne({ _id: entry._id, amount: entry.amount }, { session });
        if (del.deletedCount !== 1) throw new Error(`cash book #${ENTRY_NUMBER} changed since the checks — aborting`);
        await CashBook.updateMany(
            { business: BUSINESS_ID, entryNumber: { $gt: ENTRY_NUMBER } },
            { $inc: { runningBalance: -entry.amount } },
            { session }
        );
        const chainAfter = await checkChain(ENTRY_NUMBER - 1, session);
        if (chainAfter) throw new Error(`cash book chain broken after undo (${chainAfter}) — aborting`);
        await session.commitTransaction();
        committed = true;
        console.log("\nCommitted.");
    } catch (err) {
        await session.abortTransaction();
        throw err;
    } finally {
        session.endSession();
    }

    console.log("\nVerification:");
    if (customer) {
        const after = await Customer.findById(customer._id).lean();
        check(round2(after.balance) === round2(customer.balance + entry.amount), `customer balance is Rs ${round2(after.balance)}`);
    }
    for (const m of matches) {
        const b = await Bill.findById(m.billId).lean();
        check(!b.payments.some((x) => x._id.toString() === m.paymentId), `#${m.billNumber} payment removed (due ${round2(b.amountDue)}, ${b.paymentStatus})`);
    }
    check(!(await CashBook.exists({ _id: entry._id })), `cash book #${ENTRY_NUMBER} deleted`);
    const newLatest = await CashBook.findOne({ business: BUSINESS_ID }).sort({ createdAt: -1, entryNumber: -1 }).lean();
    check(round2(newLatest.runningBalance) === round2(latest.runningBalance - entry.amount), `cash book balance is ${round2(newLatest.runningBalance)}`);
    console.log("\nDone.\n");
};

main()
    .catch((err) => {
        console.error(`\n${err.message}\n${committed ? "The undo WAS committed — check the verification above." : "Nothing was changed."}\n`);
        process.exitCode = 1;
    })
    .finally(() => mongoose.connection.close());
