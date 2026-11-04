import mongoose from 'mongoose';
import Customer from '../models/customer.mjs';
import Bill from '../models/bill.mjs';
import { startOfToday, startOfMonth, startOfWeek, startOfDay, endOfDay, toLocalDateString } from '../utils/dateHelpers.mjs';

// ─── Customer statement (paged ledger) ──────────────────────────────────────
// The ledger isn't stored: it's built from the customer's bills (each bill,
// each payment inside it, each return inside it). Here the database builds
// those lines and the running balance in one aggregation, so a customer with
// thousands of bills never has to be loaded into memory, and any period /
// filter / sort / page shows correct balances.
//
// Rules:
//   - summary (cards) is ALL-TIME and ignores every filter
//   - a line's date is when it happened (bill date, payment date, return date)
//   - openingBalance = everything before the period; closingBalance =
//     opening + bills − payments − returns (credit moves net to zero)
//   - each line's balance is computed in date order, whatever the display sort
//   - default period is 'sinceZero': everything after the last time the
//     customer owed nothing (balance 0 or in credit) — see findLastZero

const PERIODS = ['sinceZero', 'today', 'yesterday', 'week', 'month', 'lastMonth', 'all', 'custom'];
const DEFAULT_PERIOD = 'sinceZero';
const SETTLED = 0.005; // balance at or below this = customer owes nothing
const TYPES = ['all', 'bill', 'payment', 'return', 'cancelled'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_PAGE = 100000; // a bigger page number would overflow the database skip

const round2 = (x) => Math.round((x || 0) * 100) / 100;
const isObjectId = (id) => mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);

const endOfToday = () => {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d;
};

/** Resolve a period preset (or custom from/to) to { from, to } in local time. null = unbounded. */
export const resolvePeriod = (period, fromStr, toStr) => {
    const today = startOfToday();
    switch (period) {
        case 'today':
            return { from: today, to: endOfToday() };
        case 'yesterday': {
            const from = new Date(today);
            from.setDate(from.getDate() - 1);
            const to = new Date(today.getTime() - 1);
            return { from, to };
        }
        case 'week':
            return { from: startOfWeek(today), to: endOfToday() };
        case 'month':
            return { from: startOfMonth(today), to: endOfToday() };
        case 'lastMonth': {
            const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            const to = new Date(startOfMonth(today).getTime() - 1);
            return { from, to };
        }
        case 'all':
        case 'sinceZero': // resolved from the ledger itself (findLastZero)
            return { from: null, to: null };
        case 'custom': {
            const dateRe = /^\d{4}-\d{2}-\d{2}$/;
            if (!dateRe.test(fromStr || '') || !dateRe.test(toStr || '')) {
                throw Object.assign(new Error('Custom period needs from and to dates (YYYY-MM-DD)'), { status: 400 });
            }
            const from = startOfDay(fromStr);
            const to = endOfDay(toStr);
            // 2026-02-31 would silently roll over to 3 March
            if (toLocalDateString(from) !== fromStr || toLocalDateString(to) !== toStr) {
                throw Object.assign(new Error('from and to must be real dates (YYYY-MM-DD)'), { status: 400 });
            }
            if (from > to) throw Object.assign(new Error('"from" must be on or before "to"'), { status: 400 });
            return { from, to };
        }
        default:
            throw Object.assign(new Error(`period must be one of: ${PERIODS.join(', ')}`), { status: 400 });
    }
};

/**
 * Pipeline stages turning a customer's bills into ledger lines ("events"),
 * each with the running balance after it. Mirrors the line rules of
 * getCustomerLedger exactly.
 */
