/**
 * One-time undo: remove the Khan BBQ "Record Payment" of Rs 39,150
 * (13 Oct 2026 16:57, by Admin) completely, as if it was never recorded.
 *
 * That collection wrote:
 *   - "FIFO collection" cash payments on #237 (14,500), #262 (7,250), #306 (17,400)
 *   - cash book #334: sale_collection IN 39,150
 *
 * What --apply does, in ONE transaction:
 *   1. Removes those 3 payments from the bills (bill hooks recalculate the
 *      bills and the customer balance: 0 → 39,150).
 *   2. Deletes cash book #334 and lowers the running balance of every later
 *      entry by 39,150 (each entry's balance is built on the one before).
 * Refuses if a store closing already covers the collection.
 *
 * Usage:
 *   node scripts/undo-khan-bbq-collection.mjs           # dry run — reads only
 *   node scripts/undo-khan-bbq-collection.mjs --apply   # performs the undo
 */

import "dotenv/config";
import mongoose from "mongoose";

import Bill from "../models/bill.mjs";
import Business from "../models/business.mjs";
import Customer from "../models/customer.mjs";
import CashBook from "../models/cashbook.mjs";

const EXPECTED_DB = "pos-production";
const BUSINESS_ID = "6a8eba62c817eef7e501dd99";
const CUSTOMER_ID = "6ab3e6f3d146ccf0e2a6411b";
const ENTRY_NUMBER = 334;
const AMOUNT = 39150;
const PAYMENTS = [
    { bill: 237, paymentId: "6ace1ca64b5869ab2ebc3426", amount: 14500 },
    { bill: 262, paymentId: "6ace1ca64b5869ab2ebc342a", amount: 7250 },
    { bill: 306, paymentId: "6ace1ca74b5869ab2ebc342e", amount: 17400 },
];

const APPLY = process.argv.includes("--apply");
let committed = false;

const round2 = (x) => Math.round(x * 100) / 100;
const fmt = (d) => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Karachi" }) : "—");
const check = (cond, msg) => {
    if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
    console.log(`  ✓ ${msg}`);
};

