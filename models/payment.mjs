import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * A customer collection (FIFO payment against outstanding bills).
 *
 * Customer payments are recorded as sub-documents inside each Bill's `payments`
 * array (that is unchanged). This collection is a *ledger anchor* for a single
 * collect operation: it exists so an offline-synced collect can be deduped on
 * its idempotencyKey and so a replay can return the original allocation summary
 * without re-applying the payment.
 *
 * The partial unique index on (business, idempotencyKey) is the race guard:
 * two concurrent replays both try to insert this record; one wins, the other
 * gets a duplicate-key error and returns the winner. See docs/idempotency.md.
 */
const paymentSchema = new Schema(
    {
        business: { type: Schema.Types.ObjectId, ref: "Business", required: true },
        customer: { type: Schema.Types.ObjectId, ref: "Customer", required: true },

        amount: { type: Number, required: true },
        method: {
            type: String,
            enum: ["cash", "card", "online", "store_credit"],
            default: "cash",
        },
        note: { type: String, default: "" },
        reference: { type: String, default: "" },

        // Snapshot of how this collection was distributed across bills, so a
        // replay can return the same body the first request returned.
        allocations: [
            {
                billId: { type: Schema.Types.ObjectId, ref: "Bill" },
                billNumber: { type: Number },
                allocated: { type: Number },
                newStatus: { type: String },
                _id: false,
            },
        ],

        performedBy: { type: String, default: "" },
        performedById: { type: Schema.Types.ObjectId, default: null },

        idempotencyKey: { type: String },
    },
    { timestamps: true }
);

paymentSchema.index({ business: 1, customer: 1, createdAt: -1 });
// Idempotency: only keyed docs are constrained, scoped per business.
paymentSchema.index(
    { business: 1, idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);

const Payment = mongoose.model("Payment", paymentSchema);

export default Payment;
