import Customer from '../models/customer.mjs';
import Bill from '../models/bill.mjs';
import Counter from '../models/counter.mjs';
import mongoose from 'mongoose';
import { recordCashEntry } from './cashbook.mjs';
import { startOfDay, endOfDay, toLocalDateString, toLocalTimeString } from '../utils/dateHelpers.mjs';

// Create or get customer (upsert by phone + business)
export const createOrGetCustomer = async (req, res) => {
    try {
        const { name, phone, email, address, notes, openingBalance } = req.body;

        if (!name || !phone) {
            return res.status(400).json({ message: 'Name and phone are required' });
        }

        // Check if customer exists but is deactivated
        const existing = await Customer.findOne({ phone: phone.trim(), business: req.user.businessId });

        if (existing && !existing.isActive) {
            return res.status(400).json({
                message: 'This customer has been deactivated. Ask admin to reactivate.',
                customerId: existing._id
            });
        }

        const updateFields = {
            name: name.trim(),
            ...(email !== undefined && { email }),
            ...(address !== undefined && { address }),
            ...(notes !== undefined && { notes }),
        };

        const obAmount = !existing && openingBalance !== undefined ? Number(openingBalance) : 0;

        if (obAmount > 0) {
            // Use transaction so customer + OB bill are atomic
            const session = await mongoose.startSession();
            try {
                session.startTransaction();

                const customer = await Customer.findOneAndUpdate(
                    { phone: phone.trim(), business: req.user.businessId },
                    { ...updateFields, openingBalance: obAmount },
                    { new: true, upsert: true, setDefaultsOnInsert: true, session }
                );

                const billNumber = await Counter.getNextSequence('billNumber', req.user.businessId, session);
                const now = new Date();
                const ob = new Bill({
                    billNumber,
                    business: req.user.businessId,
                    type: 'opening_balance',
                    status: 'completed',
                    paymentStatus: 'unpaid',
                    items: [],
                    total: obAmount,
                    customer: customer._id,
                    customerName: customer.name,
                    customerPhone: customer.phone,
                    cashierName: 'System',
                    notes: 'Opening balance from previous system',
                    date: toLocalDateString(now),
                    time: toLocalTimeString(now),
                });
                await ob.save({ session });

                await session.commitTransaction();
                res.status(200).json(customer);
            } catch (txError) {
                await session.abortTransaction();
                throw txError;
            } finally {
                session.endSession();
            }
        } else {
            const customer = await Customer.findOneAndUpdate(
                { phone: phone.trim(), business: req.user.businessId },
                updateFields,
                { new: true, upsert: true, setDefaultsOnInsert: true }
            );
            res.status(200).json(customer);
        }
    } catch (error) {
        console.error('Error creating/getting customer:', error);
        res.status(500).json({ message: 'Failed to save customer' });
    }
};

// Get all customers with filters and pagination
export const getCustomers = async (req, res) => {
    try {
        const { search, active, hasDues, page = 1, limit = 50 } = req.query;
        const filter = { business: req.user.businessId };

        if (active !== undefined) {
            filter.isActive = active === 'true';
        } else {
            filter.isActive = true;
        }

        if (search) {
            filter.$or = [
                { name: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } }
            ];
        }

        if (hasDues === 'true') {
            filter.balance = { $gt: 0 };
        }

        const skip = (Number(page) - 1) * Number(limit);
        const total = await Customer.countDocuments(filter);

        const customers = await Customer.find(filter)
            .sort({ name: 1 })
            .skip(skip)
            .limit(Number(limit))
            .lean();

        res.json({
            customers,
            total,
            page: Number(page),
            totalPages: Math.ceil(total / Number(limit))
        });
    } catch (error) {
        console.error('Error fetching customers:', error);
        res.status(500).json({ message: 'Failed to fetch customers' });
    }
};