/** Every entry's balance must equal the previous balance ± its amount. */
const checkChain = async (fromEntryNumber, session = null) => {
    const q = CashBook.find({ business: BUSINESS_ID, entryNumber: { $gte: fromEntryNumber } })
        .sort({ entryNumber: 1 })
        .lean();
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
    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection.name;
    console.log(`\nMode: ${APPLY ? "APPLY (will write)" : "DRY RUN (read-only)"}\nDatabase: ${db}\n`);

    console.log("Pre-checks:");
    check(db === EXPECTED_DB, `connected to ${EXPECTED_DB}`);

    const customer = await Customer.findOne({ _id: CUSTOMER_ID, business: BUSINESS_ID }).lean();
    check(customer?.name === "Khan BBQ", `customer is ${customer?.name}`);

    const bills = {};
    for (const p of PAYMENTS) {
        const bill = await Bill.findOne({ business: BUSINESS_ID, customer: CUSTOMER_ID, billNumber: p.bill }).lean();
        check(!!bill && bill.status === "completed", `bill #${p.bill} found, completed`);
        const pay = bill.payments.find((x) => x._id.toString() === p.paymentId);
        check(pay?.amount === p.amount && pay.method === "cash" && pay.note === "FIFO collection",
            `#${p.bill} has the Rs ${p.amount} cash "FIFO collection" payment (${fmt(pay?.paidAt)})`);
        bills[p.bill] = bill;
    }

    const entry = await CashBook.findOne({ business: BUSINESS_ID, entryNumber: ENTRY_NUMBER }).lean();
    check(entry?.type === "sale_collection" && entry.direction === "in" && entry.amount === AMOUNT &&
        entry.referenceId?.toString() === CUSTOMER_ID,
        `cash book #${ENTRY_NUMBER} is Rs ${AMOUNT} IN "${entry?.description}" (${fmt(entry?.createdAt)})`);

    const business = await Business.findById(BUSINESS_ID).select("lastClosingAt").lean();
    check(!business.lastClosingAt || business.lastClosingAt < entry.createdAt,
        `no store closing covers it (last closing up to ${fmt(business.lastClosingAt)})`);

    const chainError = await checkChain(ENTRY_NUMBER - 1);
    check(!chainError, `cash book balances are consistent from #${ENTRY_NUMBER - 1} onwards${chainError ? ` — ${chainError}` : ""}`);

    const later = await CashBook.find({ business: BUSINESS_ID, entryNumber: { $gt: ENTRY_NUMBER } }).sort({ entryNumber: 1 }).lean();
    check(later.every((e) => e.createdAt >= entry.createdAt), `all ${later.length} later entries are dated after #${ENTRY_NUMBER}`);
    const latest = later[later.length - 1] || entry;

    console.log("\nPlanned changes:");
    for (const p of PAYMENTS) {
        const b = bills[p.bill];
        console.log(`  Bill #${p.bill}: remove payment ${p.amount}   due ${round2(b.amountDue)} → ${round2(b.amountDue + p.amount)}   (${b.paymentStatus} → ${b.amountPaid - p.amount <= 0 ? "unpaid" : "partial"})`);
    }
    console.log(`  Customer Khan BBQ balance: ${round2(customer.balance)} → ${round2(customer.balance + AMOUNT)}`);
    console.log(`  Cash book: delete #${ENTRY_NUMBER} (IN ${AMOUNT})`);
    console.log(`             ${later.length} later entries (#${later[0]?.entryNumber}–#${latest.entryNumber}): running balance −${AMOUNT} each`);
    console.log(`             current balance ${round2(latest.runningBalance)} → ${round2(latest.runningBalance - AMOUNT)}`);

    if (!APPLY) {
        console.log("\nDRY RUN — nothing was written. Re-run with --apply to perform the undo.\n");
        return;
    }

    const session = await mongoose.startSession();
    try {
        session.startTransaction();

        for (const p of PAYMENTS) {
            const bill = await Bill.findById(bills[p.bill]._id).session(session);
            const pay = bill.payments.id(p.paymentId);
            if (!pay || pay.amount !== p.amount) throw new Error(`#${p.bill} payment changed since the checks — aborting`);
            bill.payments.pull(p.paymentId);
            await bill.save({ session }); // recalculates the bill and the customer
        }

        const del = await CashBook.deleteOne({ _id: entry._id, amount: AMOUNT }, { session });
        if (del.deletedCount !== 1) throw new Error(`cash book #${ENTRY_NUMBER} changed since the checks — aborting`);
        await CashBook.updateMany(
            { business: BUSINESS_ID, entryNumber: { $gt: ENTRY_NUMBER } },
            { $inc: { runningBalance: -AMOUNT } },
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
    const after = await Customer.findById(CUSTOMER_ID).lean();
    check(round2(after.balance) === round2(customer.balance + AMOUNT), `customer balance is Rs ${round2(after.balance)}`);
    for (const p of PAYMENTS) {
        const b = await Bill.findById(bills[p.bill]._id).lean();
        check(!b.payments.some((x) => x._id.toString() === p.paymentId), `#${p.bill} payment removed (due ${round2(b.amountDue)}, ${b.paymentStatus})`);
    }
    check(!(await CashBook.exists({ _id: entry._id })), `cash book #${ENTRY_NUMBER} deleted`);
    const newLatest = await CashBook.findOne({ business: BUSINESS_ID }).sort({ createdAt: -1, entryNumber: -1 }).lean();
    check(round2(newLatest.runningBalance) === round2(latest.runningBalance - AMOUNT),
        `cash book balance is ${round2(newLatest.runningBalance)}`);
    console.log("\nDone.\n");
};

main()
    .catch((err) => {
        console.error(`\n${err.message}\n${committed ? "The undo WAS committed — check the verification above." : "Nothing was changed."}\n`);
        process.exitCode = 1;
    })
    .finally(() => mongoose.connection.close());
