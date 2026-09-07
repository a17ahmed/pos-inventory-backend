import Customer from '../models/customer.mjs';
import Bill from '../models/bill.mjs';
import Counter from '../models/counter.mjs';
import Payment from '../models/payment.mjs';
import mongoose from 'mongoose';
import { recordCashEntry } from './cashbook.mjs';
import { startOfDay, endOfDay, toLocalDateString, toLocalTimeString } from '../utils/dateHelpers.mjs';

// Create or get customer (upsert by phone + business)
export const createOrGetCustomer = async (req, res) => {
    try {
        const { name, phone, email, address, notes, openingBalance, idempotencyKey } = req.body;

        if (!name || !phone) {
            return res.status(400).json({ message: 'Name and phone are required' });
        }

        // ── Idempotency guard (offline sync) ───────────────────────
        // Replay of a previously-synced create → return the same customer so the
        // client can map its offline temp id (local-…) to the real _id. This is
        // checked in addition to the natural upsert-by-phone dedup below, in case
        // the customer's phone was edited between the original create and a replay.
        if (idempotencyKey) {
            const byKey = await Customer.findOne({
                business: req.user.businessId,
                idempotencyKey,
            });
            if (byKey) {
                return res.status(200).json(byKey);
            }
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

        // Persist the key on insert only, so a later edit/replay never overwrites it.
        // Spread as a whole operator so we never send an empty $setOnInsert (which
        // some MongoDB versions reject).
        const setOnInsert = idempotencyKey ? { $setOnInsert: { idempotencyKey } } : {};

        const obAmount = !existing && openingBalance !== undefined ? Number(openingBalance) : 0;

        if (obAmount > 0) {
            // Use transaction so customer + OB bill are atomic
            const session = await mongoose.startSession();
            try {
                session.startTransaction();

                const customer = await Customer.findOneAndUpdate(
                    { phone: phone.trim(), business: req.user.businessId },
                    { ...updateFields, openingBalance: obAmount, ...setOnInsert },
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
                { ...updateFields, ...setOnInsert },
                { new: true, upsert: true, setDefaultsOnInsert: true }
            );
            res.status(200).json(customer);
        }
    } catch (error) {
        // Race: a concurrent replay won the insert (phone or idempotencyKey
        // unique index). Return the existing record so the client treats it as
        // an idempotent replay rather than a failure.
        if (error.code === 11000) {
            const existing = await Customer.findOne({
                business: req.user.businessId,
                ...(req.body.idempotencyKey
                    ? { idempotencyKey: req.body.idempotencyKey }
                    : { phone: (req.body.phone || '').trim() }),
            });
            if (existing) return res.status(200).json(existing);
        }
        console.error('Error creating/getting customer:', error);
        res.status(500).json({ message: 'Failed to save customer' });
    }
};

// Get all customers with filters and pagination
export const getCustomers = async (req, res) => {
    try {
        const { search, active, hasDues, page = 1 } = req.query;
        // Cap limit to [1,100] so a caller can't request the whole table (?limit=100000).
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
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

        // count + find are independent — run them in parallel to save a round-trip.
        const [total, customers] = await Promise.all([
            Customer.countDocuments(filter),
            Customer.find(filter)
                .sort({ name: 1 })
                .skip(skip)
                .limit(Number(limit))
                .lean(),
        ]);

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

// Lightweight KPI summary for the customers screen. Lets the frontend show
// "Total Customers" and "Outstanding Dues" without downloading every customer
// row and summing client-side. Dues = sum of positive balances of ACTIVE
// customers (credit/negative balances excluded), scoped to active so the figure
// exactly matches the customers list (GET /customer defaults to isActive:true).
export const getCustomerSummary = async (req, res) => {
    try {
        const businessId = req.user.businessId;

        // Scope both figures to ACTIVE customers so they exactly match what the
        // customers list (GET /customer, which defaults to isActive:true) would
        // produce if the client accumulated every page and summed dues itself.
        const [totalCustomers, duesAgg] = await Promise.all([
            Customer.countDocuments({ business: businessId, isActive: true }),
            Customer.aggregate([
                { $match: { business: new mongoose.Types.ObjectId(businessId), isActive: true, balance: { $gt: 0 } } },
                {
                    $group: {
                        _id: null,
                        totalOutstandingDues: { $sum: '$balance' },
                        customersWithDues: { $sum: 1 }
                    }
                }
            ])
        ]);

        res.json({
            totalCustomers,
            totalOutstandingDues: duesAgg[0]?.totalOutstandingDues || 0,
            customersWithDues: duesAgg[0]?.customersWithDues || 0
        });
    } catch (error) {
        console.error('Error fetching customer summary:', error);
        res.status(500).json({ message: 'Failed to fetch customer summary' });
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
                // Track how much outstanding debt remains as we process each return
                // chronologically. This lets us split each return into:
                //   debtWriteOff — portion of outstanding debt cancelled (no cash/credit moves)
                //   storeCredit  — portion the customer actually earns back
                // The full refundAmount is still used as the ledger `credit` so the
                // running balance remains correct.
                let remainingOutstanding = Math.max(0, (bill.total || 0) - (bill.amountPaid || 0));

                const sortedReturns = [...bill.returns].sort(
                    (a, b) => new Date(a.returnedAt || 0) - new Date(b.returnedAt || 0)
                );

                for (const ret of sortedReturns) {
                    const refund = ret.refundAmount || 0;
                    const debtWriteOff = Math.min(remainingOutstanding, refund);
                    const storeCredit = Math.max(0, refund - debtWriteOff);
                    remainingOutstanding = Math.max(0, remainingOutstanding - debtWriteOff);

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
                        credit: refund,        // full item value — drives the running balance
                        storeCredit,           // actual credit customer earns back
                        debtWriteOff,          // outstanding debt that is cancelled
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
        const { amount, method, note, reference, idempotencyKey } = req.body;
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

        // ── Idempotency guard (offline sync) ───────────────────────
        // MUST run before the "no outstanding bills" check below: on replay the
        // first collect already settled the dues, so a naive re-run would 400
        // with "No outstanding bills" and the client would quarantine a valid,
        // already-applied payment. Returning the stored Payment (200) instead
        // lets the client mark it synced. See docs/idempotency.md.
        if (idempotencyKey) {
            const prior = await Payment.findOne({
                business: req.user.businessId,
                idempotencyKey,
            }).lean();
            if (prior) {
                return res.status(200).json(formatCollectReplay(prior, customer));
            }
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

            // Idempotency anchor: one record per keyed collect operation. Created
            // inside the transaction so it commits atomically with the allocations;
            // the partial unique index on (business, idempotencyKey) makes a
            // concurrent replay fail with 11000 (handled in the catch below).
            // Skipped for online collects (no key) so they behave exactly as before.
            if (idempotencyKey) {
                await Payment.create([{
                    business: req.user.businessId,
                    customer: customer._id,
                    amount: payAmount,
                    method: paymentMethod,
                    note: note || '',
                    reference: reference || '',
                    allocations: allocations.map(a => ({
                        billId: a.billId,
                        billNumber: a.billNumber,
                        allocated: a.allocated,
                        newStatus: a.newStatus,
                    })),
                    performedBy: receivedByName,
                    performedById: req.user.id,
                    idempotencyKey,
                }], { session });
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
        // Race: a concurrent replay committed first (duplicate idempotencyKey).
        // Return that Payment so the client treats this as an idempotent replay.
        if (error.code === 11000 && req.body.idempotencyKey) {
            const prior = await Payment.findOne({
                business: req.user.businessId,
                idempotencyKey: req.body.idempotencyKey,
            }).lean();
            if (prior) {
                const customer = await Customer.findOne({
                    _id: req.params.id,
                    business: req.user.businessId,
                }).lean();
                return res.status(200).json(formatCollectReplay(prior, customer));
            }
        }
        console.error('Error in FIFO collection:', error);
        res.status(500).json({ message: error.message });
    }
};

// Build the collect response body from a stored Payment (idempotent replay),
// matching the shape returned by a first-time collect so the client parses it
// the same way. `customer` may be null if it was since deleted.
const formatCollectReplay = (payment, customer) => ({
    message: `Payment of Rs ${payment.amount} already recorded (idempotent replay)`,
    alreadyProcessed: true,
    customer: { _id: payment.customer, name: customer?.name || '' },
    payment: {
        _id: payment._id,
        totalAmount: payment.amount,
        method: payment.method,
        reference: payment.reference || '',
        paidAt: payment.createdAt,
        receivedByName: payment.performedBy || '',
    },
    allocations: payment.allocations || [],
    summary: {
        billsAffected: (payment.allocations || []).length,
    },
});

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
