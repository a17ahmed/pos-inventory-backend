/**
 * One-time correction of re-made bills (customer answers received 15 Oct 2026).
 *
 * In each case a bill was returned and re-made right after, and the new bill
 * was marked "paid in cash" although the customer paid only once. Per case,
 * in its own transaction:
 *   1. Cancel the wrong (returned) bill: remove its returns, reset returnedQty,
 *      status = cancelled. Stock is NOT touched (already correct).
 *   2. Optionally set the re-made bill's cash payment to what was really paid.
 *   3. Cash book: one correction OUT for the cash counted twice, dated now.
 * The customer's balance is recalculated by the bill hooks and must equal the
 * expected balance, otherwise the case is rolled back.
 *
 * Usage:
 *   node scripts/correct-remade-bills.mjs                 # dry run — reads only
 *   node scripts/correct-remade-bills.mjs --apply         # all cases
 *   node scripts/correct-remade-bills.mjs --apply --only "Big Bite"
 */

import "dotenv/config";
import mongoose from "mongoose";

import Bill from "../models/bill.mjs";
import Customer from "../models/customer.mjs";
import CashBook from "../models/cashbook.mjs";
import { recordCashEntry } from "../controllers/cashbook.mjs";

const EXPECTED_DB = "pos-production";
const BUSINESS_ID = "6a8eba62c817eef7e501dd99";
const ADMIN_ID = "6a8eba62c817eef7e501dd9b";

const CASES = [
    {
        name: "Big Bite",
        customerId: "6aa6da81d146ccf0e2a52046",
        balanceNow: -300,
        balanceAfter: 5200,
        cancel: { bill: 24, total: 6030, returns: ["RET-20260915-0003"] },
        payment: null, // Bill #31 keeps its 5,500 — that is the one real payment
        cashOut: 5500,
        reason: "Wrong bill (no discount). Re-made as Bill #31; customer paid Rs 5,500 once. Return RET-20260915-0003 removed.",
        cashNote: "Correction: Big Bite paid Rs 5,500 once (14 Sep); Bill #31's Rs 5,500 cash (15 Sep) was counted twice",
    },
    {
        name: "Red King Family Restaurant",
        customerId: "6aa91878d146ccf0e2a53a4e",
        balanceNow: 0,
        balanceAfter: 2780,
        cancel: { bill: 56, total: 2940, returns: ["RET-20260917-0005", "RET-20260917-0006"] },
        payment: { bill: 57, from: 2780, to: 2940 }, // customer paid 2,940 once; 160 over the discounted bill stays as credit
        cashOut: 2780,
        reason: "Wrong bill (no discount). Re-made as Bill #57; customer paid Rs 2,940 once. Returns RET-20260917-0005/0006 removed.",
        cashNote: "Correction: Red King paid Rs 2,940 once (17 Sep); Bill #57's Rs 2,780 cash was counted twice",
    },
    {
        name: "cook & Roll",
        customerId: "6ab14a51d146ccf0e2a61f07",
        balanceNow: -2300,
        balanceAfter: 50,
        cancel: { bill: 315, total: 2300, returns: ["RET-20261012-0032"] },
        payment: { bill: 316, from: 2350, to: 2300 }, // exchange: the 2,300 already paid; Rs 50 still owed
        cashOut: 2350,
        reason: "Exchange: mozzarella returned and replaced by Bill #316; customer paid Rs 2,300 once, Rs 50 still owed. Return RET-20261012-0032 removed.",
        cashNote: "Correction: cook & Roll exchange (12 Oct) — Bill #316's Rs 2,350 cash was not received (paid by the earlier Rs 2,300; Rs 50 owed)",
    },
];

const APPLY = process.argv.includes("--apply");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;

const round2 = (x) => Math.round(x * 100) / 100;
const check = (cond, msg) => {
    if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
    console.log(`    ✓ ${msg}`);
};

const loadCase = async (c) => {
    const customer = await Customer.findOne({ _id: c.customerId, business: BUSINESS_ID }).lean();
    check(customer?.name === c.name, `customer is ${customer?.name}`);
    check(round2(customer.balance) === c.balanceNow, `balance now is Rs ${c.balanceNow}`);

    const wrong = await Bill.findOne({ business: BUSINESS_ID, customer: c.customerId, billNumber: c.cancel.bill }).lean();
    check(wrong?.status === "completed" && wrong.type === "sale" && wrong.total === c.cancel.total,
        `Bill #${c.cancel.bill} is a completed sale of Rs ${c.cancel.total}`);
    check(wrong.returns.map((r) => r.returnNumber).sort().join(",") === [...c.cancel.returns].sort().join(","),
        `Bill #${c.cancel.bill} has exactly the returns ${c.cancel.returns.join(", ")}`);
    check(wrong.items.every((i) => i.returnedQty === i.qty), `every item on #${c.cancel.bill} was returned (stock already back)`);

    let paymentId = null;
    if (c.payment) {
        const remade = await Bill.findOne({ business: BUSINESS_ID, customer: c.customerId, billNumber: c.payment.bill }).lean();
        const cash = remade?.payments.filter((p) => p.method === "cash") || [];
        check(remade?.status === "completed" && remade.payments.length === 1 && cash.length === 1 && cash[0].amount === c.payment.from,
            `Bill #${c.payment.bill} has one cash payment of Rs ${c.payment.from}`);
        paymentId = cash[0]._id.toString();
    }

    const already = await CashBook.countDocuments({ business: BUSINESS_ID, note: c.cashNote });
    check(already === 0, "no earlier correction for this case");
    return { customer, wrong, paymentId };
};

