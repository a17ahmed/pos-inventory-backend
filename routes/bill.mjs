import express from "express";
import { validate } from "../middleware/validate.mjs";
import {
    createBillSchema,
    holdBillSchema,
    cancelHoldBillSchema,
    cancelSaleBillSchema,
    processReturnSchema,
    standaloneRefundSchema,
    addPaymentSchema,
    updateBillSchema,
    addBillItemsSchema,
} from "../middleware/validationSchemas.mjs";
import {
    createBill,
    getAllBills,
    getBill,
    updateBill,
    deleteBill,
    holdBill,
    getHoldBills,
    resumeHoldBill,
    cancelHoldBill,
    cancelSaleBill,
    processReturn,
    getReturns,
    getBillForReturn,
    getReturnsSummary,
    cancelReturn,
    lookupBillsByProduct,
    createStandaloneRefund,
    getBillStats,
    getTopProducts,
    addPayment,
    salesByProduct,
    profitReport,
    salesByCategory,
    salesByCashier,
    paymentMethodReport,
    taxReport,
    customerSalesReport,
    discountReport,
    returnAnalysis,
    salesTimeline,
    getOpenBillsForCustomer,
    addItemsToBill,
} from "../controllers/bill.mjs";

const billRouter = express.Router();

// ─── Stats & Reports (before /:id to avoid conflict) ─────────
billRouter.get("/stats", getBillStats);
billRouter.get("/top-products", getTopProducts);
billRouter.get("/report/sales-by-product", salesByProduct);
billRouter.get("/report/sales-by-category", salesByCategory);
billRouter.get("/report/sales-by-cashier", salesByCashier);
billRouter.get("/report/payment-methods", paymentMethodReport);
billRouter.get("/report/tax", taxReport);
billRouter.get("/report/customer-sales", customerSalesReport);
billRouter.get("/report/discounts", discountReport);
billRouter.get("/report/returns", returnAnalysis);
billRouter.get("/report/timeline", salesTimeline);
billRouter.get("/report/profit", profitReport);

// ─── Hold bills ──────────────────────────────────────────────
billRouter.post("/hold", validate(holdBillSchema), holdBill);
billRouter.get("/hold", getHoldBills);
billRouter.patch("/:id/resume", resumeHoldBill);
billRouter.patch("/:id/cancel", validate(cancelHoldBillSchema), cancelHoldBill);

// ─── Returns ─────────────────────────────────────────────────
billRouter.get("/returns", getReturns);
billRouter.get("/returns/today-summary", getReturnsSummary);
billRouter.get("/returns/receipt/:billNumber", getBillForReturn);
billRouter.get("/returns/product/:productId", lookupBillsByProduct);
billRouter.post("/returns/standalone", validate(standaloneRefundSchema), createStandaloneRefund);
billRouter.post("/:id/return", validate(processReturnSchema), processReturn);
billRouter.patch("/:id/return/:returnId/cancel", cancelReturn);

// ─── Cancel a completed sale (mistaken bill) ─────────────────
billRouter.post("/:id/cancel", validate(cancelSaleBillSchema), cancelSaleBill);

// ─── Payments ────────────────────────────────────────────────
billRouter.post("/:id/payment", validate(addPaymentSchema), addPayment);

// ─── Add items to a customer's credit bill from today ───────
billRouter.get("/open-for-customer/:customerId", getOpenBillsForCustomer);
billRouter.post("/:id/add-items", validate(addBillItemsSchema), addItemsToBill);

// ─── Core CRUD ───────────────────────────────────────────────
billRouter.post("/", validate(createBillSchema), createBill);
billRouter.get("/", getAllBills);
billRouter.get("/:id", getBill);
billRouter.patch("/:id", validate(updateBillSchema), updateBill);
billRouter.delete("/:id", deleteBill);

export default billRouter;
