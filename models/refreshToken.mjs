import mongoose, { Schema } from 'mongoose';
import crypto from 'crypto';

const refreshTokenSchema = new Schema({
    token: { type: String, required: true, unique: true, index: true },
    user: { type: Schema.Types.ObjectId, required: true }, // admin or employee _id
    userType: { type: String, enum: ['admin', 'employee'], required: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } }, // TTL auto-delete
}, { timestamps: true });

/**
 * Generate a cryptographically secure refresh token
 */
refreshTokenSchema.statics.createToken = async function ({ userId, userType, businessId, expiresInDays = 7 }) {
    const token = crypto.randomBytes(40).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    await this.create({
        token,
        user: userId,
        userType,
        businessId,
        expiresAt
    });

    return { token, expiresAt };
};

/**
 * Verify and consume a refresh token (rotate: delete old, issue new)
 * Uses atomic findOneAndDelete to prevent race conditions
 */
refreshTokenSchema.statics.verifyAndRotate = async function (token) {
    // Atomic operation: find and delete in one step to prevent race conditions
    const existing = await this.findOneAndDelete({
        token,
        expiresAt: { $gte: new Date() }
    });

    if (!existing) return null;

    return {
        userId: existing.user,
        userType: existing.userType,
        businessId: existing.businessId
    };
};

/**
 * Revoke all refresh tokens for a user (on logout or password change)
 */
refreshTokenSchema.statics.revokeAllForUser = async function (userId) {
    await this.deleteMany({ user: userId });
};

const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);

export default RefreshToken;