const eventStages = (customerId, businessId) => [
    { $match: { customer: customerId, business: businessId } },
    {
        $project: {
            events: {
                $cond: [
                    { $eq: ['$status', 'cancelled'] },
                    // Cancelled bill: one zero-effect line (its payments/returns don't count)
                    {
                        $cond: [
                            { $eq: ['$type', 'sale'] },
                            [{
                                kind: 'cancelled',
                                id: { $concat: [{ $toString: '$_id' }, ':cancelled'] },
                                date: '$createdAt',
                                order: 4,
                                debit: 0,
                                credit: 0,
                                billId: '$_id',
                                billNumber: '$billNumber',
                                description: { $concat: ['Bill #', { $toString: '$billNumber' }, ' (cancelled)'] },
                                billTotal: '$total',
                                cancelReason: { $ifNull: ['$cancelReason', ''] },
                                cancelledAt: '$cancelledAt',
                                items: '$items',
                                notes: { $ifNull: ['$notes', ''] },
                            }],
                            [],
                        ],
                    },
                    {
                        $concatArrays: [
                            // The bill itself (debit)
                            [{
                                kind: { $cond: [{ $eq: ['$type', 'opening_balance'] }, 'opening_balance', 'bill'] },
                                id: { $concat: [{ $toString: '$_id' }, ':bill'] },
                                date: '$createdAt',
                                order: { $cond: [{ $eq: ['$type', 'opening_balance'] }, -1, 0] },
                                debit: { $ifNull: ['$total', 0] },
                                credit: 0,
                                billId: '$_id',
                                billNumber: '$billNumber',
                                description: {
                                    $cond: [
                                        { $eq: ['$type', 'opening_balance'] },
                                        'Opening Balance',
                                        { $concat: ['Bill #', { $toString: '$billNumber' }] },
                                    ],
                                },
                                items: '$items',
                                subtotal: { $ifNull: ['$subtotal', 0] },
                                totalTax: { $ifNull: ['$totalTax', 0] },
                                discountMode: { $ifNull: ['$discountMode', 'none'] },
                                totalItemDiscount: { $ifNull: ['$totalItemDiscount', 0] },
                                billDiscountAmount: { $ifNull: ['$billDiscountAmount', 0] },
                                billDiscountReason: { $ifNull: ['$billDiscountReason', ''] },
                                totalDiscount: { $ifNull: ['$totalDiscount', 0] },
                                notes: { $ifNull: ['$notes', ''] },
                            }],
                            // Payments (credit). Store credit moved from another bill
                            // shows as a pair that nets to zero.
                            {
                                $reduce: {
                                    input: { $ifNull: ['$payments', []] },
                                    initialValue: [],
                                    in: {
                                        $concatArrays: [
                                            '$$value',
                                            {
                                                $cond: [
                                                    { $ifNull: ['$$this.creditFrom', false] },
                                                    [
                                                        {
                                                            kind: 'credit_transfer',
                                                            id: { $concat: [{ $toString: '$$this._id' }, ':transfer'] },
                                                            date: '$$this.paidAt',
                                                            order: 0.5,
                                                            debit: '$$this.amount',
                                                            credit: 0,
                                                            billId: '$$this.creditFrom',
                                                            billNumber: '$$this.creditFromBillNumber',
                                                            toBillId: '$_id',
                                                            toBillNumber: '$billNumber',
                                                            amount: '$$this.amount',
                                                            description: {
                                                                $concat: [
                                                                    'Credit from Bill #', { $toString: { $ifNull: ['$$this.creditFromBillNumber', ''] } },
                                                                    ' moved to Bill #', { $toString: '$billNumber' },
                                                                ],
                                                            },
                                                            notes: { $ifNull: ['$$this.note', ''] },
                                                        },
                                                        {
                                                            kind: 'payment',
                                                            id: { $concat: [{ $toString: '$$this._id' }, ':payment'] },
                                                            date: '$$this.paidAt',
                                                            order: 1,
                                                            debit: 0,
                                                            credit: '$$this.amount',
                                                            billId: '$_id',
                                                            billNumber: '$billNumber',
                                                            fromCredit: true,
                                                            fromBillId: '$$this.creditFrom',
                                                            fromBillNumber: '$$this.creditFromBillNumber',
                                                            method: 'store_credit',
                                                            receivedBy: { $ifNull: ['$$this.receivedByName', ''] },
                                                            description: {
                                                                $concat: [
                                                                    'Payment for Bill #', { $toString: '$billNumber' },
                                                                    ' (credit from Bill #', { $toString: { $ifNull: ['$$this.creditFromBillNumber', ''] } }, ')',
                                                                ],
                                                            },
                                                            notes: { $ifNull: ['$$this.note', ''] },
                                                        },
                                                    ],
                                                    [{
                                                        kind: 'payment',
                                                        id: { $concat: [{ $toString: '$$this._id' }, ':payment'] },
                                                        // A payment taken with the sale can be stamped a moment
                                                        // before the bill — never place it before its bill.
                                                        date: { $max: ['$$this.paidAt', '$createdAt'] },
                                                        order: 1,
                                                        debit: 0,
                                                        credit: '$$this.amount',
                                                        billId: '$_id',
                                                        billNumber: '$billNumber',
                                                        method: '$$this.method',
                                                        receivedBy: { $ifNull: ['$$this.receivedByName', ''] },
                                                        reference: { $ifNull: ['$$this.reference', ''] },
                                                        description: { $concat: ['Payment for Bill #', { $toString: '$billNumber' }] },
                                                        notes: { $ifNull: ['$$this.note', ''] },
                                                    }],
                                                ],
                                            },
                                        ],
                                    },
                                },
                            },
                            // Returns (credit = full refund value)
                            {
                                $map: {
                                    input: { $ifNull: ['$returns', []] },
                                    as: 'r',
                                    in: {
                                        kind: 'return',
                                        id: { $concat: [{ $toString: '$$r._id' }, ':return'] },
                                        returnId: '$$r._id',
                                        date: { $ifNull: ['$$r.returnedAt', '$createdAt'] },
                                        order: 2,
                                        debit: 0,
                                        credit: { $ifNull: ['$$r.refundAmount', 0] },
                                        billId: '$_id',
                                        billNumber: '$billNumber',
                                        returnNumber: '$$r.returnNumber',
                                        returnItems: '$$r.items',
                                        description: {
                                            $concat: [
                                                'Return on Bill #', { $toString: '$billNumber' },
                                                { $cond: [{ $ifNull: ['$$r.returnNumber', false] }, { $concat: [' (', '$$r.returnNumber', ')'] }, ''] },
                                            ],
                                        },
                                    },
                                },
                            },
                        ],
                    },
                ],
            },
        },
    },
    { $unwind: '$events' },
    { $replaceRoot: { newRoot: '$events' } },
    {
        $setWindowFields: {
            sortBy: { date: 1, order: 1, billNumber: 1, id: 1 },
            output: {
                balance: {
                    $sum: { $subtract: ['$debit', '$credit'] },
                    window: { documents: ['unbounded', 'current'] },
                },
                // Position in date order (1, 2, 3…) — 'sinceZero' cuts on it
                seq: { $sum: 1, window: { documents: ['unbounded', 'current'] } },
            },
        },
    },
];

