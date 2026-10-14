import mongoose from "mongoose";
import Bill from "../models/bill.mjs";

/**
 * Customer store credit settlement.
 *
 * A customer's balance is Σ amountDue over their bills. A return after
 * payment leaves a bill with a negative due — a credit SOURCE. Settlement
 * moves that credit onto the customer's unpaid bills (oldest first):
 *   - target bill: a store_credit payment with `creditFrom` = source bill
 *   - source bill: a `creditTransfers` entry (its due rises by the same amount)
 * The customer balance never changes; only which bill the money sits on. After
 * settlement the unpaid bills add up to the balance, so Record Payment matches
 * the ledger. No cash moves.
 */

const EPSILON = 0.005;
const round2 = (x) => Math.round(x * 100) / 100;

/** Auto-settlement can be switched off with AUTO_SETTLE_CREDIT=false (cleanup window). */
export const isAutoSettleEnabled = () => process.env.AUTO_SETTLE_CREDIT !== "false";

const toId = (id) => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id));

const sumDue = async (customerId, businessId, session) => {
    const q = Bill.aggregate([
        { $match: { customer: toId(customerId), business: toId(businessId), status: { $ne: "cancelled" } } },
        { $group: { _id: null, due: { $sum: "$amountDue" } } },
    ]);
    if (session) q.session(session);
    const [row] = await q;
    return round2(row?.due || 0);
};

/**
 * Move a customer's available credit onto their unpaid bills, oldest first.
 * Must run inside the caller's transaction (`session`).
 *
 * @param {object} opts
 * @param {string|ObjectId} opts.customerId
 * @param {string|ObjectId} opts.businessId
 * @param {ClientSession}   opts.session
 * @param {{id?: string, name?: string}} [opts.actor] - who triggered it (payment receivedBy)
 * @param {string}  [opts.batch]  - tag stored on every move (cleanup undo)
 * @param {boolean} [opts.force]  - run even when AUTO_SETTLE_CREDIT=false (scripts)
 * @returns {Promise<Array<{from, fromNumber, to, toNumber, amount}>>} the moves made
 */
export const settleCustomerCredit = async ({ customerId, businessId, session, actor = {}, batch = "", force = false }) => {
    if (!customerId || (!force && !isAutoSettleEnabled())) return [];

    const bills = await Bill.find({
        customer: customerId,
        business: businessId,
        status: "completed",
        type: { $in: ["sale", "opening_balance"] },
    })
        .sort({ createdAt: 1, billNumber: 1 })
        .session(session);

    const sources = bills.filter((b) => b.type === "sale" && b.amountDue < -EPSILON);
    const targets = bills.filter((b) => b.amountDue > EPSILON);
    if (sources.length === 0 || targets.length === 0) return [];

    const balanceBefore = await sumDue(customerId, businessId, session);
    const now = new Date();
    const actorId = actor.id && mongoose.Types.ObjectId.isValid(actor.id) ? toId(actor.id) : null;
    const moves = [];
    const touched = new Set();

    let s = 0;
    let t = 0;
    let credit = round2(-sources[0].amountDue);
    let due = round2(targets[0].amountDue);

    while (s < sources.length && t < targets.length) {
        const source = sources[s];
        const target = targets[t];
        const amount = round2(Math.min(credit, due));

        if (amount > 0) {
            const paymentId = new mongoose.Types.ObjectId();
            target.payments.push({
                _id: paymentId,
                amount,
                method: "store_credit",
                paidAt: now,
                receivedBy: actorId,
                receivedByName: actor.name || "System",
                note: `Credit from Bill #${source.billNumber}`,
                creditFrom: source._id,
                creditFromBillNumber: source.billNumber,
                settlementBatch: batch,
            });
            source.creditTransfers.push({
                toBill: target._id,
                toBillNumber: target.billNumber,
                paymentId,
                amount,
                at: now,
                batch,
            });
            touched.add(source);
            touched.add(target);
            moves.push({ from: source._id, fromNumber: source.billNumber, to: target._id, toNumber: target.billNumber, amount });
        }

        credit = round2(credit - amount);
        due = round2(due - amount);
        if (credit <= EPSILON) {
            s += 1;
            if (s < sources.length) credit = round2(-sources[s].amountDue);
        }
        if (due <= EPSILON) {
            t += 1;
            if (t < targets.length) due = round2(targets[t].amountDue);
        }
    }

    for (const bill of touched) await bill.save({ session });

    const balanceAfter = await sumDue(customerId, businessId, session);
    if (Math.abs(balanceAfter - balanceBefore) > 0.01) {
        throw new Error(`Store credit settlement changed the balance (${balanceBefore} → ${balanceAfter}) — aborted`);
    }

    return moves;
};

