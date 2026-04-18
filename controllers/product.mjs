import mongoose from 'mongoose';
import Product from '../models/product.mjs';
import StockMovement from '../models/stockMovement.mjs';
import Counter from '../models/counter.mjs';
import { startOfDay, endOfDay } from '../utils/dateHelpers.mjs';

// ─────────────────────────────────────────────────────────────
// Helpers: auto-generate SKU and barcode per business
// ─────────────────────────────────────────────────────────────

/**
 * Generate next sequential SKU for a business using atomic counter.
 * Format: SKU-000001, SKU-000002, ...
 * Retries if the generated SKU already exists (e.g., from legacy data).
 */
const generateUniqueSku = async (businessId) => {
    for (let attempt = 0; attempt < 5; attempt++) {
        const seq = await Counter.getNextSequence('productSku', businessId);
        const sku = `SKU-${String(seq).padStart(6, '0')}`;
        const exists = await Product.findOne({ sku, business: businessId }).lean();
        if (!exists) return sku;
    }
    throw new Error('Could not generate a unique SKU after 5 attempts');
};

/**
 * Generate a unique 12-digit numeric barcode for a business.
 * Collision-retries against the unique {barcode, business} index.
 */
const generateUniqueBarcode = async (businessId) => {
    for (let attempt = 0; attempt < 10; attempt++) {
        const timestamp = Date.now().toString().slice(-10);
        const random = Math.floor(Math.random() * 100).toString().padStart(2, '0');
        const barcode = `${timestamp}${random}`;
        const exists = await Product.findOne({ barcode, business: businessId }).lean();
        if (!exists) return barcode;
    }
    throw new Error('Could not generate a unique barcode after 10 attempts');
};

// Create a new product
const createProduct = async (req, res) => {
    try {
        if (!req.user?.businessId) {
            return res.status(400).json({
                message: 'Business ID not found. Please log out and log in again.'
            });
        }

        // Auto-generate SKU if blank (always — SKU is required for lookup)
        let sku = (req.body.sku || '').trim();
        if (!sku) {
            sku = await generateUniqueSku(req.user.businessId);
        }

        // Auto-generate barcode if blank (optional field — only when user wants one)
        let barcode = (req.body.barcode || '').trim();
        if (!barcode && req.body.autoBarcode === true) {
            barcode = await generateUniqueBarcode(req.user.businessId);
        }

        const productData = new Product({
            ...req.body,
            sku,
            barcode,
            business: req.user.businessId
        });

        const savedProduct = await productData.save();
        res.status(201).json(savedProduct);
    } catch (error) {
        console.error('Error creating product:', error);

        if (error.code === 11000) {
            const field = error.keyPattern?.barcode ? 'barcode' : 'SKU';
            return res.status(400).json({
                message: `A product with this ${field} already exists`
            });
        }

        console.error('[Product]', error.message);
        res.status(500).json({ message: 'Something went wrong' });
    }
};

// Get all products for the business
const getAllProducts = async (req, res) => {
    try {
        const { category, search, lowStock, active } = req.query;

        const query = {
            business: req.user.businessId
        };

        // Filter by active status
        if (active !== undefined) {
            query.isActive = active === 'true';
        }

        // Filter by category
        if (category && category !== 'All') {
            query.category = category;
        }

        // Filter low stock items
        if (lowStock === 'true') {
            query.$expr = { $lte: ['$stockQuantity', '$lowStockAlert'] };
            query.trackStock = true;
        }

        // Search filter in MongoDB (not JavaScript)
        if (search) {
            const searchRegex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            query.$or = [
                { name: searchRegex },
                { barcode: searchRegex },
                { sku: searchRegex }
            ];
        }

        let products = await Product.find(query).sort({ name: 1 });

        res.json(products);
    } catch (error) {
        console.error('[Product]', error.message);
        res.status(500).json({ message: 'Something went wrong' });
    }
};

// Get product by barcode
const getProductByBarcode = async (req, res) => {
    try {
        const { barcode } = req.params;

        const product = await Product.findOne({
            barcode: barcode,
            business: req.user.businessId,
            isActive: true
        });

        if (!product) {
            return res.status(404).json({ message: 'Product not found' });
        }

        res.json(product);
    } catch (error) {
        console.error('[Product]', error.message);
        res.status(500).json({ message: 'Something went wrong' });
    }
};

