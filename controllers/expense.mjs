import mongoose from 'mongoose';
import Expense from '../models/expense.mjs';
import Counter from '../models/counter.mjs';
import CashBook from '../models/cashbook.mjs';
import { recordCashEntry } from './cashbook.mjs';
import { startOfDay, endOfDay } from '../utils/dateHelpers.mjs';

// Category labels for display
const CATEGORY_LABELS = {
    rent: 'Rent',
    utilities: 'Utilities',
    supplies: 'Supplies',
    wages: 'Wages',
    maintenance: 'Maintenance',
    transport: 'Transport',
    marketing: 'Marketing',
    insurance: 'Insurance',
    taxes: 'Taxes',
    equipment: 'Equipment',
    bank_fees: 'Bank Fees',
    other: 'Other'
};

// CREATE - Create new expense
const createExpense = async (req, res) => {
    try {
        if (!req.user?.businessId) {
            return res.status(400).json({
                error: 'Business ID not found. Please log out and log in again.'
            });
        }

        const { category, description, amount, date, paymentMethod, receiptUrl, notes } = req.body;

        // Validation
        if (!category || !amount) {
            return res.status(400).json({
                error: 'Category and amount are required'
            });
        }

        if (amount <= 0) {
            return res.status(400).json({
                error: 'Amount must be greater than 0'
            });
        }

        // Get next expense number atomically
        const nextExpenseNumber = await Counter.getNextSequence('expenseNumber', req.user.businessId);

        const expense = new Expense({
            expenseNumber: nextExpenseNumber,
            category,
            description: description || '',
            amount,
            date: date ? new Date(date) : new Date(),
            paymentMethod: paymentMethod || 'cash',
            receiptUrl: receiptUrl || null,
            notes: notes || '',
            createdBy: req.user.id || req.user.adminId,
            createdByName: req.user.name || 'Admin',
            status: 'pending',
            business: req.user.businessId
        });

        const savedExpense = await expense.save();

        res.status(201).json(savedExpense);
    } catch (error) {
        console.error('Error creating expense:', error);
        res.status(500).json({ message: 'Error creating expense' });
    }
};

// GET ALL - List expenses with filtering
const getAllExpenses = async (req, res) => {
    try {
        const { status, category, startDate, endDate, page = 1, limit = 50 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        // Build filter
        const filter = { business: req.user.businessId };

        if (status) {
            filter.status = status;
        }

        if (category) {
            filter.category = category;
        }

        if (startDate || endDate) {
            filter.date = {};
            if (startDate) {
                filter.date.$gte = startOfDay(startDate);
            }
            if (endDate) {
                filter.date.$lte = endOfDay(endDate);
            }
        }

        const [expenses, total] = await Promise.all([
            Expense.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit)),
            Expense.countDocuments(filter)
        ]);

        res.json({
            expenses,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / parseInt(limit))
        });
    } catch (error) {
        console.error('Error fetching expenses:', error);
        res.status(500).json({ message: 'Error fetching expenses' });
    }
};

// GET ONE - Get single expense
const getExpense = async (req, res) => {
    try {
        const expense = await Expense.findOne({
            _id: req.params.id,
            business: req.user.businessId
        });

        if (!expense) {
            return res.status(404).json({ message: 'Expense not found' });
        }

        res.json(expense);
    } catch (error) {
        console.error('Error fetching expense:', error);
        res.status(500).json({ message: 'Error fetching expense' });
    }
};

// UPDATE - Update expense (only if pending)
const updateExpense = async (req, res) => {
    try {
        const expense = await Expense.findOne({
            _id: req.params.id,
            business: req.user.businessId
        });

        if (!expense) {
            return res.status(404).json({ message: 'Expense not found' });
        }

        // Only allow updates if expense is pending
        if (expense.status !== 'pending') {
            return res.status(400).json({
                error: 'Cannot update expense that has been approved or rejected'
            });
        }

        // Allowed fields to update
        const { category, description, amount, date, paymentMethod, receiptUrl, notes } = req.body;

        if (category) expense.category = category;
        if (description !== undefined) expense.description = description;
        if (amount !== undefined) {
            if (amount <= 0) {
                return res.status(400).json({ message: 'Amount must be greater than 0' });
            }
            expense.amount = amount;
        }
        if (date) expense.date = new Date(date);
        if (paymentMethod) expense.paymentMethod = paymentMethod;
        if (receiptUrl !== undefined) expense.receiptUrl = receiptUrl;
        if (notes !== undefined) expense.notes = notes;

        const updatedExpense = await expense.save();

        res.json(updatedExpense);
    } catch (error) {
        console.error('Error updating expense:', error);
        res.status(500).json({ message: 'Error updating expense' });
    }
};

// DELETE - Delete expense (admin only)
const deleteExpense = async (req, res) => {
    try {
        const expense = await Expense.findOne({
            _id: req.params.id,
            business: req.user.businessId
        });

        if (!expense) {
            return res.status(404).json({ message: 'Expense not found' });
        }

        // If approved cash expense, reverse the cashbook entry
        if (expense.status === 'approved' && expense.paymentMethod === 'cash') {
            await recordCashEntry({
                type: 'expense_reversal',
                amount: expense.amount,
                direction: 'in',
                referenceType: 'expense',
                referenceId: expense._id,
                referenceNumber: `Expense #${expense.expenseNumber || expense._id}`,
                description: `Reversed: ${expense.category}${expense.description ? ' - ' + expense.description : ''}`,
                note: 'Expense deleted',
                performedBy: req.user.name || 'Admin',
                performedById: req.user.id || req.user.adminId,
                businessId: req.user.businessId,
            });
        }

        await Expense.deleteOne({ _id: expense._id });

        res.json({ message: 'Expense deleted', expense });
    } catch (error) {
        console.error('Error deleting expense:', error);
        res.status(500).json({ message: 'Error deleting expense' });
    }
};

