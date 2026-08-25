import mongoose from "mongoose";
import Bill from "../models/bill.mjs";
import Expense from "../models/expense.mjs";
import Business from "../models/business.mjs";
import Customer from "../models/customer.mjs";
import Closing from "../models/closing.mjs";
import Counter from "../models/counter.mjs";
import CashBook from "../models/cashbook.mjs";
import { startOfDay, endOfDay, startOfToday } from "../utils/dateHelpers.mjs";

const TOLERANCE = 1.0; // ₹1.00, for rounding

const sumBy = (arr, fn) => arr.reduce((sum, item) => sum + (fn(item) || 0), 0);

const inRange = (date, start, end) => {
    const t = new Date(date).getTime();
    return t >= start.getTime() && t <= end.getTime();
};

// A payment's `paidAt` default (Date.now() at sub-document construction, before
// the request finishes stock/discount work) is always a few ms-to-seconds
// *before* the parent bill's own `createdAt` (a Mongoose timestamp stamped at
// .save()). A payment can never truly precede the sale it belongs to, so for
// period-bucketing we clamp it forward to the bill's createdAt — otherwise a
// period boundary that lands exactly on a bill's createdAt (e.g. the default
// start of a business's first-ever closing) spuriously excludes that bill's
// own at-sale payment and inflates creditExtended by the payment amount.
const effectivePaidAt = (paidAt, billCreatedAt) => {
    const t = new Date(paidAt).getTime();
    const billT = new Date(billCreatedAt).getTime();
    return t < billT ? billCreatedAt : paidAt;
};

// ═══════════════════════════════════════════════════════════════════════════
// SHARED COMPUTE HELPER — both preview and finalize call this, so preview
// and finalize are guaranteed identical. Never recompute on read afterwards.
// ═══════════════════════════════════════════════════════════════════════════

