/**
 * DEV ONLY — seed QA customers covering every ledger situation, for testing
 * the customer statement (ledger) screen.
 *
 * Every step goes through the real controllers (createBill, Record Payment,
 * add payment, return, cancel), so the data is exactly what the app makes.
 * After each step, the dates that step created are moved to the scenario's
 * day (bills, payments, returns, credit moves, cancels). Cash book entries
 * keep the time the seed ran.
 *
 * Usage (refuses on pos-production):
 *   node scripts/seed-ledger-qa.mjs --business <id> --admin <adminId>
 *   writes docs/ledger-qa-dataset.md with the expected values
 */

import "dotenv/config";
import fs from "fs";
import mongoose from "mongoose";

process.env.TZ = process.env.TZ || "Asia/Karachi";

import Bill from "../models/bill.mjs";
import Customer from "../models/customer.mjs";
import Business from "../models/business.mjs";
import { createBill, addPayment, processReturn, cancelSaleBill } from "../controllers/bill.mjs";
import { createOrGetCustomer, collectFromCustomer } from "../controllers/customer.mjs";
import { getCustomerStatement, getPendingBills } from "../controllers/customerStatement.mjs";

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const BUSINESS_ID = arg("business");
const ADMIN_ID = arg("admin");
const OUT = arg("out") || "docs/ledger-qa-dataset.md";

