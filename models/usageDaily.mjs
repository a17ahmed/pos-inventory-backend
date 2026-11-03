import mongoose, { Schema } from 'mongoose';

/**
 * How much a shop used the system on one local day (Asia/Karachi), for the
 * platform admin panel. One row per business per day, filled by
 * middleware/usageTracker.mjs ($inc after each response). Approximate by design
 * (a request that dies mid-flight may not be counted). Rows expire after 180 days.
 */
const usageDailySchema = new Schema(
    {
        business: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
        date: { type: String, required: true }, // YYYY-MM-DD, local time
        requests: { type: Number, default: 0 },
        errors4xx: { type: Number, default: 0 },
        errors5xx: { type: Number, default: 0 },
        logins: { type: Number, default: 0 },
        blockedRequests: { type: Number, default: 0 },
        byArea: { type: Map, of: Number, default: {} }, // bill, product, customer, cashbook, …
        activeUsers: [{ type: Schema.Types.ObjectId }],
        expireAt: { type: Date, required: true },
    },
    { timestamps: true }
);

usageDailySchema.index({ business: 1, date: 1 }, { unique: true });
usageDailySchema.index({ date: 1 });
usageDailySchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

const UsageDaily = mongoose.model('UsageDaily', usageDailySchema);

export default UsageDaily;