/**
 * Where "since last zero" starts.
 *
 * Finds the last line where the customer still owed money (lastOwed), then
 * the last line BEFORE it where they owed nothing (balance ≤ 0). The start of
 * the history counts as zero, so a customer who never got back to 0 shows
 * everything. If they owe nothing right now, this gives the last completed
 * cycle (up to the payment/return that settled it) plus anything after.
 *
 * @returns {{ zeroSeq, zeroAt, status, settledAt }}
 *   status: 'open'          owes now; statement starts after zeroAt
 *           'neverSettled'  owes now and was never at 0 → all entries
 *           'settled'       owes nothing now; settledAt = when it got to 0
 *           'noBalance'     never owed anything → all entries
 */
// Store-credit moves show as a pair (credit_transfer +X, then the fromCredit
// payment −X) that always nets to zero. Between the two lines the running
// balance blips up by X, which is not real debt — so pair lines are never used
// to decide "owed" or "zero" below.
const IS_CREDIT_PAIR = { $or: [{ $eq: ['$kind', 'credit_transfer'] }, { $eq: ['$fromCredit', true] }] };
const IS_REAL = { $not: [IS_CREDIT_PAIR] };

const findLastZero = async (customerId, businessId) => {
    const [r] = await Bill.aggregate([
        ...eventStages(customerId, businessId),
        {
            $setWindowFields: {
                sortBy: { seq: 1 },
                output: {
                    lastOwed: {
                        $max: { $cond: [{ $and: [{ $gt: ['$balance', SETTLED] }, IS_REAL] }, '$seq', 0] },
                        window: { documents: ['unbounded', 'unbounded'] },
                    },
                },
            },
        },
        {
            $facet: {
                meta: [{ $limit: 1 }, { $project: { _id: 0, lastOwed: 1 } }],
                // Balance after the last line = what the customer owes now
                tail: [{ $sort: { seq: -1 } }, { $limit: 1 }, { $project: { _id: 0, balance: 1 } }],
                zero: [
                    { $match: { $expr: { $and: [{ $lte: ['$balance', SETTLED] }, { $lt: ['$seq', '$lastOwed'] }, IS_REAL] } } },
                    { $sort: { seq: -1 } },
                    { $limit: 1 },
                    { $project: { _id: 0, seq: 1, date: 1 } },
                ],
                // First line after the last debt that brought the balance to 0 or below
                settled: [
                    { $match: { $expr: { $and: [{ $gt: ['$seq', '$lastOwed'] }, { $lte: ['$balance', SETTLED] }] } } },
                    { $sort: { seq: 1 } },
                    { $limit: 1 },
                    { $project: { _id: 0, date: 1 } },
                ],
            },
        },
    ]).allowDiskUse(true);

    const lastOwed = r?.meta[0]?.lastOwed || 0;
    if (lastOwed === 0) return { zeroSeq: 0, zeroAt: null, status: 'noBalance', settledAt: null };

    const zero = r.zero[0];
    const zeroSeq = zero?.seq || 0;
    const zeroAt = zero?.date || null;
    const owesNow = (r.tail[0]?.balance || 0) > SETTLED;
    if (!owesNow) {
        return { zeroSeq, zeroAt, status: 'settled', settledAt: r.settled[0]?.date || null };
    }
    return { zeroSeq, zeroAt, status: zeroSeq ? 'open' : 'neverSettled', settledAt: null };
};

