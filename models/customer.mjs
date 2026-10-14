import mongoose from 'mongoose';

// Fixed per-unit price ("special rate") for one product for this customer.
// One entry per product — uniqueness is enforced in the rates controller.
const specialRateSchema = new mongoose.Schema({
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    rate: { type: Number, required: true, min: 0 },
    // product.sellingPrice at save time — always set by the server
    priceWhenSaved: { type: Number, required: true, min: 0 },
    note: { type: String, trim: true, maxlength: 200, default: '' },
    // Admin or employee id (same convention as Bill.payments.receivedBy)
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    updatedByName: { type: String, default: '' },
    updatedAt: { type: Date, default: Date.now }
}, { _id: false });

const customerSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    phone: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        trim: true,
        lowercase: true,
        default: ""
    },
    address: {
        type: String,
        trim: true,
        default: ""
    },
    notes: {
        type: String,
        default: ''
    },

    // Credit terms
    creditDays: {
        type: Number,
        default: 0
    },
    creditLimit: {
        type: Number,
        default: 0
    },

    isActive: {
        type: Boolean,
        default: true
    },
    business: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Business',
        required: true
    },

    // Opening balance (for businesses migrating from another system)
    openingBalance: { type: Number, default: 0 },

    // Ledger — quick balance lookup (updated when bills are created/paid)
    totalBilled: { type: Number, default: 0 },
    totalPaid: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },

    // Stats
    totalPurchases: { type: Number, default: 0 },
    totalReturns: { type: Number, default: 0 },
    lastPurchase: { type: Date, default: null },

    // Per-product special rates (see controllers/customerRates.mjs)
    specialRates: { type: [specialRateSchema], default: [] }
}, { timestamps: true });

// Unique phone per business
customerSchema.index({ phone: 1, business: 1 }, { unique: true });
// Quick lookup for customers with outstanding balance
customerSchema.index({ business: 1, balance: 1 });
customerSchema.index({ business: 1, isActive: 1 });
// Default customer listing sort
customerSchema.index({ business: 1, isActive: 1, name: 1 });
// Product-delete cleanup of special rates
customerSchema.index({ business: 1, 'specialRates.product': 1 });

const Customer = mongoose.model('Customer', customerSchema);
export default Customer;
