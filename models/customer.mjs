import mongoose from 'mongoose';

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
    lastPurchase: { type: Date, default: null }
}, { timestamps: true });

// Unique phone per business
customerSchema.index({ phone: 1, business: 1 }, { unique: true });
// Quick lookup for customers with outstanding balance
customerSchema.index({ business: 1, balance: 1 });
customerSchema.index({ business: 1, isActive: 1 });

const Customer = mongoose.model('Customer', customerSchema);
export default Customer;
