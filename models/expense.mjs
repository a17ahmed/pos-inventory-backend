import mongoose, { Schema } from 'mongoose';

const expenseSchema = new Schema(
    {
        // Expense Number (atomic counter like billNumber)
        expenseNumber: {
            type: Number,
            required: true
        },

        // Category
        category: {
            type: String,
            enum: [
                'rent',
                'utilities',
                'supplies',
                'wages',
                'maintenance',
                'transport',
                'marketing',
                'insurance',
                'taxes',
                'equipment',
                'bank_fees',
                'other'
            ],
            required: true
        },

        // Description
        description: {
            type: String,
            default: ''
        },

        // Amount
        amount: {
            type: Number,
            required: true,
            min: 0
        },

        // Expense Date (when the expense occurred)
        date: {
            type: Date,
            required: true,
            default: Date.now
        },

        // Payment Method
        paymentMethod: {
            type: String,
            enum: ['cash', 'card', 'bank_transfer', 'cheque', 'other'],
            default: 'cash'
        },

        // Receipt/Invoice attachment URL
        receiptUrl: {
            type: String,
            default: null
        },

        // Who recorded this expense
        createdBy: {
            type: Schema.Types.ObjectId,
            ref: 'Employee',
            default: null
        },
        createdByName: {
            type: String,
            default: ''
        },

        // Approval workflow
        status: {
            type: String,
            enum: ['pending', 'approved', 'rejected'],
            default: 'pending'
        },

        // Approved/Rejected by (admin only)
        approvedBy: {
            type: Schema.Types.ObjectId,
            ref: 'Employee',
            default: null
        },
        approvedByName: {
            type: String,
            default: ''
        },
        approvedAt: {
            type: Date,
            default: null
        },

        // Rejection reason (if rejected)
        rejectionReason: {
            type: String,
            default: ''
        },

        // Notes/Comments
        notes: {
            type: String,
            default: ''
        },

        // Business reference
        business: {
            type: Schema.Types.ObjectId,
            ref: 'Business',
            required: true
        }
    },
    { timestamps: true }
);

// Compound index for unique expenseNumber per business
expenseSchema.index({ expenseNumber: 1, business: 1 }, { unique: true });

// Index for efficient querying
expenseSchema.index({ business: 1, status: 1 });
expenseSchema.index({ business: 1, category: 1 });
expenseSchema.index({ business: 1, date: -1 });
expenseSchema.index({ business: 1, createdAt: -1 });

const Expense = mongoose.model('Expense', expenseSchema);

export default Expense;
