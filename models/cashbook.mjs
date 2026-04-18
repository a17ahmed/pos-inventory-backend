import mongoose from 'mongoose';
const { Schema } = mongoose;

const cashbookSchema = new Schema({
    entryNumber: { type: Number, required: true },

    type: {
        type: String,
        enum: [
            'opening_balance',
            'manual_deposit',
            'manual_withdrawal',
            'sale_collection',
            'vendor_payment',
            'customer_refund',
            'expense',
        ],
        required: true,
    },

    amount: { type: Number, required: true, min: 0 },
    direction: { type: String, enum: ['in', 'out'], required: true },

    runningBalance: { type: Number, required: true },

    referenceType: {
        type: String,
        enum: ['bill', 'supply', 'vendor', 'customer', 'expense', 'manual'],
        default: 'manual',
    },
    referenceId: { type: Schema.Types.ObjectId, default: null },
    referenceNumber: { type: String, default: '' },

    description: { type: String, default: '' },
    note: { type: String, default: '' },

    performedBy: { type: String, default: '' },
    performedById: { type: Schema.Types.ObjectId, default: null },

    business: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
}, { timestamps: true });

// Indexes
cashbookSchema.index({ business: 1, createdAt: -1 });
cashbookSchema.index({ entryNumber: 1, business: 1 }, { unique: true });
cashbookSchema.index({ business: 1, type: 1, createdAt: -1 });
cashbookSchema.index({ business: 1, referenceType: 1, referenceId: 1 });

const CashBook = mongoose.model('CashBook', cashbookSchema);

export default CashBook;
