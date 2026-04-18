import Vendor from '../models/vendor.mjs';
import Supply from '../models/supply.mjs';
import Counter from '../models/counter.mjs';
import mongoose from 'mongoose';
import { recordCashEntry } from './cashbook.mjs';
import { startOfDay, endOfDay } from '../utils/dateHelpers.mjs';

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

        const vendors = await Vendor.find(filter).sort({ name: 1 }).lean();

        // Aggregate supply totals per vendor
        const vendorIds = vendors.map(v => v._id);
        const supplyStats = await Supply.aggregate([
            {
                $match: {
                    business: new mongoose.Types.ObjectId(req.user.businessId),
                    vendor: { $in: vendorIds }
                }
            },
            {
                $group: {
                    _id: '$vendor',
                    totalBusiness: { $sum: '$totalAmount' },
                    totalPaid: { $sum: '$paidAmount' },
                    totalRemaining: { $sum: '$remainingAmount' },
                    supplyCount: { $sum: 1 }
                }
            }
        ]);

        const statsMap = {};
        for (const stat of supplyStats) {
            statsMap[stat._id.toString()] = stat;
        }

        const result = vendors.map(v => ({
            ...v,
            totalBusiness: statsMap[v._id.toString()]?.totalBusiness || 0,
            totalPaid: statsMap[v._id.toString()]?.totalPaid || 0,
            totalRemaining: statsMap[v._id.toString()]?.totalRemaining || 0,
            supplyCount: statsMap[v._id.toString()]?.supplyCount || 0
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

        const supplies = await Supply.find({
            vendor: vendor._id,
            business: req.user.businessId
        }).sort({ createdAt: -1 });

        const totals = await Supply.aggregate([
            {
                $match: {
                    vendor: new mongoose.Types.ObjectId(vendor._id),
                    business: new mongoose.Types.ObjectId(req.user.businessId)
                }
            },
            {
                $group: {
                    _id: null,
                    totalBusiness: { $sum: '$totalAmount' },
                    totalPaid: { $sum: '$paidAmount' },
                    totalRemaining: { $sum: '$remainingAmount' },
                    supplyCount: { $sum: 1 }
                }
            }
        ]);

        res.json({
            ...vendor,
            supplies,
            totalBusiness: totals[0]?.totalBusiness || 0,
            totalPaid: totals[0]?.totalPaid || 0,
            totalRemaining: totals[0]?.totalRemaining || 0,
            supplyCount: totals[0]?.supplyCount || 0
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

        // Check for outstanding balance
        const outstanding = await Supply.aggregate([
            {
                $match: {
                    vendor: new mongoose.Types.ObjectId(vendor._id),
                    business: new mongoose.Types.ObjectId(req.user.businessId),
                    paymentStatus: { $nin: ['paid', 'returned'] }
                }
            },
            {
                $group: {
                    _id: null,
                    totalRemaining: { $sum: '$remainingAmount' }
                }
            }
        ]);

        if (outstanding[0]?.totalRemaining > 0) {
            return res.status(400).json({
                message: `Cannot delete vendor with outstanding balance of Rs ${outstanding[0].totalRemaining}`
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
            if (supply.payments && supply.payments.length > 0) {
                for (const payment of supply.payments) {
                    ledger.push({
                        type: 'payment',
                        date: payment.paidAt,
                        description: `Payment for Supply #${supply.supplyNumber}`,
                        supplyId: supply._id,
                        supplyNumber: supply.supplyNumber,
                        debit: 0,
                        credit: payment.amount,
                        method: payment.method,
                        paidBy: payment.paidBy,
                        reference: payment.reference,
                        notes: payment.note
                    });
                }
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

        // Sort by date
        ledger.sort((a, b) => new Date(a.date) - new Date(b.date));

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
                currentBalance: totalDebit - totalCredit,
                totalEntries: ledger.length,
                supplyCount: supplies.length
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

        // Fetch pending supplies — oldest first (FIFO)
        const pendingSupplies = await Supply.find({
            vendor: vendor._id,
            business: req.user.businessId,
            paymentStatus: { $in: ['unpaid', 'partial'] }
        }).sort({ billDate: 1, createdAt: 1 });

        if (pendingSupplies.length === 0) {
            return res.status(400).json({ message: 'No pending supplies for this vendor' });
        }

        const totalOutstanding = pendingSupplies.reduce((sum, s) => sum + s.remainingAmount, 0);

        if (payAmount > totalOutstanding) {
            return res.status(400).json({
                message: `Payment amount (Rs ${payAmount}) exceeds total outstanding (Rs ${totalOutstanding})`
            });
        }

        const paidBy = req.user.adminId ? 'Admin' : req.user.name || '';
        const paymentMethod = method || 'cash';
        const paymentNote = note ? `FIFO vendor payment - ${note}` : 'FIFO vendor payment';

        // Cash balance check — ensure enough cash in hand for cash payments
        if (paymentMethod === 'cash') {
            const CashBook = (await import('../models/cashbook.mjs')).default;
            const latest = await CashBook.findOne({ business: req.user.businessId })
                .sort({ createdAt: -1, entryNumber: -1 })
                .select('runningBalance')
                .lean();
            const cashBalance = latest?.runningBalance ?? 0;
            if (payAmount > cashBalance) {
                return res.status(400).json({
                    message: `Insufficient cash in hand. Available: Rs ${cashBalance.toLocaleString()}, Required: Rs ${payAmount.toLocaleString()}`,
                });
            }
        }

        // Distribute payment across supplies in a transaction
        const session = await mongoose.startSession();
        const allocations = [];
        let remainingToAllocate = payAmount;

        try {
            session.startTransaction();

            for (const supply of pendingSupplies) {
                if (remainingToAllocate <= 0) break;

                const allocate = Math.min(supply.remainingAmount, remainingToAllocate);
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

                remainingToAllocate -= allocate;
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
            summary: {
                suppliesAffected: allocations.length,
                suppliesFullyPaid: fullyPaid,
                suppliesPartiallyPaid: partiallyPaid,
                outstandingBefore: totalOutstanding,
                outstandingAfter: totalOutstanding - payAmount
            }
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

export { createVendor, getAllVendors, getVendor, updateVendor, deleteVendor, getVendorLedger, payVendor };