const applyCase = async (c, ctx) => {
    const session = await mongoose.startSession();
    try {
        session.startTransaction();

        const wrong = await Bill.findById(ctx.wrong._id).session(session);
        if (wrong.status !== "completed" || wrong.returns.length !== c.cancel.returns.length) throw new Error("bill changed since the checks");
        wrong.returns = [];
        for (const item of wrong.items) item.returnedQty = 0;
        wrong.status = "cancelled";
        wrong.cancelReason = c.reason;
        wrong.cancelledBy = new mongoose.Types.ObjectId(ADMIN_ID);
        wrong.cancelledAt = new Date();
        await wrong.save({ session });

        if (c.payment) {
            const remade = await Bill.findOne({ business: BUSINESS_ID, billNumber: c.payment.bill }).session(session);
            const pay = remade.payments.id(ctx.paymentId);
            if (!pay || pay.amount !== c.payment.from) throw new Error(`Bill #${c.payment.bill} payment changed since the checks`);
            pay.amount = c.payment.to;
            pay.note = `${pay.note ? `${pay.note} — ` : ""}corrected from Rs ${c.payment.from} (amount really paid)`;
            await remade.save({ session });
        }

        await recordCashEntry({
            type: "manual_withdrawal",
            amount: c.cashOut,
            direction: "out",
            referenceType: "customer",
            referenceId: new mongoose.Types.ObjectId(c.customerId),
            referenceNumber: `Customer: ${c.name}`,
            description: "Correction: cash counted twice",
            note: c.cashNote,
            performedBy: "Admin",
            performedById: new mongoose.Types.ObjectId(ADMIN_ID),
            businessId: BUSINESS_ID,
            session,
        });

        const after = await Customer.findById(c.customerId).session(session).lean();
        if (round2(after.balance) !== c.balanceAfter) {
            throw new Error(`balance would be ${round2(after.balance)}, expected ${c.balanceAfter}`);
        }
        await session.commitTransaction();
    } catch (err) {
        await session.abortTransaction();
        throw err;
    } finally {
        session.endSession();
    }
};

const main = async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection.name;
    console.log(`\nMode: ${APPLY ? "APPLY (will write)" : "DRY RUN (read-only)"}   Database: ${db}`);
    if (db !== EXPECTED_DB) throw new Error(`expected ${EXPECTED_DB}`);

    const latest = await CashBook.findOne({ business: BUSINESS_ID }).sort({ createdAt: -1, entryNumber: -1 }).lean();
    let cash = round2(latest.runningBalance);
    console.log(`Cash book now: ${cash}\n`);

    let failed = 0;
    for (const c of CASES.filter((x) => !ONLY || x.name === ONLY)) {
        console.log(`${c.name}`);
        try {
            const ctx = await loadCase(c);
            console.log(`    Plan:`);
            console.log(`      Bill #${c.cancel.bill}: cancelled ("${c.reason}")`);
            if (c.payment) console.log(`      Bill #${c.payment.bill}: cash payment ${c.payment.from} → ${c.payment.to}`);
            console.log(`      Cash book: OUT ${c.cashOut} "${c.cashNote}"   ${cash} → ${round2(cash - c.cashOut)}`);
            console.log(`      Balance: ${c.balanceNow} → ${c.balanceAfter}`);
            if (APPLY) {
                await applyCase(c, ctx);
                console.log(`    ✅ applied — balance is now Rs ${c.balanceAfter}`);
            }
            cash = round2(cash - c.cashOut);
        } catch (err) {
            failed += 1;
            console.log(`    ✗ ${err.message} — nothing changed for this customer`);
        }
        console.log("");
    }
    console.log(`Cash book ${APPLY ? "now" : "after"}: ${cash}`);
    if (!APPLY) console.log("\nDRY RUN — nothing was written. Re-run with --apply.\n");
    if (failed) process.exitCode = 1;
};

main()
    .catch((err) => {
        console.error(`\n${err.message}\n`);
        process.exitCode = 1;
    })
    .finally(() => mongoose.connection.close());
