import mongoose from "mongoose";
import Bill from "../models/bill.mjs";
import Counter from "../models/counter.mjs";
import Product from "../models/product.mjs";
import Customer from "../models/customer.mjs";
import Expense from "../models/expense.mjs";
import StockMovement from "../models/stockMovement.mjs";
import { recordCashEntry } from "./cashbook.mjs";
import { startOfToday, startOfMonth, startOfWeek, endOfDay as endOfDayHelper, startOfDay, toLocalDateString, toLocalTimeString, getTimezone } from "../utils/dateHelpers.mjs";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Batch-fetch costPrice for an array of items that have a product ObjectId.
 * Returns a Map<string, number> keyed by product id.
 */
const buildCostMap = async (items, businessId) => {
    const ids = items
        .map((i) => i.product)
        .filter((id) => id && mongoose.Types.ObjectId.isValid(id));

    if (ids.length === 0) return new Map();

    const products = await Product.find(
        { _id: { $in: ids }, business: businessId },
        { costPrice: 1 }
    ).lean();

    const map = new Map();
    for (const p of products) map.set(p._id.toString(), p.costPrice || 0);
    return map;
};

/**
 * Enrich bill items with costPrice from the Product collection.
 * Mutates nothing -- returns a new array.
 */
const enrichItemsWithCost = async (items, businessId) => {
    const costMap = await buildCostMap(items, businessId);
    return items.map((item) => ({
        ...item,
        costPrice:
            item.costPrice ??
            (item.product ? costMap.get(item.product.toString()) || 0 : 0),
    }));
};

/**
 * Bulk-deduct stock for sold items (only products with trackStock:true).
 * Best-effort: logs errors but does not throw.
 */
const deductStock = async (items, businessId, billRef = {}, session = null) => {
    const validItems = items.filter((i) => i.product && mongoose.Types.ObjectId.isValid(i.product));
    const ops = validItems.map((i) => ({
        updateOne: {
            filter: {
                _id: i.product,
                business: businessId,
                trackStock: true,
            },
            update: { $inc: { stockQuantity: -(i.qty || 1) } },
        },
    }));

    if (ops.length === 0) return;

    try {
        await Product.bulkWrite(ops, session ? { session } : {});

        // Log stock movements (read with session so we see transaction's snapshot)
        const query = Product.find(
            { _id: { $in: validItems.map(i => i.product) }, business: businessId },
            { stockQuantity: 1 }
        );
        if (session) query.session(session);
        const updatedProducts = await query.lean();
        const stockMap = new Map(updatedProducts.map(p => [p._id.toString(), p.stockQuantity]));

        const movements = validItems.map(i => {
            const qty = i.qty || 1;
            return {
                product: i.product,
                productName: i.name || i.productName || '',
                type: 'bill_sold',
                quantity: -qty,
                previousStock: (stockMap.get(i.product.toString()) || 0) + qty,
                newStock: stockMap.get(i.product.toString()) || 0,
                referenceType: 'bill',
                referenceId: billRef.id || null,
                referenceNumber: billRef.number ? `BILL-${billRef.number}` : '',
                unitPrice: i.price || i.sellingPrice || 0,
                reason: 'Item sold',
                performedBy: billRef.performedBy || '',
                business: businessId
            };
        });
        await StockMovement.insertMany(movements, session ? { session } : {});
    } catch (err) {
        if (session) throw err; // Let transaction handle it
        console.error("Stock deduction failed:", err.message);
    }
};

/**
 * Bulk-restore stock for returned items.
 */
const restoreStock = async (items, businessId, billRef = {}, session = null) => {
    const validItems = items.filter((i) => i.product && mongoose.Types.ObjectId.isValid(i.product));
    const ops = validItems.map((i) => ({
        updateOne: {
            filter: {
                _id: i.product,
                business: businessId,
                trackStock: true,
            },
            update: { $inc: { stockQuantity: i.quantity || i.qty || 1 } },
        },
    }));

    if (ops.length === 0) return;

    try {
        await Product.bulkWrite(ops, session ? { session } : {});

        // Log stock movements (read with session so we see transaction's snapshot)
        const query = Product.find(
            { _id: { $in: validItems.map(i => i.product) }, business: businessId },
            { stockQuantity: 1 }
        );
        if (session) query.session(session);
        const updatedProducts = await query.lean();
        const stockMap = new Map(updatedProducts.map(p => [p._id.toString(), p.stockQuantity]));

        const movements = validItems.map(i => {
            const qty = i.quantity || i.qty || 1;
            return {
                product: i.product,
                productName: i.name || i.productName || '',
                type: 'bill_return',
                quantity: qty,
                previousStock: (stockMap.get(i.product.toString()) || 0) - qty,
                newStock: stockMap.get(i.product.toString()) || 0,
                referenceType: 'bill',
                referenceId: billRef.id || null,
                referenceNumber: billRef.number || '',
                unitPrice: i.price || i.unitPrice || 0,
                reason: billRef.reason || 'Bill return',
                performedBy: billRef.performedBy || '',
                business: businessId
            };
        });
        await StockMovement.insertMany(movements, session ? { session } : {});
    } catch (err) {
        if (session) throw err; // Let transaction handle it
        console.error("Stock restoration failed:", err.message);
    }
};

/**
 * Generate a return number in the format RET-YYYYMMDD-####
 */
const generateReturnNumber = async (businessId, session = null) => {
    const seq = await Counter.getNextSequence("returnNumber", businessId, session);
    const d = new Date();
    const ymd =
        String(d.getFullYear()) +
        String(d.getMonth() + 1).padStart(2, "0") +
        String(d.getDate()).padStart(2, "0");
    return `RET-${ymd}-${String(seq).padStart(4, "0")}`;
};

// ═══════════════════════════════════════════════════════════════════════════
// SALES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /bills
 * Create a completed sale or a hold bill.
 * Body.status can be "completed" (default) or "hold".
 */
export const createBill = async (req, res) => {
    try {
        if (!req.user?.businessId) {
            return res.status(400).json({ message: "Business ID not found. Please log out and log in again." });
        }

        const { items, idempotencyKey, status } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ message: "Bill must have at least one item" });
        }

        // ── Idempotency guard ──────────────────────────────────────
        if (idempotencyKey) {
            const existing = await Bill.findOne({
                idempotencyKey,
                business: req.user.businessId,
            });
            if (existing) {
                return res.status(409).json({
                    alreadyPaid: true,
                    bill: existing,
                    message: `Bill #${existing.billNumber} has already been paid`,
                });
            }
        }

        const billStatus = status === "hold" ? "hold" : "completed";

        // ── Enrich items with costPrice ────────────────────────────
        const enrichedItems = await enrichItemsWithCost(items, req.user.businessId);

        const now = new Date();

        // Build payments array from the request
        const payments = [];
        if (req.body.payments && Array.isArray(req.body.payments)) {
            payments.push(...req.body.payments);
        } else if (req.body.amountPaid && req.body.amountPaid > 0 && billStatus === "completed") {
            // Backwards-compat: single payment from amountPaid field
            payments.push({
                amount: req.body.amountPaid,
                method: req.body.paymentMethod || "cash",
                paidAt: now,
                receivedBy: req.user.id,
                receivedByName: req.user.name || "Staff",
            });
        }

        // ── Discount validation: only one mode allowed ─────────────
        const hasItemDiscounts = enrichedItems.some((i) => (i.discountAmount || 0) > 0);
        const hasBillDiscount = (parseFloat(req.body.billDiscountAmount) || 0) > 0;

        if (hasItemDiscounts && hasBillDiscount) {
            return res.status(400).json({
                message: "Cannot apply both item-level and bill-level discounts on the same bill. Choose one.",
            });
        }

        // ── Build discount history entry ─────────────────────────
        const discountHistory = [];
        if (hasItemDiscounts) {
            discountHistory.push({
                appliedBy: req.user.id,
                appliedByName: req.user.name || "Staff",
                appliedAt: now,
                mode: "item",
                itemDiscounts: enrichedItems
                    .filter((i) => (i.discountAmount || 0) > 0)
                    .map((i) => ({
                        name: i.name,
                        product: i.product || null,
                        qty: i.qty,
                        discountAmount: i.discountAmount,
                    })),
                totalDiscountAmount: 0,
            });
        } else if (hasBillDiscount) {
            discountHistory.push({
                appliedBy: req.user.id,
                appliedByName: req.user.name || "Staff",
                appliedAt: now,
                mode: "bill",
                billDiscountAmount: parseFloat(req.body.billDiscountAmount),
                reason: req.body.billDiscountReason || "",
                totalDiscountAmount: 0,
            });
        }

        // ── Customer validation + credit limit ─────────────────────
        let customerDoc = null;
        if (req.body.customer) {
            customerDoc = await Customer.findOne({
                _id: req.body.customer,
                business: req.user.businessId
            });

            if (!customerDoc) {
                return res.status(404).json({ message: "Customer not found" });
            }

            if (!customerDoc.isActive) {
                return res.status(400).json({ message: "This customer has been deactivated" });
            }

            // Credit limit check (only for credit sales — not fully paid upfront)
            if (customerDoc.creditLimit > 0) {
                const totalPaying = payments.reduce((sum, p) => sum + (p.amount || 0), 0);

                // Calculate post-discount bill total
                let billTotal = enrichedItems.reduce((sum, i) => {
                    const lineTotal = (i.price || 0) * (i.qty || 1);
                    return sum + lineTotal - (i.discountAmount || 0);
                }, 0);

                // Subtract bill-level discount if present
                if (hasBillDiscount) {
                    billTotal -= parseFloat(req.body.billDiscountAmount) || 0;
                }

                const newCredit = billTotal - totalPaying;

                if (newCredit > 0 && (customerDoc.balance + newCredit) > customerDoc.creditLimit) {
                    return res.status(400).json({
                        message: `Credit limit exceeded. Limit: Rs ${customerDoc.creditLimit}, Outstanding: Rs ${customerDoc.balance}, New credit: Rs ${newCredit}`
                    });
                }
            }
        }

        const session = await mongoose.startSession();
        try {
            session.startTransaction();

            // ── Stock validation inside transaction (prevents TOCTOU race) ──
            if (billStatus === "completed") {
                const productIds = items
                    .filter((i) => i.product && mongoose.Types.ObjectId.isValid(i.product))
                    .map((i) => i.product);

                if (productIds.length > 0) {
                    const products = await Product.find(
                        { _id: { $in: productIds }, business: req.user.businessId, trackStock: true },
                        { name: 1, stockQuantity: 1 }
                    ).session(session).lean();

                    const stockMap = new Map();
                    for (const p of products) stockMap.set(p._id.toString(), p);

                    const outOfStock = [];
                    for (const item of items) {
                        if (!item.product) continue;
                        const prod = stockMap.get(item.product.toString());
                        if (prod && prod.stockQuantity < (item.qty || 1)) {
                            outOfStock.push({
                                name: item.name || prod.name,
                                requested: item.qty,
                                available: prod.stockQuantity,
                            });
                        }
                    }

                    if (outOfStock.length > 0) {
                        await session.abortTransaction();
                        // finally block handles session.endSession()
                        return res.status(400).json({
                            message: "Insufficient stock for some items",
                            outOfStock,
                        });
                    }
                }
            }

            // ── Atomic bill number (inside transaction) ──────────────
            const billNumber = await Counter.getNextSequence("billNumber", req.user.businessId, session);

            const bill = new Bill({
                billNumber,
                business: req.user.businessId,
                status: billStatus,
                type: "sale",
                items: enrichedItems,
                payments,
                cashGiven: req.body.cashGiven || 0,
                idempotencyKey: idempotencyKey || undefined,

                // People
                cashier: req.user.id,
                cashierName: req.user.name || "Staff",
                customer: req.body.customer || null,
                customerName: customerDoc?.name || req.body.customerName || "Walk-in",
                customerPhone: customerDoc?.phone || req.body.customerPhone || "",

                // Bill-level discount
                billDiscountAmount: parseFloat(req.body.billDiscountAmount) || 0,
                billDiscountReason: req.body.billDiscountReason || "",

                // Discount history
                discountHistory,

                // Hold info
                holdNote: billStatus === "hold" ? req.body.holdNote || "" : "",
                holdAt: billStatus === "hold" ? now : null,

                // Meta
                billName: req.body.billName || "",
                notes: req.body.notes || "",
                date: toLocalDateString(now),
                time: toLocalTimeString(now),
            });

            const saved = await bill.save({ session });

            // Update discount history with calculated amounts
            if (saved.discountHistory.length > 0 && saved.totalDiscount > 0) {
                const entry = saved.discountHistory[saved.discountHistory.length - 1];
                entry.totalDiscountAmount = saved.totalDiscount;
                if (entry.mode === "bill") {
                    entry.billDiscountAmount = saved.billDiscountAmount;
                } else if (entry.mode === "item") {
                    for (const hItem of entry.itemDiscounts) {
                        const billItem = saved.items.find(
                            (i) => i.name === hItem.name && i.product?.toString() === hItem.product?.toString()
                        );
                        if (billItem) hItem.discountAmount = billItem.discountAmount;
                    }
                }
                await saved.save({ session });
            }

            // Stock deduction (only for completed sales)
            if (billStatus === "completed") {
                await deductStock(enrichedItems, req.user.businessId, {
                    id: saved._id,
                    number: saved.billNumber,
                    performedBy: req.user.name || 'Staff'
                }, session);
            }

            // Record cash payments in cashbook
            if (billStatus === "completed" && payments.length > 0) {
                const cashTotal = payments
                    .filter(p => (p.method || 'cash') === 'cash')
                    .reduce((sum, p) => sum + (p.amount || 0), 0);

                if (cashTotal > 0) {
                    await recordCashEntry({
                        type: 'sale_collection',
                        amount: cashTotal,
                        direction: 'in',
                        referenceType: 'bill',
                        referenceId: saved._id,
                        referenceNumber: `Bill #${saved.billNumber}`,
                        description: `Sale collection - Bill #${saved.billNumber}`,
                        performedBy: req.user.name || 'Staff',
                        performedById: req.user.id,
                        businessId: req.user.businessId,
                        session,
                    });
                }
            }

            await session.commitTransaction();
            res.status(201).json(saved);
        } catch (txError) {
            await session.abortTransaction();
            throw txError;
        } finally {
            session.endSession();
        }
    } catch (error) {
        console.error("Error creating bill:", error);

        // Duplicate idempotency key (unique index violation)
        if (error.code === 11000 && error.keyPattern?.idempotencyKey) {
            const existing = await Bill.findOne({
                idempotencyKey: req.body.idempotencyKey,
                business: req.user.businessId,
            });
            return res.status(409).json({
                alreadyPaid: true,
                bill: existing,
                message: `Bill has already been processed`,
            });
        }

        // Mongoose validation errors → 400 Bad Request
        if (error.name === "ValidationError") {
            const fields = Object.keys(error.errors).join(", ");
            return res.status(400).json({
                message: `Validation failed: ${fields}`,
                errors: Object.fromEntries(
                    Object.entries(error.errors).map(([key, err]) => [key, err.message])
                ),
            });
        }

        res.status(500).json({ message: "Failed to create bill" });
    }
};

