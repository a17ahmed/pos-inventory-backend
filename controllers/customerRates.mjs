import mongoose from 'mongoose';
import Customer from '../models/customer.mjs';
import Product from '../models/product.mjs';
import { hasPosPermission } from '../middleware/accessControl.mjs';

// ─── Customer special rates ─────────────────────────────────────────────────
// A fixed per-unit price for one product for one customer. The POS reads the
// lean `specialRates` array from the customer object; these endpoints manage it.

const MESSAGES = {
    noPermission: 'You are not allowed to save customer rates',
    customerNotFound: 'Customer not found',
    productNotFound: 'Product not found',
    invalidRate: 'Rate must be lower than the selling price',
    duplicate: 'Duplicate product in rates',
};

const RATE_PRODUCT_FIELDS = { name: 1, barcode: 1, sellingPrice: 1, costPrice: 1, maxDiscountPercent: 1 };

const round2 = (x) => Math.round(x * 100) / 100;

const isObjectId = (id) => mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);

/**
 * Warning flags for a rate against the product's CURRENT values. Mirrors the
 * POS's getItemDiscountCap: the cap is maxDiscountPercent of the per-unit
 * profit, or the full profit when no percent is set.
 */
export const computeRateFlags = (product, rate) => {
    const sellingPrice = product.sellingPrice || 0;
    const costPrice = product.costPrice || 0;
    const profit = Math.max(0, sellingPrice - costPrice);
    const pct = product.maxDiscountPercent;
    const maxDiscountPerUnit = pct === null || pct === undefined ? profit : profit * (pct / 100);

    return {
        belowCost: rate < costPrice,
        beyondLimit: round2(sellingPrice - rate) > round2(maxDiscountPerUnit),
    };
};

const warningCodes = (flags) => [
    ...(flags.belowCost ? ['BELOW_COST'] : []),
    ...(flags.beyondLimit ? ['BEYOND_LIMIT'] : []),
];

// Parse and range-check a client rate. Returns the rounded number or null.
const parseRate = (value, product) => {
    if (value === null || value === '' || typeof value === 'boolean') return null;
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate < 0 || rate >= product.sellingPrice) return null;
    return round2(rate);
};

const actorFields = (req) => ({
    updatedBy: req.user.id && isObjectId(req.user.id) ? new mongoose.Types.ObjectId(req.user.id) : null,
    updatedByName: req.user.name || (req.user.adminId ? 'Admin' : 'Staff'),
});

// Shape a stored rate for API responses (the spec's lean item shape).
const toLeanRate = (r) => ({
    product: r.product,
    rate: r.rate,
    priceWhenSaved: r.priceWhenSaved,
    note: r.note || '',
    updatedByName: r.updatedByName || '',
    updatedAt: r.updatedAt,
});

const leanRates = (customer) => (customer?.specialRates || []).map(toLeanRate);

// Build the stored entry. priceWhenSaved always comes from the product.
const makeEntry = (product, rate, note, actor, now) => ({
    product: product._id,
    rate,
    priceWhenSaved: round2(product.sellingPrice),
    note: (note || '').trim().slice(0, 200),
    ...actor,
    updatedAt: now,
});

/**
 * Validate a list of { product, rate, note } entries for one business and
 * build the entries to store (priceWhenSaved from the product, stamped with
 * the caller and `now`). Returns { error: { status, message } } or
 * { entries, warnings }.
 */
export const buildRateEntries = async (inputs, req, now = new Date()) => {
    const ids = inputs.map((r) => String(r.product));
    if (new Set(ids).size !== ids.length) {
        return { error: { status: 400, message: MESSAGES.duplicate } };
    }
    if (inputs.length === 0) return { entries: [], warnings: [] };

    const products = await Product.find(
        { _id: { $in: ids }, business: req.user.businessId, isActive: true },
        RATE_PRODUCT_FIELDS
    ).lean();
    const productMap = new Map(products.map((p) => [p._id.toString(), p]));

    const actor = actorFields(req);
    const entries = [];
    const warnings = [];

    for (const input of inputs) {
        const id = String(input.product);
        const product = productMap.get(id);
        if (!product) {
            return { error: { status: 400, message: `${MESSAGES.productNotFound}: ${id}` } };
        }
        const rate = parseRate(input.rate, product);
        if (rate === null) {
            return { error: { status: 400, message: `${MESSAGES.invalidRate} (product ${id})` } };
        }

        entries.push(makeEntry(product, rate, input.note, actor, now));

        const codes = warningCodes(computeRateFlags(product, rate));
        if (codes.length > 0) warnings.push({ product: id, codes });
    }

    return { entries, warnings };
};

