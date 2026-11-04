import mongoose, { Schema } from 'mongoose';

/** Every action taken in the platform admin panel (who, what, which shop, when). */
const platformAuditSchema = new Schema(
    {
        actor: {
            id: { type: Schema.Types.ObjectId, ref: 'PlatformAdmin', default: null },
            name: { type: String, default: '' },
            email: { type: String, default: '' },
        },
        action: { type: String, required: true }, // e.g. business.block, admin.create, auth.login
        business: { type: Schema.Types.ObjectId, ref: 'Business', default: null },
        businessName: { type: String, default: '' },
        details: { type: Schema.Types.Mixed, default: {} },
        ip: { type: String, default: '' },
    },
    { timestamps: true }
);

platformAuditSchema.index({ createdAt: -1 });
platformAuditSchema.index({ business: 1, createdAt: -1 });
platformAuditSchema.index({ action: 1, createdAt: -1 });

const PlatformAudit = mongoose.model('PlatformAudit', platformAuditSchema);

export default PlatformAudit;