// Get single product by ID
const getProduct = async (req, res) => {
    try {
        const product = await Product.findOne({
            _id: req.params.id,
            business: req.user.businessId
        });

        if (!product) {
            return res.status(404).json({ message: 'Product not found' });
        }

        res.json(product);
    } catch (error) {
        console.error('[Product]', error.message);
        res.status(500).json({ message: 'Something went wrong' });
    }
};

// Update product
const updateProduct = async (req, res) => {
    try {
        // Only allow updating these fields
        const allowedFields = [
            'name', 'description', 'barcode', 'sku',
            'costPrice', 'sellingPrice', 'gst', 'category',
            'stockQuantity', 'lowStockAlert', 'unit', 'trackStock'
        ];

        const updates = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                updates[field] = req.body[field];
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ message: 'No valid fields to update' });
        }

        const product = await Product.findOneAndUpdate(
            { _id: req.params.id, business: req.user.businessId },
            updates,
            { new: true, runValidators: true }
        );

        if (!product) {
            return res.status(404).json({ message: 'Product not found' });
        }

        res.json(product);
    } catch (error) {
        if (error.code === 11000) {
            const field = error.keyPattern?.barcode ? 'barcode' : 'SKU';
            return res.status(400).json({
                message: `A product with this ${field} already exists`
            });
        }
        console.error('[Product]', error.message);
        res.status(500).json({ message: 'Something went wrong' });
    }
};

// Delete product (soft delete)
const deleteProduct = async (req, res) => {
    try {
        const product = await Product.findOneAndUpdate(
            { _id: req.params.id, business: req.user.businessId },
            { isActive: false },
            { new: true }
        );

        if (!product) {
            return res.status(404).json({ message: 'Product not found' });
        }

        res.json({ message: 'Product deleted successfully', product });
    } catch (error) {
        console.error('[Product]', error.message);
        res.status(500).json({ message: 'Something went wrong' });
    }
};

// Update stock quantity (atomic)
const updateStock = async (req, res) => {
    try {
        const { quantity, operation } = req.body; // operation: 'add', 'subtract', 'set'

        const filter = { _id: req.params.id, business: req.user.businessId };
        let update;

        switch (operation) {
            case 'add':
                update = { $inc: { stockQuantity: quantity } };
                break;
            case 'subtract':
                update = { $inc: { stockQuantity: -quantity } };
                break;
            case 'set':
                update = { $set: { stockQuantity: quantity } };
                break;
            default:
                return res.status(400).json({ message: 'Invalid operation' });
        }

        const product = await Product.findOneAndUpdate(filter, update, { new: true });

        if (!product) {
            return res.status(404).json({ message: 'Product not found' });
        }

        // Ensure stock doesn't go negative
        if (product.stockQuantity < 0) {
            product.stockQuantity = 0;
            await product.save();
        }

        res.json(product);
    } catch (error) {
        console.error('[Product]', error.message);
        res.status(500).json({ message: 'Something went wrong' });
    }
};

// Bulk update stock (for sales)
const bulkUpdateStock = async (req, res) => {
    try {
        const { items } = req.body; // Array of { productId, quantity }

        const ops = items.map(item => ({
            updateOne: {
                filter: { _id: item.productId, business: req.user.businessId, trackStock: true },
                update: { $inc: { stockQuantity: -item.quantity } }
            }
        }));

        const session = await mongoose.startSession();
        try {
            session.startTransaction();
            await Product.bulkWrite(ops, { session });
            await session.commitTransaction();
        } catch (txError) {
            await session.abortTransaction();
            throw txError;
        } finally {
            session.endSession();
        }

        res.json({ message: 'Stock updated successfully' });
    } catch (error) {
        console.error('[Product]', error.message);
        res.status(500).json({ message: 'Something went wrong' });
    }
};