/**
 * Aggregation-pipeline update that atomically replaces `specialRates` with
 * `entries`. With `keepUnchanged`, an entry whose product already has a rate
 * with the same value keeps its stored priceWhenSaved/updatedAt/updatedBy
 * (only the note is refreshed), so saving an unchanged list doesn't clear the
 * "price changed" warning. With `merge`, rates for other products are kept.
 */
const ratesUpdatePipeline = (entries, { keepUnchanged = false, merge = false } = {}) => {
    const current = { $ifNull: ['$specialRates', []] };
    const incomingIds = entries.map((e) => e.product);

    // $literal so user text (e.g. a note starting with "$") is never read as a field path
    const incoming = keepUnchanged
        ? {
            $map: {
                input: { $literal: entries },
                as: 'n',
                in: {
                    $let: {
                        vars: {
                            old: {
                                $ifNull: [
                                    { $first: { $filter: { input: current, cond: { $eq: ['$$this.product', '$$n.product'] } } } },
                                    null,
                                ],
                            },
                        },
                        in: {
                            $cond: [
                                { $and: [{ $ne: ['$$old', null] }, { $eq: ['$$old.rate', '$$n.rate'] }] },
                                { $mergeObjects: ['$$old', { note: '$$n.note' }] },
                                '$$n',
                            ],
                        },
                    },
                },
            },
        }
        : { $literal: entries };

    const specialRates = merge
        ? {
            $concatArrays: [
                { $filter: { input: current, cond: { $not: [{ $in: ['$$this.product', { $literal: incomingIds }] }] } } },
                incoming,
            ],
        }
        : incoming;

    return [{ $set: { specialRates } }];
};

const loadProduct = (productId, businessId) =>
    Product.findOne({ _id: productId, business: businessId, isActive: true }, RATE_PRODUCT_FIELDS).lean();

/**
 * GET /customer/:id/rates
 * Rates with product details and computed flags, for management screens.
 * Rates whose product was deleted are dropped and pruned from the document.
 */
export const getCustomerRates = async (req, res) => {
    try {
        if (!isObjectId(req.params.id)) {
            return res.status(404).json({ message: MESSAGES.customerNotFound });
        }

        const customer = await Customer.findOne(
            { _id: req.params.id, business: req.user.businessId },
            { specialRates: 1 }
        ).lean();

        if (!customer) {
            return res.status(404).json({ message: MESSAGES.customerNotFound });
        }

        const stored = customer.specialRates || [];
        const products = stored.length > 0
            ? await Product.find(
                { _id: { $in: stored.map((r) => r.product) }, business: req.user.businessId, isActive: true },
                RATE_PRODUCT_FIELDS
            ).lean()
            : [];
        const productMap = new Map(products.map((p) => [p._id.toString(), p]));

        const rates = [];
        const missing = [];
        for (const r of stored) {
            const product = productMap.get(r.product.toString());
            if (!product) {
                missing.push(r.product);
                continue;
            }
            rates.push({
                ...toLeanRate(r),
                product: {
                    _id: product._id,
                    name: product.name,
                    barcode: product.barcode || '',
                    sellingPrice: product.sellingPrice,
                    costPrice: product.costPrice || 0,
                    maxDiscountPercent: product.maxDiscountPercent ?? null,
                },
                priceChanged: product.sellingPrice !== r.priceWhenSaved,
                ...computeRateFlags(product, r.rate),
            });
        }

        if (missing.length > 0) {
            // Best-effort cleanup; the response is already correct without it
            Customer.updateOne(
                { _id: customer._id, business: req.user.businessId },
                { $pull: { specialRates: { product: { $in: missing } } } }
            ).catch((err) => console.error('[CustomerRates] prune failed:', err.message));
        }

        res.json({ rates });
    } catch (error) {
        console.error('Error fetching customer rates:', error);
        res.status(500).json({ message: 'Failed to fetch customer rates' });
    }
};

