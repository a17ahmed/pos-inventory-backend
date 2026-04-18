import mongoose, { Schema } from "mongoose";

const adminSchema = new Schema(
    {
        name: { type: String, required: true },
        email: {
            type: String, required: true, unique: true,
            validate: {
                validator: (val) => {
                    return /^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/.test(val);
                },
                message: (props) => `${props.value} is not valid email`,
            }
        },
        password: { type: String, minLength: 8, required: true },
        business: {
            type: Schema.Types.ObjectId,
            ref: "Business",
            required: false
        },
        role: {
            type: String,
            enum: ["owner", "manager", "admin"],
            default: "owner"
        },
        token: String,
        otp: String,
        otpExpiry: Date,
    },
    { timestamps: true }
)

const Admin = mongoose.model("Admin", adminSchema);

export default Admin;