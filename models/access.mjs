import mongoose, { Schema } from "mongoose";

const accessSchema = new Schema(
    {
        employee: {
            type: Schema.Types.ObjectId,
            ref: "Employee",
            required: true
        },
        business: {
            type: Schema.Types.ObjectId,
            ref: "Business",
            required: true
        },
        permissions: {
            // POS / Sales
            pos: {
                view: { type: Boolean, default: true },
                create: { type: Boolean, default: true }
            },
            pendingBills: {
                view: { type: Boolean, default: true },
                create: { type: Boolean, default: true },
                resume: { type: Boolean, default: true },
                cancel: { type: Boolean, default: false }
            },
            returns: {
                view: { type: Boolean, default: false },
                create: { type: Boolean, default: false },
                standalone: { type: Boolean, default: false },
                cancel: { type: Boolean, default: false }
            },

            // Inventory
            products: {
                view: { type: Boolean, default: false },
                create: { type: Boolean, default: false },
                edit: { type: Boolean, default: false },
                delete: { type: Boolean, default: false },
                updateStock: { type: Boolean, default: false }
            },

            // Purchasing
            vendors: {
                view: { type: Boolean, default: false },
                create: { type: Boolean, default: false },
                edit: { type: Boolean, default: false },
                delete: { type: Boolean, default: false },
                pay: { type: Boolean, default: false }
            },
            supplies: {
                view: { type: Boolean, default: false },
                create: { type: Boolean, default: false },
                edit: { type: Boolean, default: false },
                delete: { type: Boolean, default: false },
                recordPayment: { type: Boolean, default: false },
                processReturn: { type: Boolean, default: false }
            },

            // Finance
            expenses: {
                view: { type: Boolean, default: false },
                create: { type: Boolean, default: false },
                edit: { type: Boolean, default: false },
                delete: { type: Boolean, default: false },
                approve: { type: Boolean, default: false }
            },

            // People
            customers: {
                view: { type: Boolean, default: false },
                create: { type: Boolean, default: false },
                edit: { type: Boolean, default: false },
                delete: { type: Boolean, default: false }
            },
            employees: {
                view: { type: Boolean, default: false },
                create: { type: Boolean, default: false },
                edit: { type: Boolean, default: false },
                delete: { type: Boolean, default: false },
                resetPassword: { type: Boolean, default: false }
            },

            // Cash Management
            cashbook: {
                view: { type: Boolean, default: false },
                manage: { type: Boolean, default: false }
            },

            // Reports / Analytics
            dashboard: {
                view: { type: Boolean, default: true }
            },
            reports: {
                view: { type: Boolean, default: false }
            },

            // Settings
            settings: {
                view: { type: Boolean, default: false },
                edit: { type: Boolean, default: false }
            }
        }
    },
    { timestamps: true }
);

// One access doc per employee per business
accessSchema.index({ employee: 1, business: 1 }, { unique: true });

const Access = mongoose.model("Access", accessSchema);

export default Access;
