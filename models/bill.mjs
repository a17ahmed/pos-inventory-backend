import mongoose, { Schema } from "mongoose";

// Return item schema (embedded in each return entry)
const returnItemSchema = new Schema({
    product: { type: Schema.Types.ObjectId, ref: "Product", default: null },
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true },
    costPrice: { type: Number, default: 0 },
    refundAmount: { type: Number, default: 0 },
    profitLost: { type: Number, default: 0 },
    reason: {
        type: String,
        enum: ["defective", "wrong_item", "changed_mind", "expired", "damaged", "other"],
        default: "changed_mind"
    },
    reasonNote: { type: String, default: "" }
}, { _id: false });

// Return entry schema (each return event on a bill)
const returnEntrySchema = new Schema({
    returnNumber: { type: String, required: true },
    items: [returnItemSchema],
    refundMethod: {
        type: String,
        enum: ["cash", "card", "store_credit", "ledger_adjust"],
        default: "cash"
    },
    refundAmount: { type: Number, default: 0 },
    profitLost: { type: Number, default: 0 },
    processedBy: { type: Schema.Types.ObjectId, ref: "Employee", default: null },
    processedByName: { type: String, default: "" },
    returnedAt: { type: Date, default: Date.now }
}, { _id: true });

// Bill item schema
const billItemSchema = new Schema({
    product: { type: Schema.Types.ObjectId, ref: "Product", default: null },
    name: { type: String, required: true },
    barcode: { type: String, default: "" },
    category: { type: String, default: "General" },
    qty: { type: Number, required: true },
    price: { type: Number, required: true },
    costPrice: { type: Number, default: 0 },
    gst: { type: Number, default: 0 },

    // Per-item discount (flat ₹ off, frontend converts % to flat before sending)
    discountAmount: { type: Number, default: 0 },

    itemTotal: { type: Number, default: 0 },
    itemProfit: { type: Number, default: 0 },
    returnedQty: { type: Number, default: 0 },
    remainingQty: { type: Number, default: 0 },
    returnedProfit: { type: Number, default: 0 },
    netProfit: { type: Number, default: 0 }
}, { _id: true });

