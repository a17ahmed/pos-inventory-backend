import mongoose from "mongoose";
import Supply from "../models/supply.mjs";

/**
 * Vendor credit settlement (mirror of utils/storeCredit.mjs for customers).
 *
 * A supply returned after being paid can end up overpaid: the vendor owes us.
 * Settlement moves that credit onto the same vendor's unpaid supplies (oldest
 * bill first):
 *   - target supply: a "vendor_credit" payment with creditFrom = source supply
 *   - source supply: a creditTransfers entry (its balance rises by the same amount)
 * What we owe the vendor overall never changes; only which supply it sits on.
 * No cash moves.
 */

const EPSILON = 0.005;
const round2 = (x) => Math.round((x || 0) * 100) / 100;
const toId = (id) => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id));

/**
 * Signed balance of a supply: positive = we owe the vendor, negative = the
 * vendor owes us. Computed from the supply's own fields so supplies saved
 * before `balance` existed are handled too.
 */
export const supplyBalance = (s) =>
    round2((s.totalAmount || 0) - (s.totalReturned || 0) - (s.paidAmount || 0) + (s.creditUsed || 0));

/** Same as supplyBalance, as an aggregation expression. */
export const SUPPLY_BALANCE_EXPR = {
    $subtract: [
        { $add: [{ $ifNull: ["$totalAmount", 0] }, { $ifNull: ["$creditUsed", 0] }] },
        { $add: [{ $ifNull: ["$totalReturned", 0] }, { $ifNull: ["$paidAmount", 0] }] },
    ],
};

/** Real money paid on a supply (vendor credit moved in from other supplies excluded). */
export const SUPPLY_REAL_PAID_EXPR = {
    $subtract: [{ $ifNull: ["$paidAmount", 0] }, { $ifNull: ["$creditApplied", 0] }],
};

/**
 * $group accumulators for vendor totals. Spread into a $group stage.
 *   totalRemaining — what we still owe on unpaid supplies
 *   totalCredit    — what the vendor owes us (returns on paid supplies)
 *   netBalance     — totalRemaining − totalCredit
 */
export const VENDOR_TOTALS_GROUP = {
    totalBusiness: { $sum: "$totalAmount" },
    totalPaid: { $sum: SUPPLY_REAL_PAID_EXPR },
    totalReturned: { $sum: { $ifNull: ["$totalReturned", 0] } },
    totalRemaining: { $sum: { $max: [0, SUPPLY_BALANCE_EXPR] } },
    totalCredit: { $sum: { $max: [0, { $multiply: [-1, SUPPLY_BALANCE_EXPR] }] } },
    netBalance: { $sum: SUPPLY_BALANCE_EXPR },
    supplyCount: { $sum: 1 },
};

/** Round a vendor totals row from VENDOR_TOTALS_GROUP (missing row → zeros). */
export const vendorTotals = (row = {}) => ({
    totalBusiness: round2(row.totalBusiness),
    totalPaid: round2(row.totalPaid),
    totalReturned: round2(row.totalReturned),
    totalRemaining: round2(row.totalRemaining),
    totalCredit: round2(row.totalCredit),
    netBalance: round2(row.netBalance),
    supplyCount: row.supplyCount || 0,
});

/** Net we owe a vendor (Σ signed balances; negative = vendor credit). */
const vendorNet = async (vendorId, businessId, session) => {
    const q = Supply.aggregate([
        { $match: { vendor: toId(vendorId), business: toId(businessId) } },
        { $group: { _id: null, net: { $sum: SUPPLY_BALANCE_EXPR } } },
    ]);
    if (session) q.session(session);
    const [row] = await q;
    return round2(row?.net || 0);
};

/**
 * Move a vendor's credit onto their unpaid supplies, oldest bill first.
 * Must run inside the caller's transaction (`session`).
 *
 * @returns {Promise<Array<{from, fromNumber, to, toNumber, amount}>>} the moves made
 */
export const settleVendorCredit = async ({ vendorId, businessId, session, actor = {}, batch = "" }) => {
    if (!vendorId) return [];

    const supplies = await Supply.find({ vendor: vendorId, business: businessId })
        .sort({ billDate: 1, createdAt: 1, supplyNumber: 1 })
        .session(session);

    const sources = supplies.filter((s) => supplyBalance(s) < -EPSILON);
    const targets = supplies.filter((s) => supplyBalance(s) > EPSILON);
    if (sources.length === 0 || targets.length === 0) return [];

    const netBefore = await vendorNet(vendorId, businessId, session);
    const now = new Date();
    const moves = [];
    const touched = new Set();

    let si = 0;
    let ti = 0;
    let credit = round2(-supplyBalance(sources[0]));
    let due = round2(supplyBalance(targets[0]));

    while (si < sources.length && ti < targets.length) {
        const source = sources[si];
        const target = targets[ti];
        const amount = round2(Math.min(credit, due));

        if (amount > 0) {
            const paymentId = new mongoose.Types.ObjectId();
            target.payments.push({
                _id: paymentId,
                amount,
                method: "vendor_credit",
                paidAt: now,
                paidBy: actor.name || "System",
                note: `Credit from Supply #${source.supplyNumber}`,
                creditFrom: source._id,
                creditFromSupplyNumber: source.supplyNumber,
                settlementBatch: batch,
            });
            source.creditTransfers.push({
                toSupply: target._id,
                toSupplyNumber: target.supplyNumber,
                paymentId,
                amount,
                at: now,
                batch,
            });
            touched.add(source);
            touched.add(target);
            moves.push({ from: source._id, fromNumber: source.supplyNumber, to: target._id, toNumber: target.supplyNumber, amount });
        }

        credit = round2(credit - amount);
        due = round2(due - amount);
        if (credit <= EPSILON) {
            si += 1;
            if (si < sources.length) credit = round2(-supplyBalance(sources[si]));
        }
        if (due <= EPSILON) {
            ti += 1;
            if (ti < targets.length) due = round2(supplyBalance(targets[ti]));
        }
    }

    for (const s of touched) await s.save({ session });

    const netAfter = await vendorNet(vendorId, businessId, session);
    if (Math.abs(netAfter - netBefore) > 0.01) {
        throw new Error(`Vendor credit settlement changed the balance (${netBefore} → ${netAfter}) — aborted`);
    }
    return moves;
};