// Get categories
const getCategories = async (req, res) => {
    try {
        const categories = await Product.distinct('category', {
            business: req.user.businessId,
            isActive: true
        });

        res.json(categories.filter(Boolean).sort());
    } catch (error) {
        console.error('[Product]', error.message);
        res.status(500).json({ message: 'Something went wrong' });
    }
};

// Get low stock products
const getLowStockProducts = async (req, res) => {
    try {
        const products = await Product.find({
            business: req.user.businessId,
            isActive: true,
            trackStock: true,
            $expr: { $lte: ['$stockQuantity', '$lowStockAlert'] }
        }).sort({ stockQuantity: 1 });

        res.json(products);
    } catch (error) {
        console.error('[Product]', error.message);
        res.status(500).json({ message: 'Something went wrong' });
    }
};

// Generate unique barcode (preview — does not save)
const generateBarcode = async (req, res) => {
    try {
        const barcode = await generateUniqueBarcode(req.user.businessId);
        res.json({ barcode });
    } catch (error) {
        console.error('[Product]', error.message);
        res.status(500).json({ message: error.message || 'Something went wrong' });
    }
};

// Generate next unique SKU (consumes the counter — safe because SKU is just an
// identifier and gaps are acceptable)
const generateSku = async (req, res) => {
    try {
        const sku = await generateUniqueSku(req.user.businessId);
        res.json({ sku });
    } catch (error) {
        console.error('[Product]', error.message);
        res.status(500).json({ message: error.message || 'Something went wrong' });
    }
};

// Get product by SKU (scoped to business)
const getProductBySku = async (req, res) => {
    try {
        const { sku } = req.params;
        const product = await Product.findOne({
            sku,
            business: req.user.businessId,
            isActive: true
        });

        if (!product) {
            return res.status(404).json({ message: 'Product not found' });
        }

        res.json(product);
    } catch (error) {
        console.error('[Product]', error.message);
        res.status(500).json({ message: 'Something went wrong' });
    }
};

// Get stock movement history for a product (or all products)
const getStockMovements = async (req, res) => {
    try {
        const { productId, type, startDate, endDate, page = 1, limit = 50 } = req.query;
        const filter = { business: req.user.businessId };

        if (productId) filter.product = productId;
        if (type) filter.type = type;
        if (startDate || endDate) {
            filter.createdAt = {};
            if (startDate) filter.createdAt.$gte = startOfDay(startDate);
            if (endDate) filter.createdAt.$lte = endOfDay(endDate);
        }

        const skip = (Number(page) - 1) * Number(limit);
        const total = await StockMovement.countDocuments(filter);

        const movements = await StockMovement.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit))
            .lean();

        res.json({
            movements,
            total,
            page: Number(page),
            totalPages: Math.ceil(total / Number(limit))
        });
    } catch (error) {
        console.error('Error fetching stock movements:', error);
        res.status(500).json({ message: 'Failed to fetch stock movements' });
    }
};

// Inventory valuation report
const getInventoryValuation = async (req, res) => {
    try {
        const products = await Product.find({
            business: req.user.businessId,
            isActive: true,
            trackStock: true
        }).select('name category stockQuantity costPrice sellingPrice').sort({ category: 1, name: 1 }).lean();

        let totalCostValue = 0;
        let totalRetailValue = 0;
        let totalItems = 0;

        const items = products.map(p => {
            const costValue = p.stockQuantity * (p.costPrice || 0);
            const retailValue = p.stockQuantity * (p.sellingPrice || 0);
            const potentialProfit = retailValue - costValue;
            totalCostValue += costValue;
            totalRetailValue += retailValue;
            totalItems += p.stockQuantity;

            return {
                _id: p._id,
                name: p.name,
                category: p.category || 'Uncategorized',
                stockQuantity: p.stockQuantity,
                costPrice: p.costPrice || 0,
                sellingPrice: p.sellingPrice || 0,
                costValue,
                retailValue,
                potentialProfit,
                margin: retailValue > 0 ? Math.round((potentialProfit / retailValue) * 10000) / 100 : 0,
            };
        });

        // Group by category
        const byCategory = {};
        for (const item of items) {
            if (!byCategory[item.category]) {
                byCategory[item.category] = { costValue: 0, retailValue: 0, itemCount: 0, productCount: 0 };
            }
            byCategory[item.category].costValue += item.costValue;
            byCategory[item.category].retailValue += item.retailValue;
            byCategory[item.category].itemCount += item.stockQuantity;
            byCategory[item.category].productCount += 1;
        }

        const categories = Object.entries(byCategory).map(([category, data]) => ({
            category,
            ...data,
            potentialProfit: data.retailValue - data.costValue,
        })).sort((a, b) => b.retailValue - a.retailValue);

        res.json({
            items,
            byCategory: categories,
            summary: {
                totalProducts: products.length,
                totalItems,
                totalCostValue: Math.round(totalCostValue * 100) / 100,
                totalRetailValue: Math.round(totalRetailValue * 100) / 100,
                totalPotentialProfit: Math.round((totalRetailValue - totalCostValue) * 100) / 100,
                avgMargin: totalRetailValue > 0 ? Math.round(((totalRetailValue - totalCostValue) / totalRetailValue) * 10000) / 100 : 0,
            }
        });
    } catch (error) {
        console.error('Error fetching inventory valuation:', error);
        res.status(500).json({ message: 'Failed to fetch inventory valuation' });
    }
};