const billSchema = new Schema(
    {
        billNumber: { type: Number },
        business: {
            type: Schema.Types.ObjectId,
            ref: "Business",
            required: true
        },

        // Status
        status: {
            type: String,
            enum: ["hold", "completed", "cancelled"],
            default: "completed"
        },
        paymentStatus: {
            type: String,
            enum: ["unpaid", "partial", "paid"],
            default: "paid"
        },
        returnStatus: {
            type: String,
            enum: ["none", "partial", "full"],
            default: "none"
        },
        type: {
            type: String,
            enum: ["sale", "refund", "opening_balance"],
            default: "sale"
        },

        // Items
        items: {
            type: [billItemSchema],
            required: true
        },

        // Discount mode: "item" | "bill" | "none" (only one allowed per bill)
        discountMode: { type: String, enum: ["item", "bill", "none"], default: "none" },

        // Bill-level discount (flat ₹ off, frontend converts % to flat before sending)
        billDiscountAmount: { type: Number, default: 0 },
        billDiscountReason: { type: String, default: "" },

        // Discount totals (auto-calculated)
        totalItemDiscount: { type: Number, default: 0 },
        totalDiscount: { type: Number, default: 0 },

        // Discount history - tracks who gave what discount and when
        discountHistory: [{
            appliedBy: { type: Schema.Types.ObjectId, ref: "Employee", default: null },
            appliedByName: { type: String, default: "" },
            appliedAt: { type: Date, default: Date.now },
            mode: { type: String, enum: ["item", "bill"] },
            billDiscountAmount: { type: Number, default: 0 },
            reason: { type: String, default: "" },
            itemDiscounts: [{
                name: { type: String },
                product: { type: Schema.Types.ObjectId, ref: "Product", default: null },
                qty: { type: Number },
                discountAmount: { type: Number },
            }],
            totalDiscountAmount: { type: Number, default: 0 },
        }],

        // Totals
        subtotal: { type: Number, default: 0 },    // before any discount
        totalTax: { type: Number, default: 0 },
        total: { type: Number, default: 0 },        // after all discounts + tax
        totalQty: { type: Number, default: 0 },

        // Profit
        totalCost: { type: Number, default: 0 },
        billProfit: { type: Number, default: 0 },
        returnedProfit: { type: Number, default: 0 },
        netProfit: { type: Number, default: 0 },

        // Payments (tracks each payment event)
        payments: [{
            amount: { type: Number, required: true },
            method: {
                type: String,
                enum: ["cash", "card", "online", "store_credit"],
                default: "cash"
            },
            paidAt: { type: Date, default: Date.now },
            receivedBy: { type: Schema.Types.ObjectId, ref: "Employee", default: null },
            receivedByName: { type: String, default: "" },
            note: { type: String, default: "" },
            reference: { type: String, default: "" }
        }],
        amountPaid: { type: Number, default: 0 },
        amountDue: { type: Number, default: 0 },
        cashGiven: { type: Number, default: 0 },
        change: { type: Number, default: 0 },
        idempotencyKey: { type: String },

        // People
        cashier: { type: Schema.Types.ObjectId, ref: "Employee", default: null },
        cashierName: { type: String, default: "" },
        customer: { type: Schema.Types.ObjectId, ref: "Customer", default: null },
        customerName: { type: String, default: "Walk-in" },
        customerPhone: { type: String, default: "" },

        // Returns
        returns: [returnEntrySchema],
        totalRefunded: { type: Number, default: 0 },        // all refunds (all methods)
        totalLedgerRefunded: { type: Number, default: 0 },  // ledger_adjust only — reduces amountDue/balance
        netAmount: { type: Number, default: 0 },

        // Cancel info (only for cancelled hold bills)
        cancelReason: { type: String, default: "" },
        cancelledBy: { type: Schema.Types.ObjectId, ref: "Employee", default: null },
        cancelledAt: { type: Date, default: null },
        refundOnCancel: { type: Number, default: 0 },

        // Hold info
        holdNote: { type: String, default: "" },
        holdAt: { type: Date, default: null },

        // Refund receipt (self-reference when type = "refund")
        originalBill: { type: Schema.Types.ObjectId, ref: "Bill", default: null },

        // Meta
        billName: { type: String, default: "" },
        notes: { type: String, default: "" },
        date: { type: String },
        time: { type: String }
    },
    { timestamps: true }
);