/**
 * PUT /customer/:id/rates/:productId
 * Create or update ONE rate (POS "save as customer's rate" prompt).
 */
export const upsertCustomerRate = async (req, res) => {
    try {
        if (!(await hasPosPermission(req, 'saveCustomerRates'))) {
            return res.status(403).json({ message: MESSAGES.noPermission });
        }

        const { id, productId } = req.params;
        if (!isObjectId(id)) {
            return res.status(404).json({ message: MESSAGES.customerNotFound });
        }
        if (!isObjectId(productId)) {
            return res.status(404).json({ message: MESSAGES.productNotFound });
        }

        const [customerExists, product] = await Promise.all([
            Customer.exists({ _id: id, business: req.user.businessId }),
            loadProduct(productId, req.user.businessId),
        ]);
        if (!customerExists) {
            return res.status(404).json({ message: MESSAGES.customerNotFound });
        }
        if (!product) {
            return res.status(404).json({ message: MESSAGES.productNotFound });
        }

        const rate = parseRate(req.body.rate, product);
        if (rate === null) {
            return res.status(400).json({ message: MESSAGES.invalidRate });
        }

        const entry = makeEntry(product, rate, req.body.note, actorFields(req), new Date());

        const customer = await Customer.findOneAndUpdate(
            { _id: id, business: req.user.businessId },
            ratesUpdatePipeline([entry], { merge: true }),
            { new: true, projection: { specialRates: 1 } }
        ).lean();

        if (!customer) {
            return res.status(404).json({ message: MESSAGES.customerNotFound });
        }

        res.json({
            rate: toLeanRate(entry),
            warnings: warningCodes(computeRateFlags(product, rate)),
            specialRates: leanRates(customer),
        });
    } catch (error) {
        console.error('Error saving customer rate:', error);
        res.status(500).json({ message: 'Failed to save customer rate' });
    }
};

/**
 * DELETE /customer/:id/rates/:productId
 * Remove one rate. Idempotent: removing a rate that doesn't exist is still 200.
 */
export const deleteCustomerRate = async (req, res) => {
    try {
        if (!(await hasPosPermission(req, 'saveCustomerRates'))) {
            return res.status(403).json({ message: MESSAGES.noPermission });
        }

        const { id, productId } = req.params;
        if (!isObjectId(id)) {
            return res.status(404).json({ message: MESSAGES.customerNotFound });
        }
        if (!isObjectId(productId)) {
            return res.status(404).json({ message: MESSAGES.productNotFound });
        }

        const customer = await Customer.findOneAndUpdate(
            { _id: id, business: req.user.businessId },
            { $pull: { specialRates: { product: productId } } },
            { new: true, projection: { specialRates: 1 } }
        ).lean();

        if (!customer) {
            return res.status(404).json({ message: MESSAGES.customerNotFound });
        }

        res.json({ specialRates: leanRates(customer) });
    } catch (error) {
        console.error('Error deleting customer rate:', error);
        res.status(500).json({ message: 'Failed to delete customer rate' });
    }
};

/**
 * PUT /customer/:id/rates
 * Replace the whole list (Customers screen "Save"). Products not in the
 * payload are removed; unchanged rates keep their priceWhenSaved.
 */
export const replaceCustomerRates = async (req, res) => {
    try {
        if (!(await hasPosPermission(req, 'saveCustomerRates'))) {
            return res.status(403).json({ message: MESSAGES.noPermission });
        }

        if (!isObjectId(req.params.id)) {
            return res.status(404).json({ message: MESSAGES.customerNotFound });
        }

        const { entries, warnings, error } = await buildRateEntries(req.body.rates, req);
        if (error) {
            return res.status(error.status).json({ message: error.message });
        }

        const customer = await Customer.findOneAndUpdate(
            { _id: req.params.id, business: req.user.businessId },
            ratesUpdatePipeline(entries, { keepUnchanged: true }),
            { new: true, projection: { specialRates: 1 } }
        ).lean();

        if (!customer) {
            return res.status(404).json({ message: MESSAGES.customerNotFound });
        }

        res.json({ specialRates: leanRates(customer), warnings });
    } catch (error) {
        console.error('Error replacing customer rates:', error);
        res.status(500).json({ message: 'Failed to save customer rates' });
    }
};

export { MESSAGES as RATE_MESSAGES };
