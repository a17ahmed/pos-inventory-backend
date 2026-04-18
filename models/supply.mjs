import mongoose, { Schema } from 'mongoose';

const supplySchema = new Schema(
    {
        supplyNumber: {
            type: Number,
            required: true
        },
        type: {
            type: String,
            enum: ['purchase', 'opening_balance'],
            default: 'purchase'
        },
        vendor: {
            type: Schema.Types.ObjectId,
            ref: 'Vendor',
            required: true
        },
        vendorName: {
            type: String,
            default: ''
        },
        billNumber: {
            type: String,
            default: ''
        },
        billDate: {
            type: Date,
            required: true,
            default: Date.now
        },
        items: [
            {
                product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
                name: { type: String, required: true },
                quantity: { type: Number, required: true, min: 1 },
                unitPrice: { type: Number, required: true, min: 0 },
                gst: { type: Number, default: 0 },
                gstAmount: { type: Number, default: 0 },
                total: { type: Number, required: true, min: 0 },
                returnedQty: { type: Number, default: 0 },
                remainingQty: { type: Number, default: 0 }
            }
        ],

        // Supply returns (partial or full)
        returns: [{
            items: [{
                product: { type: Schema.Types.ObjectId, ref: 'Product' },
                name: { type: String },
                quantity: { type: Number, min: 1 },
                unitPrice: { type: Number },
                refundAmount: { type: Number, default: 0 },
                reason: {
                    type: String,
                    enum: ['defective', 'wrong_item', 'expired', 'damaged', 'excess', 'other'],
                    default: 'defective'
                }
            }],
            totalRefund: { type: Number, default: 0 },
            returnedAt: { type: Date, default: Date.now },
            returnedBy: { type: String, default: '' },
            note: { type: String, default: '' }
        }],
        totalReturned: { type: Number, default: 0 },

        // Tax totals
        totalGst: { type: Number, default: 0 },

        totalAmount: {
            type: Number,
            required: true,
            min: 0
        },
        paidAmount: {
            type: Number,
            default: 0,
            min: 0
        },
        remainingAmount: {
            type: Number,
            default: 0,
            min: 0
        },
        paymentStatus: {
            type: String,
            enum: ['unpaid', 'partial', 'paid', 'returned'],
            default: 'unpaid'
        },

        // Payment history - each payment event
        payments: [{
            amount: { type: Number, required: true },
            method: {
                type: String,
                enum: ['cash', 'card', 'bank_transfer', 'cheque', 'other'],
                default: 'cash'
            },
            paidAt: { type: Date, default: Date.now },
            paidBy: { type: String, default: '' },
            note: { type: String, default: '' },
            reference: { type: String, default: '' }
        }],

        receiptImage: {
            type: String,
            default: null
        },
        notes: {
            type: String,
            default: ''
        },
        createdBy: {
            type: String,
            default: ''
        },
        business: {
            type: Schema.Types.ObjectId,
            ref: 'Business',
            required: true
        }
    },
    { timestamps: true }
);

// Auto-calculate all totals before saving
supplySchema.pre('save', function (next) {
    // Item-level calculations
    for (const item of this.items) {
        const lineTotal = item.unitPrice * item.quantity;
        if (item.gst > 0) {
            item.gstAmount = Math.round((lineTotal * item.gst / 100) * 100) / 100;
        } else {
            item.gstAmount = 0;
        }
        item.total = lineTotal + item.gstAmount;
        item.remainingQty = item.quantity - (item.returnedQty || 0);
    }

    // Tax totals
    this.totalGst = this.items.reduce((sum, i) => sum + (i.gstAmount || 0), 0);

    // Return totals
    this.totalReturned = (this.returns || []).reduce((sum, r) => sum + r.totalRefund, 0);

    // Calculate paidAmount from payments history
    if (this.payments && this.payments.length > 0) {
        this.paidAmount = this.payments.reduce((sum, p) => sum + p.amount, 0);
    }

    // Effective amount owed = totalAmount - totalReturned
    const effectiveAmount = this.totalAmount - this.totalReturned;
    this.remainingAmount = effectiveAmount - this.paidAmount;
    if (this.remainingAmount < 0) this.remainingAmount = 0;

    if (effectiveAmount <= 0 && this.totalReturned > 0) {
        // Fully returned — nothing owed because items were sent back
        this.paymentStatus = 'returned';
        this.remainingAmount = 0;
    } else if (this.paidAmount <= 0) {
        this.paymentStatus = 'unpaid';
    } else if (this.paidAmount >= effectiveAmount) {
        this.paymentStatus = 'paid';
        this.remainingAmount = 0;
    } else {
        this.paymentStatus = 'partial';
    }
    next();
});

supplySchema.index({ supplyNumber: 1, business: 1 }, { unique: true });
supplySchema.index({ business: 1, vendor: 1 });
supplySchema.index({ business: 1, paymentStatus: 1 });
supplySchema.index({ business: 1, billDate: -1 });
supplySchema.index({ business: 1, createdAt: -1 });

const Supply = mongoose.model('Supply', supplySchema);

export default Supply;