const typeMatch = (type) => {
    switch (type) {
        case 'bill': return { kind: { $in: ['bill', 'opening_balance'] } };
        case 'payment': return { kind: { $in: ['payment', 'credit_transfer'] } };
        case 'return': return { kind: 'return' };
        case 'cancelled': return { kind: 'cancelled' };
        default: return { kind: { $ne: 'cancelled' } };
    }
};

const sumIf = (cond, field) => ({ $sum: { $cond: [cond, `$${field}`, 0] } });
const IS_BILL = { $in: ['$kind', ['bill', 'opening_balance']] };
const IS_REAL_PAYMENT = { $and: [{ $eq: ['$kind', 'payment'] }, { $ne: ['$fromCredit', true] }] };
const IS_RETURN = { $eq: ['$kind', 'return'] };
const NOT_CANCELLED = { $ne: ['$kind', 'cancelled'] };

/**
 * Fill storeCredit / debtWriteOff / notes on return lines (same split as the
 * old ledger: the return first clears what was still unpaid on its bill).
 */
const enrichReturnRows = async (rows) => {
    const returnRows = rows.filter((r) => r.kind === 'return');
    if (returnRows.length === 0) return;

    const bills = await Bill.find(
        { _id: { $in: [...new Set(returnRows.map((r) => String(r.billId)))] } },
        { total: 1, amountPaid: 1, returns: 1 }
    ).lean();
    const split = new Map(); // returnId -> { storeCredit, debtWriteOff, notes }
    for (const bill of bills) {
        let remaining = Math.max(0, (bill.total || 0) - (bill.amountPaid || 0));
        const sorted = [...(bill.returns || [])].sort((a, b) => new Date(a.returnedAt || 0) - new Date(b.returnedAt || 0));
        for (const ret of sorted) {
            const refund = ret.refundAmount || 0;
            const debtWriteOff = Math.min(remaining, refund);
            remaining = Math.max(0, remaining - debtWriteOff);
            const reasons = [...new Set((ret.items || []).map((i) => i.reasonNote || i.reason || '').filter(Boolean))];
            split.set(String(ret._id), {
                storeCredit: Math.max(0, refund - debtWriteOff),
                debtWriteOff,
                notes: reasons.join(', '),
            });
        }
    }
    for (const row of returnRows) Object.assign(row, split.get(String(row.returnId)) || {});
};

const toEntry = (row) => {
    const { kind, order, returnId, seq, ...rest } = row;
    return { ...rest, type: kind, debit: round2(row.debit), credit: round2(row.credit), balance: round2(row.balance) };
};

/**
 * GET /customer/:id/statement
 * Query: period, from, to, type, sort, search, page, limit (see file header).
 */
