import Supply from '../models/supply.mjs';
import Vendor from '../models/vendor.mjs';
import Product from '../models/product.mjs';
import Counter from '../models/counter.mjs';
import StockMovement from '../models/stockMovement.mjs';
import mongoose from 'mongoose';
import { cloudinary } from '../middleware/upload.mjs';
import CashBook from '../models/cashbook.mjs';
import { recordCashEntry } from './cashbook.mjs';
import { startOfDay, endOfDay } from '../utils/dateHelpers.mjs';

// Helper: log stock movements in bulk
// When session is provided (inside transaction), errors propagate to trigger abort.
// When no session (standalone), errors are logged but swallowed (fire-and-forget).
const logStockMovements = async (entries, session = null) => {
    try {
        if (entries.length > 0) {
            await StockMovement.insertMany(entries, session ? { session } : {});
        }
    } catch (err) {
        if (session) throw err; // Let transaction handle it
        console.error('Stock movement logging failed:', err.message);
    }
};

// Create supply
const createSupply = async (req, res) => {
    try {
        let { vendor, vendorName, billNumber, billDate, items, totalAmount, paidAmount, notes } = req.body;

        // Parse items if sent as string (multipart/form-data)
        if (typeof items === 'string') {
            items = JSON.parse(items);
        }

        if (!vendor) {
            return res.status(400).json({ message: 'Vendor is required' });
        }

        if (!items || items.length === 0) {
            return res.status(400).json({ message: 'At least one item is required' });
        }

        // Validate vendor belongs to this business
        const vendorDoc = await Vendor.findOne({
            _id: vendor,
            business: req.user.businessId,
            isActive: true
        });

        if (!vendorDoc) {
            return res.status(404).json({ message: 'Vendor not found' });
        }

        // Validate all product IDs belong to this business
        const productIds = items.map(item => item.product).filter(Boolean);
        if (productIds.length !== items.length) {
            return res.status(400).json({ message: 'Each item must have a product ID' });
        }

        const uniqueProductIds = [...new Set(productIds)];
        const products = await Product.find({
            _id: { $in: uniqueProductIds },
            business: req.user.businessId
        });

        if (products.length !== uniqueProductIds.length) {
            return res.status(400).json({ message: 'One or more products not found in this business' });
        }

        const productMap = new Map(products.map(p => [p._id.toString(), p]));

        // Calculate item totals with GST
        const processedItems = items.map(item => {
            const product = productMap.get(item.product.toString());
            const qty = Number(item.quantity);
            const price = Number(item.unitPrice);
            const gst = Number(item.gst) || 0;
            const lineTotal = qty * price;
            const gstAmount = gst > 0 ? Math.round((lineTotal * gst / 100) * 100) / 100 : 0;
            return {
                product: product._id,
                name: product.name,
                quantity: qty,
                unitPrice: price,
                gst,
                gstAmount,
                total: lineTotal + gstAmount
            };
        });

        const calculatedTotal = processedItems.reduce((sum, item) => sum + item.total, 0);

        // Credit limit validation
        if (vendorDoc.creditLimit > 0) {
            const outstanding = await Supply.aggregate([
                {
                    $match: {
                        vendor: vendorDoc._id,
                        business: new mongoose.Types.ObjectId(req.user.businessId),
                        paymentStatus: { $nin: ['paid', 'returned'] }
                    }
                },
                { $group: { _id: null, totalRemaining: { $sum: '$remainingAmount' } } }
            ]);
            const currentOutstanding = outstanding[0]?.totalRemaining || 0;
            const newRemaining = calculatedTotal - (Number(paidAmount) || 0);
            if (currentOutstanding + newRemaining > vendorDoc.creditLimit) {
                return res.status(400).json({
                    message: `Credit limit exceeded. Vendor limit: Rs ${vendorDoc.creditLimit}, Outstanding: Rs ${currentOutstanding}, New balance: Rs ${newRemaining}`
                });
            }
        }

        // Build initial payment if paidAmount provided
        const payments = [];
        const initialPaid = Number(paidAmount) || 0;
        const supplyPayMethod = req.body.paymentMethod || 'cash';
        if (initialPaid > 0) {
            payments.push({
                amount: initialPaid,
                method: supplyPayMethod,
                paidAt: new Date(),
                paidBy: req.user.adminId ? 'Admin' : req.user.name || '',
                note: 'Initial payment on supply creation',
                reference: req.body.paymentReference || ''
            });
        }

        // ── Auto-update product stock + costPrice ────────────────
        const stockOps = processedItems
            .filter(i => i.product)
            .map(i => ({
                updateOne: {
                    filter: { _id: i.product, business: req.user.businessId, trackStock: true },
                    update: {
                        $inc: { stockQuantity: i.quantity },
                        $set: { costPrice: i.unitPrice }
                    }
                }
            }));

        const session = await mongoose.startSession();
        let supply;
        try {
            session.startTransaction();

            const supplyNumber = await Counter.getNextSequence('supplyNumber', req.user.businessId, session);

            supply = new Supply({
                supplyNumber,
                vendor: vendorDoc._id,
                vendorName: vendorDoc.name,
                billNumber: billNumber || '',
                billDate: billDate || new Date(),
                items: processedItems,
                totalAmount: calculatedTotal,
                paidAmount: initialPaid,
                payments,
                notes: notes || '',
                receiptImage: req.file ? req.file.path : null,
                createdBy: req.user.adminId ? 'Admin' : req.user.name || '',
                business: req.user.businessId
            });

            await supply.save({ session });

            if (stockOps.length > 0) {
                await Product.bulkWrite(stockOps, { session });

                // Log stock movements
                const updatedProducts = await Product.find(
                    { _id: { $in: processedItems.map(i => i.product) }, business: req.user.businessId },
                    { stockQuantity: 1 }
                ).session(session).lean();
                const stockMap = new Map(updatedProducts.map(p => [p._id.toString(), p.stockQuantity]));

                const movements = processedItems.map(i => ({
                    product: i.product,
                    productName: i.name,
                    type: 'supply_in',
                    quantity: i.quantity,
                    previousStock: (stockMap.get(i.product.toString()) || 0) - i.quantity,
                    newStock: stockMap.get(i.product.toString()) || 0,
                    referenceType: 'supply',
                    referenceId: supply._id,
                    referenceNumber: `SUP-${supply.supplyNumber}`,
                    unitPrice: i.unitPrice,
                    reason: 'New supply received',
                    performedBy: req.user.adminId ? 'Admin' : req.user.name || '',
                    business: req.user.businessId
                }));
                await logStockMovements(movements, session);
            }

            // Record initial cash payment in cashbook
            if (initialPaid > 0 && supplyPayMethod === 'cash') {
                await recordCashEntry({
                    type: 'vendor_payment',
                    amount: initialPaid,
                    direction: 'out',
                    referenceType: 'supply',
                    referenceId: supply._id,
                    referenceNumber: `Supply #${supply.supplyNumber}`,
                    description: `Supply payment - ${vendorDoc.name} (Supply #${supply.supplyNumber})`,
                    note: 'Initial payment on supply creation',
                    performedBy: req.user.adminId ? 'Admin' : req.user.name || '',
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

        res.status(201).json(supply);
    } catch (error) {
        console.error('[Supply]', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Get all supplies
const getAllSupplies = async (req, res) => {
    try {
        const { vendor, paymentStatus, startDate, endDate, page = 1, limit = 50 } = req.query;
        const filter = { business: req.user.businessId, type: { $ne: 'opening_balance' } };

        if (vendor) filter.vendor = vendor;
        if (paymentStatus) filter.paymentStatus = paymentStatus;
        if (startDate || endDate) {
            filter.billDate = {};
            if (startDate) filter.billDate.$gte = startOfDay(startDate);
            if (endDate) filter.billDate.$lte = endOfDay(endDate);
        }

        const skip = (Number(page) - 1) * Number(limit);
        const total = await Supply.countDocuments(filter);

        const supplies = await Supply.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit))
            .populate('vendor', 'name phone company');

        res.json({
            supplies,
            total,
            page: Number(page),
            totalPages: Math.ceil(total / Number(limit))
        });
    } catch (error) {
        console.error('[Supply]', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Get single supply
const getSupply = async (req, res) => {
    try {
        const supply = await Supply.findOne({
            _id: req.params.id,
            business: req.user.businessId
        }).populate('vendor', 'name phone company');

        if (!supply) {
            return res.status(404).json({ message: 'Supply not found' });
        }

        res.json(supply);
    } catch (error) {
        console.error('[Supply]', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Update supply
const updateSupply = async (req, res) => {
    try {
        const supply = await Supply.findOne({
            _id: req.params.id,
            business: req.user.businessId
        });

        if (!supply) {
            return res.status(404).json({ message: 'Supply not found' });
        }

        let { billNumber, billDate, items, paidAmount, notes } = req.body;

        if (typeof items === 'string') {
            items = JSON.parse(items);
        }

        if (billNumber !== undefined) supply.billNumber = billNumber;
        if (billDate !== undefined) supply.billDate = billDate;
        if (notes !== undefined) supply.notes = notes;
        if (paidAmount !== undefined) supply.paidAmount = Number(paidAmount);

        // Track old image for cleanup after successful commit
        let oldImageToDelete = null;
        if (req.file) {
            if (supply.receiptImage) {
                oldImageToDelete = supply.receiptImage;
            }
            supply.receiptImage = req.file.path;
        }

        if (items && items.length > 0) {
            const productIds = items.map(item => item.product).filter(Boolean);
            if (productIds.length !== items.length) {
                return res.status(400).json({ message: 'Each item must have a product ID' });
            }

            const products = await Product.find({
                _id: { $in: productIds },
                business: req.user.businessId
            });

            if (products.length !== productIds.length) {
                return res.status(400).json({ message: 'One or more products not found in this business' });
            }

            // ── Reverse old stock from previous items ────────────
            const oldItems = supply.items.filter(i => i.product);
            const reverseOps = oldItems.map(i => ({
                updateOne: {
                    filter: { _id: i.product, business: req.user.businessId, trackStock: true },
                    update: { $inc: { stockQuantity: -i.quantity } }
                }
            }));

            const productMap = new Map(products.map(p => [p._id.toString(), p]));

            const newItems = items.map(item => {
                const product = productMap.get(item.product.toString());
                const qty = Number(item.quantity);
                const price = Number(item.unitPrice);
                const gst = Number(item.gst) || 0;
                const lineTotal = qty * price;
                const gstAmount = gst > 0 ? Math.round((lineTotal * gst / 100) * 100) / 100 : 0;
                return {
                    product: product._id,
                    name: product.name,
                    quantity: qty,
                    unitPrice: price,
                    gst,
                    gstAmount,
                    total: lineTotal + gstAmount
                };
            });

            supply.items = newItems;
            supply.totalAmount = newItems.reduce((sum, item) => sum + item.total, 0);

            // ── Apply new stock + costPrice ──────────────────────
            const addOps = newItems
                .filter(i => i.product)
                .map(i => ({
                    updateOne: {
                        filter: { _id: i.product, business: req.user.businessId, trackStock: true },
                        update: {
                            $inc: { stockQuantity: i.quantity },
                            $set: { costPrice: i.unitPrice }
                        }
                    }
                }));

            // ── Transaction: reverse old stock → add new stock → save supply ──
            const session = await mongoose.startSession();
            try {
                session.startTransaction();

                if (reverseOps.length > 0) {
                    await Product.bulkWrite(reverseOps, { session });
                    const reversedProducts = await Product.find(
                        { _id: { $in: oldItems.map(i => i.product) }, business: req.user.businessId },
                        { stockQuantity: 1 }
                    ).session(session).lean();
                    const reverseStockMap = new Map(reversedProducts.map(p => [p._id.toString(), p.stockQuantity]));
                    await logStockMovements(oldItems.map(i => ({
                        product: i.product,
                        productName: i.name,
                        type: 'supply_update_reverse',
                        quantity: -i.quantity,
                        previousStock: (reverseStockMap.get(i.product.toString()) || 0) + i.quantity,
                        newStock: reverseStockMap.get(i.product.toString()) || 0,
                        referenceType: 'supply',
                        referenceId: supply._id,
                        referenceNumber: `SUP-${supply.supplyNumber}`,
                        unitPrice: i.unitPrice,
                        reason: 'Supply update - reversing old items',
                        performedBy: req.user.adminId ? 'Admin' : req.user.name || '',
                        business: req.user.businessId
                    })), session);
                }

                if (addOps.length > 0) {
                    await Product.bulkWrite(addOps, { session });
                    const addedProducts = await Product.find(
                        { _id: { $in: newItems.map(i => i.product) }, business: req.user.businessId },
                        { stockQuantity: 1 }
                    ).session(session).lean();
                    const addStockMap = new Map(addedProducts.map(p => [p._id.toString(), p.stockQuantity]));
                    await logStockMovements(newItems.map(i => ({
                        product: i.product,
                        productName: i.name,
                        type: 'supply_update_add',
                        quantity: i.quantity,
                        previousStock: (addStockMap.get(i.product.toString()) || 0) - i.quantity,
                        newStock: addStockMap.get(i.product.toString()) || 0,
                        referenceType: 'supply',
                        referenceId: supply._id,
                        referenceNumber: `SUP-${supply.supplyNumber}`,
                        unitPrice: i.unitPrice,
                        reason: 'Supply update - applying new items',
                        performedBy: req.user.adminId ? 'Admin' : req.user.name || '',
                        business: req.user.businessId
                    })), session);
                }

                await supply.save({ session });
                await session.commitTransaction();
            } catch (txError) {
                await session.abortTransaction();
                throw txError;
            } finally {
                session.endSession();
            }
        } else {
            // No item changes — just save the supply (billNumber, notes, etc.)
            await supply.save();
        }

        // Clean up old Cloudinary image only after successful save/commit
        if (oldImageToDelete) {
            const publicId = oldImageToDelete.split('/').slice(-2).join('/').split('.')[0];
            cloudinary.uploader.destroy(publicId).catch(() => {});
        }

        res.json(supply);
    } catch (error) {
        console.error('[Supply]', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Record payment on a supply
const recordPayment = async (req, res) => {
    try {
        const { amount, method, note, reference } = req.body;

        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({ message: 'Valid payment amount is required' });
        }

        const supply = await Supply.findOne({
            _id: req.params.id,
            business: req.user.businessId
        });

        if (!supply) {
            return res.status(404).json({ message: 'Supply not found' });
        }

        if (supply.paymentStatus === 'paid') {
            return res.status(400).json({ message: 'This supply is already fully paid' });
        }

        if (supply.paymentStatus === 'returned') {
            return res.status(400).json({ message: 'This supply has been fully returned. No payment needed.' });
        }

        if (Number(amount) > supply.remainingAmount) {
            return res.status(400).json({
                message: `Payment amount cannot exceed remaining balance of Rs ${supply.remainingAmount}`
            });
        }

        const paymentMethod = method || 'cash';
        const payAmount = Number(amount);

        // Cash balance check
        if (paymentMethod === 'cash') {
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

        const paidBy = req.user.adminId ? 'Admin' : req.user.name || '';

        supply.payments.push({
            amount: payAmount,
            method: paymentMethod,
            paidAt: new Date(),
            paidBy,
            note: note || '',
            reference: reference || ''
        });

        // Use transaction for cash payments (supply + cashbook must be atomic)
        if (paymentMethod === 'cash') {
            const session = await mongoose.startSession();
            try {
                session.startTransaction();
                await supply.save({ session });
                await recordCashEntry({
                    type: 'vendor_payment',
                    amount: payAmount,
                    direction: 'out',
                    referenceType: 'supply',
                    referenceId: supply._id,
                    referenceNumber: `Supply #${supply.supplyNumber}`,
                    description: `Supply payment - ${supply.vendorName || 'Vendor'} (Supply #${supply.supplyNumber})`,
                    note: note || '',
                    performedBy: paidBy,
                    performedById: req.user.id,
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
            await supply.save();
        }

        res.json(supply);
    } catch (error) {
        console.error('[Supply]', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Delete supply
const deleteSupply = async (req, res) => {
    try {
        const supply = await Supply.findOne({
            _id: req.params.id,
            business: req.user.businessId
        });

        if (!supply) {
            return res.status(404).json({ message: 'Supply not found' });
        }

        // Delete receipt image from Cloudinary if exists (outside transaction — external service)
        if (supply.receiptImage) {
            const publicId = supply.receiptImage.split('/').slice(-2).join('/').split('.')[0];
            await cloudinary.uploader.destroy(publicId).catch(() => {});
        }

        // ── Reverse stock that was added by this supply ─────────
        const deleteItems = supply.items.filter(i => i.product);
        const reverseOps = deleteItems.map(i => ({
            updateOne: {
                filter: { _id: i.product, business: req.user.businessId, trackStock: true },
                update: { $inc: { stockQuantity: -i.quantity } }
            }
        }));

        const session = await mongoose.startSession();
        try {
            session.startTransaction();

            if (reverseOps.length > 0) {
                await Product.bulkWrite(reverseOps, { session });
                const deletedProducts = await Product.find(
                    { _id: { $in: deleteItems.map(i => i.product) }, business: req.user.businessId },
                    { stockQuantity: 1 }
                ).session(session).lean();
                const delStockMap = new Map(deletedProducts.map(p => [p._id.toString(), p.stockQuantity]));
                await logStockMovements(deleteItems.map(i => ({
                    product: i.product,
                    productName: i.name,
                    type: 'supply_delete',
                    quantity: -i.quantity,
                    previousStock: (delStockMap.get(i.product.toString()) || 0) + i.quantity,
                    newStock: delStockMap.get(i.product.toString()) || 0,
                    referenceType: 'supply',
                    referenceId: supply._id,
                    referenceNumber: `SUP-${supply.supplyNumber}`,
                    unitPrice: i.unitPrice,
                    reason: 'Supply deleted',
                    performedBy: req.user.adminId ? 'Admin' : req.user.name || '',
                    business: req.user.businessId
                })), session);
            }

            // Reverse cashbook entries for cash payments
            const cashTotal = supply.payments
                .filter(p => p.method === 'cash')
                .reduce((sum, p) => sum + p.amount, 0);
            if (cashTotal > 0) {
                await recordCashEntry({
                    type: 'vendor_payment_reversal',
                    amount: cashTotal,
                    direction: 'in',
                    referenceType: 'supply',
                    referenceId: supply._id,
                    referenceNumber: `Supply #${supply.supplyNumber}`,
                    description: `Reversed: Supply #${supply.supplyNumber} deleted`,
                    note: 'Supply deleted',
                    performedBy: req.user.adminId ? 'Admin' : req.user.name || '',
                    performedById: req.user.id,
                    businessId: req.user.businessId,
                    session,
                });
            }

            await Supply.deleteOne({ _id: supply._id }, { session });
            await session.commitTransaction();
        } catch (txError) {
            await session.abortTransaction();
            throw txError;
        } finally {
            session.endSession();
        }

        res.json({ message: 'Supply deleted successfully' });
    } catch (error) {
        console.error('[Supply]', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Get supply stats
const getSupplyStats = async (req, res) => {
    try {
        const businessId = new mongoose.Types.ObjectId(req.user.businessId);
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay());
        startOfWeek.setHours(0, 0, 0, 0);

        const [overall, thisMonth, thisWeek, byVendor, byStatus] = await Promise.all([
            // Overall totals
            Supply.aggregate([
                { $match: { business: businessId, type: { $ne: 'opening_balance' } } },
                {
                    $group: {
                        _id: null,
                        totalAmount: { $sum: '$totalAmount' },
                        totalPaid: { $sum: '$paidAmount' },
                        totalRemaining: { $sum: '$remainingAmount' },
                        count: { $sum: 1 }
                    }
                }
            ]),
            // This month
            Supply.aggregate([
                { $match: { business: businessId, type: { $ne: 'opening_balance' }, billDate: { $gte: startOfMonth } } },
                {
                    $group: {
                        _id: null,
                        totalAmount: { $sum: '$totalAmount' },
                        totalPaid: { $sum: '$paidAmount' },
                        totalRemaining: { $sum: '$remainingAmount' },
                        count: { $sum: 1 }
                    }
                }
            ]),
            // This week
            Supply.aggregate([
                { $match: { business: businessId, type: { $ne: 'opening_balance' }, billDate: { $gte: startOfWeek } } },
                {
                    $group: {
                        _id: null,
                        totalAmount: { $sum: '$totalAmount' },
                        count: { $sum: 1 }
                    }
                }
            ]),
            // By vendor (top 10)
            Supply.aggregate([
                { $match: { business: businessId, type: { $ne: 'opening_balance' } } },
                {
                    $group: {
                        _id: '$vendor',
                        vendorName: { $first: '$vendorName' },
                        totalAmount: { $sum: '$totalAmount' },
                        totalPaid: { $sum: '$paidAmount' },
                        totalRemaining: { $sum: '$remainingAmount' },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { totalAmount: -1 } },
                { $limit: 10 }
            ]),
            // By payment status
            Supply.aggregate([
                { $match: { business: businessId, type: { $ne: 'opening_balance' } } },
                {
                    $group: {
                        _id: '$paymentStatus',
                        count: { $sum: 1 },
                        totalAmount: { $sum: '$totalAmount' }
                    }
                }
            ])
        ]);

        res.json({
            overall: overall[0] || { totalAmount: 0, totalPaid: 0, totalRemaining: 0, count: 0 },
            thisMonth: thisMonth[0] || { totalAmount: 0, totalPaid: 0, totalRemaining: 0, count: 0 },
            thisWeek: thisWeek[0] || { totalAmount: 0, count: 0 },
            byVendor,
            byStatus
        });
    } catch (error) {
        console.error('[Supply]', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Process supply return (partial or full)
const processSupplyReturn = async (req, res) => {
    try {
        const { items, note } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ message: 'At least one return item is required' });
        }

        const supply = await Supply.findOne({
            _id: req.params.id,
            business: req.user.businessId
        });

        if (!supply) {
            return res.status(404).json({ message: 'Supply not found' });
        }

        // Build a map of supply items by product ID for quick lookup
        const supplyItemMap = new Map();
        for (const item of supply.items) {
            supplyItemMap.set(item.product.toString(), item);
        }

        // Validate return items
        const returnItems = [];
        let totalRefund = 0;

        for (const retItem of items) {
            if (!retItem.product) {
                return res.status(400).json({ message: 'Each return item must have a product ID' });
            }

            const supplyItem = supplyItemMap.get(retItem.product.toString());
            if (!supplyItem) {
                return res.status(400).json({ message: `Product ${retItem.product} not found in this supply` });
            }

            const returnQty = Number(retItem.quantity);
            if (!returnQty || returnQty <= 0) {
                return res.status(400).json({ message: 'Return quantity must be greater than 0' });
            }

            const availableQty = supplyItem.quantity - (supplyItem.returnedQty || 0);
            if (returnQty > availableQty) {
                return res.status(400).json({
                    message: `Cannot return ${returnQty} of "${supplyItem.name}". Only ${availableQty} available for return.`
                });
            }

            const baseCost = returnQty * supplyItem.unitPrice;
            const gstRefund = supplyItem.gst > 0
                ? Math.round((baseCost * supplyItem.gst / 100) * 100) / 100
                : 0;
            const refundAmount = baseCost + gstRefund;
            totalRefund += refundAmount;

            returnItems.push({
                product: supplyItem.product,
                name: supplyItem.name,
                quantity: returnQty,
                unitPrice: supplyItem.unitPrice,
                refundAmount,
                reason: retItem.reason || 'defective'
            });

            // Update returnedQty on the supply item
            supplyItem.returnedQty = (supplyItem.returnedQty || 0) + returnQty;
        }

        // Push the return record
        supply.returns.push({
            items: returnItems,
            totalRefund,
            returnedAt: new Date(),
            returnedBy: req.user.adminId ? 'Admin' : req.user.name || '',
            note: note || ''
        });

        // Reverse stock for returned items
        const returnStockItems = returnItems.filter(i => i.product);
        const stockOps = returnStockItems.map(i => ({
            updateOne: {
                filter: { _id: i.product, business: req.user.businessId, trackStock: true },
                update: { $inc: { stockQuantity: -i.quantity } }
            }
        }));

        // pre-save hook recalculates totalReturned, remainingAmount, paymentStatus
        const session = await mongoose.startSession();
        try {
            session.startTransaction();
            await supply.save({ session });

            if (stockOps.length > 0) {
                await Product.bulkWrite(stockOps, { session });
                const retProducts = await Product.find(
                    { _id: { $in: returnStockItems.map(i => i.product) }, business: req.user.businessId },
                    { stockQuantity: 1 }
                ).session(session).lean();
                const retStockMap = new Map(retProducts.map(p => [p._id.toString(), p.stockQuantity]));
                await logStockMovements(returnStockItems.map(i => ({
                    product: i.product,
                    productName: i.name,
                    type: 'supply_return',
                    quantity: -i.quantity,
                    previousStock: (retStockMap.get(i.product.toString()) || 0) + i.quantity,
                    newStock: retStockMap.get(i.product.toString()) || 0,
                    referenceType: 'supply',
                    referenceId: supply._id,
                    referenceNumber: `SUP-${supply.supplyNumber}`,
                    unitPrice: i.unitPrice,
                    reason: `Supply return - ${i.reason || 'defective'}`,
                    performedBy: req.user.adminId ? 'Admin' : req.user.name || '',
                    business: req.user.businessId
                })), session);
            }

            await session.commitTransaction();
        } catch (txError) {
            await session.abortTransaction();
            throw txError;
        } finally {
            session.endSession();
        }

        res.json({
            message: 'Return processed successfully',
            returnedItems: returnItems,
            totalRefund,
            supply
        });
    } catch (error) {
        console.error('[Supply]', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

export {
    createSupply,
    getAllSupplies,
    getSupply,
    updateSupply,
    recordPayment,
    deleteSupply,
    getSupplyStats,
    processSupplyReturn
};
