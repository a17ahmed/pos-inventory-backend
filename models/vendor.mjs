import mongoose, { Schema } from 'mongoose';

const vendorSchema = new Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true
        },
        phone: {
            type: String,
            trim: true,
            default: ''
        },
        company: {
            type: String,
            trim: true,
            default: ''
        },
        address: {
            type: String,
            trim: true,
            default: ''
        },
        bankAccount: {
            accountHolder: {
                type: String,
                trim: true,
                default: ''
            },
            accountNumber: {
                type: String,
                trim: true,
                default: ''
            },
            bankName: {
                type: String,
                trim: true,
                default: ''
            },
            ifscCode: {
                type: String,
                trim: true,
                default: ''
            }
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

        // Opening balance (for businesses migrating from another system)
        openingBalance: { type: Number, default: 0 },

        notes: {
            type: String,
            default: ''
        },
        isActive: {
            type: Boolean,
            default: true
        },
        business: {
            type: Schema.Types.ObjectId,
            ref: 'Business',
            required: true
        }
    },
    { timestamps: true }
);

vendorSchema.index({ name: 1, business: 1 }, { unique: true });
vendorSchema.index({ business: 1, isActive: 1 });

const Vendor = mongoose.model('Vendor', vendorSchema);

export default Vendor;
