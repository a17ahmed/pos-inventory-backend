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
            autoSendToKitchen: { type: Boolean, default: true }
        },
        isActive: {
            type: Boolean,
            default: true
        }
    },
    { timestamps: true }
);

const Business = mongoose.model("Business", businessSchema);

export default Business;
