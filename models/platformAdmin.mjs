import mongoose, { Schema } from 'mongoose';

/**
 * A user of the platform admin panel (the software owner and their staff) —
 * NOT a shop user. Logs in at /platform/auth/login and gets a token with
 * scope "platform" that the shop API never accepts.
 *   superadmin — everything (block / unblock, panel users)
 *   support    — read-only
 */
const platformAdminSchema = new Schema(
    {
        name: { type: String, required: true, trim: true },
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        password: { type: String, required: true },
        role: { type: String, enum: ['superadmin', 'support'], default: 'support' },
        isActive: { type: Boolean, default: true },
        lastLoginAt: { type: Date, default: null },
        // Bumped on logout / password change / disable — tokens carrying an
        // older version stop working at once
        tokenVersion: { type: Number, default: 0 },
    },
    { timestamps: true }
);

const PlatformAdmin = mongoose.model('PlatformAdmin', platformAdminSchema);

export default PlatformAdmin;