// APPROVE - Approve expense (admin only)
const approveExpense = async (req, res) => {
    try {
        const expense = await Expense.findOne({
            _id: req.params.id,
            business: req.user.businessId
        });

        if (!expense) {
            return res.status(404).json({ message: 'Expense not found' });
        }

        if (expense.status !== 'pending') {
            return res.status(400).json({
                error: `Expense has already been ${expense.status}`
            });
        }

        expense.status = 'approved';
        expense.approvedBy = req.user.id || req.user.adminId;
        expense.approvedByName = req.user.name || 'Admin';
        expense.approvedAt = new Date();
        expense.rejectionReason = '';

        // Use transaction for cash expenses (expense + cashbook must be atomic)
        if (expense.paymentMethod === 'cash') {
            const session = await mongoose.startSession();
            try {
                session.startTransaction();
                await expense.save({ session });
                await recordCashEntry({
                    type: 'expense',
                    amount: expense.amount,
                    direction: 'out',
                    referenceType: 'expense',
                    referenceId: expense._id,
                    referenceNumber: `Expense #${expense.expenseNumber || expense._id}`,
                    description: `Expense: ${expense.category}${expense.description ? ' - ' + expense.description : ''}`,
                    note: expense.description || '',
                    performedBy: req.user.name || 'Admin',
                    performedById: req.user.id || req.user.adminId,
                    businessId: req.user.businessId,
                    session,
                });
                await session.commitTransaction();
            } catch (txError) {
                await session.abortTransaction();
                throw txError;
            } finally {
                session.endSession();
            }
        } else {
            await expense.save();
        }

        res.json({
            message: 'Expense approved',
            expense
        });
    } catch (error) {
        console.error('Error approving expense:', error);
        res.status(500).json({ message: 'Error approving expense' });
    }
};

// REJECT - Reject expense (admin only)
const rejectExpense = async (req, res) => {
    try {
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({ message: 'Rejection reason is required' });
        }

        const expense = await Expense.findOne({
            _id: req.params.id,
            business: req.user.businessId
        });

        if (!expense) {
            return res.status(404).json({ message: 'Expense not found' });
        }

        if (expense.status !== 'pending') {
            return res.status(400).json({
                error: `Expense has already been ${expense.status}`
            });
        }

        expense.status = 'rejected';
        expense.approvedBy = req.user.id || req.user.adminId;
        expense.approvedByName = req.user.name || 'Admin';
        expense.approvedAt = new Date();
        expense.rejectionReason = reason;

        const updatedExpense = await expense.save();

        res.json({
            message: 'Expense rejected',
            expense: updatedExpense
        });
    } catch (error) {
        console.error('Error rejecting expense:', error);
        res.status(500).json({ message: 'Error rejecting expense' });
    }
};

// STATS - Get expense statistics for P&L
const getExpenseStats = async (req, res) => {
    try {
        const businessId = new mongoose.Types.ObjectId(req.user.businessId);
        const { startDate, endDate } = req.query;

        // Build date filter
        const dateFilter = {};
        if (startDate) {
            dateFilter.$gte = startOfDay(startDate);
        }
        if (endDate) {
            dateFilter.$lte = endOfDay(endDate);
        }

        // Get today and month start for period stats
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

        // Aggregate approved expenses
        const stats = await Expense.aggregate([
            {
                $match: {
                    business: businessId,
                    status: 'approved',
                    ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {})
                }
            },
            {
                $group: {
                    _id: null,
                    totalExpenses: { $sum: '$amount' },
                    expenseCount: { $sum: 1 },
                    // Today's expenses
                    todayExpenses: {
                        $sum: {
                            $cond: [{ $gte: ['$date', today] }, '$amount', 0]
                        }
                    },
                    // This month's expenses
                    monthExpenses: {
                        $sum: {
                            $cond: [{ $gte: ['$date', monthStart] }, '$amount', 0]
                        }
                    }
                }
            }
        ]);

        // Get expenses by category
        const byCategory = await Expense.aggregate([
            {
                $match: {
                    business: businessId,
                    status: 'approved',
                    ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {})
                }
            },
            {
                $group: {
                    _id: '$category',
                    total: { $sum: '$amount' },
                    count: { $sum: 1 }
                }
            },
            {
                $project: {
                    category: '$_id',
                    label: {
                        $switch: {
                            branches: Object.entries(CATEGORY_LABELS).map(([key, value]) => ({
                                case: { $eq: ['$_id', key] },
                                then: value
                            })),
                            default: '$_id'
                        }
                    },
                    total: 1,
                    count: 1,
                    _id: 0
                }
            },
            { $sort: { total: -1 } }
        ]);

        // Get pending expenses count
        const pendingCount = await Expense.countDocuments({
            business: businessId,
            status: 'pending'
        });

        const result = stats[0] || {
            totalExpenses: 0,
            expenseCount: 0,
            todayExpenses: 0,
            monthExpenses: 0
        };

        res.json({
            ...result,
            byCategory,
            pendingCount,
            categoryLabels: CATEGORY_LABELS
        });
    } catch (error) {
        console.error('Error fetching expense stats:', error);
        res.status(500).json({ message: 'Error fetching expense stats' });
    }
};

export {
    createExpense,
    getAllExpenses,
    getExpense,
    updateExpense,
    deleteExpense,
    approveExpense,
    rejectExpense,
    getExpenseStats
};
