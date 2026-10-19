import Vendor from '../models/vendor.mjs';
import Supply from '../models/supply.mjs';
import Counter from '../models/counter.mjs';
import mongoose from 'mongoose';
import { recordCashEntry } from './cashbook.mjs';
import CashBook from '../models/cashbook.mjs';
import { startOfDay, endOfDay } from '../utils/dateHelpers.mjs';
import { settleVendorCredit, VENDOR_TOTALS_GROUP, vendorTotals } from '../utils/vendorCredit.mjs';

const creditActor = (req) => ({ name: req.user.adminId ? 'Admin' : req.user.name || 'Staff' });

// Totals for one vendor (amount we owe, vendor credit, …) — see VENDOR_TOTALS_GROUP
const getVendorTotals = async (vendorId, businessId, session = null) => {
    const q = Supply.aggregate([
        { $match: { vendor: new mongoose.Types.ObjectId(vendorId), business: new mongoose.Types.ObjectId(businessId) } },
        { $group: { _id: null, ...VENDOR_TOTALS_GROUP } },
    ]);
    if (session) q.session(session);
    const [row] = await q;
    return vendorTotals(row);
};

// Create vendor
const createVendor = async (req, res) => {
    try {
        const { name, phone, company, address, bankAccount, creditDays, creditLimit, notes, openingBalance } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Vendor name is required' });
        }

        const obAmount = Number(openingBalance) || 0;

        const vendor = new Vendor({
            name: name.trim(),
            phone: phone || '',
            company: company || '',
            address: address || '',
            bankAccount: bankAccount || {},
            creditDays: creditDays || 0,
            creditLimit: creditLimit || 0,
            notes: notes || '',
            openingBalance: obAmount,
            business: req.user.businessId
        });

        if (obAmount > 0) {
            // Use transaction so vendor + OB supply are atomic
            const session = await mongoose.startSession();
            try {
                session.startTransaction();

                await vendor.save({ session });

                const supplyNumber = await Counter.getNextSequence('supplyNumber', req.user.businessId, session);
                const ob = new Supply({
                    supplyNumber,
                    type: 'opening_balance',
                    vendor: vendor._id,
                    vendorName: vendor.name,
                    items: [],
                    totalAmount: obAmount,
                    remainingAmount: obAmount,
                    paidAmount: 0,
                    paymentStatus: 'unpaid',
                    notes: 'Opening balance from previous system',
                    createdBy: 'System',
                    business: req.user.businessId,
                });
                await ob.save({ session });

                await session.commitTransaction();
            } catch (txError) {
                await session.abortTransaction();
                throw txError;
            } finally {
                session.endSession();
            }
        } else {
            await vendor.save();
        }

        res.status(201).json(vendor);
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ message: 'A vendor with this name already exists' });
        }
        res.status(500).json({ message: error.message });
    }
};

// Get all vendors with aggregated supply totals
const getAllVendors = async (req, res) => {
    try {
        const { search, active } = req.query;
        const filter = { business: req.user.businessId };

        if (active !== undefined) {
            filter.isActive = active === 'true';
        } else {
            filter.isActive = true;
        }

        if (search) {
            filter.name = { $regex: search, $options: 'i' };
        }

        // Safety ceiling: bare array, no pagination. Vendors are a small set, so
        // 2000 is a no-op in practice — it only caps a pathological full scan.
        const vendors = await Vendor.find(filter).sort({ name: 1 }).limit(2000).lean();

        // Aggregate supply totals per vendor
        const vendorIds = vendors.map(v => v._id);
        const supplyStats = await Supply.aggregate([
            {
                $match: {
                    business: new mongoose.Types.ObjectId(req.user.businessId),
                    vendor: { $in: vendorIds }
                }
            },
            { $group: { _id: '$vendor', ...VENDOR_TOTALS_GROUP } }
        ]);

        const statsMap = {};
        for (const stat of supplyStats) {
            statsMap[stat._id.toString()] = stat;
        }

        const result = vendors.map(v => ({
            ...v,
            ...vendorTotals(statsMap[v._id.toString()])
        }));

        res.json(result);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Get single vendor with their supplies
const getVendor = async (req, res) => {
    try {
        const vendor = await Vendor.findOne({
            _id: req.params.id,
            business: req.user.businessId
        }).lean();

        if (!vendor) {
            return res.status(404).json({ message: 'Vendor not found' });
        }

        // supplies list + totals aggregate are independent — run in parallel.
        const [supplies, totals] = await Promise.all([
            Supply.find({
                vendor: vendor._id,
                business: req.user.businessId
            }).sort({ createdAt: -1 }),
            getVendorTotals(vendor._id, req.user.businessId),
        ]);

        res.json({
            ...vendor,
            supplies,
            ...totals
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Update vendor
const updateVendor = async (req, res) => {
    try {
        const allowedFields = ['name', 'phone', 'company', 'address', 'bankAccount', 'notes', 'isActive', 'creditDays', 'creditLimit'];
        const updates = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                updates[field] = req.body[field];
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ message: 'No valid fields to update' });
        }

        const vendor = await Vendor.findOneAndUpdate(
            { _id: req.params.id, business: req.user.businessId },
            updates,
            { new: true, runValidators: true }
        );

        if (!vendor) {
            return res.status(404).json({ message: 'Vendor not found' });
        }

        res.json(vendor);
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ message: 'A vendor with this name already exists' });
        }
        res.status(500).json({ message: error.message });
    }
};