export const getCustomerStatement = async (req, res) => {
    try {
        if (!isObjectId(req.params.id)) {
            return res.status(404).json({ message: 'Customer not found' });
        }
        const businessId = new mongoose.Types.ObjectId(req.user.businessId);
        const customer = await Customer.findOne(
            { _id: req.params.id, business: businessId },
            { name: 1, phone: 1, email: 1, address: 1, lastPurchase: 1 }
        ).lean();
        if (!customer) {
            return res.status(404).json({ message: 'Customer not found' });
        }

        const period = req.query.period || DEFAULT_PERIOD;
        const type = req.query.type || 'all';
        const sort = req.query.sort || 'oldest';
        if (!TYPES.includes(type)) return res.status(400).json({ message: `type must be one of: ${TYPES.join(', ')}` });
        if (!['oldest', 'newest'].includes(sort)) return res.status(400).json({ message: 'sort must be oldest or newest' });

        let range;
        try {
            range = resolvePeriod(period, req.query.from, req.query.to);
        } catch (err) {
            return res.status(err.status || 400).json({ message: err.message });
        }

        const page = Math.min(Math.max(parseInt(req.query.page) || 1, 1), MAX_PAGE);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
        const search = String(req.query.search || '').trim().replace(/[^0-9]/g, '');

        const customerId = new mongoose.Types.ObjectId(customer._id);

        // periodMatch = lines in the period; beforeMatch = lines before it (opening)
        let periodMatch = {};
        let beforeMatch = null;
        let sinceZero = null;
        if (period === 'sinceZero') {
            sinceZero = await findLastZero(customerId, businessId);
            if (sinceZero.zeroSeq) {
                periodMatch = { seq: { $gt: sinceZero.zeroSeq } };
                beforeMatch = { seq: { $lte: sinceZero.zeroSeq } };
            }
            range = { from: sinceZero.zeroAt, to: null };
        } else {
            const inPeriod = {};
            if (range.from) inPeriod.$gte = range.from;
            if (range.to) inPeriod.$lte = range.to;
            if (Object.keys(inPeriod).length) periodMatch = { date: inPeriod };
            if (range.from) beforeMatch = { date: { $lt: range.from } };
        }

        const rowMatch = { ...periodMatch, ...typeMatch(type) };
        if (search) {
            const re = new RegExp(search);
            rowMatch.$or = [{ billNumberStr: re }, { toBillNumberStr: re }];
        }

        const dir = sort === 'newest' ? -1 : 1;

        const [result] = await Bill.aggregate([
            ...eventStages(customerId, businessId),
            {
                $addFields: {
                    billNumberStr: { $toString: { $ifNull: ['$billNumber', ''] } },
                    toBillNumberStr: { $toString: { $ifNull: ['$toBillNumber', ''] } },
                },
            },
            {
                $facet: {
                    allTime: [
                        { $match: { kind: { $ne: 'cancelled' } } },
                        {
                            $group: {
                                _id: null,
                                totalBilled: sumIf(IS_BILL, 'debit'),
                                totalPaid: sumIf(IS_REAL_PAYMENT, 'credit'),
                                totalReturns: sumIf(IS_RETURN, 'credit'),
                                totalBills: { $sum: { $cond: [IS_BILL, 1, 0] } },
                                amountDue: { $sum: { $subtract: ['$debit', '$credit'] } },
                            },
                        },
                    ],
                    opening: beforeMatch
                        ? [
                            { $match: beforeMatch },
                            { $group: { _id: null, balance: { $sum: { $subtract: ['$debit', '$credit'] } } } },
                        ]
                        : [{ $match: { kind: '__none__' } }], // all-time: nothing before it
                    periodTotals: [
                        { $match: periodMatch },
                        {
                            $group: {
                                _id: null,
                                bills: sumIf(IS_BILL, 'debit'),
                                payments: sumIf(IS_REAL_PAYMENT, 'credit'),
                                returns: sumIf(IS_RETURN, 'credit'),
                                net: { $sum: { $subtract: ['$debit', '$credit'] } },
                                entryCount: { $sum: { $cond: [NOT_CANCELLED, 1, 0] } },
                                cancelledCount: { $sum: { $cond: [NOT_CANCELLED, 0, 1] } },
                            },
                        },
                    ],
                    rows: [
                        { $match: rowMatch },
                        { $sort: { date: dir, order: dir, billNumber: dir, id: dir } },
                        { $skip: (page - 1) * limit },
                        { $limit: limit },
                        { $project: { billNumberStr: 0, toBillNumberStr: 0 } },
                    ],
                    rowCount: [{ $match: rowMatch }, { $count: 'n' }],
                },
            },
        ]).allowDiskUse(true);

        const all = result.allTime[0] || { totalBilled: 0, totalPaid: 0, totalReturns: 0, totalBills: 0, amountDue: 0 };
        const totals = result.periodTotals[0] || { bills: 0, payments: 0, returns: 0, net: 0, entryCount: 0, cancelledCount: 0 };
        const openingBalance = round2(result.opening[0]?.balance || 0);
        const amountDue = round2(all.amountDue);
        const total = result.rowCount[0]?.n || 0;

        await enrichReturnRows(result.rows);

        res.json({
            customer,
            summary: {
                totalBilled: round2(all.totalBilled),
                totalPaid: round2(all.totalPaid),
                totalReturns: round2(all.totalReturns),
                totalBills: all.totalBills,
                amountDue,
                availableCredit: amountDue < 0 ? round2(-amountDue) : 0,
            },
            period: {
                preset: period,
                from: range.from,
                to: range.to,
                openingBalance,
                bills: round2(totals.bills),
                payments: round2(totals.payments),
                returns: round2(totals.returns),
                closingBalance: round2(openingBalance + totals.net),
                entryCount: totals.entryCount,
                cancelledCount: totals.cancelledCount,
                // only for period=sinceZero: why the statement starts where it does
                ...(sinceZero && {
                    sinceZero: { status: sinceZero.status, zeroAt: sinceZero.zeroAt, settledAt: sinceZero.settledAt },
                }),
            },
            entries: result.rows.map(toEntry),
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit),
                hasMore: page * limit < total,
            },
        });
    } catch (error) {
        console.error('Error fetching customer statement:', error);
        res.status(500).json({ message: 'Failed to fetch customer statement' });
    }
};

