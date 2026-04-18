import mongoose, { Schema } from 'mongoose';

const productSchema = new Schema(
    {
        // Basic Info
        name: {
            type: String,
            required: true
        },
        description: {
            type: String,
            default: ''
        },
        // Identification
        barcode: {
            type: String,
            default: ''
        },
        sku: {
            type: String,
            default: ''
        },
        // Pricing
        costPrice: {
            type: Number,
            default: 0
        },
        sellingPrice: {
            type: Number,
            required: true
        },
        gst: {
            type: Number,
            default: 0
        },
        // Category
        category: {
            type: String,
            default: 'General'
        },
        // Stock Management
        stockQuantity: {
            type: Number,
            default: 0
        },
        lowStockAlert: {
            type: Number,
            default: 10
        },
        unit: {
            type: String,
            enum: ['piece', 'kg', 'gram', 'liter', 'ml', 'box', 'pack', 'dozen'],
            default: 'piece'
        },
        trackStock: {
            type: Boolean,
            default: true
        },
        // Status
        isActive: {
            type: Boolean,
            default: true
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

// Compound index for unique barcode per business
productSchema.index(
    { barcode: 1, business: 1 },
    { unique: true, partialFilterExpression: { barcode: { $gt: "" } } }
);
// Compound index for unique SKU per business
productSchema.index({ sku: 1, business: 1 }, { unique: true, sparse: true });
// Index for quick name search
productSchema.index({ name: 'text', description: 'text' });

const Product = mongoose.model('Product', productSchema);

export default Product;
