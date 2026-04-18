import mongoose from 'mongoose';
import CashBook from '../models/cashbook.mjs';
import Counter from '../models/counter.mjs';

// ═══════════════════════════════════════════════════════════════
// CORE HELPER — called by other controllers inside transactions
// ═══════════════════════════════════════════════════════════════

/**
 * Record a cash entry in the cashbook.
 * Designed to be called from within other controllers' transactions.
 *
 * @param {Object} opts
 * @param {string} opts.type          - Entry type (opening_balance, sale_collection, vendor_payment, etc.)
 * @param {number} opts.amount        - Always positive
 * @param {string} opts.direction     - 'in' or 'out'
 * @param {string} opts.referenceType - 'bill', 'supply', 'vendor', 'customer', 'expense', 'manual'
 * @param {ObjectId} opts.referenceId
 * @param {string} opts.referenceNumber
 * @param {string} opts.description
 * @param {string} opts.note
 * @param {string} opts.performedBy
 * @param {ObjectId} opts.performedById
 * @param {string} opts.businessId
 * @param {ClientSession} [opts.session] - Mongoose session for transaction participation
 * @returns {Promise<Object>} The saved CashBook entry
 */
export const recordCashEntry = async ({
    type,
    amount,
    direction,
    referenceType = 'manual',
    referenceId = null,
    referenceNumber = '',
    description = '',
    note = '',
    performedBy = '',
    performedById = null,
    businessId,
    session = null,
}) => {
    const bizId = new mongoose.Types.ObjectId(businessId);

    // Get current balance from latest entry
    const findOpts = session ? { session } : {};
    const latest = await CashBook.findOne({ business: bizId })
        .sort({ createdAt: -1, entryNumber: -1 })
        .select('runningBalance')
        .session(session)
        .lean();

    const prevBalance = latest?.runningBalance ?? 0;
    const newBalance = direction === 'in'
        ? prevBalance + amount
        : prevBalance - amount;

    const entryNumber = await Counter.getNextSequence('cashbookEntry', businessId, session);

    const entry = new CashBook({
        entryNumber,
        type,
        amount,
        direction,
        runningBalance: newBalance,
        referenceType,
        referenceId,
        referenceNumber,
        description,
        note,
        performedBy,
        performedById,
        business: bizId,
    });

    const saved = await entry.save({ session });
    return saved;
};


// ═══════════════════════════════════════════════════════════════
// API ENDPOINT HANDLERS
// ═══════════════════════════════════════════════════════════════

/**
 * GET /cashbook/balance
 * Returns current cash balance + today's summary.
 */
export const getCurrentBalance = async (req, res) => {
    try {
        const businessId = new mongoose.Types.ObjectId(req.user.businessId);

        const latest = await CashBook.findOne({ business: businessId })
            .sort({ createdAt: -1, entryNumber: -1 })
            .select('runningBalance')
            .lean();

        const balance = latest?.runningBalance ?? 0;

        // Today's in/out summary
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [todaySummary] = await CashBook.aggregate([
            { $match: { business: businessId, createdAt: { $gte: today } } },
            {
                $group: {
                    _id: null,
                    totalIn: {
                        $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amount', 0] },
                    },
                    totalOut: {
                        $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amount', 0] },
                    },
                    entries: { $sum: 1 },
                },
            },
        ]);

        res.json({
            balance,
            today: {
                totalIn: todaySummary?.totalIn ?? 0,
                totalOut: todaySummary?.totalOut ?? 0,
                entries: todaySummary?.entries ?? 0,
            },
        });
    } catch (error) {
        console.error('Error getting cash balance:', error);
        res.status(500).json({ message: 'Failed to get cash balance' });
    }
};

/**
 * GET /cashbook
 * Paginated cashbook ledger with filters.
 */
export const getCashBook = async (req, res) => {
    try {
        const businessId = new mongoose.Types.ObjectId(req.user.businessId);
        const { type, startDate, endDate, page = 1, limit = 50 } = req.query;

        const match = { business: businessId };

        if (type && type !== 'all') {
            match.type = type;
        }

        if (startDate || endDate) {
            match.createdAt = {};
            if (startDate) {
                // Parse as local midnight (not UTC) by splitting the date string
                const [y, m, d] = startDate.split('-').map(Number);
                match.createdAt.$gte = new Date(y, m - 1, d, 0, 0, 0, 0);
            }
            if (endDate) {
                const [y, m, d] = endDate.split('-').map(Number);
                match.createdAt.$lte = new Date(y, m - 1, d, 23, 59, 59, 999);
            }
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [entries, total] = await Promise.all([
            CashBook.find(match)
                .sort({ createdAt: 1, entryNumber: 1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean(),
            CashBook.countDocuments(match),
        ]);

        res.json({
            entries,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit)),
            },
        });
    } catch (error) {
        console.error('Error fetching cashbook:', error);
        res.status(500).json({ message: 'Failed to fetch cashbook' });
    }
};

/**
 * POST /cashbook/opening-balance
 * Admin sets the initial cash balance.
 */
