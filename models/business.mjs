import mongoose, { Schema } from "mongoose";

const businessSchema = new Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true
        },
        businessType: {
            type: Schema.Types.ObjectId,
            ref: "BusinessType",
            required: true
        },
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
            validate: {
                validator: (val) => {
                    return /^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/.test(val);
                },
                message: (props) => `${props.value} is not a valid email`,
            }
        },
        phone: {
            type: String,
            trim: true,
            default: ""
        },
        address: {
            street: { type: String, default: "" },
            city: { type: String, default: "" },
            state: { type: String, default: "" },
            zipCode: { type: String, default: "" },
            country: { type: String, default: "" }
        },
        logo: {
            type: String,
            default: ""
        },
        currency: {
            type: String,
            default: "PKR"
        },
        taxRate: {
            type: Number,
            default: 0,
            min: 0,
            max: 100
        },
        // Separate tax rates for different payment methods
        cashTaxRate: {
            type: Number,
            default: 0,
            min: 0,
            max: 100
        },
        cardTaxRate: {
            type: Number,
            default: 0,
            min: 0,
            max: 100
        },
        taxLabel: {
            type: String,
            default: "GST"
        },
        receiptFooter: {
            type: String,
            default: "Thank you for your business!"
        },
        receiptNote: {
            type: String,
            default: ""
        },
        showCustomerPhone: {
            type: Boolean,
            default: true
        },
        showCustomerAddress: {
            type: Boolean,
            default: true
        },
        settings: {
            language: { type: String, default: "en" },
            timezone: { type: String, default: "Asia/Karachi" },
            dateFormat: { type: String, default: "DD/MM/YYYY" },
            timeFormat: { type: String, default: "12h" },
            // Optional features (all disabled by default)
            enableTableManagement: { type: Boolean, default: false },
            enableKitchenDisplay: { type: Boolean, default: false },
            enableDeals: { type: Boolean, default: true },
            requireTableForDineIn: { type: Boolean, default: false },
            autoSendToKitchen: { type: Boolean, default: true },
            // Allow a limit-override bill line to go below cost price
            // (POS warns first). Off = the cost-price floor is always enforced.
            allowSellBelowCost: { type: Boolean, default: false },
            // Let the POS add items to a registered customer's credit bill from
            // today instead of making a new bill (POST /bill/:id/add-items)
            allowBillAmend: { type: Boolean, default: false },
            // Print the receipt automatically when a bill is saved. Off = the
            // cashier prints manually with the Print button. Default on to keep
            // the existing behaviour for current shops.
            autoPrint: { type: Boolean, default: true }
        },
        isActive: {
            type: Boolean,
            default: true
        },
        lastClosingAt: {
            type: Date,
            default: null
        },
        // ── Platform (software owner) controls — never editable by the shop ──
        // status: active = normal, warning = works but shows a banner,
        // blocked = every login / request rejected (data untouched)
        subscription: {
            status: { type: String, enum: ['active', 'warning', 'blocked'], default: 'active' },
            message: { type: String, default: '' },   // shown to the shop
            contact: { type: String, default: '' },   // e.g. "Call 03xx-xxxxxxx"
            paidUntil: { type: Date, default: null },
            plan: { type: String, default: '' },
            monthlyFee: { type: Number, default: 0 },
            notes: { type: String, default: '' },     // internal, never shown to the shop
            // Tokens issued before this moment are rejected (force logout)
            sessionsRevokedAt: { type: Date, default: null },
            history: [{
                _id: false,
                action: { type: String },             // warn, block, unblock, update, revoke_sessions
                reason: { type: String, default: '' },
                details: { type: Schema.Types.Mixed, default: {} },
                at: { type: Date, default: Date.now },
                byId: { type: Schema.Types.ObjectId, default: null },
                byName: { type: String, default: '' }
            }]
        },
        lastActiveAt: {
            type: Date,
            default: null
        }
    },
    { timestamps: true }
);

// Platform-only subscription fields a shop must never see (internal notes,
// block/warn history with panel staff names, the fee). Shop-facing queries
// exclude them with SHOP_HIDDEN_BUSINESS_FIELDS; as a safety net they are also
// stripped whenever a Business document is serialised to JSON. The platform
// panel reads Business with .lean() / aggregate, which bypasses this.
export const SHOP_HIDDEN_BUSINESS_FIELDS = '-subscription.notes -subscription.history -subscription.monthlyFee';

businessSchema.set('toJSON', {
    transform: (doc, ret) => {
        if (ret.subscription) {
            delete ret.subscription.notes;
            delete ret.subscription.history;
            delete ret.subscription.monthlyFee;
        }
        return ret;
    },
});

const Business = mongoose.model("Business", businessSchema);

export default Business;