// Get single customer with recent bills.
// Trusts the stored customer doc — balance/totals are maintained by the
// Bill post-save hook, so no live aggregation is needed here.
export const getCustomer = async (req, res) => {
    try {
        const customer = await Customer.findOne({
            _id: req.params.id,
            business: req.user.businessId
        }).lean();

        if (!customer) {
            return res.status(404).json({ message: 'Customer not found' });
        }

        const recentBills = await Bill.find({
            customer: customer._id,
            business: req.user.businessId,
            type: { $ne: 'opening_balance' },
            status: { $ne: 'cancelled' }
        }).sort({ createdAt: -1 }).limit(20).lean();

        res.json({ ...customer, recentBills });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Update customer
export const updateCustomer = async (req, res) => {
    try {
        const allowedFields = ['name', 'phone', 'email', 'address', 'notes', 'isActive', 'creditDays', 'creditLimit'];
        const updates = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                updates[field] = req.body[field];
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ message: 'No valid fields to update' });
        }

        const customer = await Customer.findOneAndUpdate(
            { _id: req.params.id, business: req.user.businessId },
            updates,
            { new: true, runValidators: true }
        );

        if (!customer) {
            return res.status(404).json({ message: 'Customer not found' });
        }

        res.json(customer);
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ message: 'A customer with this phone number already exists' });
        }
        res.status(500).json({ message: error.message });
    }
};