/**
 * GET /customer/:id/pending-bills?sort=oldest|newest|amount
 * The bills that make up the customer's Amount Due (used by the Amount Due
 * panel and the Record Payment window).
 */
export const getPendingBills = async (req, res) => {
    try {
        if (!isObjectId(req.params.id)) {
            return res.status(404).json({ message: 'Customer not found' });
        }
        const sort = req.query.sort || 'oldest';
        if (!['oldest', 'newest', 'amount'].includes(sort)) {
            return res.status(400).json({ message: 'sort must be oldest, newest or amount' });
        }

        const customer = await Customer.exists({ _id: req.params.id, business: req.user.businessId });
        if (!customer) {
            return res.status(404).json({ message: 'Customer not found' });
        }

        const bills = await Bill.find(
            { customer: req.params.id, business: req.user.businessId, status: { $ne: 'cancelled' } },
            { billNumber: 1, type: 1, status: 1, createdAt: 1, total: 1, amountPaid: 1, totalLedgerRefunded: 1, amountDue: 1, paymentStatus: 1 }
        ).lean();

        // Age in calendar days (local time): a bill from the 17th is 10 days old on the 27th, at any hour
        const today = startOfToday().getTime();
        const dayOf = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
        const pending = bills
            .filter((b) => (b.amountDue || 0) > 0.005)
            .map((b) => ({
                billId: b._id,
                billNumber: b.billNumber,
                type: b.type,
                status: b.status,
                date: b.createdAt,
                total: round2(b.total),
                paid: round2(b.amountPaid),
                returned: round2(b.totalLedgerRefunded),
                due: round2(b.amountDue),
                ageDays: Math.round((today - dayOf(b.createdAt)) / 86400000),
                paymentStatus: b.paymentStatus,
            }));

        const byDate = (a, b) => new Date(a.date) - new Date(b.date) || a.billNumber - b.billNumber;
        if (sort === 'oldest') pending.sort(byDate);
        else if (sort === 'newest') pending.sort((a, b) => byDate(b, a));
        else pending.sort((a, b) => b.due - a.due || byDate(a, b));

        const totalDue = round2(pending.reduce((s, b) => s + b.due, 0));
        const availableCredit = round2(bills.filter((b) => (b.amountDue || 0) < -0.005).reduce((s, b) => s - b.amountDue, 0));

        res.json({
            bills: pending,
            totalDue,
            availableCredit,
            amountDue: round2(totalDue - availableCredit),
        });
    } catch (error) {
        console.error('Error fetching pending bills:', error);
        res.status(500).json({ message: 'Failed to fetch pending bills' });
    }
};