export const computeClosing = async (businessId, periodStart, periodEnd, session = null) => {
    const bizId = new mongoose.Types.ObjectId(businessId);
    const commonMatch = { business: bizId, type: "sale", status: "completed" };

    // ── Sale bills created within the period ──────────────────────────────
    const periodBills = await Bill.find({
        ...commonMatch,
        createdAt: { $gte: periodStart, $lte: periodEnd },
    }).session(session).lean();

    const grossSales = sumBy(periodBills, (b) => b.total + b.totalDiscount);
    const totalDiscounts = sumBy(periodBills, (b) => b.totalDiscount);
    const totalOrders = periodBills.length;
    const totalItemsSold = sumBy(periodBills, (b) => b.totalQty);
    const salesTotal = sumBy(periodBills, (b) => b.total);

    // COGS of kept goods (costPrice × (qty - returnedQty)), sale bills created in period
    const cogs = sumBy(periodBills, (b) =>
        sumBy(b.items, (i) => i.costPrice * (i.qty - (i.returnedQty || 0)))
    );

    // ── Returns processed in the period, regardless of the original sale's
    // period (recognized by returnedAt, not the sale's createdAt) ─────────
    const billsWithReturns = await Bill.find({
        ...commonMatch,
        "returns.0": { $exists: true },
    }).select("returns").session(session).lean();

    const inRangeReturns = [];
    for (const b of billsWithReturns) {
        for (const r of b.returns) {
            if (inRange(r.returnedAt, periodStart, periodEnd)) inRangeReturns.push(r);
        }
    }

    const totalReturns = sumBy(inRangeReturns, (r) => r.refundAmount);
    const refundsByMethod = { cash: 0, card: 0, store_credit: 0, ledger_adjust: 0 };
    for (const r of inRangeReturns) {
        refundsByMethod[r.refundMethod] = (refundsByMethod[r.refundMethod] || 0) + r.refundAmount;
    }

    // ── Net sales / profit ─────────────────────────────────────────────────
    const netSales = salesTotal - totalReturns;
    const grossProfit = netSales - cogs;

    const expenseAgg = await Expense.aggregate([
        { $match: { business: bizId, status: "approved", date: { $gte: periodStart, $lte: periodEnd } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
    ]).session(session);
    const totalExpenses = expenseAgg[0]?.total || 0;
    const netProfit = grossProfit - totalExpenses;
    const costPlusProfit = cogs + grossProfit;

    // ── Settlement split (reconstructed from payments[].paidAt ∈ range, on
    // period sale bills) + per-bill line detail for the snapshot ──────────
    let cashSales = 0, cardSales = 0, upiSales = 0, storeCreditUsed = 0, creditExtended = 0;
    const bills = [];
    const creditByCustomer = new Map(); // customerId string -> { customerId, customerName, amount, billCount }

    for (const b of periodBills) {
        const inPeriodPayments = (b.payments || []).filter((p) =>
            inRange(effectivePaidAt(p.paidAt, b.createdAt), periodStart, periodEnd)
        );
        const inPeriodPaidTotal = sumBy(inPeriodPayments, (p) => p.amount);
        const inPeriodLedgerRefund = sumBy(
            (b.returns || []).filter((r) => r.refundMethod === "ledger_adjust" && inRange(r.returnedAt, periodStart, periodEnd)),
            (r) => r.refundAmount
        );

        const methodTotals = {};
        for (const p of inPeriodPayments) {
            if (p.method === "cash") cashSales += p.amount;
            else if (p.method === "card") cardSales += p.amount;
            else if (p.method === "online") upiSales += p.amount;
            else if (p.method === "store_credit") storeCreditUsed += p.amount;
            methodTotals[p.method] = (methodTotals[p.method] || 0) + p.amount;
        }

        // Credit is only a trackable receivable when tied to a customer
        // ledger. An unpaid walk-in balance (customer: null) has no ledger to
        // collect against, so it's excluded here — it surfaces instead as an
        // unreconciled gap in settlementTotal, which is the correct signal
        // (an untracked loss, not a guaranteed future collection).
        if (b.customer) {
            const contribution = b.total - inPeriodPaidTotal - inPeriodLedgerRefund;
            creditExtended += contribution;

            // Half-a-cent epsilon so floating-point noise doesn't leave
            // phantom zero-amount entries in the per-customer breakdown.
            if (Math.abs(contribution) > 0.005) {
                const key = b.customer.toString();
                const existing = creditByCustomer.get(key);
                if (existing) {
                    existing.amount += contribution;
                    existing.billCount += 1;
                } else {
                    creditByCustomer.set(key, {
                        customerId: b.customer,
                        customerName: b.customerName,
                        customerPhone: "",
                        amount: contribution,
                        billCount: 1,
                    });
                }
            }
        }

        const methodsUsed = Object.keys(methodTotals);
        const paymentMethod = methodsUsed.length === 0 ? "credit" : methodsUsed.length === 1 ? methodsUsed[0] : "mixed";

        bills.push({
            billNumber: b.billNumber,
            date: b.createdAt,
            customerName: b.customerName,
            items: (b.items || []).map((i) => ({
                name: i.name,
                qty: i.qty,
                price: i.price,
                costPrice: i.costPrice,
                lineProfit: i.netProfit,
            })),
            billTotal: b.total,
            billProfit: b.netProfit,
            paymentMethod,
            amountPaid: inPeriodPaidTotal,
            creditAmount: b.total - inPeriodPaidTotal,
        });
    }

    // Who this period's new credit is actually owed by — the detail behind
    // the single creditExtended total, so "who do I need to collect from"
    // has an answer. Highest amount first (most worth chasing).
    const creditExtendedByCustomer = Array.from(creditByCustomer.values()).sort((a, b) => b.amount - a.amount);
    if (creditExtendedByCustomer.length > 0) {
        const phones = await Customer.find({ _id: { $in: creditExtendedByCustomer.map((c) => c.customerId) } })
            .select("phone")
            .session(session)
            .lean();
        const phoneById = new Map(phones.map((c) => [c._id.toString(), c.phone]));
        for (const entry of creditExtendedByCustomer) {
            entry.customerPhone = phoneById.get(entry.customerId.toString()) || "";
        }
    }

    // Refunds paid back out reduce the settlement side. ledger_adjust refunds
    // on period-created bills are already netted into creditExtended above;
    // store_credit refunds reduce storeCreditUsed; online has no refund path.
    cashSales -= refundsByMethod.cash;
    cardSales -= refundsByMethod.card;
    storeCreditUsed -= refundsByMethod.store_credit;

    const settlementTotal = cashSales + cardSales + upiSales + creditExtended + storeCreditUsed;
    const reconciliationDifference = netSales - settlementTotal;
    const reconciled = Math.abs(reconciliationDifference) <= TOLERANCE;

    // ── Receivables (informational, not part of the reconciliation equation).
    // Scoped to customer != null throughout, to match how Customer.balance
    // itself is built (Bill post-save hook skips walk-in bills entirely) —
    // otherwise these would silently diverge from the real customer ledger
    // whenever a walk-in bill carries an unpaid balance. ─────────────────
    const collectionsAgg = await Bill.aggregate([
        { $match: { ...commonMatch, customer: { $ne: null }, createdAt: { $lt: periodStart } } },
        { $unwind: "$payments" },
        {
            $addFields: {
                effectivePaidAt: { $cond: [{ $lt: ["$payments.paidAt", "$createdAt"] }, "$createdAt", "$payments.paidAt"] },
            },
        },
        { $match: { effectivePaidAt: { $gte: periodStart, $lte: periodEnd } } },
        { $group: { _id: null, total: { $sum: "$payments.amount" } } },
    ]).session(session);
    const collectionsReceived = collectionsAgg[0]?.total || 0;

    const outstandingAgg = await Bill.aggregate([
        { $match: { ...commonMatch, customer: { $ne: null }, createdAt: { $lte: periodEnd } } },
        {
            $addFields: {
                paidToDate: {
                    $sum: {
                        $map: {
                            input: { $filter: { input: "$payments", as: "p", cond: { $lte: ["$$p.paidAt", periodEnd] } } },
                            as: "p",
                            in: "$$p.amount",
                        },
                    },
                },
                ledgerRefundToDate: {
                    $sum: {
                        $map: {
                            input: {
                                $filter: {
                                    input: "$returns",
                                    as: "r",
                                    cond: {
                                        $and: [
                                            { $eq: ["$$r.refundMethod", "ledger_adjust"] },
                                            { $lte: ["$$r.returnedAt", periodEnd] },
                                        ],
                                    },
                                },
                            },
                            as: "r",
                            in: "$$r.refundAmount",
                        },
                    },
                },
            },
        },
        {
            $group: {
                _id: null,
                outstanding: { $sum: { $subtract: ["$total", { $add: ["$paidToDate", "$ledgerRefundToDate"] }] } },
            },
        },
    ]).session(session);
    const outstandingReceivable = outstandingAgg[0]?.outstanding || 0;

    // ── Expected cash on hand — sourced from the cashbook ledger, which
    // independently records every real cash movement (sale collections,
    // refunds, expenses, vendor/supply payments, manual deposits/
    // withdrawals) as it happens. This is NOT derived from bill totals, so
    // — unlike settlementTotal above — comparing it against a physical
    // count can genuinely fail (shrinkage, an unlogged withdrawal, a
    // miscount), which is the actual point of a till reconciliation.
    const cashbookEntry = await CashBook.findOne({ business: bizId, createdAt: { $lte: periodEnd } })
        .sort({ createdAt: -1, entryNumber: -1 })
        .select("runningBalance")
        .session(session)
        .lean();
    const expectedCash = cashbookEntry?.runningBalance ?? 0;

    return {
        periodStart,
        periodEnd,
        grossSales,
        totalDiscounts,
        totalReturns,
        netSales,
        totalOrders,
        totalItemsSold,
        cogs,
        grossProfit,
        totalExpenses,
        netProfit,
        cashSales,
        cardSales,
        upiSales,
        storeCreditUsed,
        creditExtended,
        creditExtendedByCustomer,
        settlementTotal,
        costPlusProfit,
        reconciled,
        reconciliationDifference,
        collectionsReceived,
        outstandingReceivable,
        expectedCash,
        bills,
    };
};

// One reconciliation row: expected (from the books) vs. counted (from an
// external check — drawer count, bank/merchant statement). counted is
// optional — until it's actually supplied, variance/reconciled stay null
// rather than defaulting to a misleading true/zero.
const buildTenderCheck = (expected, counted) => {
    if (counted === undefined || counted === null || counted === "") {
        return { expected, counted: null, variance: null, reconciled: null };
    }
    const c = Number(counted);
    const variance = c - expected;
    return { expected, counted: c, variance, reconciled: Math.abs(variance) <= TOLERANCE };
};

// Merges user-supplied external verification amounts into a computed
// closing. Both preview and finalize call this, so a live preview and the
// saved record compute variance identically. `counts` is
// { cash?, card?, online? } — any/all optional. cash checks against the
// cumulative cashbook drawer balance; card/online check against this
// period's own settlement figures (there's no running balance for
// electronic tenders the way there is for a physical drawer).
export const withTenderCounts = (computed, counts = {}) => ({
    ...computed,
    tenderReconciliation: {
        cash: buildTenderCheck(computed.expectedCash, counts.cash),
        card: buildTenderCheck(computed.cardSales, counts.card),
        online: buildTenderCheck(computed.upiSales, counts.online),
    },
});

// ═══════════════════════════════════════════════════════════════════════════
// API ENDPOINT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /closing/last
 */
export const getLastClosing = async (req, res) => {
    try {
        const businessId = new mongoose.Types.ObjectId(req.user.businessId);
        const last = await Closing.findOne({ business: businessId }).sort({ closingNumber: -1 }).lean();
        res.json(last || null);
    } catch (error) {
        console.error("Error fetching last closing:", error);
        res.status(500).json({ message: "Failed to fetch last closing" });
    }
};

/**
 * GET /closing/preview?startDate=&endDate=&countedCash=&countedCard=&countedOnline=
 */
export const previewClosing = async (req, res) => {
    try {
        const businessId = req.user.businessId;
        const { startDate, endDate, countedCash, countedCard, countedOnline } = req.query;

        const periodEnd = endDate ? endOfDay(endDate) : new Date();

        let periodStart;
        if (startDate) {
            periodStart = startOfDay(startDate);
        } else {
            const last = await Closing.findOne({ business: businessId }).sort({ closingNumber: -1 }).select("periodEnd").lean();
            if (last) {
                periodStart = last.periodEnd;
            } else {
                const earliest = await Bill.findOne({ business: businessId, type: "sale", status: "completed" })
                    .sort({ createdAt: 1 }).select("createdAt").lean();
                periodStart = earliest ? earliest.createdAt : startOfToday();
            }
        }

        if (periodStart > periodEnd) {
            return res.status(400).json({ message: "startDate must be before endDate" });
        }

        const result = await computeClosing(businessId, periodStart, periodEnd);
        res.json(withTenderCounts(result, { cash: countedCash, card: countedCard, online: countedOnline }));
    } catch (error) {
        console.error("Error previewing closing:", error);
        res.status(500).json({ message: "Failed to preview closing" });
    }
};

/**
 * POST /closing — body { periodStart, periodEnd, countedNote?, countedCash?, countedCard?, countedOnline? }
 * Server recomputes authoritatively; ignores any client-supplied figures.
 * countedCash/countedCard/countedOnline are the closer's externally-verified
 * amounts (drawer count, bank/merchant statement) — compared against what
 * the books expect to produce a real, per-tender variance.
 */
export const createClosing = async (req, res) => {
    try {
        const businessId = req.user.businessId;
        const { periodStart: rawStart, periodEnd: rawEnd, countedNote, countedCash, countedCard, countedOnline } = req.body;

        const periodStart = new Date(rawStart);
        const periodEnd = new Date(rawEnd);

        if (isNaN(periodStart.getTime()) || isNaN(periodEnd.getTime()) || periodStart >= periodEnd) {
            return res.status(400).json({ message: "Invalid period range" });
        }

        const session = await mongoose.startSession();
        try {
            session.startTransaction();

            // Reject overlap with any existing closing for this business
            const overlap = await Closing.findOne({
                business: businessId,
                periodStart: { $lt: periodEnd },
                periodEnd: { $gt: periodStart },
            }).session(session).lean();

            if (overlap) {
                await session.abortTransaction();
                return res.status(400).json({
                    message: `Period overlaps existing closing #${overlap.closingNumber} (${overlap.periodStart.toISOString()} – ${overlap.periodEnd.toISOString()})`,
                });
            }

            const computed = await computeClosing(businessId, periodStart, periodEnd, session);
            const withCounts = withTenderCounts(computed, { cash: countedCash, card: countedCard, online: countedOnline });
            const closingNumber = await Counter.getNextSequence("closingNumber", businessId, session);

            const closing = new Closing({
                ...withCounts,
                closingNumber,
                business: businessId,
                closedBy: { id: req.user.id, name: req.user.name || "Staff" },
                closedAt: new Date(),
                notes: countedNote || "",
            });

            const saved = await closing.save({ session });

            await Business.findByIdAndUpdate(businessId, { lastClosingAt: periodEnd }, { session });

            await session.commitTransaction();
            res.status(201).json(saved);
        } catch (txError) {
            await session.abortTransaction();
            throw txError;
        } finally {
            session.endSession();
        }
    } catch (error) {
        console.error("Error creating closing:", error);
        res.status(500).json({ message: "Failed to create closing" });
    }
};

/**
 * GET /closing?page=&limit= — paginated history summary
 */
export const getClosings = async (req, res) => {
    try {
        const businessId = new mongoose.Types.ObjectId(req.user.businessId);
        const { page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [closings, total] = await Promise.all([
            Closing.find({ business: businessId })
                .select("closingNumber periodStart periodEnd netSales netProfit reconciled tenderReconciliation closedAt closedBy")
                .sort({ closingNumber: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean(),
            Closing.countDocuments({ business: businessId }),
        ]);

        res.json({
            closings,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit)),
            },
        });
    } catch (error) {
        console.error("Error fetching closings:", error);
        res.status(500).json({ message: "Failed to fetch closings" });
    }
};

/**
 * GET /closing/:id — full frozen record (view / PDF re-download)
 */
export const getClosingById = async (req, res) => {
    try {
        const businessId = new mongoose.Types.ObjectId(req.user.businessId);
        const closing = await Closing.findOne({ _id: req.params.id, business: businessId }).lean();
        if (!closing) {
            return res.status(404).json({ message: "Closing not found" });
        }
        res.json(closing);
    } catch (error) {
        console.error("Error fetching closing:", error);
        res.status(500).json({ message: "Failed to fetch closing" });
    }
};
