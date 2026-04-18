import mongoose, { Schema } from 'mongoose';

const stockMovementSchema = new Schema(
    {
        product: {
            type: Schema.Types.ObjectId,
            ref: 'Product',
            required: true
        },
        productName: {
            type: String,
            required: true
        },
        type: {
            type: String,
            enum: ['supply_in', 'supply_update_reverse', 'supply_update_add', 'supply_delete', 'supply_return', 'bill_sold', 'bill_return', 'manual_adjustment'],
            required: true
        },
        quantity: {
            type: Number,
            required: true
        },
        previousStock: {
            type: Number,
            default: 0
        },
        newStock: {
            type: Number,
            default: 0
        },
        referenceType: {
            type: String,
            enum: ['supply', 'bill', 'manual'],
            required: true
        },
        referenceId: {
            type: Schema.Types.ObjectId
        },
        referenceNumber: {
            type: String,
            default: ''
        },
        unitPrice: {
            type: Number,
            default: 0
        },
        reason: {
            type: String,
            default: ''
        },
        performedBy: {
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

stockMovementSchema.index({ business: 1, product: 1, createdAt: -1 });
stockMovementSchema.index({ business: 1, referenceType: 1, referenceId: 1 });
stockMovementSchema.index({ business: 1, createdAt: -1 });

const StockMovement = mongoose.model('StockMovement', stockMovementSchema);

export default StockMovement;