/**
 * GET /bills
 * Paginated list with optional status & type filters. Sorted by createdAt desc.
 */
export const getAllBills = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        const fetchAll = req.query.all === "true";

        const query = { business: req.user.businessId };

        if (req.query.status) query.status = req.query.status;
        if (req.query.type) query.type = req.query.type;
        else query.type = { $ne: "opening_balance" };
        if (req.query.paymentStatus) query.paymentStatus = req.query.paymentStatus;

        // Date range filter
        if (req.query.startDate || req.query.endDate) {
            query.createdAt = {};
            if (req.query.startDate) query.createdAt.$gte = new Date(req.query.startDate);
            if (req.query.endDate) query.createdAt.$lte = endOfDay(req.query.endDate);
        }

        const total = await Bill.countDocuments(query);

        let bills;
        if (fetchAll) {
            bills = await Bill.find(query).sort({ createdAt: -1 }).limit(5000).lean();
        } else {
            const skip = (page - 1) * limit;
            bills = await Bill.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean();
        }

        const totalPages = fetchAll ? 1 : Math.ceil(total / limit);

        res.json({
            bills,
            pagination: {
                page: fetchAll ? 1 : page,
                perPage: fetchAll ? total : limit,
                total,
                totalPages,
                hasMore: fetchAll ? false : page < totalPages,
            },
        });
    } catch (error) {
        console.error("Error fetching bills:", error);
        res.status(500).json({ message: "Failed to fetch bills" });
    }
};

/**
 * GET /bills/:id
 */
export const getBill = async (req, res) => {
    try {
        const bill = await Bill.findOne({
            _id: req.params.id,
            business: req.user.businessId,
        });

        if (!bill) return res.status(404).json({ message: "Bill not found" });

        res.json(bill);
    } catch (error) {
        console.error("Error fetching bill:", error);
        res.status(500).json({ message: "Failed to fetch bill" });
    }
};

/**
 * PATCH /bills/:id
 * Safe field updates only -- never allow changing billNumber, business, type, etc.
 */
export const updateBill = async (req, res) => {
    try {
        const bill = await Bill.findOne({
            _id: req.params.id,
            business: req.user.businessId,
        });

        if (!bill) return res.status(404).json({ message: "Bill not found" });

        // Whitelist of safe fields
        const safe = [
            "customerName",
            "customerPhone",
            "cashGiven",
            "notes",
            "billName",
            "holdNote",
        ];

        for (const key of safe) {
            if (req.body[key] !== undefined) bill[key] = req.body[key];
        }

        const updated = await bill.save(); // triggers pre-save recalculation
        res.json(updated);
    } catch (error) {
        console.error("Error updating bill:", error);
        res.status(500).json({ message: "Failed to update bill" });
    }
};

/**
 * DELETE /bills/:id
 */