// Dead stock report — products not sold in X days
const getDeadStock = async (req, res) => {
    try {
        const { days = 30 } = req.query;
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - Number(days));

        // Get all active products with stock
        const products = await Product.find({
            business: req.user.businessId,
            isActive: true,
            trackStock: true,
            stockQuantity: { $gt: 0 }
        }).select('name category stockQuantity costPrice sellingPrice').lean();

        const productIds = products.map(p => p._id);

        // Find products that were sold after cutoff
        const Bill = (await import('../models/bill.mjs')).default;
        const soldProducts = await Bill.aggregate([
            {
                $match: {
                    business: new mongoose.Types.ObjectId(req.user.businessId),
                    status: 'completed',
                    type: 'sale',
                    createdAt: { $gte: cutoffDate },
                }
            },
            { $unwind: '$items' },
            { $match: { 'items.product': { $in: productIds } } },
            { $group: { _id: '$items.product', lastSold: { $max: '$createdAt' }, qtySold: { $sum: '$items.qty' } } }
        ]);

        const soldMap = new Map(soldProducts.map(s => [s._id.toString(), s]));

        // Dead stock = products NOT in soldMap
        const deadStock = products
            .filter(p => !soldMap.has(p._id.toString()))
            .map(p => ({
                _id: p._id,
                name: p.name,
                category: p.category || 'Uncategorized',
                stockQuantity: p.stockQuantity,
                costPrice: p.costPrice || 0,
                sellingPrice: p.sellingPrice || 0,
                stockValue: p.stockQuantity * (p.costPrice || 0),
            }))
            .sort((a, b) => b.stockValue - a.stockValue);

        const totalDeadValue = deadStock.reduce((s, p) => s + p.stockValue, 0);

        res.json({
            deadStock,
            days: Number(days),
            summary: {
                deadProducts: deadStock.length,
                totalProducts: products.length,
                deadPercentage: products.length > 0 ? Math.round((deadStock.length / products.length) * 10000) / 100 : 0,
                totalDeadValue: Math.round(totalDeadValue * 100) / 100,
            }
        });
    } catch (error) {
        console.error('Error fetching dead stock report:', error);
        res.status(500).json({ message: 'Failed to fetch dead stock report' });
    }
};