// Delete vendor (soft delete)
const deleteVendor = async (req, res) => {
    try {
        const vendor = await Vendor.findOne({
            _id: req.params.id,
            business: req.user.businessId
        });

        if (!vendor) {
            return res.status(404).json({ message: 'Vendor not found' });
        }

        // Check for outstanding balance either way
        const totals = await getVendorTotals(vendor._id, req.user.businessId);

        if (totals.totalRemaining > 0) {
            return res.status(400).json({
                message: `Cannot delete vendor with outstanding balance of Rs ${totals.totalRemaining}`
            });
        }
        if (totals.totalCredit > 0) {
            return res.status(400).json({
                message: `Cannot delete vendor — they still owe you Rs ${totals.totalCredit} in credit from returns`
            });
        }

        vendor.isActive = false;
        await vendor.save();

        res.json({ message: 'Vendor deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Vendor ledger - chronological timeline of supplies + payments with running balance
const getVendorLedger = async (req, res) => {
    try {
        const vendor = await Vendor.findOne({
            _id: req.params.id,
            business: req.user.businessId
        }).lean();

        if (!vendor) {
            return res.status(404).json({ message: 'Vendor not found' });
        }

        const { startDate, endDate } = req.query;

        const supplyFilter = {
            vendor: new mongoose.Types.ObjectId(vendor._id),
            business: new mongoose.Types.ObjectId(req.user.businessId)
        };

        if (startDate || endDate) {
            supplyFilter.billDate = {};
            if (startDate) supplyFilter.billDate.$gte = startOfDay(startDate);
            if (endDate) supplyFilter.billDate.$lte = endOfDay(endDate);
        }

        const supplies = await Supply.find(supplyFilter)
            .sort({ billDate: 1, createdAt: 1 })
            .lean();

        // Build ledger entries: one for each supply + one for each payment
        const ledger = [];

        for (const supply of supplies) {
            // Supply entry (debit - vendor gave us goods, we owe them)
            const isOpeningBalance = supply.type === 'opening_balance';
            ledger.push({
                type: isOpeningBalance ? 'opening_balance' : 'supply',
                date: supply.billDate,
                description: isOpeningBalance ? 'Opening Balance' : `Supply #${supply.supplyNumber}${supply.billNumber ? ` (Bill: ${supply.billNumber})` : ''}`,
                supplyId: supply._id,
                supplyNumber: supply.supplyNumber,
                items: supply.items,
                debit: supply.totalAmount,
                credit: 0,
                notes: supply.notes
            });

            // Payment entries (credit - we paid the vendor)
            // A payment with creditFrom is vendor credit moved in from another
            // supply (no money paid) — paired with that supply's credit_transfer row.
            if (supply.payments && supply.payments.length > 0) {
                for (const payment of supply.payments) {
                    const fromCredit = !!payment.creditFrom;
                    ledger.push({
                        type: 'payment',
                        date: payment.paidAt,
                        description: fromCredit
                            ? `Paid from credit of Supply #${payment.creditFromSupplyNumber}`
                            : `Payment for Supply #${supply.supplyNumber}`,
                        supplyId: supply._id,
                        supplyNumber: supply.supplyNumber,
                        debit: 0,
                        credit: payment.amount,
                        method: payment.method,
                        fromCredit,
                        ...(fromCredit && {
                            creditFromSupplyId: payment.creditFrom,
                            creditFromSupplyNumber: payment.creditFromSupplyNumber
                        }),
                        paidBy: payment.paidBy,
                        reference: payment.reference,
                        notes: payment.note
                    });
                }
            }

            // Credit this supply had (overpaid after a return) moved to another supply
            for (const t of supply.creditTransfers || []) {
                ledger.push({
                    type: 'credit_transfer',
                    date: t.at,
                    description: `Credit from Supply #${supply.supplyNumber} used on Supply #${t.toSupplyNumber}`,
                    supplyId: supply._id,
                    supplyNumber: supply.supplyNumber,
                    toSupplyId: t.toSupply,
                    toSupplyNumber: t.toSupplyNumber,
                    debit: t.amount,
                    credit: 0
                });
            }

            // Return entries (credit - vendor owes us back / reduces what we owe)
            if (supply.returns && supply.returns.length > 0) {
                for (const ret of supply.returns) {
                    ledger.push({
                        type: 'return',
                        date: ret.returnedAt,
                        description: `Return on Supply #${supply.supplyNumber} (${ret.items.length} item${ret.items.length > 1 ? 's' : ''})`,
                        supplyId: supply._id,
                        supplyNumber: supply.supplyNumber,
                        returnItems: ret.items,
                        debit: 0,
                        credit: ret.totalRefund,
                        returnedBy: ret.returnedBy,
                        notes: ret.note
                    });
                }
            }
        }

        // Sort by date, with type priority for same-timestamp entries
        // (debit/supply before credit/payment so running balance makes sense)
        const typePriority = { opening_balance: 0, supply: 1, return: 2, credit_transfer: 3, payment: 4 };
        ledger.sort((a, b) => {
            const dateDiff = new Date(a.date) - new Date(b.date);
            if (dateDiff !== 0) return dateDiff;
            return (typePriority[a.type] || 0) - (typePriority[b.type] || 0);
        });

        // Calculate running balance (credit_transfer + its fromCredit payment net to 0)
        let runningBalance = 0;
        for (const entry of ledger) {
            runningBalance = Math.round((runningBalance + entry.debit - entry.credit) * 100) / 100;
            entry.balance = runningBalance;
        }

        // Summary — credit moved between supplies is neither a supply nor a payment
        const round2 = (x) => Math.round(x * 100) / 100;
        const totalDebit = round2(ledger.filter(e => e.type === 'supply' || e.type === 'opening_balance').reduce((sum, e) => sum + e.debit, 0));
        const totalPaid = round2(ledger.filter(e => e.type === 'payment' && !e.fromCredit).reduce((sum, e) => sum + e.credit, 0));
        const totalReturns = round2(ledger.filter(e => e.type === 'return').reduce((sum, e) => sum + e.credit, 0));
        const totalCredit = totalPaid + totalReturns;
        // Whole-vendor position (not limited by the date filter)
        const totals = await getVendorTotals(vendor._id, req.user.businessId);

        res.json({
            vendor: {
                _id: vendor._id,
                name: vendor.name,
                phone: vendor.phone,
                company: vendor.company
            },
            ledger,
            summary: {
                totalSupplies: totalDebit,
                totalPaid,
                totalReturns,
                currentBalance: round2(totalDebit - totalCredit),
                totalEntries: ledger.length,
                supplyCount: supplies.length,
                // all-time, ignores startDate/endDate:
                amountDue: totals.totalRemaining,   // we owe the vendor
                vendorCredit: totals.totalCredit,   // vendor owes us (returns on paid supplies)
                netBalance: totals.netBalance       // amountDue − vendorCredit
            }
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// FIFO vendor payment - distribute lump sum across pending supplies (oldest first)
const payVendor = async (req, res) => {
    try {
        const { amount, method, note, reference } = req.body;
        const payAmount = Number(amount);

        if (!payAmount || payAmount <= 0) {
            return res.status(400).json({ message: 'Valid payment amount is required' });
        }

        const vendor = await Vendor.findOne({
            _id: req.params.id,
            business: req.user.businessId,
            isActive: true
        }).lean();

        if (!vendor) {
            return res.status(404).json({ message: 'Vendor not found' });
        }

        const paidBy = req.user.adminId ? 'Admin' : req.user.name || '';
        const paymentMethod = method || 'cash';
        const paymentNote = note ? `FIFO vendor payment - ${note}` : 'FIFO vendor payment';

        // Distribute payment across supplies in a transaction
        const session = await mongoose.startSession();
        const allocations = [];
        let creditApplied = [];
        let totalOutstanding = 0;
        let remainingToAllocate = payAmount;

        try {
            session.startTransaction();

            const reject = async (status, message) => {
                await session.abortTransaction();
                // finally block handles session.endSession()
                return res.status(status).json({ message });
            };

            // Credit the vendor owes us (returns on paid supplies) is used first
            creditApplied = await settleVendorCredit({
                vendorId: vendor._id,
                businessId: req.user.businessId,
                session,
                actor: creditActor(req),
            });
            const creditNote = creditApplied.length > 0
                ? ` (Rs ${Math.round(creditApplied.reduce((sum, m) => sum + m.amount, 0) * 100) / 100} vendor credit was applied first)`
                : '';

            // Fetch pending supplies — oldest first (FIFO)
            const pendingSupplies = await Supply.find({
                vendor: vendor._id,
                business: req.user.businessId,
                paymentStatus: { $in: ['unpaid', 'partial'] }
            }).sort({ billDate: 1, createdAt: 1 }).session(session);

            if (pendingSupplies.length === 0) {
                return await reject(400, `No pending supplies for this vendor${creditNote}`);
            }

            totalOutstanding = Math.round(pendingSupplies.reduce((sum, s) => sum + s.remainingAmount, 0) * 100) / 100;

            if (payAmount > totalOutstanding + 0.005) {
                return await reject(400, `Payment amount (Rs ${payAmount}) exceeds total outstanding (Rs ${totalOutstanding})${creditNote}`);
            }

            // Cash balance check — ensure enough cash in hand for cash payments
            if (paymentMethod === 'cash') {
                const latest = await CashBook.findOne({ business: req.user.businessId })
                    .sort({ createdAt: -1, entryNumber: -1 })
                    .select('runningBalance')
                    .session(session)
                    .lean();
                const cashBalance = latest?.runningBalance ?? 0;
                if (payAmount > cashBalance) {
                    return await reject(400, `Insufficient cash in hand. Available: Rs ${cashBalance.toLocaleString()}, Required: Rs ${payAmount.toLocaleString()}`);
                }
            }

            for (const supply of pendingSupplies) {
                if (remainingToAllocate <= 0.005) break;

                const allocate = Math.round(Math.min(supply.remainingAmount, remainingToAllocate) * 100) / 100;
                const previouslyPaid = supply.paidAmount;

                supply.payments.push({
                    amount: allocate,
                    method: paymentMethod,
                    paidAt: new Date(),
                    paidBy,
                    note: paymentNote,
                    reference: reference || ''
                });

                await supply.save({ session }); // pre-save hook recalculates everything

                allocations.push({
                    supplyId: supply._id,
                    supplyNumber: supply.supplyNumber,
                    billNumber: supply.billNumber,
                    billDate: supply.billDate,
                    supplyTotal: supply.totalAmount,
                    allocated: allocate,
                    previouslyPaid,
                    newPaidAmount: supply.paidAmount,
                    newRemainingAmount: supply.remainingAmount,
                    newStatus: supply.paymentStatus
                });

                remainingToAllocate = Math.round((remainingToAllocate - allocate) * 100) / 100;
            }

            // Record in cashbook (only for cash payments)
            if (paymentMethod === 'cash') {
                await recordCashEntry({
                    type: 'vendor_payment',
                    amount: payAmount,
                    direction: 'out',
                    referenceType: 'vendor',
                    referenceId: vendor._id,
                    referenceNumber: `Vendor: ${vendor.name}`,
                    description: `Vendor payment to ${vendor.name} (${allocations.length} supplies)`,
                    note: note || '',
                    performedBy: paidBy,
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
            message: `Payment of Rs ${payAmount} distributed across ${allocations.length} supplies`,
            vendor: { _id: vendor._id, name: vendor.name },
            payment: {
                totalAmount: payAmount,
                method: paymentMethod,
                reference: reference || '',
                paidAt: new Date(),
                paidBy
            },
            allocations,
            creditApplied,   // [{ fromNumber, toNumber, amount }] vendor credit used before this payment
            summary: {
                suppliesAffected: allocations.length,
                suppliesFullyPaid: fullyPaid,
                suppliesPartiallyPaid: partiallyPaid,
                outstandingBefore: totalOutstanding,
                outstandingAfter: Math.round((totalOutstanding - payAmount) * 100) / 100
            }
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

export { createVendor, getAllVendors, getVendor, updateVendor, deleteVendor, getVendorLedger, payVendor };