export const deleteBill = async (req, res) => {
    try {
        const bill = await Bill.findOne({
            _id: req.params.id,
            business: req.user.businessId,
        });

        if (!bill) return res.status(404).json({ message: "Bill not found" });

        // Prevent deleting completed bills — use refund instead
        if (bill.status === "completed") {
            return res.status(400).json({
                message: "Cannot delete a completed bill. Use refund instead."
            });
        }

        const customerId = bill.customer;
        const businessId = bill.business;

        await Bill.deleteOne({ _id: bill._id });

        // deleteOne doesn't trigger post-save hook, so manually sync customer ledger
        if (customerId) {
            const result = await Bill.aggregate([
                {
                    $match: {
                        customer: customerId,
                        business: businessId,
                        status: { $ne: "cancelled" }
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalBilled: { $sum: "$total" },
                        totalPaid: { $sum: "$amountPaid" },
                        balance: { $sum: "$amountDue" },
                        totalReturns: {
                            $sum: { $cond: [{ $ne: ["$returnStatus", "none"] }, 1, 0] }
                        },
                        totalPurchases: { $sum: 1 },
                        lastPurchase: { $max: "$createdAt" }
                    }
                }
            ]);

            if (result.length > 0) {
                const stats = result[0];
                await Customer.findByIdAndUpdate(customerId, {
                    totalBilled: stats.totalBilled,
                    totalPaid: stats.totalPaid,
                    balance: stats.balance,
                    totalPurchases: stats.totalPurchases,
                    totalReturns: stats.totalReturns,
                    lastPurchase: stats.lastPurchase
                });
            } else {
                await Customer.findByIdAndUpdate(customerId, {
                    totalBilled: 0, totalPaid: 0, balance: 0,
                    totalPurchases: 0, totalReturns: 0, lastPurchase: null
                });
            }
        }

        res.json({ message: "Bill deleted", bill });
    } catch (error) {
        console.error("Error deleting bill:", error);
        res.status(500).json({ message: "Failed to delete bill" });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// HOLD BILLS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /bills/hold
 * Create a hold bill. Accepts optional partial payment.
 */
export const holdBill = async (req, res) => {
    try {
        if (!req.user?.businessId) {
            return res.status(400).json({ message: "Business ID not found. Please log out and log in again." });
        }

        const { items } = req.body;
        if (!items || items.length === 0) {
            return res.status(400).json({ message: "Bill must have at least one item" });
        }

        const enrichedItems = await enrichItemsWithCost(items, req.user.businessId);
        const now = new Date();

        // Build payment if partial payment was made
        const payments = [];
        const amountPaid = parseFloat(req.body.amountPaid) || 0;
        if (amountPaid > 0) {
            payments.push({
                amount: amountPaid,
                method: req.body.paymentMethod || "cash",
                paidAt: now,
                receivedBy: req.user.id,
                receivedByName: req.user.name || "Staff",
                note: "Partial payment on hold",
            });
        }

        // ── Discount validation ──────────────────────────────────
        const hasItemDiscounts = enrichedItems.some((i) => (i.discountAmount || 0) > 0);
        const hasBillDiscount = (parseFloat(req.body.billDiscountAmount) || 0) > 0;

        if (hasItemDiscounts && hasBillDiscount) {
            return res.status(400).json({
                message: "Cannot apply both item-level and bill-level discounts on the same bill. Choose one.",
            });
        }

        // Build discount history
        const discountHistory = [];
        if (hasItemDiscounts) {
            discountHistory.push({
                appliedBy: req.user.id,
                appliedByName: req.user.name || "Staff",
                appliedAt: now,
                mode: "item",
                itemDiscounts: enrichedItems
                    .filter((i) => (i.discountAmount || 0) > 0)
                    .map((i) => ({
                        name: i.name, product: i.product || null, qty: i.qty,
                        discountAmount: i.discountAmount,
                    })),
                totalDiscountAmount: 0,
            });
        } else if (hasBillDiscount) {
            discountHistory.push({
                appliedBy: req.user.id,
                appliedByName: req.user.name || "Staff",
                appliedAt: now,
                mode: "bill",
                billDiscountAmount: parseFloat(req.body.billDiscountAmount),
                reason: req.body.billDiscountReason || "",
                totalDiscountAmount: 0,
            });
        }

        const session = await mongoose.startSession();
        try {
            session.startTransaction();
            const billNumber = await Counter.getNextSequence("billNumber", req.user.businessId, session);

            const bill = new Bill({
                billNumber,
                business: req.user.businessId,
                status: "hold",
                type: "sale",
                items: enrichedItems,
                payments,
                cashier: req.user.id,
                cashierName: req.user.name || "Staff",
                customer: req.body.customer || null,
                customerName: req.body.customerName || "Walk-in",
                customerPhone: req.body.customerPhone || "",
                billDiscountAmount: parseFloat(req.body.billDiscountAmount) || 0,
                billDiscountReason: req.body.billDiscountReason || "",
                discountHistory,
                holdNote: req.body.holdNote || req.body.billName || "",
                holdAt: now,
                billName: req.body.billName || "",
                notes: req.body.notes || "",
                date: toLocalDateString(now),
                time: toLocalTimeString(now),
            });

            const saved = await bill.save({ session });

            // Update discount history with calculated amounts
            if (saved.discountHistory.length > 0 && saved.totalDiscount > 0) {
                const entry = saved.discountHistory[saved.discountHistory.length - 1];
                entry.totalDiscountAmount = saved.totalDiscount;
                if (entry.mode === "bill") {
                    entry.billDiscountAmount = saved.billDiscountAmount;
                } else if (entry.mode === "item") {
                    for (const hItem of entry.itemDiscounts) {
                        const billItem = saved.items.find(
                            (i) => i.name === hItem.name && i.product?.toString() === hItem.product?.toString()
                        );
                        if (billItem) hItem.discountAmount = billItem.discountAmount;
                    }
                }
                await saved.save({ session });
            }

            await session.commitTransaction();
            res.status(201).json(saved);
        } catch (txError) {
            await session.abortTransaction();
            throw txError;
        } finally {
            session.endSession();
        }
    } catch (error) {
        console.error("Error creating hold bill:", error);
        res.status(500).json({ message: "Failed to create hold bill" });
    }
};

/**
 * GET /bills/hold
 * Get all hold bills with sorting options.
 */
export const getHoldBills = async (req, res) => {
    try {
        const { sortBy } = req.query;

        let sortOption = { createdAt: -1 };
        if (sortBy === "amount") sortOption = { amountDue: -1 };
        else if (sortBy === "customer") sortOption = { customerName: 1, createdAt: -1 };

        const bills = await Bill.find({
            business: req.user.businessId,
            status: "hold",
        })
            .populate("customer", "name phone")
            .sort(sortOption)
            .lean();

        res.json(bills);
    } catch (error) {
        console.error("Error fetching hold bills:", error);
        res.status(500).json({ message: "Failed to fetch hold bills" });
    }
};

/**
 * PATCH /bills/:id/resume
 * Mark a hold bill as resumed and return its data so the frontend can
 * load it back into the POS.
 */
export const resumeHoldBill = async (req, res) => {
    try {
        const bill = await Bill.findOne({
            _id: req.params.id,
            business: req.user.businessId,
            status: "hold",
        });

        if (!bill) return res.status(404).json({ message: "Hold bill not found" });

        bill.status = "completed";

        const session = await mongoose.startSession();
        try {
            session.startTransaction();

            // ── Stock validation inside transaction ──────────────────
            const productIds = bill.items
                .filter((i) => i.product && mongoose.Types.ObjectId.isValid(i.product))
                .map((i) => i.product);

            if (productIds.length > 0) {
                const products = await Product.find(
                    { _id: { $in: productIds }, business: req.user.businessId, trackStock: true },
                    { name: 1, stockQuantity: 1 }
                ).session(session).lean();

                const stockMap = new Map();
                for (const p of products) stockMap.set(p._id.toString(), p);

                const outOfStock = [];
                for (const item of bill.items) {
                    if (!item.product) continue;
                    const prod = stockMap.get(item.product.toString());
                    if (prod && prod.stockQuantity < (item.qty || 1)) {
                        outOfStock.push({
                            name: item.name || prod.name,
                            requested: item.qty,
                            available: prod.stockQuantity,
                        });
                    }
                }

                if (outOfStock.length > 0) {
                    await session.abortTransaction();
                    // finally block handles session.endSession()
                    return res.status(400).json({
                        message: "Insufficient stock for some items",
                        outOfStock,
                    });
                }
            }

            const saved = await bill.save({ session });

            await deductStock(saved.items, req.user.businessId, {
                id: saved._id,
                number: saved.billNumber,
                performedBy: req.user.name || 'Staff'
            }, session);

            await session.commitTransaction();
            res.json(saved);
        } catch (txError) {
            await session.abortTransaction();
            throw txError;
        } finally {
            session.endSession();
        }
    } catch (error) {
        console.error("Error resuming hold bill:", error);
        res.status(500).json({ message: "Failed to resume hold bill" });
    }
};

/**
 * PATCH /bills/:id/cancel
 * Cancel a hold bill, track reason and optional refund for partial payment.
 */
export const cancelHoldBill = async (req, res) => {
    try {
        const bill = await Bill.findOne({
            _id: req.params.id,
            business: req.user.businessId,
            status: "hold",
        });

        if (!bill) return res.status(404).json({ message: "Hold bill not found" });

        bill.status = "cancelled";
        bill.cancelReason = req.body.cancelReason || "";
        bill.cancelledBy = req.user.id;
        bill.cancelledAt = new Date();
        bill.refundOnCancel = parseFloat(req.body.refundOnCancel) || 0;

        const session = await mongoose.startSession();
        try {
            session.startTransaction();
            const saved = await bill.save({ session });
            await session.commitTransaction();
            res.json(saved);
        } catch (txError) {
            await session.abortTransaction();
            throw txError;
        } finally {
            session.endSession();
        }
    } catch (error) {
        console.error("Error cancelling hold bill:", error);
        res.status(500).json({ message: "Failed to cancel hold bill" });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// RETURNS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /bills/:id/returns
 * Process a return against an existing completed bill.
 * Adds an entry to bill.returns[], updates item returnedQty, restores stock.
 * The post-save hook handles customer ledger sync.
 */
export const processReturn = async (req, res) => {
    try {
        const { items } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ message: "No items to return" });
        }

        // Everything inside a single transaction to prevent race conditions
        // (two concurrent returns could both pass the "remaining qty" check
        // if the bill is fetched outside the transaction).
        const session = await mongoose.startSession();
        let saved;
        let returnNumber;
        let totalRefundAmount = 0;
        let refundMethod;

        try {
            session.startTransaction();

            // Fetch bill inside transaction — locks the document
            const bill = await Bill.findOne({
                _id: req.params.id,
                business: req.user.businessId,
                status: "completed",
                type: "sale",
            }).session(session);

            if (!bill) {
                await session.abortTransaction();
                session.endSession();
                return res.status(404).json({ message: "Completed sale bill not found" });
            }

            // Auto-select refund method based on who the bill belongs to:
            //   - has customer  → ledger_adjust (reduces their balance, no cash moves)
            //   - walk-in        → cash refund (counted in sales report)
            const isCustomerBill = !!bill.customer;
            refundMethod = isCustomerBill ? "ledger_adjust" : "cash";

            // Validate return quantities don't exceed remaining
            for (const returnItem of items) {
                const billItem = bill.items.id(returnItem.itemId);
                if (!billItem) {
                    await session.abortTransaction();
                    session.endSession();
                    return res.status(400).json({
                        message: `Item not found in bill: ${returnItem.name || returnItem.itemId}`,
                    });
                }
                const remaining = billItem.qty - billItem.returnedQty;
                if (returnItem.quantity > remaining) {
                    await session.abortTransaction();
                    session.endSession();
                    return res.status(400).json({
                        message: `Cannot return ${returnItem.quantity} of "${billItem.name}" - only ${remaining} remaining`,
                    });
                }
            }

            // Discount-aware refund: apportion bill-level discount + tax across items.
            const grossWithTax = (bill.subtotal || 0) + (bill.totalTax || 0);
            const billRatio = grossWithTax > 0 ? (bill.total / grossWithTax) : 1;

            // Build return entry
            let totalProfitLost = 0;
            const returnItems = [];

            for (const returnItem of items) {
                const billItem = bill.items.id(returnItem.itemId);

                const itemTax = (billItem.gst || 0) * billItem.qty;
                const itemGrossWithTax = billItem.itemTotal + itemTax;
                const effectiveLineValue = itemGrossWithTax * billRatio;
                const effectiveUnitPrice = effectiveLineValue / (billItem.qty || 1);

                const refundAmount = Math.round(effectiveUnitPrice * returnItem.quantity * 100) / 100;
                const profitLost = Math.round((effectiveUnitPrice - billItem.costPrice) * returnItem.quantity * 100) / 100;

                totalRefundAmount += refundAmount;
                totalProfitLost += profitLost;

                returnItems.push({
                    product: billItem.product || null,
                    name: billItem.name,
                    quantity: returnItem.quantity,
                    price: billItem.price,
                    costPrice: billItem.costPrice,
                    refundAmount,
                    profitLost,
                    reason: returnItem.reason || "changed_mind",
                    reasonNote: returnItem.reasonNote || "",
                });

                billItem.returnedQty += returnItem.quantity;
            }

            // Restore stock for returned items
            const stockItems = items
                .map((ri) => {
                    const billItem = bill.items.id(ri.itemId);
                    return billItem?.product
                        ? { product: billItem.product, quantity: ri.quantity, name: billItem.name, price: billItem.price }
                        : null;
                })
                .filter(Boolean);

            returnNumber = await generateReturnNumber(req.user.businessId, session);

            bill.returns.push({
                returnNumber,
                items: returnItems,
                refundMethod,
                refundAmount: totalRefundAmount,
                profitLost: totalProfitLost,
                processedBy: req.user.id,
                processedByName: req.user.name || "Staff",
                returnedAt: new Date(),
            });

            saved = await bill.save({ session });
            await restoreStock(stockItems, req.user.businessId, {
                id: bill._id,
                number: returnNumber,
                reason: 'Bill return',
                performedBy: req.user.name || 'Staff'
            }, session);

            // Record cash refund in cashbook (only for cash refunds, not ledger adjustments)
            if (refundMethod === 'cash' && totalRefundAmount > 0) {
                await recordCashEntry({
                    type: 'customer_refund',
                    amount: totalRefundAmount,
                    direction: 'out',
                    referenceType: 'bill',
                    referenceId: bill._id,
                    referenceNumber: `Return ${returnNumber} (Bill #${bill.billNumber})`,
                    description: `Cash refund - Bill #${bill.billNumber}`,
                    performedBy: req.user.name || 'Staff',
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

        res.json({
            message: "Return processed successfully",
            returnNumber,
            refundAmount: totalRefundAmount,
            bill: saved,
        });
    } catch (error) {
        console.error("Error processing return:", error);
        if (error.name === "ValidationError") {
            const fields = Object.keys(error.errors).join(", ");
            return res.status(400).json({
                message: `Validation failed: ${fields}`,
                errors: Object.fromEntries(
                    Object.entries(error.errors).map(([key, err]) => [key, err.message])
                ),
            });
        }
        res.status(500).json({ message: "Failed to process return", error: error.message });
    }
};

/**
 * GET /bills/returns
 * Get all bills that have at least one return (returnStatus != "none").
 */
export const getReturns = async (req, res) => {
    try {
        const query = {
            business: req.user.businessId,
            type: "sale",
            returnStatus: { $ne: "none" },
        };

        if (req.query.startDate || req.query.endDate) {
            query.createdAt = {};
            if (req.query.startDate) query.createdAt.$gte = new Date(req.query.startDate);
            if (req.query.endDate) query.createdAt.$lte = endOfDay(req.query.endDate);
        }

        const bills = await Bill.find(query)
            .sort({ createdAt: -1 })
            .lean();

        res.json(bills);
    } catch (error) {
        console.error("Error fetching returns:", error);
        res.status(500).json({ message: "Failed to fetch returns" });
    }
};

/**
 * GET /bills/return-lookup/:billNumber
 * Lookup a bill by billNumber for the return screen.
 * Shows remaining quantities per item.
 */
export const getBillForReturn = async (req, res) => {
    try {
        const bill = await Bill.findOne({
            billNumber: parseInt(req.params.billNumber),
            business: req.user.businessId,
        });

        if (!bill) return res.status(404).json({ message: "Bill not found" });

        if (bill.type === "refund") {
            return res.status(400).json({
                message: "Cannot process return on a refund bill",
                isRefundBill: true,
            });
        }

        if (bill.type === "opening_balance") {
            return res.status(400).json({
                message: "Cannot process return on an opening balance entry",
            });
        }

        if (bill.status === "cancelled") {
            return res.status(400).json({ message: "Cannot process return on a cancelled bill" });
        }

        const itemsWithReturns = bill.items.map((item) => ({
            ...item.toObject(),
            originalQty: item.qty,
            returnedQty: item.returnedQty || 0,
            remainingQty: item.qty - (item.returnedQty || 0),
        }));

        res.json({
            ...bill.toObject(),
            items: itemsWithReturns,
            hasReturns: bill.returns && bill.returns.length > 0,
            returnHistory: bill.returns || [],
        });
    } catch (error) {
        console.error("Error looking up bill for return:", error);
        res.status(500).json({ message: "Failed to look up bill" });
    }
};

/**
 * GET /bills/returns/summary
 * Today's return stats.
 */
export const getReturnsSummary = async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const result = await Bill.aggregate([
            {
                $match: {
                    business: new mongoose.Types.ObjectId(req.user.businessId),
                    type: "sale",
                    returnStatus: { $ne: "none" },
                },
            },
            { $unwind: "$returns" },
            {
                $match: {
                    "returns.returnedAt": { $gte: today },
                },
            },
            {
                $group: {
                    _id: null,
                    totalReturns: { $sum: 1 },
                    totalRefunded: { $sum: "$returns.refundAmount" },
                    totalItems: {
                        $sum: {
                            $reduce: {
                                input: "$returns.items",
                                initialValue: 0,
                                in: { $add: ["$$value", "$$this.quantity"] },
                            },
                        },
                    },
                },
            },
        ]);

        const stats = result[0] || { totalReturns: 0, totalRefunded: 0, totalItems: 0 };

        res.json({
            totalReturns: stats.totalReturns,
            totalRefunded: stats.totalRefunded,
            totalItems: stats.totalItems,
        });
    } catch (error) {
        console.error("Error fetching returns summary:", error);
        res.status(500).json({ message: "Failed to fetch returns summary" });
    }
};

/**
 * PATCH /bills/:id/returns/:returnId/cancel
 * Reverse a specific return entry. Restores stock and item returnedQty.
 */
export const cancelReturn = async (req, res) => {
    try {
        const session = await mongoose.startSession();
        let saved;

        try {
            session.startTransaction();

            const bill = await Bill.findOne({
                _id: req.params.id,
                business: req.user.businessId,
                status: "completed",
                type: "sale",
            }).session(session);

            if (!bill) {
                await session.abortTransaction();
                session.endSession();
                return res.status(404).json({ message: "Completed sale bill not found" });
            }

            const returnEntry = bill.returns.id(req.params.returnId);
            if (!returnEntry) {
                await session.abortTransaction();
                session.endSession();
                return res.status(404).json({ message: "Return entry not found" });
            }

            // Restore item returnedQty on the bill
            for (const returnItem of returnEntry.items) {
                const billItem = returnItem.product
                    ? bill.items.find((i) => i.product?.toString() === returnItem.product.toString())
                    : bill.items.find((i) => i.name.toLowerCase() === returnItem.name.toLowerCase());
                if (billItem) {
                    billItem.returnedQty = Math.max(0, billItem.returnedQty - returnItem.quantity);
                }
            }

            // Reverse stock restoration (deduct the stock that was restored during the return)
            const stockItems = [];
            for (const returnItem of returnEntry.items) {
                const billItem = returnItem.product
                    ? bill.items.find((i) => i.product?.toString() === returnItem.product.toString())
                    : bill.items.find((i) => i.name.toLowerCase() === returnItem.name.toLowerCase());
                if (billItem?.product) {
                    stockItems.push({
                        product: billItem.product,
                        qty: returnItem.quantity,
                        name: billItem.name,
                        price: billItem.price,
                    });
                }
            }

            bill.returns.pull(req.params.returnId);

            await deductStock(stockItems, req.user.businessId, {
                id: bill._id,
                number: bill.billNumber,
                performedBy: req.user.name || 'Staff'
            }, session);
            saved = await bill.save({ session });
            await session.commitTransaction();
        } catch (txError) {
            await session.abortTransaction();
            throw txError;
        } finally {
            session.endSession();
        }

        res.json({ message: "Return cancelled successfully", bill: saved });
    } catch (error) {
        console.error("Error cancelling return:", error);
        res.status(500).json({ message: "Failed to cancel return" });
    }
};

/**
 * GET /bills/return-lookup/product/:productId?days=60
 * Find walk-in bills (no customer attached) from the last N days that contain
 * the given product and still have returnable quantity remaining.
 *
 * Used by the return-without-receipt flow: cashier scans the product, picks
 * the original bill from the list, then proceeds with a linked return.
 * Customer bills are NOT returned here — customer returns go through the
 * customer ledger directly.
 */
export const lookupBillsByProduct = async (req, res) => {
    try {
        const { productId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(productId)) {
            return res.status(400).json({ message: "Invalid product id" });
        }

        const days = Math.min(parseInt(req.query.days) || 60, 365);
        const since = new Date();
        since.setDate(since.getDate() - days);

        const bills = await Bill.find({
            business: req.user.businessId,
            status: "completed",
            type: "sale",
            customer: null, // walk-in only
            createdAt: { $gte: since },
            "items.product": new mongoose.Types.ObjectId(productId),
        })
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();

        // Filter to only bills where this product still has remaining qty
        const matches = [];
        for (const bill of bills) {
            const item = bill.items.find(
                (i) => i.product && i.product.toString() === productId
            );
            if (!item) continue;
            const remaining = item.qty - (item.returnedQty || 0);
            if (remaining <= 0) continue;

            matches.push({
                _id: bill._id,
                billNumber: bill.billNumber,
                createdAt: bill.createdAt,
                total: bill.total,
                paymentStatus: bill.paymentStatus,
                cashierName: bill.cashierName,
                item: {
                    itemId: item._id,
                    name: item.name,
                    qty: item.qty,
                    returnedQty: item.returnedQty || 0,
                    remainingQty: remaining,
                    price: item.price,
                    itemTotal: item.itemTotal,
                },
            });
        }

        res.json({
            productId,
            windowDays: days,
            count: matches.length,
            bills: matches,
        });
    } catch (error) {
        console.error("Error looking up bills by product:", error);
        res.status(500).json({ message: "Failed to look up bills" });
    }
};

/**
 * POST /bills/standalone-refund
 * Create a standalone refund bill for a walk-in customer when the original
 * bill cannot be located (receiptless return). Creates a type:"refund" bill
 * with no originalBill link and negative-priced items.
 *
 * Counts in sales reports as a separate "standalone refund" bucket so it
 * doesn't pollute linked return metrics.
 */
export const createStandaloneRefund = async (req, res) => {
    try {
        // Permission check is handled by accessControl middleware (returns.standalone)

        const {
            items,
            refundMethod = "cash",
            customerName = "Walk-in",
            customerPhone = "",
            notes = "",
        } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ message: "No items to refund" });
        }

        // Enrich with costPrice for items that reference a product
        const enriched = await enrichItemsWithCost(items, req.user.businessId);

        const refundItems = enriched.map((item) => ({
            product: item.product || null,
            name: item.name,
            barcode: item.barcode || "",
            category: item.category || "General",
            qty: item.qty,
            price: -Math.abs(item.price), // refund bills use negative prices
            costPrice: item.costPrice || 0,
            gst: 0,
        }));

        // Always restock on standalone returns
        const stockItems = enriched
            .filter((i) => i.product)
            .map((i) => ({
                product: i.product,
                quantity: i.qty,
                name: i.name,
                price: i.price,
            }));

        const now = new Date();
        const session = await mongoose.startSession();
        let savedRefund;
        try {
            session.startTransaction();

            const refundBillNumber = await Counter.getNextSequence(
                "billNumber",
                req.user.businessId,
                session
            );

            const refund = new Bill({
                billNumber: refundBillNumber,
                business: req.user.businessId,
                status: "completed",
                type: "refund",
                items: refundItems,
                originalBill: null, // standalone — no link
                cashier: req.user.id,
                cashierName: req.user.name || "Admin",
                customer: null, // always walk-in
                customerName: customerName || "Walk-in",
                customerPhone: customerPhone || "",
                notes: notes || "Standalone refund (no original bill)",
                date: toLocalDateString(now),
                time: toLocalTimeString(now),
            });

            // Track the refund method via payments array (negative since money leaves)
            refund.payments.push({
                amount: refundItems.reduce(
                    (sum, i) => sum + i.price * i.qty,
                    0
                ),
                method: refundMethod,
                paidAt: now,
                receivedBy: req.user.id,
                receivedByName: "Admin",
                note: "Standalone refund payout",
            });

            savedRefund = await refund.save({ session });

            if (stockItems.length > 0) {
                await restoreStock(
                    stockItems,
                    req.user.businessId,
                    {
                        id: savedRefund._id,
                        number: `STANDALONE-${savedRefund.billNumber}`,
                        reason: "Standalone refund",
                        performedBy: req.user.name || "Admin",
                    },
                    session
                );
            }

            // Record cash refund in cashbook
            const totalRefundAmount = enriched.reduce((sum, i) => sum + Math.abs(i.price) * i.qty, 0);
            if (refundMethod === "cash" && totalRefundAmount > 0) {
                await recordCashEntry({
                    type: "customer_refund",
                    amount: totalRefundAmount,
                    direction: "out",
                    referenceType: "bill",
                    referenceId: savedRefund._id,
                    referenceNumber: `Standalone Refund (Bill #${savedRefund.billNumber})`,
                    description: `Standalone cash refund - Bill #${savedRefund.billNumber}`,
                    performedBy: req.user.name || "Admin",
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

        res.json({
            message: "Standalone refund processed",
            refundBill: savedRefund,
        });
    } catch (error) {
        console.error("Error processing standalone refund:", error);
        res.status(500).json({
            message: "Failed to process standalone refund",
            error: error.message,
        });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /bills/stats?filter=today|week|month&chart=true
 * Single $facet aggregation for today/week/month stats with profit tracking.
 */
export const getBillStats = async (req, res) => {
    try {
        const businessId = new mongoose.Types.ObjectId(req.user.businessId);
        const filter = req.query.filter || "today";
        const includeChart = req.query.chart === "true";

        const now = new Date();
        const today = new Date(now);
        today.setHours(0, 0, 0, 0);

        const weekStart = new Date(now);
        weekStart.setDate(weekStart.getDate() - 7);
        weekStart.setHours(0, 0, 0, 0);

        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        // Determine period boundaries
        let periodStart, prevPeriodStart, prevPeriodEnd;
        switch (filter) {
            case "week":
                periodStart = weekStart;
                prevPeriodStart = new Date(weekStart);
                prevPeriodStart.setDate(prevPeriodStart.getDate() - 7);
                prevPeriodEnd = weekStart;
                break;
            case "month":
                periodStart = monthStart;
                prevPeriodStart = new Date(monthStart);
                prevPeriodStart.setMonth(prevPeriodStart.getMonth() - 1);
                prevPeriodEnd = monthStart;
                break;
            default: // today
                periodStart = today;
                prevPeriodStart = new Date(today);
                prevPeriodStart.setDate(prevPeriodStart.getDate() - 1);
                prevPeriodEnd = today;
        }

        const saleMatch = { type: "sale", status: "completed" };

        const facets = {
            // Current period sales
            periodSales: [
                {
                    $match: {
                        business: businessId,
                        createdAt: { $gte: periodStart },
                        ...saleMatch,
                    },
                },
                {
                    $group: {
                        _id: null,
                        grossRevenue: { $sum: "$total" },
                        totalOrders: { $sum: 1 },
                        totalItems: { $sum: "$totalQty" },
                        totalCost: { $sum: "$totalCost" },
                        totalProfit: { $sum: "$billProfit" },
                        totalRefunded: { $sum: "$totalRefunded" },
                        netProfit: { $sum: "$netProfit" },
                        totalDiscount: { $sum: { $ifNull: ["$totalDiscount", 0] } },
                        totalItemDiscount: { $sum: { $ifNull: ["$totalItemDiscount", 0] } },
                        totalBillDiscount: { $sum: { $ifNull: ["$billDiscountAmount", 0] } },
                        totalCollected: { $sum: { $ifNull: ["$amountPaid", 0] } },
                        totalCredit: { $sum: { $ifNull: ["$amountDue", 0] } },
                    },
                },
            ],
            // Previous period (for growth calculation)
            prevPeriod: [
                {
                    $match: {
                        business: businessId,
                        createdAt: { $gte: prevPeriodStart, $lt: prevPeriodEnd },
                        ...saleMatch,
                    },
                },
                {
                    $group: {
                        _id: null,
                        grossRevenue: { $sum: "$total" },
                    },
                },
            ],
        };

        // Add today/month facets only if not the selected period
        if (filter !== "today") {
            facets.todaySales = [
                { $match: { business: businessId, createdAt: { $gte: today }, ...saleMatch } },
                {
                    $group: {
                        _id: null,
                        sales: { $sum: "$total" },
                        orders: { $sum: 1 },
                        refunded: { $sum: "$totalRefunded" },
                        profit: { $sum: "$netProfit" },
                        collected: { $sum: { $ifNull: ["$amountPaid", 0] } },
                        credit: { $sum: { $ifNull: ["$amountDue", 0] } },
                    },
                },
            ];
        }
        if (filter !== "month") {
            facets.monthSales = [
                { $match: { business: businessId, createdAt: { $gte: monthStart }, ...saleMatch } },
                {
                    $group: {
                        _id: null,
                        sales: { $sum: "$total" },
                        orders: { $sum: 1 },
                        refunded: { $sum: "$totalRefunded" },
                        profit: { $sum: "$netProfit" },
                        collected: { $sum: { $ifNull: ["$amountPaid", 0] } },
                        credit: { $sum: { $ifNull: ["$amountDue", 0] } },
                    },
                },
            ];
        }

        // ── Refund breakdown by method (today) ──────────────────
        facets.todayRefundBreakdown = [
            { $match: { business: businessId, ...saleMatch, "returns.0": { $exists: true } } },
            { $unwind: "$returns" },
            { $match: { "returns.returnedAt": { $gte: today } } },
            {
                $group: {
                    _id: "$returns.refundMethod",
                    amount: { $sum: "$returns.refundAmount" },
                    count: { $sum: 1 },
                },
            },
        ];

        // Refund breakdown for selected period
        facets.periodRefundBreakdown = [
            { $match: { business: businessId, ...saleMatch, "returns.0": { $exists: true } } },
            { $unwind: "$returns" },
            { $match: { "returns.returnedAt": { $gte: periodStart } } },
            {
                $group: {
                    _id: "$returns.refundMethod",
                    amount: { $sum: "$returns.refundAmount" },
                    count: { $sum: 1 },
                },
            },
        ];

        // ── Standalone refunds (type: "refund") ──────────────────
        facets.todayStandaloneRefunds = [
            { $match: { business: businessId, type: "refund", status: "completed", createdAt: { $gte: today } } },
            { $unwind: "$payments" },
            {
                $group: {
                    _id: "$payments.method",
                    amount: { $sum: { $abs: "$payments.amount" } },
                    count: { $sum: 1 },
                },
            },
        ];
        facets.periodStandaloneRefunds = [
            { $match: { business: businessId, type: "refund", status: "completed", createdAt: { $gte: periodStart } } },
            { $unwind: "$payments" },
            {
                $group: {
                    _id: "$payments.method",
                    amount: { $sum: { $abs: "$payments.amount" } },
                    count: { $sum: 1 },
                },
            },
        ];

        // COGS of items still with customers (sold qty minus returned qty)
        facets.periodNetCogs = [
            { $match: { business: businessId, type: "sale", status: "completed", createdAt: { $gte: periodStart } } },
            { $unwind: "$items" },
            {
                $group: {
                    _id: null,
                    netCogs: { $sum: { $multiply: ["$items.costPrice", { $subtract: ["$items.qty", { $ifNull: ["$items.returnedQty", 0] }] }] } },
                },
            },
        ];

        // Chart data
        if (includeChart) {
            const tz = getTimezone();
            const chartGroupBy =
                filter === "today"
                    ? { $hour: { date: "$createdAt", timezone: tz } }
                    : { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: tz } };

            facets.chartData = [
                { $match: { business: businessId, createdAt: { $gte: periodStart }, ...saleMatch } },
                {
                    $group: {
                        _id: chartGroupBy,
                        revenue: { $sum: "$total" },
                        profit: { $sum: "$netProfit" },
                        orders: { $sum: 1 },
                    },
                },
                { $sort: { _id: 1 } },
            ];
        }

        // Single DB round-trip
        const [facetResult] = await Bill.aggregate([{ $facet: facets }]);

        // ── Extract results ────────────────────────────────────────
        const period = facetResult.periodSales[0] || {
            grossRevenue: 0,
            totalOrders: 0,
            totalItems: 0,
            totalCost: 0,
            totalProfit: 0,
            totalRefunded: 0,
            netProfit: 0,
            totalDiscount: 0,
            totalItemDiscount: 0,
            totalBillDiscount: 0,
            totalCollected: 0,
            totalCredit: 0,
        };
        const prev = facetResult.prevPeriod[0] || { grossRevenue: 0 };

        // Parse refund breakdowns early so we can use the correct period total
        const _parseRefunds = (arr) => {
            const out = { cashRefund: 0, cardRefund: 0, ledgerAdjust: 0, storeCreditRefund: 0, total: 0 };
            for (const r of arr || []) {
                if (r._id === "cash") out.cashRefund = r.amount;
                else if (r._id === "card") out.cardRefund = r.amount;
                else if (r._id === "ledger_adjust") out.ledgerAdjust = r.amount;
                else if (r._id === "store_credit") out.storeCreditRefund = r.amount;
                out.total += r.amount;
            }
            return out;
        };
        // Merge linked returns + standalone refunds
        const _mergeRefunds = (linked, standalone) => {
            const merged = _parseRefunds(linked);
            for (const r of standalone || []) {
                if (r._id === "cash") merged.cashRefund += r.amount;
                else if (r._id === "card") merged.cardRefund += r.amount;
                else if (r._id === "ledger_adjust") merged.ledgerAdjust += r.amount;
                else if (r._id === "store_credit") merged.storeCreditRefund += r.amount;
                merged.total += r.amount;
            }
            return merged;
        };
        const periodRefunds = _mergeRefunds(facetResult.periodRefundBreakdown, facetResult.periodStandaloneRefunds);
        const todayRefunds = _mergeRefunds(facetResult.todayRefundBreakdown, facetResult.todayStandaloneRefunds);

        // For P&L: use period.totalRefunded (from sale bills created in the period)
        // + standalone refunds created in the period. This aligns with revenue/COGS
        // which are also filtered by bill createdAt, ensuring consistency.
        // The returnedAt-based periodRefunds is kept for cash drawer / refund breakdown display.
        const standaloneRefundTotal = (facetResult.periodStandaloneRefunds || []).reduce((s, r) => s + r.amount, 0);
        const periodTotalRefunded = period.totalRefunded + standaloneRefundTotal;

        // COGS of items still with customers (directly computed from item data)
        const adjustedCogs = facetResult.periodNetCogs?.[0]?.netCogs || 0;
        const netRevenue = period.grossRevenue - periodTotalRefunded;
        const avgOrderValue = period.totalOrders > 0 ? period.grossRevenue / period.totalOrders : 0;
        const profitMargin = netRevenue > 0 ? (period.netProfit / netRevenue) * 100 : 0;
        const growth =
            prev.grossRevenue > 0
                ? ((period.grossRevenue - prev.grossRevenue) / prev.grossRevenue) * 100
                : 0;

        // Today stats
        let todayData;
        if (filter === "today") {
            todayData = {
                sales: period.grossRevenue,
                orders: period.totalOrders,
                refunded: todayRefunds.total,
                profit: period.netProfit,
                collected: period.totalCollected,
                credit: period.totalCredit,
            };
        } else {
            const td = facetResult.todaySales?.[0] || { sales: 0, orders: 0, refunded: 0, profit: 0, collected: 0, credit: 0 };
            td.refunded = todayRefunds.total;
            todayData = td;
        }

        // Month stats
        let monthData;
        if (filter === "month") {
            monthData = {
                sales: period.grossRevenue,
                orders: period.totalOrders,
                refunded: periodTotalRefunded,
                profit: period.netProfit,
                collected: period.totalCollected,
                credit: period.totalCredit,
            };
        } else {
            monthData = facetResult.monthSales?.[0] || { sales: 0, orders: 0, refunded: 0, profit: 0, collected: 0, credit: 0 };
        }

        // Refund breakdowns already parsed above (before netRevenue calculation)

        const response = {
            // Core (filtered period)
            grossRevenue: period.grossRevenue,
            totalOrders: period.totalOrders,
            totalItems: period.totalItems,
            avgOrderValue,
            growth,

            // Discounts
            totalDiscount: period.totalDiscount,
            totalItemDiscount: period.totalItemDiscount,
            totalBillDiscount: period.totalBillDiscount,

            // Returns & refunds
            totalRefunded: periodTotalRefunded,
            linkedReturns: period.totalRefunded,
            standaloneRefunds: standaloneRefundTotal,
            refundBreakdown: periodRefunds,

            // P&L
            netRevenue,
            totalCost: period.totalCost,
            adjustedCogs,
            grossProfit: period.totalProfit,
            netProfit: period.netProfit,
            profitMargin,

            // Collection breakdown (period)
            totalCollected: period.totalCollected,
            totalCredit: period.totalCredit,

            // Today
            todaySales: todayData.sales,
            todayOrders: todayData.orders,
            todayRefunded: todayData.refunded,
            todayProfit: todayData.profit,
            netTodaySales: todayData.sales - todayData.refunded,
            todayCollected: todayData.collected,
            todayCredit: todayData.credit,
            todayCashRefund: todayRefunds.cashRefund,
            todayLedgerAdjust: todayRefunds.ledgerAdjust,
            todayRefundBreakdown: todayRefunds,
            todayCashInDrawer: todayData.collected - todayRefunds.cashRefund - todayRefunds.cardRefund,

            // Month
            monthSales: monthData.sales,
            monthOrders: monthData.orders,
            monthRefunded: monthData.refunded,
            monthProfit: monthData.profit,
            netMonthSales: monthData.sales - monthData.refunded,
            monthCollected: monthData.collected,
            monthCredit: monthData.credit,

            // Meta
            filter,
            periodStart,
            periodEnd: now,
        };

        if (includeChart) {
            response.chartData = facetResult.chartData || [];
        }

        res.json(response);
    } catch (error) {
        console.error("Error fetching bill stats:", error);
        res.status(500).json({ message: "Failed to fetch bill stats" });
    }
};

/**
 * GET /bills/top-products?limit=12
 * Most sold products aggregation.
 */
export const getTopProducts = async (req, res) => {
    try {
        const businessId = new mongoose.Types.ObjectId(req.user.businessId);
        const limit = parseInt(req.query.limit) || 12;

        const topProducts = await Bill.aggregate([
            {
                $match: {
                    business: businessId,
                    type: "sale",
                    status: "completed",
                },
            },
            { $unwind: "$items" },
            {
                $group: {
                    _id: { $ifNull: ["$items.product", "$items.name"] },
                    name: { $first: "$items.name" },
                    product: { $first: "$items.product" },
                    totalQtySold: { $sum: "$items.qty" },
                    totalRevenue: { $sum: "$items.itemTotal" },
                    totalProfit: { $sum: "$items.netProfit" },
                    lastPrice: { $last: "$items.price" },
                    transactionCount: { $sum: 1 },
                },
            },
            { $sort: { totalQtySold: -1 } },
            { $limit: limit },
        ]);

        // Enrich with current product details
        const productIds = topProducts
            .filter((p) => p.product)
            .map((p) => p.product);

        let productDetails = {};
        if (productIds.length > 0) {
            const products = await Product.find(
                { _id: { $in: productIds }, business: businessId },
                { name: 1, sellingPrice: 1, category: 1 }
            ).lean();

            for (const p of products) {
                productDetails[p._id.toString()] = p;
            }
        }

        const result = topProducts.map((item) => {
            const details = item.product ? productDetails[item.product.toString()] : null;
            return {
                _id: item.product || item._id,
                name: details?.name || item.name,
                price: details?.sellingPrice || item.lastPrice,
                category: details?.category || "General",
                totalQtySold: item.totalQtySold,
                totalRevenue: item.totalRevenue,
                totalProfit: item.totalProfit,
                transactionCount: item.transactionCount,
            };
        });

        res.json(result);
    } catch (error) {
        console.error("Error fetching top products:", error);
        res.status(500).json({ message: "Failed to fetch top products" });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// PAYMENT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /bills/:id/payments
 * Add a payment entry to an existing bill's payments[].
 * If fully paid, the pre-save hook sets paymentStatus to "paid".
 * For hold bills that become fully paid, auto-complete the bill.
 */
export const addPayment = async (req, res) => {
    try {
        const bill = await Bill.findOne({
            _id: req.params.id,
            business: req.user.businessId,
        });

        if (!bill) return res.status(404).json({ message: "Bill not found" });

        if (bill.status === "cancelled") {
            return res.status(400).json({ message: "Cannot add payment to a cancelled bill" });
        }

        const { amount, method, note, reference } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ message: "Payment amount must be greater than 0" });
        }

        bill.payments.push({
            amount: parseFloat(amount),
            method: method || "cash",
            paidAt: new Date(),
            receivedBy: req.user.id,
            receivedByName: req.user.adminId ? "Admin" : (req.user.name || "Staff"),
            note: note || "",
            reference: reference || "",
        });

        // If this is a hold bill and total payments >= total, auto-complete
        const newTotal = bill.payments.reduce((sum, p) => sum + p.amount, 0);
        const shouldComplete = bill.status === "hold" && newTotal >= bill.total;
        if (shouldComplete) {
            bill.status = "completed";
        }

        // Use transaction so bill save + stock deduction are atomic
        const session = await mongoose.startSession();
        try {
            session.startTransaction();

            // ── Stock validation when auto-completing a hold bill ────
            if (shouldComplete) {
                const productIds = bill.items
                    .filter((i) => i.product && mongoose.Types.ObjectId.isValid(i.product))
                    .map((i) => i.product);

                if (productIds.length > 0) {
                    const products = await Product.find(
                        { _id: { $in: productIds }, business: req.user.businessId, trackStock: true },
                        { name: 1, stockQuantity: 1 }
                    ).session(session).lean();

                    const stockMap = new Map();
                    for (const p of products) stockMap.set(p._id.toString(), p);

                    const outOfStock = [];
                    for (const item of bill.items) {
                        if (!item.product) continue;
                        const prod = stockMap.get(item.product.toString());
                        if (prod && prod.stockQuantity < (item.qty || 1)) {
                            outOfStock.push({
                                name: item.name || prod.name,
                                requested: item.qty,
                                available: prod.stockQuantity,
                            });
                        }
                    }

                    if (outOfStock.length > 0) {
                        await session.abortTransaction();
                        // finally block handles session.endSession()
                        return res.status(400).json({
                            message: "Insufficient stock to complete this bill",
                            outOfStock,
                        });
                    }
                }
            }

            const saved = await bill.save({ session });

            if (shouldComplete) {
                await deductStock(saved.items, req.user.businessId, {
                    id: saved._id,
                    number: saved.billNumber,
                    performedBy: req.user.name || 'Staff'
                }, session);
            }

            // Record cash payment in cashbook
            const payMethod = method || 'cash';
            if (payMethod === 'cash') {
                await recordCashEntry({
                    type: 'sale_collection',
                    amount: parseFloat(amount),
                    direction: 'in',
                    referenceType: 'bill',
                    referenceId: saved._id,
                    referenceNumber: `Bill #${saved.billNumber}`,
                    description: `Payment received - Bill #${saved.billNumber}`,
                    performedBy: req.user.adminId ? 'Admin' : (req.user.name || 'Staff'),
                    performedById: req.user.id,
                    businessId: req.user.businessId,
                    session,
                });
            }

            await session.commitTransaction();
            res.json(saved);
        } catch (txError) {
            await session.abortTransaction();
            throw txError;
        } finally {
            session.endSession();
        }
    } catch (error) {
        console.error("Error adding payment:", error);
        res.status(500).json({ message: "Failed to add payment" });
    }
};

// Use shared endOfDay helper (imported as endOfDayHelper) for timezone-correct parsing
const endOfDay = endOfDayHelper;

// ═══════════════════════════════════════════════════════════════════════════
// SALES BY PRODUCT (date range)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /bills/report/sales-by-product?startDate=&endDate=&productId=&category=
 * Shows how many units of each product were sold, revenue, discount, and profit
 * within the given date range.
 */
export const salesByProduct = async (req, res) => {
    try {
        const businessId = new mongoose.Types.ObjectId(req.user.businessId);
        const { startDate, endDate, productId, category } = req.query;

        const match = {
            business: businessId,
            type: "sale",
            status: "completed",
        };

        if (startDate || endDate) {
            match.createdAt = {};
            if (startDate) match.createdAt.$gte = startOfDay(startDate);
            if (endDate) match.createdAt.$lte = endOfDay(endDate);
        }

        const itemMatch = {};
        if (productId && mongoose.Types.ObjectId.isValid(productId)) {
            itemMatch["items.product"] = new mongoose.Types.ObjectId(productId);
        }
        if (category) {
            itemMatch["items.category"] = category;
        }

        const pipeline = [
            { $match: match },
            { $unwind: "$items" },
        ];

        if (Object.keys(itemMatch).length > 0) {
            pipeline.push({ $match: itemMatch });
        }

        pipeline.push(
            {
                $group: {
                    _id: { $ifNull: ["$items.product", "$items.name"] },
                    name: { $first: "$items.name" },
                    category: { $first: "$items.category" },
                    barcode: { $first: "$items.barcode" },
                    product: { $first: "$items.product" },
                    totalQtySold: { $sum: "$items.qty" },
                    totalReturnedQty: { $sum: "$items.returnedQty" },
                    netQtySold: { $sum: { $subtract: ["$items.qty", "$items.returnedQty"] } },
                    grossRevenue: { $sum: { $add: ["$items.itemTotal", "$items.discountAmount"] } },
                    totalItemDiscount: { $sum: "$items.discountAmount" },
                    netRevenue: { $sum: "$items.itemTotal" },
                    totalCost: { $sum: { $multiply: ["$items.costPrice", { $subtract: ["$items.qty", "$items.returnedQty"] }] } },
                    totalProfit: { $sum: "$items.netProfit" },
                    avgPrice: { $avg: "$items.price" },
                    transactionCount: { $sum: 1 },
                },
            },
            { $sort: { totalQtySold: -1 } }
        );

        const results = await Bill.aggregate(pipeline);

        // Summary row
        const summary = results.reduce(
            (acc, r) => {
                acc.totalQtySold += r.totalQtySold;
                acc.totalReturnedQty += r.totalReturnedQty;
                acc.netQtySold += r.netQtySold;
                acc.grossRevenue += r.grossRevenue;
                acc.totalItemDiscount += r.totalItemDiscount;
                acc.netRevenue += r.netRevenue;
                acc.totalCost += r.totalCost;
                acc.totalProfit += r.totalProfit;
                acc.totalTransactions += r.transactionCount;
                return acc;
            },
            {
                totalQtySold: 0, totalReturnedQty: 0, netQtySold: 0,
                grossRevenue: 0, totalItemDiscount: 0, netRevenue: 0,
                totalCost: 0, totalProfit: 0, totalTransactions: 0,
            }
        );
        summary.profitMargin = summary.netRevenue > 0
            ? Math.round((summary.totalProfit / summary.netRevenue) * 10000) / 100
            : 0;

        res.json({ products: results, summary });
    } catch (error) {
        console.error("Error fetching sales by product:", error);
        res.status(500).json({ message: "Failed to fetch sales by product report" });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// PROFIT REPORT (with expenses)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /bills/report/profit?startDate=&endDate=&filter=today|week|month
 * Full P&L: Revenue - COGS - Expenses = Net Profit
 * Also includes discount breakdown.
 */
export const profitReport = async (req, res) => {
    try {
        const businessId = new mongoose.Types.ObjectId(req.user.businessId);
        const { startDate, endDate, filter } = req.query;

        // Determine date range
        const now = new Date();
        let periodStart, periodEnd;

        if (startDate && endDate) {
            periodStart = startOfDay(startDate);
            periodEnd = endOfDay(endDate);
        } else {
            switch (filter) {
                case "week":
                    periodStart = new Date(now);
                    periodStart.setDate(periodStart.getDate() - 7);
                    periodStart.setHours(0, 0, 0, 0);
                    periodEnd = now;
                    break;
                case "month":
                    periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
                    periodEnd = now;
                    break;
                case "year":
                    periodStart = new Date(now.getFullYear(), 0, 1);
                    periodEnd = now;
                    break;
                default: // today
                    periodStart = new Date(now);
                    periodStart.setHours(0, 0, 0, 0);
                    periodEnd = now;
            }
        }

        const dateMatch = { $gte: periodStart, $lte: periodEnd };

        // Sales aggregation + standalone refunds
        const [salesResult, standaloneRefundResult, netCogsResult, expenseResult] = await Promise.all([
            Bill.aggregate([
                {
                    $match: {
                        business: businessId,
                        type: "sale",
                        status: "completed",
                        createdAt: dateMatch,
                    },
                },
                {
                    $group: {
                        _id: null,
                        grossRevenue: { $sum: { $add: ["$total", "$totalDiscount"] } },
                        totalItemDiscount: { $sum: "$totalItemDiscount" },
                        totalBillDiscount: { $sum: "$billDiscountAmount" },
                        totalDiscount: { $sum: "$totalDiscount" },
                        netRevenue: { $sum: "$total" },
                        totalCost: { $sum: "$totalCost" },
                        grossProfit: { $sum: "$billProfit" },
                        totalRefunded: { $sum: "$totalRefunded" },
                        returnedProfit: { $sum: "$returnedProfit" },
                        netProfit: { $sum: "$netProfit" },
                        totalOrders: { $sum: 1 },
                        totalItems: { $sum: "$totalQty" },
                    },
                },
            ]),
            // Standalone refund totals
            Bill.aggregate([
                {
                    $match: {
                        business: businessId,
                        type: "refund",
                        status: "completed",
                        createdAt: dateMatch,
                    },
                },
                {
                    $group: {
                        _id: null,
                        totalRefunded: { $sum: { $abs: "$total" } },
                        count: { $sum: 1 },
                    },
                },
            ]),
            // COGS of items still with customers (sale items: costPrice × (qty - returnedQty))
            Bill.aggregate([
                {
                    $match: {
                        business: businessId,
                        type: "sale",
                        status: "completed",
                        createdAt: dateMatch,
                    },
                },
                { $unwind: "$items" },
                {
                    $group: {
                        _id: null,
                        netCogs: { $sum: { $multiply: ["$items.costPrice", { $subtract: ["$items.qty", { $ifNull: ["$items.returnedQty", 0] }] }] } },
                    },
                },
            ]),
            Expense.aggregate([
                {
                    $match: {
                        business: businessId,
                        status: "approved",
                        date: dateMatch,
                    },
                },
                {
                    $group: {
                        _id: null,
                        totalExpenses: { $sum: "$amount" },
                    },
                },
                // Also get breakdown by category
            ]),
        ]);

        // Expense breakdown by category (separate query for clarity)
        const expenseBreakdown = await Expense.aggregate([
            {
                $match: {
                    business: businessId,
                    status: "approved",
                    date: dateMatch,
                },
            },
            {
                $group: {
                    _id: "$category",
                    amount: { $sum: "$amount" },
                    count: { $sum: 1 },
                },
            },
            { $sort: { amount: -1 } },
        ]);

        const sales = salesResult[0] || {
            grossRevenue: 0, totalItemDiscount: 0, totalBillDiscount: 0,
            totalDiscount: 0, netRevenue: 0, totalCost: 0, grossProfit: 0,
            totalRefunded: 0, returnedProfit: 0, netProfit: 0,
            totalOrders: 0, totalItems: 0,
        };
        const standaloneRefunds = standaloneRefundResult[0] || { totalRefunded: 0, count: 0 };
        const adjustedCogs = netCogsResult[0]?.netCogs || 0;
        const totalExpenses = expenseResult[0]?.totalExpenses || 0;

        // Include standalone refunds in totals
        sales.totalRefunded += standaloneRefunds.totalRefunded;

        // Net Revenue - COGS of kept items - Expenses = Net Profit
        const revenueAfterReturns = sales.netRevenue - sales.totalRefunded;
        const trueNetProfit = revenueAfterReturns - adjustedCogs - totalExpenses;
        const profitMargin = revenueAfterReturns > 0
            ? Math.round((trueNetProfit / revenueAfterReturns) * 10000) / 100
            : 0;

        res.json({
            period: { start: periodStart, end: periodEnd, filter: filter || "custom" },

            // Revenue
            grossRevenue: sales.grossRevenue,
            totalDiscount: sales.totalDiscount,
            totalItemDiscount: sales.totalItemDiscount,
            totalBillDiscount: sales.totalBillDiscount,
            netRevenue: sales.netRevenue,
            totalRefunded: sales.totalRefunded,
            revenueAfterReturns,

            // Cost & Profit
            totalCost: sales.totalCost,
            adjustedCogs,
            grossProfit: sales.grossProfit,
            returnedProfit: sales.returnedProfit,
            salesNetProfit: sales.netProfit,

            // Expenses
            totalExpenses,
            expenseBreakdown,

            // True P&L
            trueNetProfit,
            profitMargin,

            // Volume
            totalOrders: sales.totalOrders,
            totalItems: sales.totalItems,
            avgOrderValue: sales.totalOrders > 0 ? Math.round((sales.netRevenue / sales.totalOrders) * 100) / 100 : 0,
        });
    } catch (error) {
        console.error("Error fetching profit report:", error);
        res.status(500).json({ message: "Failed to fetch profit report" });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// SALES BY CATEGORY
// ═══════════════════════════════════════════════════════════════════════════

export const salesByCategory = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const match = {
            business: new mongoose.Types.ObjectId(req.user.businessId),
            status: "completed",
            type: "sale",
        };
        if (startDate || endDate) {
            match.createdAt = {};
            if (startDate) match.createdAt.$gte = startOfDay(startDate);
            if (endDate) match.createdAt.$lte = endOfDay(endDate);
        }

        const results = await Bill.aggregate([
            { $match: match },
            { $unwind: "$items" },
            {
                $group: {
                    _id: "$items.category",
                    totalQtySold: { $sum: "$items.qty" },
                    totalReturnedQty: { $sum: "$items.returnedQty" },
                    grossRevenue: { $sum: { $add: ["$items.itemTotal", { $ifNull: ["$items.discountAmount", 0] }] } },
                    totalDiscount: { $sum: { $ifNull: ["$items.discountAmount", 0] } },
                    netRevenue: { $sum: "$items.itemTotal" },
                    totalCost: { $sum: { $multiply: [{ $ifNull: ["$items.costPrice", 0] }, { $subtract: ["$items.qty", { $ifNull: ["$items.returnedQty", 0] }] }] } },
                    totalProfit: { $sum: "$items.netProfit" },
                    transactionCount: { $sum: 1 },
                }
            },
            {
                $project: {
                    category: { $ifNull: ["$_id", "Uncategorized"] },
                    totalQtySold: 1,
                    totalReturnedQty: 1,
                    netQtySold: { $subtract: ["$totalQtySold", "$totalReturnedQty"] },
                    grossRevenue: 1,
                    totalDiscount: 1,
                    netRevenue: 1,
                    totalCost: 1,
                    totalProfit: 1,
                    transactionCount: 1,
                }
            },
            { $sort: { grossRevenue: -1 } }
        ]);

        const totalRevenue = results.reduce((s, r) => s + r.grossRevenue, 0);
        const data = results.map(r => ({
            ...r,
            revenuePercentage: totalRevenue > 0 ? Math.round((r.grossRevenue / totalRevenue) * 10000) / 100 : 0,
            profitMargin: r.netRevenue > 0 ? Math.round((r.totalProfit / r.netRevenue) * 10000) / 100 : 0,
        }));

        res.json({ categories: data, totalRevenue });
    } catch (error) {
        console.error("Error fetching sales by category:", error);
        res.status(500).json({ message: "Failed to fetch sales by category" });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// SALES BY CASHIER/EMPLOYEE
// ═══════════════════════════════════════════════════════════════════════════

export const salesByCashier = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const match = {
            business: new mongoose.Types.ObjectId(req.user.businessId),
            status: "completed",
            type: "sale",
        };
        if (startDate || endDate) {
            match.createdAt = {};
            if (startDate) match.createdAt.$gte = startOfDay(startDate);
            if (endDate) match.createdAt.$lte = endOfDay(endDate);
        }

        const results = await Bill.aggregate([
            { $match: match },
            {
                $group: {
                    _id: { cashier: "$cashier", cashierName: "$cashierName" },
                    totalSales: { $sum: "$total" },
                    totalDiscount: { $sum: "$totalDiscount" },
                    totalRefunded: { $sum: "$totalRefunded" },
                    netSales: { $sum: { $subtract: ["$total", { $ifNull: ["$totalRefunded", 0] }] } },
                    totalProfit: { $sum: "$netProfit" },
                    billCount: { $sum: 1 },
                    totalItems: { $sum: { $size: "$items" } },
                    totalQty: { $sum: "$totalQty" },
                    avgOrderValue: { $avg: "$total" },
                }
            },
            {
                $project: {
                    cashierId: "$_id.cashier",
                    cashierName: { $ifNull: ["$_id.cashierName", "Unknown"] },
                    totalSales: 1,
                    totalDiscount: 1,
                    totalRefunded: 1,
                    netSales: 1,
                    totalProfit: 1,
                    billCount: 1,
                    totalItems: 1,
                    totalQty: 1,
                    avgOrderValue: { $round: ["$avgOrderValue", 2] },
                }
            },
            { $sort: { totalSales: -1 } }
        ]);

        res.json({ cashiers: results });
    } catch (error) {
        console.error("Error fetching sales by cashier:", error);
        res.status(500).json({ message: "Failed to fetch sales by cashier" });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// PAYMENT METHOD BREAKDOWN
// ═══════════════════════════════════════════════════════════════════════════

export const paymentMethodReport = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const match = {
            business: new mongoose.Types.ObjectId(req.user.businessId),
            status: "completed",
            type: "sale",
        };
        if (startDate || endDate) {
            match.createdAt = {};
            if (startDate) match.createdAt.$gte = startOfDay(startDate);
            if (endDate) match.createdAt.$lte = endOfDay(endDate);
        }

        const results = await Bill.aggregate([
            { $match: match },
            { $unwind: "$payments" },
            {
                $group: {
                    _id: "$payments.method",
                    totalAmount: { $sum: "$payments.amount" },
                    transactionCount: { $sum: 1 },
                }
            },
            { $sort: { totalAmount: -1 } }
        ]);

        const grandTotal = results.reduce((s, r) => s + r.totalAmount, 0);
        const methods = results.map(r => ({
            method: r._id || "unknown",
            totalAmount: r.totalAmount,
            transactionCount: r.transactionCount,
            percentage: grandTotal > 0 ? Math.round((r.totalAmount / grandTotal) * 10000) / 100 : 0,
        }));

        res.json({ methods, grandTotal });
    } catch (error) {
        console.error("Error fetching payment method report:", error);
        res.status(500).json({ message: "Failed to fetch payment method report" });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// TAX/GST COLLECTION REPORT
// ═══════════════════════════════════════════════════════════════════════════

export const taxReport = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const match = {
            business: new mongoose.Types.ObjectId(req.user.businessId),
            status: "completed",
            type: "sale",
        };
        if (startDate || endDate) {
            match.createdAt = {};
            if (startDate) match.createdAt.$gte = startOfDay(startDate);
            if (endDate) match.createdAt.$lte = endOfDay(endDate);
        }

        const [byRate, byCategory, totals] = await Promise.all([
            // GST by rate (gst field is flat per-unit amount, not percentage)
            Bill.aggregate([
                { $match: match },
                { $unwind: "$items" },
                { $match: { "items.gst": { $gt: 0 } } },
                {
                    $group: {
                        _id: "$items.gst",
                        taxableAmount: { $sum: "$items.itemTotal" },
                        taxCollected: { $sum: { $multiply: ["$items.gst", { $subtract: ["$items.qty", { $ifNull: ["$items.returnedQty", 0] }] }] } },
                        itemCount: { $sum: { $subtract: ["$items.qty", { $ifNull: ["$items.returnedQty", 0] }] } },
                    }
                },
                { $sort: { _id: 1 } }
            ]),
            // GST by category
            Bill.aggregate([
                { $match: match },
                { $unwind: "$items" },
                { $match: { "items.gst": { $gt: 0 } } },
                {
                    $group: {
                        _id: "$items.category",
                        taxableAmount: { $sum: "$items.itemTotal" },
                        taxCollected: { $sum: { $multiply: ["$items.gst", { $subtract: ["$items.qty", { $ifNull: ["$items.returnedQty", 0] }] }] } },
                    }
                },
                { $sort: { taxCollected: -1 } }
            ]),
            // Overall totals
            Bill.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: null,
                        totalTax: { $sum: "$totalTax" },
                        totalRevenue: { $sum: "$total" },
                        billCount: { $sum: 1 },
                    }
                }
            ])
        ]);

        const overall = totals[0] || { totalTax: 0, totalRevenue: 0, billCount: 0 };

        res.json({
            byRate: byRate.map(r => ({
                gstRate: r._id,
                taxableAmount: Math.round(r.taxableAmount * 100) / 100,
                taxCollected: Math.round(r.taxCollected * 100) / 100,
                itemCount: r.itemCount,
            })),
            byCategory: byCategory.map(r => ({
                category: r._id || "Uncategorized",
                taxableAmount: Math.round(r.taxableAmount * 100) / 100,
                taxCollected: Math.round(r.taxCollected * 100) / 100,
            })),
            summary: {
                totalTaxCollected: overall.totalTax,
                totalRevenue: overall.totalRevenue,
                taxPercentage: overall.totalRevenue > 0 ? Math.round((overall.totalTax / overall.totalRevenue) * 10000) / 100 : 0,
                billCount: overall.billCount,
            }
        });
    } catch (error) {
        console.error("Error fetching tax report:", error);
        res.status(500).json({ message: "Failed to fetch tax report" });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOMER SALES REPORT
// ═══════════════════════════════════════════════════════════════════════════

export const customerSalesReport = async (req, res) => {
    try {
        const { startDate, endDate, limit = 50 } = req.query;
        const match = {
            business: new mongoose.Types.ObjectId(req.user.businessId),
            status: "completed",
            type: "sale",
            customer: { $ne: null },
        };
        if (startDate || endDate) {
            match.createdAt = {};
            if (startDate) match.createdAt.$gte = startOfDay(startDate);
            if (endDate) match.createdAt.$lte = endOfDay(endDate);
        }

        const results = await Bill.aggregate([
            { $match: match },
            {
                $group: {
                    _id: "$customer",
                    customerName: { $first: "$customerName" },
                    customerPhone: { $first: "$customerPhone" },
                    totalSpent: { $sum: "$total" },
                    totalPaid: { $sum: "$amountPaid" },
                    totalDiscount: { $sum: "$totalDiscount" },
                    totalRefunded: { $sum: "$totalRefunded" },
                    billCount: { $sum: 1 },
                    totalItems: { $sum: { $size: "$items" } },
                    totalQty: { $sum: "$totalQty" },
                    lastPurchase: { $max: "$createdAt" },
                    avgOrderValue: { $avg: "$total" },
                }
            },
            {
                $project: {
                    customerId: "$_id",
                    customerName: 1,
                    customerPhone: 1,
                    totalSpent: 1,
                    totalPaid: 1,
                    balance: { $subtract: ["$totalSpent", "$totalPaid"] },
                    totalDiscount: 1,
                    totalRefunded: 1,
                    billCount: 1,
                    totalItems: 1,
                    totalQty: 1,
                    lastPurchase: 1,
                    avgOrderValue: { $round: ["$avgOrderValue", 2] },
                }
            },
            { $sort: { totalSpent: -1 } },
            { $limit: Number(limit) }
        ]);

        const { customer: _ignore, ...walkInMatch } = match;
        const walkInStats = await Bill.aggregate([
            { $match: { ...walkInMatch, customer: null } },
            {
                $group: {
                    _id: null,
                    totalSpent: { $sum: "$total" },
                    billCount: { $sum: 1 },
                }
            }
        ]);

        res.json({
            customers: results,
            walkIn: walkInStats[0] || { totalSpent: 0, billCount: 0 },
        });
    } catch (error) {
        console.error("Error fetching customer sales report:", error);
        res.status(500).json({ message: "Failed to fetch customer sales report" });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// DISCOUNT ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

export const discountReport = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const match = {
            business: new mongoose.Types.ObjectId(req.user.businessId),
            status: "completed",
            type: "sale",
            totalDiscount: { $gt: 0 },
        };
        if (startDate || endDate) {
            match.createdAt = {};
            if (startDate) match.createdAt.$gte = startOfDay(startDate);
            if (endDate) match.createdAt.$lte = endOfDay(endDate);
        }

        const [summary, byCashier, byMode, recentDiscounted] = await Promise.all([
            // Overall discount summary
            Bill.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: null,
                        totalDiscount: { $sum: "$totalDiscount" },
                        totalItemDiscount: { $sum: "$totalItemDiscount" },
                        totalBillDiscount: { $sum: "$billDiscountAmount" },
                        grossRevenue: { $sum: { $add: ["$total", "$totalDiscount"] } },
                        discountedBills: { $sum: 1 },
                    }
                }
            ]),
            // Discounts by cashier
            Bill.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: { cashier: "$cashier", cashierName: "$cashierName" },
                        totalDiscount: { $sum: "$totalDiscount" },
                        billCount: { $sum: 1 },
                        avgDiscount: { $avg: "$totalDiscount" },
                    }
                },
                {
                    $project: {
                        cashierName: { $ifNull: ["$_id.cashierName", "Unknown"] },
                        totalDiscount: 1,
                        billCount: 1,
                        avgDiscount: { $round: ["$avgDiscount", 2] },
                    }
                },
                { $sort: { totalDiscount: -1 } }
            ]),
            // Discounts by mode (item vs bill)
            Bill.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: "$discountMode",
                        totalDiscount: { $sum: "$totalDiscount" },
                        billCount: { $sum: 1 },
                    }
                }
            ]),
            // Recent discounted bills
            Bill.find(match)
                .sort({ createdAt: -1 })
                .limit(20)
                .select("billNumber cashierName totalDiscount discountMode total createdAt")
                .lean()
        ]);

        const stats = summary[0] || {
            totalDiscount: 0, totalItemDiscount: 0, totalBillDiscount: 0,
            grossRevenue: 0, discountedBills: 0,
        };

        res.json({
            summary: {
                ...stats,
                discountPercentage: stats.grossRevenue > 0
                    ? Math.round((stats.totalDiscount / stats.grossRevenue) * 10000) / 100 : 0,
            },
            byCashier,
            byMode,
            recentDiscounted,
        });
    } catch (error) {
        console.error("Error fetching discount report:", error);
        res.status(500).json({ message: "Failed to fetch discount report" });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// RETURN RATE ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

export const returnAnalysis = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const match = {
            business: new mongoose.Types.ObjectId(req.user.businessId),
            status: "completed",
            type: "sale",
        };
        if (startDate || endDate) {
            match.createdAt = {};
            if (startDate) match.createdAt.$gte = startOfDay(startDate);
            if (endDate) match.createdAt.$lte = endOfDay(endDate);
        }

        const [byProduct, byReason, overall] = await Promise.all([
            // Return rate by product
            Bill.aggregate([
                { $match: { ...match, "returns.0": { $exists: true } } },
                { $unwind: "$returns" },
                { $unwind: "$returns.items" },
                {
                    $group: {
                        _id: { product: { $ifNull: ["$returns.items.product", "$returns.items.name"] }, name: "$returns.items.name" },
                        returnedQty: { $sum: "$returns.items.quantity" },
                        refundAmount: { $sum: "$returns.items.refundAmount" },
                        returnCount: { $sum: 1 },
                    }
                },
                {
                    $project: {
                        productName: "$_id.name",
                        productId: {
                            $cond: [{ $eq: [{ $type: "$_id.product" }, "objectId"] }, "$_id.product", null]
                        },
                        returnedQty: 1,
                        refundAmount: 1,
                        returnCount: 1,
                    }
                },
                { $sort: { returnedQty: -1 } },
                { $limit: 20 }
            ]),
            // Return reasons
            Bill.aggregate([
                { $match: { ...match, "returns.0": { $exists: true } } },
                { $unwind: "$returns" },
                { $unwind: "$returns.items" },
                {
                    $group: {
                        _id: "$returns.items.reason",
                        count: { $sum: 1 },
                        totalQty: { $sum: "$returns.items.quantity" },
                        totalRefund: { $sum: "$returns.items.refundAmount" },
                    }
                },
                { $sort: { count: -1 } }
            ]),
            // Overall return stats
            Bill.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: null,
                        totalBills: { $sum: 1 },
                        billsWithReturns: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ["$returns", []] } }, 0] }, 1, 0] } },
                        totalRevenue: { $sum: "$total" },
                        totalRefunded: { $sum: "$totalRefunded" },
                    }
                }
            ])
        ]);

        const stats = overall[0] || { totalBills: 0, billsWithReturns: 0, totalRevenue: 0, totalRefunded: 0 };

        res.json({
            byProduct,
            byReason,
            summary: {
                totalBills: stats.totalBills,
                billsWithReturns: stats.billsWithReturns,
                returnRate: stats.totalBills > 0 ? Math.round((stats.billsWithReturns / stats.totalBills) * 10000) / 100 : 0,
                totalRefunded: stats.totalRefunded,
                refundPercentage: stats.totalRevenue > 0 ? Math.round((stats.totalRefunded / stats.totalRevenue) * 10000) / 100 : 0,
            }
        });
    } catch (error) {
        console.error("Error fetching return analysis:", error);
        res.status(500).json({ message: "Failed to fetch return analysis" });
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// DAILY/WEEKLY/MONTHLY BREAKDOWN
// ═══════════════════════════════════════════════════════════════════════════

export const salesTimeline = async (req, res) => {
    try {
        const { startDate, endDate, groupBy = "day" } = req.query;
        const match = {
            business: new mongoose.Types.ObjectId(req.user.businessId),
            status: "completed",
            type: "sale",
        };

        if (startDate || endDate) {
            match.createdAt = {};
            if (startDate) match.createdAt.$gte = startOfDay(startDate);
            if (endDate) match.createdAt.$lte = endOfDay(endDate);
        }

        const tz = getTimezone();
        let dateGroup;
        if (groupBy === "month") {
            dateGroup = { year: { $year: { date: "$createdAt", timezone: tz } }, month: { $month: { date: "$createdAt", timezone: tz } } };
        } else if (groupBy === "week") {
            dateGroup = { year: { $isoWeekYear: { date: "$createdAt", timezone: tz } }, week: { $isoWeek: { date: "$createdAt", timezone: tz } } };
        } else {
            dateGroup = { year: { $year: { date: "$createdAt", timezone: tz } }, month: { $month: { date: "$createdAt", timezone: tz } }, day: { $dayOfMonth: { date: "$createdAt", timezone: tz } } };
        }

        const results = await Bill.aggregate([
            { $match: match },
            {
                $group: {
                    _id: dateGroup,
                    totalSales: { $sum: "$total" },
                    totalDiscount: { $sum: "$totalDiscount" },
                    totalRefunded: { $sum: "$totalRefunded" },
                    totalProfit: { $sum: "$netProfit" },
                    billCount: { $sum: 1 },
                    totalItems: { $sum: { $size: "$items" } },
                    totalQty: { $sum: "$totalQty" },
                }
            },
            { $sort: { "_id.year": 1, "_id.month": 1, "_id.week": 1, "_id.day": 1 } }
        ]);

        const timeline = results.map(r => {
            let label;
            if (groupBy === "month") label = `${r._id.year}-${String(r._id.month).padStart(2, "0")}`;
            else if (groupBy === "week") label = `${r._id.year}-W${String(r._id.week).padStart(2, "0")}`;
            else label = `${r._id.year}-${String(r._id.month).padStart(2, "0")}-${String(r._id.day).padStart(2, "0")}`;

            return {
                period: label,
                totalSales: r.totalSales,
                totalDiscount: r.totalDiscount,
                totalRefunded: r.totalRefunded,
                netSales: r.totalSales - r.totalRefunded,
                totalProfit: r.totalProfit,
                billCount: r.billCount,
                totalItems: r.totalItems,
                totalQty: r.totalQty,
                avgOrderValue: r.billCount > 0 ? Math.round((r.totalSales / r.billCount) * 100) / 100 : 0,
            };
        });

        res.json({ timeline, groupBy });
    } catch (error) {
        console.error("Error fetching sales timeline:", error);
        res.status(500).json({ message: "Failed to fetch sales timeline" });
    }
};