const DAY = 86400000;
const at = (daysAgo, hour = 11, minute = 0) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hour, minute, 0, 0);
    return d;
};
const lastMonth = (day, hour = 11) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() - 1, day, hour, 0, 0, 0);
};
const fmtDate = (d) => new Date(d).toLocaleDateString("en-GB", { timeZone: process.env.TZ });
const fmtDT = (d) => new Date(d).toLocaleString("en-GB", { timeZone: process.env.TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const rs = (n) => (n < 0 ? `Cr ${Math.abs(n).toLocaleString("en-US")}` : n.toLocaleString("en-US"));

const user = () => ({ adminId: ADMIN_ID, id: ADMIN_ID, businessId: BUSINESS_ID, name: "Admin" });
const call = (fn, { params = {}, body = {}, query = {} } = {}) =>
    new Promise((resolve, reject) => {
        let statusCode = 200;
        const res = { status(c) { statusCode = c; return this; }, json(b) { resolve({ statusCode, body: b }); return this; } };
        Promise.resolve(fn({ params, body, query, user: user() }, res)).catch(reject);
    });
const ok = (r, what) => {
    if (r.statusCode >= 300) throw new Error(`${what} failed (${r.statusCode}): ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
};

/** Move every date this step created (>= stepStart) on the customer's bills to `target`. */
const placeStep = async (customerId, stepStart, target) => {
    if (!target) return; // "now"
    const shift = (d) => (d && new Date(d) >= stepStart ? new Date(target.getTime() + (new Date(d) - stepStart)) : d);
    const bills = await Bill.find({ customer: customerId, business: BUSINESS_ID }).lean();
    for (const b of bills) {
        const createdAt = shift(b.createdAt);
        const set = {
            createdAt,
            cancelledAt: shift(b.cancelledAt),
            payments: (b.payments || []).map((p) => ({ ...p, paidAt: shift(p.paidAt) })),
            returns: (b.returns || []).map((r) => ({ ...r, returnedAt: shift(r.returnedAt) })),
            creditTransfers: (b.creditTransfers || []).map((t) => ({ ...t, at: shift(t.at) })),
        };
        if (createdAt !== b.createdAt) {
            const d = new Date(createdAt);
            set.date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            set.time = d.toLocaleTimeString("en-GB", { hour12: false });
        }
        await Bill.collection.updateOne({ _id: b._id }, { $set: set });
    }
};

// ── Scenario steps (each runs "now", then is placed on its day) ─────────────
const S = (customerRef) => ({
    async bill(items, { paid = 0, method = "cash", when } = {}) {
        const t = new Date();
        const b = ok(await call(createBill, {
            body: {
                customer: customerRef.id,
                items: items.map(([name, price, qty = 1]) => ({ name, price, qty })),
                payments: paid ? [{ amount: paid, method }] : [],
            },
        }), "create bill");
        await placeStep(customerRef.id, t, when);
        return b;
    },
    async pay(billId, amount, { method = "cash", when } = {}) {
        const t = new Date();
        ok(await call(addPayment, { params: { id: String(billId) }, body: { amount, method } }), "add payment");
        await placeStep(customerRef.id, t, when);
    },
    async collect(amount, { method = "cash", when } = {}) {
        const t = new Date();
        ok(await call(collectFromCustomer, { params: { id: customerRef.id }, body: { amount, method } }), "record payment");
        await placeStep(customerRef.id, t, when);
    },
    async returnItems(bill, picks, { when } = {}) {
        const t = new Date();
        const body = picks === "full"
            ? { fullReturn: true, reason: "changed_mind" }
            : { items: picks.map(([idx, quantity]) => ({ itemId: String(bill.items[idx]._id), quantity, reason: "changed_mind" })) };
        ok(await call(processReturn, { params: { id: String(bill._id) }, body }), "return");
        await placeStep(customerRef.id, t, when);
    },
    async cancel(billId, reason, { when } = {}) {
        const t = new Date();
        ok(await call(cancelSaleBill, { params: { id: String(billId) }, body: { reason } }), "cancel bill");
        await placeStep(customerRef.id, t, when);
    },
});

const SCENARIOS = [
    {
        name: "QA 01 Fully Paid", phone: "03000000101",
        story: "Two bills, both paid in cash at the counter.",
        expect: { amountDue: 0, todayOpening: 0, todayClosing: 0, pending: [] },
        run: async (s) => {
            await s.bill([["Rice 5kg", 2500]], { paid: 2500, when: at(20) });
            await s.bill([["Oil 1L", 1200]], { paid: 1200 });
        },
    },
    {
        name: "QA 02 Unpaid Bills", phone: "03000000102",
        story: "Two bills on account, nothing paid yet.",
        expect: { amountDue: 7000, todayOpening: 5000, todayClosing: 7000, pending: [5000, 2000] },
        run: async (s) => {
            await s.bill([["Flour 10kg", 5000]], { when: at(15) });
            await s.bill([["Sugar 2kg", 2000]]);
        },
    },
    {
        name: "QA 03 Partial + Later Payments", phone: "03000000103",
        story: "One 10,000 bill: 3,000 paid at sale, 1,000 by Record Payment 5 days ago, 2,000 added on the bill today.",
        expect: { amountDue: 4000, todayOpening: 6000, todayClosing: 4000, pending: [4000] },
        run: async (s) => {
            const b = await s.bill([["Cheese 5kg", 10000]], { paid: 3000, when: at(12) });
            await s.collect(1000, { when: at(5) });
            await s.pay(b._id, 2000);
        },
    },
    {
        name: "QA 04 FIFO Collection", phone: "03000000104",
        story: "Three unpaid bills (3,000 / 4,000 / 5,000). Today Record Payment 5,000 pays the oldest first: first bill fully, second 2,000.",
        expect: { amountDue: 7000, todayOpening: 12000, todayClosing: 7000, pending: [2000, 5000] },
        run: async (s) => {
            await s.bill([["Boxes A", 3000]], { when: at(30) });
            await s.bill([["Boxes B", 4000]], { when: at(20) });
            await s.bill([["Boxes C", 5000]], { when: at(10) });
            await s.collect(5000);
        },
    },
    {
        name: "QA 05 Return on Unpaid Bill", phone: "03000000105",
        story: "6,000 unpaid bill; 3 days ago items worth 2,000 returned → simply reduces what is owed (no credit).",
        expect: { amountDue: 4000, todayOpening: 4000, todayClosing: 4000, pending: [4000] },
        run: async (s) => {
            const b = await s.bill([["Sauce carton", 4000], ["Ketchup carton", 2000]], { when: at(8) });
            await s.returnItems(b, [[1, 1]], { when: at(3) });
        },
    },
    {
        name: "QA 06 Return Credit Pays Other Bill", phone: "03000000106",
        story: "Bill A 3,000 paid; Bill B 5,000 unpaid. Yesterday 2,000 returned from paid Bill A → 2,000 credit automatically pays Bill B.",
        expect: { amountDue: 3000, todayOpening: 3000, todayClosing: 3000, pending: [3000] },
        run: async (s) => {
            const a = await s.bill([["Patties 16pc", 2000], ["Patties 12pc", 1000]], { paid: 3000, when: at(9) });
            await s.bill([["Fries 2.5kg", 5000]], { when: at(6) });
            await s.returnItems(a, [[0, 1]], { when: at(1, 16) });
        },
    },
    {
        name: "QA 07 Advance Credit", phone: "03000000107",
        story: "2,500 bill paid in cash, fully returned today, no other bills → shop owes the customer 2,500 (credit).",
        expect: { amountDue: -2500, todayOpening: 0, todayClosing: -2500, pending: [] },
        run: async (s) => {
            const b = await s.bill([["Mayo 4kg", 2500]], { paid: 2500, when: at(4) });
            await s.returnItems(b, "full");
        },
    },
    {
        name: "QA 08 Credit Used On New Bill", phone: "03000000108",
        story: "1,000 bill paid, fully returned 3 days ago (1,000 credit). Today a new 3,000 bill on account → credit used automatically, 2,000 left.",
        expect: { amountDue: 2000, todayOpening: -1000, todayClosing: 2000, pending: [2000] },
        run: async (s) => {
            const b = await s.bill([["Napkins", 1000]], { paid: 1000, when: at(6) });
            await s.returnItems(b, "full", { when: at(3) });
            await s.bill([["Cups", 3000]]);
        },
    },
    {
        name: "QA 09 Cancelled Bill", phone: "03000000109",
        story: "A 4,000 cash bill made by mistake and cancelled; a real 1,000 unpaid bill.",
        expect: { amountDue: 1000, todayOpening: 1000, todayClosing: 1000, pending: [1000], cancelledAll: 1 },
        run: async (s) => {
            const b = await s.bill([["Wrong item", 4000]], { paid: 4000 });
            await s.cancel(b._id, "Created by mistake (QA)");
            await s.bill([["Spoons", 1000]], { when: at(2) });
        },
        afterRun: async (ref) => {
            // place the cancelled bill (and its cancel) 7 days ago
            const b = await Bill.findOne({ customer: ref.id, status: "cancelled" }).lean();
            const shiftMs = at(7).getTime() - new Date(b.createdAt).getTime();
            await Bill.collection.updateOne({ _id: b._id }, {
                $set: {
                    createdAt: new Date(new Date(b.createdAt).getTime() + shiftMs),
                    cancelledAt: new Date(new Date(b.cancelledAt).getTime() + shiftMs),
                    payments: b.payments.map((p) => ({ ...p, paidAt: new Date(new Date(p.paidAt).getTime() + shiftMs) })),
                },
            });
        },
    },
    {
        name: "QA 10 Full Return Unpaid", phone: "03000000110",
        story: "3,000 unpaid bill fully returned 2 days ago → nothing owed.",
        expect: { amountDue: 0, todayOpening: 0, todayClosing: 0, pending: [] },
        run: async (s) => {
            const b = await s.bill([["Item X", 1500], ["Item Y", 1500]], { when: at(5) });
            await s.returnItems(b, "full", { when: at(2) });
        },
    },
    {
        name: "QA 11 Opening Balance", phone: "03000000111", openingBalance: 8000,
        story: "Customer added with an 8,000 opening balance (40 days ago), a 2,000 bill last month, and 3,000 paid today (goes to the oldest = opening balance).",
        expect: { amountDue: 7000, todayOpening: 10000, todayClosing: 7000, pending: [5000, 2000] },
        run: async (s) => {
            await s.bill([["Gloves", 2000]], { when: lastMonth(15) });
            await s.collect(3000);
        },
    },
    {
        name: "QA 12 Last Month Only", phone: "03000000112",
        story: "All activity last month: 1,500 bill paid, 2,500 bill unpaid, 1,000 paid on 25th. Nothing this month.",
        expect: { amountDue: 1500, todayOpening: 1500, todayClosing: 1500, pending: [1500] },
        run: async (s) => {
            await s.bill([["Foil", 1500]], { paid: 1500, when: lastMonth(10) });
            await s.bill([["Wrap", 2500]], { when: lastMonth(20) });
            await s.collect(1000, { when: lastMonth(25) });
        },
    },
    {
        name: "QA 13 Card & Online", phone: "03000000113",
        story: "4,000 bill paid by card; 3,000 bill unpaid, paid today by online transfer.",
        expect: { amountDue: 0, todayOpening: 3000, todayClosing: 0, pending: [] },
        run: async (s) => {
            await s.bill([["Chicken 5kg", 4000]], { paid: 4000, method: "card", when: at(3) });
            await s.bill([["Nuggets", 3000]], { when: at(1) });
            await s.collect(3000, { method: "online" });
        },
    },
    {
        name: "QA 14 Big Ledger Paging", phone: "03000000114",
        story: "70 bills of 1,000, one per day for 70 days (oldest 69 days ago, newest today); every other one paid at sale → 105 lines (3 pages of 50).",
        expect: { amountDue: 35000, todayOpening: 34000, todayClosing: 35000, pendingCount: 35, lines: 105 },
        run: async (s) => {
            for (let i = 69; i >= 0; i--) {
                const paid = i % 2 === 1 ? 1000 : 0;
                await s.bill([[`Daily supply ${70 - i}`, 1000]], { paid, when: i === 0 ? null : at(i) });
            }
        },
    },
    {
        name: "QA 15 Two Returns Partly Paid", phone: "03000000115",
        story: "5 cartons × 1,000 = 5,000, 2,000 paid. 6 days ago 1 carton returned (reduces due). 2 days ago 3 cartons returned: 2,000 clears the rest, 1,000 becomes credit.",
        expect: { amountDue: -1000, todayOpening: -1000, todayClosing: -1000, pending: [] },
        run: async (s) => {
            const b = await s.bill([["Carton", 1000, 5]], { paid: 2000, when: at(10) });
            await s.returnItems(b, [[0, 1]], { when: at(6) });
            await s.returnItems(b, [[0, 3]], { when: at(2) });
        },
    },
];

const main = async () => {
    if (!BUSINESS_ID || !ADMIN_ID) throw new Error("Usage: --business <id> --admin <adminId>");
    await mongoose.connect(process.env.MONGODB_URI);
    if (mongoose.connection.name === "pos-production") throw new Error("Refusing to seed QA data on pos-production");
    const business = await Business.findById(BUSINESS_ID).select("name").lean();
    if (!business) throw new Error("business not found");
    if (await Customer.exists({ business: BUSINESS_ID, name: /^QA \d\d / })) throw new Error("QA customers already exist — remove them first");
    console.log(`Seeding ${SCENARIOS.length} QA customers into "${business.name}" on ${mongoose.connection.name}\n`);

    const report = [];
    for (const sc of SCENARIOS) {
        const t = new Date();
        const c = ok(await call(createOrGetCustomer, { body: { name: sc.name, phone: sc.phone, ...(sc.openingBalance ? { openingBalance: sc.openingBalance } : {}) } }), "create customer");
        const ref = { id: String(c._id) };
        if (sc.openingBalance) await placeStep(ref.id, t, at(40));
        const steps = S(ref);
        steps.ref = ref;
        await sc.run(steps);
        if (sc.afterRun) await sc.afterRun(ref);

        // lastPurchase follows the moved dates
        const last = await Bill.findOne({ customer: ref.id, status: { $ne: "cancelled" } }).sort({ createdAt: -1 }).lean();
        await Customer.updateOne({ _id: ref.id }, { $set: { lastPurchase: last?.createdAt || null } });

        const q = (query) => call(getCustomerStatement, { params: { id: ref.id }, query });
        const [today, all, cancelled, pend] = await Promise.all([
            q({}), q({ period: "all", limit: 200 }), q({ period: "all", type: "cancelled" }),
            call(getPendingBills, { params: { id: ref.id } }),
        ]);
        const stored = await Customer.findById(ref.id).lean();

        // verify the hand-computed expectations
        const e = sc.expect;
        const errs = [];
        const eq = (label, got, want) => { if (Math.abs(got - want) > 0.01) errs.push(`${label}: got ${got}, expected ${want}`); };
        eq("amountDue", all.body.summary.amountDue, e.amountDue);
        eq("stored balance", stored.balance, e.amountDue);
        eq("today opening", today.body.period.openingBalance, e.todayOpening);
        eq("today closing", today.body.period.closingBalance, e.todayClosing);
        eq("all-time closing", all.body.period.closingBalance, e.amountDue);
        eq("pending amountDue", pend.body.amountDue, e.amountDue);
        if (e.pending) {
            const got = pend.body.bills.map((b) => b.due).join(",");
            if (got !== e.pending.join(",")) errs.push(`pending bills: got [${got}], expected [${e.pending.join(",")}]`);
        }
        if (e.pendingCount !== undefined && pend.body.bills.length !== e.pendingCount) errs.push(`pending count ${pend.body.bills.length}`);
        if (e.lines !== undefined && all.body.pagination.total !== e.lines) errs.push(`lines ${all.body.pagination.total}`);
        if (e.cancelledAll !== undefined && all.body.period.cancelledCount !== e.cancelledAll) errs.push(`cancelledCount ${all.body.period.cancelledCount}`);

        console.log(`${errs.length ? "✗" : "✓"} ${sc.name.padEnd(36)} due ${rs(e.amountDue).padStart(9)}${errs.length ? "  ← " + errs.join(" | ") : ""}`);
        report.push({ sc, today: today.body, all: all.body, cancelled: cancelled.body, pend: pend.body, errs });
    }

    // ── Markdown guide for the frontend ───────────────────────────────────
    const md = [];
    md.push(`# Ledger QA dataset — ${business.name} (dev)`, "");
    md.push(`Seeded ${fmtDT(new Date())} (Pakistan time). Log in as the business admin and open **Customers → search "QA"**.`, "");
    md.push("Every value below was checked against the backend when the data was created. Cash book entries for these payments keep the time the seed ran (only bill / payment / return dates were moved to the scenario days).", "");
    md.push("Default view of the ledger = **Today, oldest first**. Cards (Total Billed / Total Paid / Returns / Total Bills / Amount Due) must show the **All-time** numbers below whatever filter is selected.", "");
    md.push("## Overview", "", "| # | Customer | Phone | What it tests | Amount Due |", "|---|---|---|---|---|");
    for (const r of report) md.push(`| ${r.sc.name.slice(3, 5)} | ${r.sc.name} | ${r.sc.phone} | ${r.sc.story} | **${rs(r.all.summary.amountDue)}** |`);
    md.push("");
    for (const r of report) {
        const s = r.all.summary;
        md.push(`## ${r.sc.name}  (${r.sc.phone})`, "", r.sc.story, "");
        md.push("**Cards (all-time, never change with filters)**", "", "| Total Billed | Total Paid | Returns | Total Bills | Amount Due | Available credit |", "|---|---|---|---|---|---|");
        md.push(`| ${rs(s.totalBilled)} | ${rs(s.totalPaid)} | ${rs(s.totalReturns)} | ${s.totalBills} | **${rs(s.amountDue)}** | ${rs(s.availableCredit)} |`, "");
        const tp = r.today.period, ap = r.all.period;
        md.push("**Period bar**", "", "| Period | Opening | Bills | Paid | Returns | Closing | Lines | Cancelled hidden |", "|---|---|---|---|---|---|---|---|");
        md.push(`| Today (default) | ${rs(tp.openingBalance)} | ${rs(tp.bills)} | ${rs(tp.payments)} | ${rs(tp.returns)} | **${rs(tp.closingBalance)}** | ${tp.entryCount} | ${tp.cancelledCount} |`);
        md.push(`| All time | ${rs(ap.openingBalance)} | ${rs(ap.bills)} | ${rs(ap.payments)} | ${rs(ap.returns)} | **${rs(ap.closingBalance)}** | ${ap.entryCount} | ${ap.cancelledCount} |`, "");
        md.push("**Amount Due panel (pending bills, oldest first)**", "");
        if (r.pend.bills.length === 0) md.push(`No pending bills.${r.pend.availableCredit ? ` Available credit: **${rs(r.pend.availableCredit)}**.` : ""}`, "");
        else {
            md.push("| Bill | Date | Total | Paid | Returned | Still due | Age (days) |", "|---|---|---|---|---|---|---|");
            const list = r.pend.bills.length > 8 ? [...r.pend.bills.slice(0, 4), null, ...r.pend.bills.slice(-2)] : r.pend.bills;
            for (const b of list) md.push(b ? `| #${b.billNumber} | ${fmtDate(b.date)} | ${rs(b.total)} | ${rs(b.paid)} | ${rs(b.returned)} | **${rs(b.due)}** | ${b.ageDays} |` : `| … | | | | | | |`);
            md.push(`| **Total** | | | | | **${rs(r.pend.totalDue)}**${r.pend.availableCredit ? ` (− credit ${rs(r.pend.availableCredit)})` : ""} = **${rs(r.pend.amountDue)}** | |`, "");
        }
        md.push(`**All-time ledger lines (oldest first)${r.all.entries.length > 12 ? ` — first 6 and last 6 of ${r.all.pagination.total}` : ""}**`, "", "| Date | Bill | Type | Description | Method | Debit | Credit | Balance | Notes |", "|---|---|---|---|---|---|---|---|---|");
        const lines = r.all.entries.length > 12 ? [...r.all.entries.slice(0, 6), null, ...r.all.entries.slice(-6)] : r.all.entries;
        for (const e of lines) {
            if (!e) { md.push("| … | | | | | | | | |"); continue; }
            const label = { bill: "SALE", payment: "PAID", return: "RETURN", credit_transfer: "CREDIT MOVED", opening_balance: "OPENING", cancelled: "CANCELLED" }[e.type];
            const method = e.method ? (e.method === "store_credit" ? "STORE CREDIT" : e.method.toUpperCase()) : "";
            const note = e.type === "return" ? (e.debtWriteOff ? `unpaid amount reduced ${rs(e.debtWriteOff)}` : "") + (e.storeCredit ? `${e.debtWriteOff ? " · " : ""}credit ${rs(e.storeCredit)}` : "") : "";
            md.push(`| ${fmtDT(e.date)} | #${e.billNumber} | ${label} | ${e.description} | ${method} | ${e.debit ? rs(e.debit) : "—"} | ${e.credit ? rs(e.credit) : "—"} | ${rs(e.balance)} | ${note} |`);
        }
        if (r.cancelled.entries.length) {
            md.push("", "**Cancelled filter**", "");
            for (const e of r.cancelled.entries) md.push(`- #${e.billNumber} ${fmtDT(e.date)} · ${rs(e.billTotal)} · reason: "${e.cancelReason}" · counts as 0`);
        }
        md.push("");
    }
    md.push("## Checks to run on every customer", "",
        "1. Cards stay identical when switching Today / Yesterday / This week / This month / Last month / All time / Custom, type filters, sort and pages.",
        "2. Period bar: Opening + Bills − Paid − Returns = Closing. For Today and All time, Closing = Amount Due.",
        "3. Amount Due card = total of the pending-bills panel (minus available credit) = Record Payment total.",
        "4. Sort Newest first: same lines reversed, every line keeps the same Balance.",
        "5. Type = Payments shows PAID and CREDIT MOVED lines only; opening/closing unchanged.",
        "6. Negative balances show as \"Cr …\" (QA 07, QA 15).",
        "7. QA 14: 105 lines → 3 pages of 50; balances continue across pages; Last line balance = 35,000.",
        "8. QA 12: Last month filter shows its 4 lines (opening 0 → closing 1,500); This month is empty with opening = closing = 1,500.",
        "9. QA 09: Cancelled bill hidden by default (\"1 cancelled bill hidden\"), shown greyed with Cancelled filter, counts as 0.",
        "10. QA 03 / QA 04: payments made today on old bills appear under Today.",
        "11. Print / PDF of a period: opening, all lines, closing, all-time Amount Due; no cancelled bills.", "");

    fs.mkdirSync(OUT.split("/").slice(0, -1).join("/") || ".", { recursive: true });
    fs.writeFileSync(OUT, md.join("\n"));
    const failed = report.filter((r) => r.errs.length).length;
    console.log(`\n${failed ? `${failed} scenario(s) did not match` : "All scenarios match the expected values"}. Guide written to ${OUT}`);
    if (failed) process.exitCode = 1;
};

main()
    .catch((err) => { console.error(`\n${err.message}\n`); process.exitCode = 1; })
    .finally(() => mongoose.connection.close());