// Inventory stock report — all products grouped by category with subtotals
const getStockReport = async (req, res) => {
    try {
        const { category, search, includeZeroStock, sortBy = 'name', sortOrder = 'asc' } = req.query;

        const query = {
            business: req.user.businessId,
            isActive: true,
            trackStock: true
        };

        if (category && category !== 'All') {
            query.category = category;
        }

        if (includeZeroStock !== 'true') {
            query.stockQuantity = { $gt: 0 };
        }

        const products = await Product.find(query)
            .select('name sku barcode category stockQuantity costPrice sellingPrice unit lowStockAlert')
            .sort({ category: 1, name: 1 })
            .lean();

        // Apply search filter (name, sku, barcode)
        let filtered = products;
        if (search) {
            const s = search.toLowerCase();
            filtered = products.filter(p =>
                p.name.toLowerCase().includes(s) ||
                p.sku?.toLowerCase().includes(s) ||
                p.barcode?.toLowerCase().includes(s)
            );
        }

        // Group by category
        const categoryMap = new Map();
        for (const p of filtered) {
            const cat = p.category || 'Uncategorized';
            if (!categoryMap.has(cat)) categoryMap.set(cat, []);
            categoryMap.get(cat).push(p);
        }

        // Sort within each category
        const sortDir = sortOrder === 'desc' ? -1 : 1;
        const sortFn = (a, b) => {
            if (sortBy === 'stockQuantity') return (a.stockQuantity - b.stockQuantity) * sortDir;
            if (sortBy === 'totalCost') return ((a.stockQuantity * (a.costPrice || 0)) - (b.stockQuantity * (b.costPrice || 0))) * sortDir;
            return a.name.localeCompare(b.name) * sortDir;
        };

        // Build response
        const grandTotal = { categoryCount: 0, productCount: 0, totalItems: 0, totalCost: 0, totalRetail: 0, lowStockCount: 0 };
        const categories = [];

        for (const [catName, catProducts] of categoryMap) {
            catProducts.sort(sortFn);

            const subtotal = { productCount: 0, totalItems: 0, totalCost: 0, totalRetail: 0, lowStockCount: 0 };
            const items = catProducts.map(p => {
                const totalCost = Math.round(p.stockQuantity * (p.costPrice || 0) * 100) / 100;
                const totalRetail = Math.round(p.stockQuantity * (p.sellingPrice || 0) * 100) / 100;
                const isLowStock = p.stockQuantity <= (p.lowStockAlert || 0);

                subtotal.productCount++;
                subtotal.totalItems += p.stockQuantity;
                subtotal.totalCost += totalCost;
                subtotal.totalRetail += totalRetail;
                if (isLowStock) subtotal.lowStockCount++;

                return {
                    _id: p._id,
                    name: p.name,
                    sku: p.sku || '',
                    barcode: p.barcode || '',
                    stockQuantity: p.stockQuantity,
                    unit: p.unit || 'piece',
                    costPrice: p.costPrice || 0,
                    sellingPrice: p.sellingPrice || 0,
                    totalCost,
                    totalRetail,
                    lowStockAlert: p.lowStockAlert || 0,
                    isLowStock
                };
            });

            subtotal.totalCost = Math.round(subtotal.totalCost * 100) / 100;
            subtotal.totalRetail = Math.round(subtotal.totalRetail * 100) / 100;

            grandTotal.categoryCount++;
            grandTotal.productCount += subtotal.productCount;
            grandTotal.totalItems += subtotal.totalItems;
            grandTotal.totalCost += subtotal.totalCost;
            grandTotal.totalRetail += subtotal.totalRetail;
            grandTotal.lowStockCount += subtotal.lowStockCount;

            categories.push({ name: catName, products: items, subtotal });
        }

        // Sort categories alphabetically
        categories.sort((a, b) => a.name.localeCompare(b.name));

        grandTotal.totalCost = Math.round(grandTotal.totalCost * 100) / 100;
        grandTotal.totalRetail = Math.round(grandTotal.totalRetail * 100) / 100;

        res.json({
            report: {
                generatedAt: new Date().toISOString(),
                filters: {
                    category: category || null,
                    search: search || null,
                    includeZeroStock: includeZeroStock === 'true'
                },
                categories,
                grandTotal
            }
        });
    } catch (error) {
        console.error('Error fetching stock report:', error);
        res.status(500).json({ message: 'Failed to fetch stock report' });
    }
};

export {
    createProduct,
    getAllProducts,
    getProduct,
    getProductByBarcode,
    getProductBySku,
    updateProduct,
    deleteProduct,
    updateStock,
    bulkUpdateStock,
    getCategories,
    getLowStockProducts,
    generateBarcode,
    generateSku,
    getStockMovements,
    getInventoryValuation,
    getStockReport,
    getDeadStock
};