/**
 * Undo every credit move made FROM `sourceBill` (a document the caller will
 * save): removes the credit payments from the target bills (saved here) and
 * clears the bill's creditTransfers. Used before cancelling a return.
 */
export const unwindCreditFrom = async (sourceBill, session) => {
    if (!sourceBill.creditTransfers?.length) return 0;

    let total = 0;
    const byTarget = new Map();
    for (const t of sourceBill.creditTransfers) {
        const key = t.toBill.toString();
        if (!byTarget.has(key)) byTarget.set(key, []);
        byTarget.get(key).push(t.paymentId.toString());
        total += t.amount;
    }

    for (const [targetId, paymentIds] of byTarget) {
        const target = await Bill.findById(targetId).session(session);
        if (!target) continue;
        const keep = target.payments.filter((p) => !paymentIds.includes(p._id.toString()));
        if (keep.length !== target.payments.length) {
            target.payments = keep;
            await target.save({ session });
        }
    }

    sourceBill.creditTransfers = [];
    return round2(total);
};

/**
 * Give back every credit payment `targetBill` received (a document the caller
 * will save): removes them from the bill and the matching creditTransfers
 * from the source bills (saved here). Used before cancelling a bill.
 */
export const releaseCreditOn = async (targetBill, session) => {
    const creditPayments = targetBill.payments.filter((p) => p.creditFrom);
    if (creditPayments.length === 0) return 0;

    const bySource = new Map();
    for (const p of creditPayments) {
        const key = p.creditFrom.toString();
        if (!bySource.has(key)) bySource.set(key, []);
        bySource.get(key).push(p._id.toString());
    }

    for (const [sourceId, paymentIds] of bySource) {
        const source = await Bill.findById(sourceId).session(session);
        if (!source) continue;
        const keep = source.creditTransfers.filter((t) => !paymentIds.includes(t.paymentId.toString()));
        if (keep.length !== source.creditTransfers.length) {
            source.creditTransfers = keep;
            await source.save({ session });
        }
    }

    targetBill.payments = targetBill.payments.filter((p) => !p.creditFrom);
    return round2(creditPayments.reduce((sum, p) => sum + p.amount, 0));
};

/**
 * Remove every move tagged `batch` for one customer (cleanup undo). Balance
 * is checked to be unchanged.
 */
export const undoSettlementBatch = async ({ customerId, businessId, batch, session }) => {
    if (!batch) throw new Error("batch is required");
    const balanceBefore = await sumDue(customerId, businessId, session);

    const bills = await Bill.find({
        customer: customerId,
        business: businessId,
        $or: [{ "payments.settlementBatch": batch }, { "creditTransfers.batch": batch }],
    }).session(session);

    let removed = 0;
    for (const bill of bills) {
        const payments = bill.payments.filter((p) => p.settlementBatch !== batch);
        const transfers = bill.creditTransfers.filter((t) => t.batch !== batch);
        removed += bill.payments.length - payments.length;
        bill.payments = payments;
        bill.creditTransfers = transfers;
        await bill.save({ session });
    }

    const balanceAfter = await sumDue(customerId, businessId, session);
    if (Math.abs(balanceAfter - balanceBefore) > 0.01) {
        throw new Error(`Undo changed the balance (${balanceBefore} → ${balanceAfter}) — aborted`);
    }
    return removed;
};
