import mongoose, { Schema } from "mongoose";

const businessTypeSchema = new Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true
        },
        code: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true
        },
        icon: {
            type: String,
            required: true,
            default: "briefcase"
        },
        description: {
            type: String,
            default: ""
        },
        features: [{
            type: String
        }],
        isActive: {
            type: Boolean,
            default: true
        },
        sortOrder: {
            type: Number,
            default: 0
        }
    },
    { timestamps: true }
);

const BusinessType = mongoose.model("BusinessType", businessTypeSchema);

export default BusinessType;