// ── Indexes ──────────────────────────────────────────────────
billSchema.index({ billNumber: 1, business: 1 }, { unique: true });
billSchema.index({ business: 1, status: 1 });
billSchema.index({ business: 1, status: 1, date: 1 });
billSchema.index({ business: 1, type: 1, status: 1, createdAt: -1 });
billSchema.index({ cashier: 1, business: 1 });
billSchema.index({ customer: 1, business: 1 });
billSchema.index(
    { idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);

// ── Pre-save: calculate all totals and profits ───────────────
billSchema.pre("save", function (next) {
    // ── Refund bills use negative prices — skip normal discount/profit logic
    if (this.type === "refund") {
        for (const item of this.items) {
            item.itemTotal = item.price * item.qty;
            item.discountAmount = 0;
            item.itemProfit = 0;
            item.remainingQty = item.qty;
            item.returnedProfit = 0;
            item.netProfit = 0;
        }
        this.subtotal = this.items.reduce((sum, i) => sum + i.itemTotal, 0);
        this.totalTax = 0;
        this.totalQty = this.items.reduce((sum, i) => sum + i.qty, 0);
        this.total = this.subtotal;
        this.totalDiscount = 0;
        this.totalItemDiscount = 0;
        this.billDiscountAmount = 0;
        // Store actual cost of refunded items for profit reporting
        this.totalCost = this.items.reduce((sum, i) => sum + (i.costPrice * i.qty), 0);
        this.billProfit = Math.abs(this.total) - this.totalCost; // profit lost on this refund
        this.returnedProfit = 0;
        this.netProfit = 0;
        this.totalRefunded = Math.abs(this.total);
        this.netAmount = this.total;
        this.amountPaid = this.payments.reduce((sum, p) => sum + p.amount, 0);
        this.amountDue = 0;
        return next();
    }

    // ── Opening balance bills — simple: total = amount, no items/profit
    if (this.type === "opening_balance") {
        this.subtotal = this.total;
        this.totalTax = 0;
        this.totalQty = 0;
        this.totalDiscount = 0;
        this.totalItemDiscount = 0;
        this.billDiscountAmount = 0;
        this.totalCost = 0;
        this.billProfit = 0;
        this.returnedProfit = 0;
        this.netProfit = 0;
        this.totalRefunded = 0;
        this.netAmount = this.total;
        this.amountPaid = this.payments.reduce((sum, p) => sum + p.amount, 0);
        this.amountDue = this.total - this.amountPaid;
        if (this.amountPaid <= 0) {
            this.paymentStatus = "unpaid";
        } else if (this.amountPaid < this.total) {
            this.paymentStatus = "partial";
        } else {
            this.paymentStatus = "paid";
            this.amountDue = 0;
        }
        return next();
    }

    // ── Enforce one discount mode per bill ─────────────────────
    const hasItemDiscounts = this.items.some((i) => (i.discountAmount || 0) > 0);
    const hasBillDiscount = (this.billDiscountAmount || 0) > 0;

    if (hasItemDiscounts && hasBillDiscount) {
        return next(new Error("Cannot apply both item-level and bill-level discounts. Choose one."));
    }

    // Auto-detect discount mode
    if (hasItemDiscounts) {
        this.discountMode = "item";
        this.billDiscountAmount = 0;
    } else if (hasBillDiscount) {
        this.discountMode = "bill";
        for (const item of this.items) item.discountAmount = 0;
    } else {
        this.discountMode = "none";
    }

    // ── Item-level calculations ────────────────────────────────
    for (const item of this.items) {
        const lineGross = item.price * item.qty;

        // Cap discount at line gross (can't discount more than the price)
        item.discountAmount = Math.min(item.discountAmount || 0, lineGross);

        item.itemTotal = lineGross - item.discountAmount;
        const effectivePrice = item.itemTotal / (item.qty || 1);
        item.itemProfit = (effectivePrice - item.costPrice) * item.qty;
        item.remainingQty = item.qty - item.returnedQty;
        item.returnedProfit = (effectivePrice - item.costPrice) * item.returnedQty;
        item.netProfit = item.itemProfit - item.returnedProfit;
    }

    // ── Bill-level totals ──────────────────────────────────────
    this.subtotal = this.items.reduce((sum, i) => sum + i.itemTotal, 0);
    this.totalTax = this.items.reduce((sum, i) => sum + (i.gst * i.qty), 0);
    this.totalQty = this.items.reduce((sum, i) => sum + i.qty, 0);
    this.totalItemDiscount = this.items.reduce((sum, i) => sum + (i.discountAmount || 0), 0);

    // Bill-level discount (cap at subtotal + tax)
    const beforeBillDiscount = this.subtotal + this.totalTax;
    this.billDiscountAmount = Math.min(this.billDiscountAmount || 0, beforeBillDiscount);

    // Combined discount
    this.totalDiscount = this.totalItemDiscount + this.billDiscountAmount;

    // Final total
    this.total = beforeBillDiscount - this.billDiscountAmount;
    if (this.total < 0) this.total = 0;

    // ── Distribute bill-level discount into item profits ───────
    // So that item-level netProfit aggregation in reports matches bill-level totals
    if (this.billDiscountAmount > 0 && this.subtotal > 0) {
        for (const item of this.items) {
            const share = (item.itemTotal / this.subtotal) * this.billDiscountAmount;
            const effectivePrice = (item.itemTotal - share) / (item.qty || 1);
            item.itemProfit = (effectivePrice - item.costPrice) * item.qty;
            item.returnedProfit = (effectivePrice - item.costPrice) * item.returnedQty;
            item.netProfit = item.itemProfit - item.returnedProfit;
        }
    }

    // ── Profit ─────────────────────────────────────────────────
    this.totalCost = this.items.reduce((sum, i) => sum + (i.costPrice * i.qty), 0);
    this.billProfit = this.total - this.totalCost;
    this.returnedProfit = this.items.reduce((sum, i) => sum + i.returnedProfit, 0);
    this.netProfit = this.billProfit - this.returnedProfit;

    // ── Returns ────────────────────────────────────────────────
    this.totalRefunded = this.returns.reduce((sum, r) => sum + r.refundAmount, 0);
    // Ledger adjustments reduce what the customer owes (no cash moves)
    this.totalLedgerRefunded = this.returns
        .filter((r) => r.refundMethod === "ledger_adjust")
        .reduce((sum, r) => sum + r.refundAmount, 0);
    this.netAmount = this.total - this.totalRefunded;

    // ── Payments ───────────────────────────────────────────────
    this.amountPaid = this.payments.reduce((sum, p) => sum + p.amount, 0);

    // Effective total customer must settle (after ledger-only refunds)
    const effectiveTotal = Math.max(0, this.total - this.totalLedgerRefunded);

    if (this.amountPaid <= 0 && effectiveTotal > 0) {
        this.paymentStatus = "unpaid";
    } else if (this.amountPaid < effectiveTotal) {
        this.paymentStatus = "partial";
    } else {
        this.paymentStatus = "paid";
    }

    // NOTE: amountDue is allowed to go NEGATIVE.
    // A negative value means the customer overpaid (e.g. returned items after
    // fully paying the bill) and represents store credit owed TO the customer.
    // The post-save hook aggregates amountDue across all their bills so the
    // customer-level balance naturally reflects both debt (+) and credit (-).
    this.amountDue = effectiveTotal - this.amountPaid;
    this.change = this.cashGiven - this.total;
    if (this.change < 0) this.change = 0;

    // ── Return status ──────────────────────────────────────────
    const totalReturnedQty = this.items.reduce((sum, i) => sum + i.returnedQty, 0);
    if (totalReturnedQty <= 0) {
        this.returnStatus = "none";
    } else if (totalReturnedQty < this.totalQty) {
        this.returnStatus = "partial";
    } else {
        this.returnStatus = "full";
    }

    next();
});

// ── Post-save: sync customer ledger (skip for walk-in) ───────
// Uses this.$session() so it participates in any active transaction.
billSchema.post("save", async function () {
    if (!this.customer) return;

    const session = this.$session() || null;
    const Customer = mongoose.model("Customer");

    // Aggregate all bills for this customer in this business
    const pipeline = [
        {
            $match: {
                customer: this.customer,
                business: this.business,
                status: { $ne: "cancelled" }
            }
        },
        {
            $group: {
                _id: null,
                totalBilled: { $sum: "$total" },
                totalPaid: { $sum: "$amountPaid" },
                totalLedgerRefunded: { $sum: "$totalLedgerRefunded" },
                balance: { $sum: "$amountDue" },
                totalReturns: {
                    $sum: {
                        $cond: [{ $ne: ["$returnStatus", "none"] }, 1, 0]
                    }
                },
                totalPurchases: { $sum: 1 },
                lastPurchase: { $max: "$createdAt" }
            }
        }
    ];

    const result = session
        ? await mongoose.model("Bill").aggregate(pipeline).session(session)
        : await mongoose.model("Bill").aggregate(pipeline);

    const opts = session ? { session } : {};

    if (result.length > 0) {
        const stats = result[0];
        await Customer.findByIdAndUpdate(this.customer, {
            totalBilled: stats.totalBilled,
            totalPaid: stats.totalPaid,
            balance: stats.balance,
            totalPurchases: stats.totalPurchases,
            totalReturns: stats.totalReturns,
            lastPurchase: stats.lastPurchase
        }, opts);
    } else {
        // No active bills — reset ledger
        await Customer.findByIdAndUpdate(this.customer, {
            totalBilled: 0,
            totalPaid: 0,
            balance: 0,
            totalPurchases: 0,
            totalReturns: 0,
            lastPurchase: null
        }, opts);
    }
});

const Bill = mongoose.model("Bill", billSchema);

export default Bill;