// Delete customer (soft delete)
export const deleteCustomer = async (req, res) => {
    try {
        const customer = await Customer.findOne({
            _id: req.params.id,
            business: req.user.businessId
        });

        if (!customer) {
            return res.status(404).json({ message: 'Customer not found' });
        }

        // Block if customer has any unsettled balance (owes us OR we owe them)
        if (customer.balance > 0) {
            return res.status(400).json({
                message: `Cannot delete customer with outstanding balance of Rs ${customer.balance}`
            });
        }
        if (customer.balance < 0) {
            return res.status(400).json({
                message: `Cannot delete customer with store credit of Rs ${Math.abs(customer.balance)}. Settle the credit first.`
            });
        }

        customer.isActive = false;
        await customer.save();

        res.json({ message: 'Customer deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Customer ledger — chronological timeline of bills + payments with running balance
export const getCustomerLedger = async (req, res) => {
    try {
        const customer = await Customer.findOne({
            _id: req.params.id,
            business: req.user.businessId
        }).lean();

        if (!customer) {
            return res.status(404).json({ message: 'Customer not found' });
        }

        const { startDate, endDate } = req.query;

        const billFilter = {
            customer: new mongoose.Types.ObjectId(customer._id),
            business: new mongoose.Types.ObjectId(req.user.businessId),
            status: { $ne: 'cancelled' }
        };

        if (startDate || endDate) {
            billFilter.createdAt = {};
            if (startDate) billFilter.createdAt.$gte = startOfDay(startDate);
            if (endDate) billFilter.createdAt.$lte = endOfDay(endDate);
        }

        const bills = await Bill.find(billFilter)
            .sort({ createdAt: 1 })
            .lean();

        // Build ledger entries
        const ledger = [];

        for (const bill of bills) {
            // Bill entry (debit — customer owes us)
            const isOpeningBalance = bill.type === 'opening_balance';
            ledger.push({
                type: isOpeningBalance ? 'opening_balance' : 'bill',
                date: bill.createdAt,
                description: isOpeningBalance ? 'Opening Balance' : `Bill #${bill.billNumber}`,
                billId: bill._id,
                billNumber: bill.billNumber,
                items: bill.items,
                subtotal: bill.subtotal || 0,
                totalTax: bill.totalTax || 0,
                discountMode: bill.discountMode || 'none',
                totalItemDiscount: bill.totalItemDiscount || 0,
                billDiscountAmount: bill.billDiscountAmount || 0,
                billDiscountReason: bill.billDiscountReason || '',
                totalDiscount: bill.totalDiscount || 0,
                debit: bill.total,
                credit: 0,
                notes: bill.notes || ''
            });

            // Payment entries (credit — customer paid us)
            if (bill.payments && bill.payments.length > 0) {
                for (const payment of bill.payments) {
                    ledger.push({
                        type: 'payment',
                        date: payment.paidAt,
                        description: `Payment for Bill #${bill.billNumber}`,
                        billId: bill._id,
                        billNumber: bill.billNumber,
                        debit: 0,
                        credit: payment.amount,
                        method: payment.method,
                        receivedBy: payment.receivedByName || '',
                        notes: payment.note || ''
                    });
                }
            }

            // Return entries (credit — we refunded the customer)
            if (bill.returns && bill.returns.length > 0) {
                for (const ret of bill.returns) {
                    // Summarise per-item reasons (returnEntry has no top-level reason)
                    const reasons = (ret.items || [])
                        .map(i => i.reasonNote || i.reason || '')
                        .filter(Boolean);
                    const uniqueReasons = [...new Set(reasons)];

                    ledger.push({
                        type: 'return',
                        date: ret.returnedAt || ret.createdAt,
                        description: `Return on Bill #${bill.billNumber}${ret.returnNumber ? ` (${ret.returnNumber})` : ''}`,
                        billId: bill._id,
                        billNumber: bill.billNumber,
                        returnItems: ret.items,
                        debit: 0,
                        credit: ret.refundAmount || 0,
                        notes: uniqueReasons.join(', ')
                    });
                }
            }
        }

        // Sort by date, then by type (bill before payment/return at the same timestamp).
        // Rationale: an initial payment recorded with a bill can have a paidAt slightly
        // before the bill's createdAt, which would incorrectly show the credit before
        // the debit. A bill (liability) must always come before its settlement.
        const typeOrder = { opening_balance: -1, bill: 0, payment: 1, return: 2 };
        ledger.sort((a, b) => {
            const dateDiff = new Date(a.date) - new Date(b.date);
            if (Math.abs(dateDiff) > 1000) return dateDiff; // >1s apart → respect real order
            return (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99);
        });

        // Calculate running balance
        let runningBalance = 0;
        for (const entry of ledger) {
            runningBalance += entry.debit - entry.credit;
            entry.balance = runningBalance;
        }

        // Summary
        const totalDebit = ledger.reduce((sum, e) => sum + e.debit, 0);
        const totalPaid = ledger.filter(e => e.type === 'payment').reduce((sum, e) => sum + e.credit, 0);
        const totalReturns = ledger.filter(e => e.type === 'return').reduce((sum, e) => sum + e.credit, 0);
        const totalCredit = totalPaid + totalReturns;

        res.json({
            customer: {
                _id: customer._id,
                name: customer.name,
                phone: customer.phone,
                email: customer.email
            },
            ledger,
            summary: {
                totalBilled: totalDebit,
                totalPaid,
                totalReturns,
                currentBalance: totalDebit - totalCredit,
                totalEntries: ledger.length,
                billCount: bills.length
            }
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// FIFO collection — customer pays us a lump sum; distribute across outstanding bills (oldest first)
export const collectFromCustomer = async (req, res) => {
    try {
        const { amount, method, note, reference } = req.body;
        const payAmount = Number(amount);

        if (!payAmount || payAmount <= 0) {
            return res.status(400).json({ message: 'Valid payment amount is required' });
        }

        const customer = await Customer.findOne({
            _id: req.params.id,
            business: req.user.businessId,
            isActive: true
        }).lean();

        if (!customer) {
            return res.status(404).json({ message: 'Customer not found' });
        }

        // Fetch outstanding bills — oldest first (FIFO)
        const pendingBills = await Bill.find({
            customer: customer._id,
            business: req.user.businessId,
            status: { $ne: 'cancelled' },
            paymentStatus: { $in: ['unpaid', 'partial'] }
        }).sort({ createdAt: 1 });

        if (pendingBills.length === 0) {
            return res.status(400).json({ message: 'No outstanding bills for this customer' });
        }

        // Use amountDue (authoritative) — accounts for ledger refunds
        const totalOutstanding = pendingBills.reduce(
            (sum, b) => sum + Math.max(0, b.amountDue || 0),
            0
        );

        if (payAmount > totalOutstanding + 0.01) {
            return res.status(400).json({
                message: `Payment amount (Rs ${payAmount}) exceeds total outstanding (Rs ${totalOutstanding.toFixed(2)})`
            });
        }

        const receivedByName = req.user.adminId ? 'Admin' : req.user.name || 'Staff';
        const paymentMethod = method || 'cash';
        const paymentNote = note ? `FIFO collection - ${note}` : 'FIFO collection';

        // Distribute payment across bills in a transaction
        const session = await mongoose.startSession();
        const allocations = [];
        let remainingToAllocate = payAmount;

        try {
            session.startTransaction();

            for (const bill of pendingBills) {
                if (remainingToAllocate <= 0) break;

                // Use amountDue so bills with ledger refunds report the correct
                // remaining balance (skip any with zero or negative due)
                const due = bill.amountDue || 0;
                if (due <= 0.0001) continue;

                const allocate = Math.min(due, remainingToAllocate);
                const previouslyPaid = bill.amountPaid || 0;

                bill.payments.push({
                    amount: allocate,
                    method: paymentMethod,
                    paidAt: new Date(),
                    receivedBy: req.user.id,
                    receivedByName,
                    note: paymentNote,
                    reference: reference || ''
                });

                await bill.save({ session }); // pre-save hook recalculates amountPaid/status; post-save syncs customer.balance

                allocations.push({
                    billId: bill._id,
                    billNumber: bill.billNumber,
                    billDate: bill.createdAt,
                    billTotal: bill.total,
                    allocated: allocate,
                    previouslyPaid,
                    newPaidAmount: bill.amountPaid,
                    newRemainingAmount: bill.total - bill.amountPaid,
                    newStatus: bill.paymentStatus
                });

                remainingToAllocate -= allocate;
            }

            // Record in cashbook (only for cash collections)
            if (paymentMethod === 'cash') {
                await recordCashEntry({
                    type: 'sale_collection',
                    amount: payAmount,
                    direction: 'in',
                    referenceType: 'customer',
                    referenceId: customer._id,
                    referenceNumber: `Customer: ${customer.name}`,
                    description: `Collection from ${customer.name} (${allocations.length} bills)`,
                    note: note || '',
                    performedBy: receivedByName,
                    performedById: req.user.id,
                    businessId: req.user.businessId,
                    session,
                });
            }

            await session.commitTransaction();
        } catch (txError) {
            await session.abortTransaction();
            throw txError;
        } finally {
            session.endSession();
        }

        const fullyPaid = allocations.filter(a => a.newStatus === 'paid').length;
        const partiallyPaid = allocations.filter(a => a.newStatus === 'partial').length;

        res.json({
            message: `Payment of Rs ${payAmount} distributed across ${allocations.length} bill(s)`,
            customer: { _id: customer._id, name: customer.name },
            payment: {
                totalAmount: payAmount,
                method: paymentMethod,
                reference: reference || '',
                paidAt: new Date(),
                receivedByName
            },
            allocations,
            summary: {
                billsAffected: allocations.length,
                billsFullyPaid: fullyPaid,
                billsPartiallyPaid: partiallyPaid,
                outstandingBefore: totalOutstanding,
                outstandingAfter: totalOutstanding - payAmount
            }
        });
    } catch (error) {
        console.error('Error in FIFO collection:', error);
        res.status(500).json({ message: error.message });
    }
};

// Search customers by name or phone
export const searchCustomers = async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.trim().length === 0) {
            return res.json([]);
        }

        const query = q.trim();
        const customers = await Customer.find({
            business: req.user.businessId,
            isActive: true,
            $or: [
                { name: { $regex: query, $options: 'i' } },
                { phone: { $regex: query, $options: 'i' } }
            ]
        }).sort({ name: 1 }).limit(20);

        res.json(customers);
    } catch (error) {
        console.error('Error searching customers:', error);
        res.status(500).json({ message: 'Failed to search customers' });
    }
};