export const setOpeningBalance = async (req, res) => {
    try {
        const businessId = req.user.businessId;
        const { amount, note } = req.body;

        // Check if opening balance already exists
        const existing = await CashBook.findOne({
            business: businessId,
            type: 'opening_balance',
        }).lean();

        if (existing) {
            return res.status(400).json({
                message: 'Opening balance already set. Use deposit/withdraw to adjust.',
            });
        }

        const entry = await recordCashEntry({
            type: 'opening_balance',
            amount: Number(amount),
            direction: 'in',
            referenceType: 'manual',
            description: 'Opening cash balance',
            note: note || '',
            performedBy: req.user.adminId ? 'Admin' : req.user.name || 'Staff',
            performedById: req.user.id,
            businessId,
        });

        res.status(201).json({
            message: `Opening balance of Rs ${amount} set successfully`,
            entry,
        });
    } catch (error) {
        console.error('Error setting opening balance:', error);
        res.status(500).json({ message: 'Failed to set opening balance' });
    }
};

/**
 * POST /cashbook/deposit
 * Admin manually adds cash (e.g. brought from bank, petty cash top-up).
 */
export const manualDeposit = async (req, res) => {
    try {
        const { amount, note, description } = req.body;

        const entry = await recordCashEntry({
            type: 'manual_deposit',
            amount: Number(amount),
            direction: 'in',
            referenceType: 'manual',
            description: description || 'Manual cash deposit',
            note: note || '',
            performedBy: req.user.adminId ? 'Admin' : req.user.name || 'Staff',
            performedById: req.user.id,
            businessId: req.user.businessId,
        });

        res.status(201).json({
            message: `Rs ${amount} deposited successfully`,
            entry,
            newBalance: entry.runningBalance,
        });
    } catch (error) {
        console.error('Error depositing cash:', error);
        res.status(500).json({ message: 'Failed to deposit cash' });
    }
};

/**
 * POST /cashbook/withdraw
 * Admin manually withdraws cash (e.g. bank deposit, personal withdrawal).
 */
export const manualWithdraw = async (req, res) => {
    try {
        const { amount, note, description } = req.body;

        // Check balance
        const businessId = new mongoose.Types.ObjectId(req.user.businessId);
        const latest = await CashBook.findOne({ business: businessId })
            .sort({ createdAt: -1, entryNumber: -1 })
            .select('runningBalance')
            .lean();

        const currentBalance = latest?.runningBalance ?? 0;

        if (Number(amount) > currentBalance) {
            return res.status(400).json({
                message: `Insufficient cash. Available: Rs ${currentBalance}, Requested: Rs ${amount}`,
            });
        }

        const entry = await recordCashEntry({
            type: 'manual_withdrawal',
            amount: Number(amount),
            direction: 'out',
            referenceType: 'manual',
            description: description || 'Manual cash withdrawal',
            note: note || '',
            performedBy: req.user.adminId ? 'Admin' : req.user.name || 'Staff',
            performedById: req.user.id,
            businessId: req.user.businessId,
        });

        res.status(201).json({
            message: `Rs ${amount} withdrawn successfully`,
            entry,
            newBalance: entry.runningBalance,
        });
    } catch (error) {
        console.error('Error withdrawing cash:', error);
        res.status(500).json({ message: 'Failed to withdraw cash' });
    }
};

/**
 * GET /cashbook/summary
 * Aggregated stats by type and time period.
 */
export const getCashBookSummary = async (req, res) => {
    try {
        const businessId = new mongoose.Types.ObjectId(req.user.businessId);
        const { startDate, endDate } = req.query;

        const now = new Date();
        const today = new Date(now);
        today.setHours(0, 0, 0, 0);

        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const dateMatch = {};
        if (startDate || endDate) {
            if (startDate) {
                const [y, m, d] = startDate.split('-').map(Number);
                dateMatch.$gte = new Date(y, m - 1, d, 0, 0, 0, 0);
            }
            if (endDate) {
                const [y, m, d] = endDate.split('-').map(Number);
                dateMatch.$lte = new Date(y, m - 1, d, 23, 59, 59, 999);
            }
        }

        const basePipeline = (dateFilter) => [
            { $match: { business: businessId, createdAt: dateFilter } },
            {
                $group: {
                    _id: '$type',
                    totalIn: {
                        $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amount', 0] },
                    },
                    totalOut: {
                        $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amount', 0] },
                    },
                    count: { $sum: 1 },
                },
            },
        ];

        const [todayBreakdown, monthBreakdown, customBreakdown] = await Promise.all([
            CashBook.aggregate(basePipeline({ $gte: today })),
            CashBook.aggregate(basePipeline({ $gte: monthStart })),
            Object.keys(dateMatch).length > 0
                ? CashBook.aggregate(basePipeline(dateMatch))
                : Promise.resolve(null),
        ]);

        const summarize = (breakdown) => {
            const byType = {};
            let totalIn = 0;
            let totalOut = 0;
            for (const row of breakdown) {
                byType[row._id] = { in: row.totalIn, out: row.totalOut, count: row.count };
                totalIn += row.totalIn;
                totalOut += row.totalOut;
            }
            return { byType, totalIn, totalOut, net: totalIn - totalOut };
        };

        // Current balance
        const latest = await CashBook.findOne({ business: businessId })
            .sort({ createdAt: -1, entryNumber: -1 })
            .select('runningBalance')
            .lean();

        res.json({
            currentBalance: latest?.runningBalance ?? 0,
            today: summarize(todayBreakdown),
            thisMonth: summarize(monthBreakdown),
            ...(customBreakdown ? { custom: summarize(customBreakdown) } : {}),
        });
    } catch (error) {
        console.error('Error getting cashbook summary:', error);
        res.status(500).json({ message: 'Failed to get cashbook summary' });
    }
};
