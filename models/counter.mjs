import mongoose from 'mongoose';

const counterSchema = new mongoose.Schema({
    _id: { type: String, required: true }, // e.g., "billNumber:businessId" or "orderNumber:businessId"
    seq: { type: Number, default: 0 }
});

/**
 * Atomically get the next sequence number for a given counter.
 * Uses findOneAndUpdate with upsert to avoid race conditions.
 *
 * @param {string} name - Counter name (e.g., 'billNumber', 'orderNumber')
 * @param {string} businessId - Business ID for per-business sequences
 * @returns {Promise<number>} The next sequence number
 */
counterSchema.statics.getNextSequence = async function (name, businessId, session = null) {
    const opts = { new: true, upsert: true };
    if (session) opts.session = session;
    const counter = await this.findOneAndUpdate(
        { _id: `${name}:${businessId}` },
        { $inc: { seq: 1 } },
        opts
    );
    return counter.seq;
};

/**
 * Initialize counter from existing data (for migration).
 * Sets the counter to the max existing value so new IDs don't collide.
 *
 * @param {string} name - Counter name
 * @param {string} businessId - Business ID
 * @param {number} currentMax - Current maximum value in existing data
 */
counterSchema.statics.initializeCounter = async function (name, businessId, currentMax) {
    await this.findOneAndUpdate(
        { _id: `${name}:${businessId}` },
        { $max: { seq: currentMax } },
        { upsert: true }
    );
};

const Counter = mongoose.model('Counter', counterSchema);

export default Counter;
