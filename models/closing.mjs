import mongoose, { Schema } from "mongoose";

// Snapshot of a single sale bill's line detail, frozen at closing time
const closingLineItemSchema = new Schema({
    name: { type: String, required: true },
    qty: { type: Number, required: true },
    price: { type: Number, required: true },
    costPrice: { type: Number, default: 0 },
    lineProfit: { type: Number, default: 0 },
}, { _id: false });

const closingBillSchema = new Schema({
    billNumber: { type: Number },
    date: { type: Date },
    customerName: { type: String, default: "Walk-in" },
    items: [closingLineItemSchema],
    billTotal: { type: Number, default: 0 },
    billProfit: { type: Number, default: 0 },
    paymentMethod: { type: String, default: "" },
    amountPaid: { type: Number, default: 0 },
    creditAmount: { type: Number, default: 0 },
}, { _id: false });

// One row of a real, external reconciliation check: what the books say
// (expected) vs. what was physically/externally verified (counted) — a
// drawer count for cash, a bank/merchant statement for card and online.
// counted/variance/reconciled stay null until someone actually checks.
const tenderCheckSchema = new Schema({
    expected: { type: Number, default: 0 },
    counted: { type: Number, default: null },
    variance: { type: Number, default: null },
    reconciled: { type: Boolean, default: null },
}, { _id: false });

// One customer's share of this period's new credit — the detail behind the
// single creditExtended total, so "who do I need to collect from" has an
// answer straight from the closing record.
const creditByCustomerSchema = new Schema({
    customerId: { type: Schema.Types.ObjectId, ref: "Customer" },
    customerName: { type: String, default: "" },
    customerPhone: { type: String, default: "" },
    amount: { type: Number, default: 0 },
    billCount: { type: Number, default: 0 },
}, { _id: false });

const closingSchema = new Schema(
    {
        closingNumber: { type: Number },
        business: {
            type: Schema.Types.ObjectId,
            ref: "Business",
            required: true,
            index: true,
        },

        periodStart: { type: Date, required: true },
        periodEnd: { type: Date, required: true },

        closedBy: {
            id: { type: Schema.Types.ObjectId, default: null },
            name: { type: String, default: "" },
        },
        closedAt: { type: Date, default: Date.now },

        // Sales
        grossSales: { type: Number, default: 0 },
        totalDiscounts: { type: Number, default: 0 },
        totalReturns: { type: Number, default: 0 },
        netSales: { type: Number, default: 0 },
        totalOrders: { type: Number, default: 0 },
        totalItemsSold: { type: Number, default: 0 },

        // Profit
        cogs: { type: Number, default: 0 },
        grossProfit: { type: Number, default: 0 },
        totalExpenses: { type: Number, default: 0 },
        netProfit: { type: Number, default: 0 },

        // Settlement
        cashSales: { type: Number, default: 0 },
        cardSales: { type: Number, default: 0 },
        upiSales: { type: Number, default: 0 },
        storeCreditUsed: { type: Number, default: 0 },
        creditExtended: { type: Number, default: 0 },
        creditExtendedByCustomer: [creditByCustomerSchema],

        // Reconciliation
        settlementTotal: { type: Number, default: 0 },
        costPlusProfit: { type: Number, default: 0 },
        reconciled: { type: Boolean, default: true },
        reconciliationDifference: { type: Number, default: 0 },

        // Receivables (informational, not part of the reconciliation equation)
        collectionsReceived: { type: Number, default: 0 },
        outstandingReceivable: { type: Number, default: 0 },

        // Cash on hand, per the cashbook ledger (an independent record of
        // every actual cash movement: sale collections, refunds, expenses,
        // vendor/supply payments, manual deposits/withdrawals) as of
        // periodEnd — kept as its own field because it's a cumulative
        // till balance, not a per-period figure like cardSales/upiSales.
        expectedCash: { type: Number, default: 0 },

        // Real reconciliation — books vs. what was actually verified.
        // cash.expected mirrors expectedCash above (a running drawer
        // balance); card.expected/online.expected mirror cardSales/upiSales
        // (this period's settlement only — there's no running "drawer" for
        // electronic tenders). Unlike the sales-vs-settlement check above,
        // these can genuinely fail: shrinkage, an unlogged withdrawal, a
        // bank statement that doesn't match, a miscount.
        tenderReconciliation: {
            cash: tenderCheckSchema,
            card: tenderCheckSchema,
            online: tenderCheckSchema,
        },

        // Line detail snapshot (powers the closing PDF/receipt)
        bills: [closingBillSchema],

        notes: { type: String, default: "" },
    },
    { timestamps: true }
);

closingSchema.index({ business: 1, periodStart: 1 });
closingSchema.index({ business: 1, closingNumber: 1 }, { unique: true });

const Closing = mongoose.model("Closing", closingSchema);

export default Closing;
