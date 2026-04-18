import mongoose from "mongoose";
const { Schema } = mongoose;

const employeeSchema = new Schema({
    // Core fields (required for all employees)
    name: {
        type: String,
        required: true,
        trim: true
    },
    employeeId: {
        type: String,
        required: true,
        lowercase: true,
        trim: true
    },
    password: {
        type: String,
        required: true
    },
    requirePasswordChange: {
        type: Boolean,
        default: true
    },
    token: {
        type: String
    },
    business: {
        type: Schema.Types.ObjectId,
        ref: "Business",
        required: true
    },

    // Contact information (optional)
    phone: {
        type: String,
        trim: true,
        default: ""
    },
    email: {
        type: String,
        trim: true,
        lowercase: true,
        default: ""
    },

    // Role & Status
    role: {
        type: String,
        enum: ["employee", "senior", "manager", "chef", "head_chef", "waiter"],
        default: "employee"
    },
    status: {
        type: String,
        enum: ["active", "inactive", "on_leave"],
        default: "active"
    },
    // Real-time work status (for shift tracking)
    workStatus: {
        type: String,
        enum: ["active", "on_break", "busy", "offline"],
        default: "active"
    },

    // Service-business specific fields
    specializations: [{
        type: String,
        trim: true
    }],
    commissionRate: {
        type: Number,
        default: 0,
        min: 0,
        max: 100
    },

    // Optional HR fields
    photo: {
        type: String,
        default: ""
    },
    salary: {
        type: Number,
        default: 0
    },
    joiningDate: {
        type: Date,
        default: Date.now
    },
    workingHours: {
        start: { type: String, default: "09:00" },
        end: { type: String, default: "18:00" }
    },
    daysOff: [{
        type: String,
        enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    }]
}, {
    timestamps: true
});

// Indexes for efficient queries
employeeSchema.index({ business: 1, status: 1 });
employeeSchema.index({ employeeId: 1, business: 1 }, { unique: true });
employeeSchema.index({ business: 1, name: 1 });

const Employee = mongoose.model("Employee", employeeSchema);

export default Employee;
