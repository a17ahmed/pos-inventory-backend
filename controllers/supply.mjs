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
import { settleVendorCredit, SUPPLY_BALANCE_EXPR, SUPPLY_REAL_PAID_EXPR } from '../utils/vendorCredit.mjs';

// Who triggered a vendor-credit settlement (stored on the credit payment)
const creditActor = (req) => ({ name: req.user.adminId ? 'Admin' : req.user.name || 'Staff' });

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

        // Paying more than the bill would turn cash into vendor credit
        if ((Number(paidAmount) || 0) > calculatedTotal + 0.005) {
            return res.status(400).json({
                message: `Paid amount (Rs ${Number(paidAmount)}) can't be more than the supply total (Rs ${calculatedTotal})`
            });
        }

        // Credit limit validation (net of any credit the vendor owes us)
        if (vendorDoc.creditLimit > 0) {
            const [net] = await Supply.aggregate([
                { $match: { vendor: vendorDoc._id, business: new mongoose.Types.ObjectId(req.user.businessId) } },
                { $group: { _id: null, net: { $sum: SUPPLY_BALANCE_EXPR } } }
            ]);
            const currentOutstanding = Math.round((net?.net || 0) * 100) / 100;
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
                paidAt: billDate ? new Date(billDate) : new Date(),
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

            // Cash paid now must actually be in the drawer (same rule as Pay)
            if (initialPaid > 0 && supplyPayMethod === 'cash') {
                const latest = await CashBook.findOne({ business: req.user.businessId })
                    .sort({ createdAt: -1, entryNumber: -1 })
                    .select('runningBalance')
                    .session(session)
                    .lean();
                const cashBalance = latest?.runningBalance ?? 0;
                if (initialPaid > cashBalance) {
                    await session.abortTransaction();
                    return res.status(400).json({
                        message: `Insufficient cash in hand. Available: Rs ${cashBalance.toLocaleString()}, Required: Rs ${initialPaid.toLocaleString()}`
                    });
                }
            }

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

            // Credit the vendor owes us (from an earlier return) pays this supply
            const creditMoves = await settleVendorCredit({
                vendorId: supply.vendor,
                businessId: req.user.businessId,
                session,
                actor: creditActor(req),
            });
            if (creditMoves.length > 0) supply = await Supply.findById(supply._id).session(session);

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
        const { vendor, paymentStatus, startDate, endDate, page = 1 } = req.query;
        // Cap limit to [1,100] so a caller can't request the whole table (?limit=100000).
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const filter = { business: req.user.businessId, type: { $ne: 'opening_balance' } };

        if (vendor) filter.vendor = vendor;
        if (paymentStatus) filter.paymentStatus = paymentStatus;
        if (startDate || endDate) {
            filter.billDate = {};
            if (startDate) filter.billDate.$gte = startOfDay(startDate);
            if (endDate) filter.billDate.$lte = endOfDay(endDate);
        }

        const skip = (Number(page) - 1) * Number(limit);

        // count and page fetch are independent — fire both at once instead of
        // waiting for the count before starting the page query.
        const [total, supplies] = await Promise.all([
            Supply.countDocuments(filter),
            Supply.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(Number(limit))
                .populate('vendor', 'name phone company'),
        ]);

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

// True when the incoming items match the saved ones (product, qty, price, and
// GST when it is sent), in any order.
const sameItems = (saved, incoming) => {
    if (saved.length !== incoming.length) return false;
    const key = (product, qty, price) => `${product}|${Number(qty)}|${Number(price)}`;
    const left = saved.map(i => ({ k: key(i.product, i.quantity, i.unitPrice), gst: i.gst || 0 }));
    for (const item of incoming) {
        const idx = left.findIndex(l =>
            l.k === key(item.product, item.quantity, item.unitPrice) &&
            (item.gst === undefined || Number(item.gst) === l.gst)
        );
        if (idx === -1) return false;
        left.splice(idx, 1);
    }
    return true;
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

        // Paid amount comes only from recorded payments (Pay), so the ledger,
        // the supply and the cash book always agree. An unchanged value from
        // the edit form is ignored.
        if (paidAmount !== undefined && Math.abs(Number(paidAmount) - (supply.paidAmount || 0)) > 0.005) {
            return res.status(400).json({ message: 'Paid amount can\'t be edited. Use "Pay" to record a payment.' });
        }

        // The edit form always re-sends every item. Same items as saved → treat
        // as no item change (no stock churn, and allowed after a return).
        if (items && items.length > 0 && sameItems(supply.items, items)) {
            items = undefined;
        }

        // Changing items after a return would wipe the returned quantities and
        // put back stock that already went to the vendor.
        if (items && items.length > 0 && (supply.returns || []).length > 0) {
            return res.status(400).json({ message: 'This supply has returns, so its items can\'t be changed. Undo the returns first.' });
        }

        if (billNumber !== undefined) supply.billNumber = billNumber;
        if (billDate !== undefined) supply.billDate = billDate;
        if (notes !== undefined) supply.notes = notes;

        // Track old image for cleanup after successful commit
        let oldImageToDelete = null;
        if (req.file) {
            if (supply.receiptImage) {
                oldImageToDelete = supply.receiptImage;
            }
            supply.receiptImage = req.file.path;
        }

        let result = supply;
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

            // Net stock change per product (new qty − old qty). A cut can't take
            // back more than is still on the shelf (same rule as a return).
            const netByProduct = new Map();
            for (const i of oldItems) {
                const key = i.product.toString();
                netByProduct.set(key, (netByProduct.get(key) || 0) - i.quantity);
            }
            for (const i of newItems.filter(i => i.product)) {
                const key = i.product.toString();
                netByProduct.set(key, (netByProduct.get(key) || 0) + i.quantity);
            }
            const cutIds = [...netByProduct].filter(([, net]) => net < 0).map(([id]) => id);

            // ── Transaction: reverse old stock → add new stock → save supply ──
            const session = await mongoose.startSession();
            try {
                session.startTransaction();

                if (cutIds.length > 0) {
                    const liveProducts = await Product.find(
                        { _id: { $in: cutIds }, business: req.user.businessId, trackStock: true },
                        { name: 1, stockQuantity: 1 }
                    ).session(session).lean();
                    const outOfStock = liveProducts
                        .filter(p => p.stockQuantity < -netByProduct.get(p._id.toString()))
                        .map(p => ({ productId: p._id, name: p.name, requested: -netByProduct.get(p._id.toString()), available: p.stockQuantity }));
                    if (outOfStock.length > 0) {
                        await session.abortTransaction();
                        return res.status(400).json({
                            message: 'Some of these items were already sold, so the quantity can\'t be reduced that much',
                            outOfStock
                        });
                    }
                }

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

                // A lower total can leave the supply overpaid → vendor credit
                const moves = await settleVendorCredit({
                    vendorId: supply.vendor,
                    businessId: req.user.businessId,
                    session,
                    actor: creditActor(req),
                });
                if (moves.length > 0) result = await Supply.findById(supply._id).session(session);

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

        res.json(result);
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

        const paymentMethod = method || 'cash';
        const payAmount = Number(amount);
        const paidBy = req.user.adminId ? 'Admin' : req.user.name || '';

        const session = await mongoose.startSession();
        try {
            session.startTransaction();

            const reject = async (status, message) => {
                await session.abortTransaction();
                // finally block handles session.endSession()
                return res.status(status).json({ message });
            };

            let supply = await Supply.findOne({
                _id: req.params.id,
                business: req.user.businessId
            }).session(session);

            if (!supply) return await reject(404, 'Supply not found');

            // Credit the vendor owes us may already cover (part of) this supply
            const moves = await settleVendorCredit({
                vendorId: supply.vendor,
                businessId: req.user.businessId,
                session,
                actor: creditActor(req),
            });
            if (moves.length > 0) supply = await Supply.findById(supply._id).session(session);

            if (supply.paymentStatus === 'returned') {
                return await reject(400, 'This supply has been fully returned. No payment needed.');
            }
            if (supply.paymentStatus === 'paid' || supply.remainingAmount <= 0.005) {
                return await reject(400, 'This supply is already fully paid');
            }
            if (payAmount > supply.remainingAmount + 0.005) {
                return await reject(400, `Payment amount cannot exceed remaining balance of Rs ${supply.remainingAmount}`);
            }

            // Cash balance check
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

            supply.payments.push({
                amount: payAmount,
                method: paymentMethod,
                paidAt: new Date(),
                paidBy,
                note: note || '',
                reference: reference || ''
            });
            await supply.save({ session });

            if (paymentMethod === 'cash') {
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
            }

            await session.commitTransaction();
            res.json(supply);
        } catch (txError) {
            await session.abortTransaction();
            throw txError;
        } finally {
            session.endSession();
        }
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

        // A supply with payments, returns or moved vendor credit is part of the
        // vendor's ledger and the cash book — deleting it would leave them wrong.
        if ((supply.payments || []).length > 0) {
            return res.status(400).json({ message: 'This supply has payments, so it can\'t be deleted.' });
        }
        if ((supply.returns || []).length > 0) {
            return res.status(400).json({ message: 'This supply has returns, so it can\'t be deleted.' });
        }
        if ((supply.creditTransfers || []).length > 0) {
            return res.status(400).json({ message: 'This supply\'s credit was used on other supplies, so it can\'t be deleted.' });
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
                // Same rule as a return: can't take back stock that was already sold
                const needByProduct = new Map();
                for (const i of deleteItems) {
                    const key = i.product.toString();
                    needByProduct.set(key, (needByProduct.get(key) || 0) + i.quantity);
                }
                const liveProducts = await Product.find(
                    { _id: { $in: [...needByProduct.keys()] }, business: req.user.businessId, trackStock: true },
                    { name: 1, stockQuantity: 1 }
                ).session(session).lean();
                const outOfStock = liveProducts
                    .filter(p => p.stockQuantity < needByProduct.get(p._id.toString()))
                    .map(p => ({ productId: p._id, name: p.name, requested: needByProduct.get(p._id.toString()), available: p.stockQuantity }));
                if (outOfStock.length > 0) {
                    await session.abortTransaction();
                    return res.status(400).json({
                        message: 'Some items from this supply were already sold, so it can\'t be deleted',
                        outOfStock
                    });
                }

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

            await Supply.deleteOne({ _id: supply._id }, { session });
            await session.commitTransaction();
        } catch (txError) {
            await session.abortTransaction();
            throw txError;
        } finally {
            session.endSession();
        }

        // Delete receipt image from Cloudinary (external service — only after the delete committed)
        if (supply.receiptImage) {
            const publicId = supply.receiptImage.split('/').slice(-2).join('/').split('.')[0];
            await cloudinary.uploader.destroy(publicId).catch(() => {});
        }

        res.json({ message: 'Supply deleted successfully' });
    } catch (error) {
        console.error('[Supply]', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Shared by GET /supply/stats and the dashboard-summary endpoint — single
// implementation so the two can never report different numbers.
const computeSupplyStats = async (rawBusinessId) => {
        const businessId = rawBusinessId instanceof mongoose.Types.ObjectId
            ? rawBusinessId
            : new mongoose.Types.ObjectId(rawBusinessId);
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
                        totalPaid: { $sum: SUPPLY_REAL_PAID_EXPR },
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
                        totalPaid: { $sum: SUPPLY_REAL_PAID_EXPR },
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
                        totalPaid: { $sum: SUPPLY_REAL_PAID_EXPR },
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

        return {
            overall: overall[0] || { totalAmount: 0, totalPaid: 0, totalRemaining: 0, count: 0 },
            thisMonth: thisMonth[0] || { totalAmount: 0, totalPaid: 0, totalRemaining: 0, count: 0 },
            thisWeek: thisWeek[0] || { totalAmount: 0, count: 0 },
            byVendor,
            byStatus
        };
};

const getSupplyStats = async (req, res) => {
    try {
        const result = await computeSupplyStats(req.user.businessId);
        res.json(result);
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
        let result = supply;
        let creditSettlement = [];
        const session = await mongoose.startSession();
        try {
            session.startTransaction();
            await supply.save({ session });

            if (stockOps.length > 0) {
                // Guard: the return quantity above was validated against what this
                // supply originally shipped, not against what's actually left in
                // stock right now (some of it may have already been sold). Check
                // live stockQuantity inside the transaction before reversing it.
                // Sum requested return quantity per product first — multiple
                // return lines for the same product must be checked against
                // their combined total, not each independently against the same
                // unmutated stock snapshot.
                const requestedByProduct = new Map();
                for (const i of returnStockItems) {
                    const key = i.product.toString();
                    requestedByProduct.set(key, (requestedByProduct.get(key) || 0) + i.quantity);
                }

                const currentProducts = await Product.find(
                    { _id: { $in: [...requestedByProduct.keys()] }, business: req.user.businessId, trackStock: true },
                    { name: 1, stockQuantity: 1 }
                ).session(session).lean();
                const currentStockMap = new Map(currentProducts.map(p => [p._id.toString(), p]));

                const outOfStock = [];
                for (const [productId, requested] of requestedByProduct) {
                    const prod = currentStockMap.get(productId);
                    if (prod && prod.stockQuantity < requested) {
                        outOfStock.push({
                            productId,
                            name: prod.name,
                            requested,
                            available: prod.stockQuantity
                        });
                    }
                }

                if (outOfStock.length > 0) {
                    await session.abortTransaction();
                    return res.status(400).json({
                        message: 'Cannot return more than is currently in stock for some items',
                        outOfStock
                    });
                }

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

            // Returning goods on a paid supply leaves the vendor owing us —
            // that credit pays this vendor's oldest unpaid supplies.
            creditSettlement = await settleVendorCredit({
                vendorId: supply.vendor,
                businessId: req.user.businessId,
                session,
                actor: creditActor(req),
            });
            if (creditSettlement.length > 0) result = await Supply.findById(supply._id).session(session);

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
            creditSettlement,   // [{ fromNumber, toNumber, amount }] credit applied to other supplies
            supply: result
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
    computeSupplyStats,
    processSupplyReturn
};
