import Joi from "joi";

const objectId = Joi.string().regex(/^[0-9a-fA-F]{24}$/, "valid ObjectId");

// ═══════════════════════════════════════════════════════════════
// ADMIN AUTH
// ═══════════════════════════════════════════════════════════════

export const adminSignupSchema = Joi.object({
    name: Joi.string().required(),
    email: Joi.string().email().required(),
    password: Joi.string().min(8).required(),
});

export const adminLoginSchema = Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required(),
});

export const forgotPasswordSchema = Joi.object({
    email: Joi.string().email().required(),
});

export const verifyOtpSchema = Joi.object({
    email: Joi.string().email().required(),
    otp: Joi.string().required(),
});

export const resetPasswordSchema = Joi.object({
    email: Joi.string().email().required(),
    otp: Joi.string().required(),
    newPassword: Joi.string().min(8).required(),
});

// ═══════════════════════════════════════════════════════════════
// EMPLOYEE AUTH
// ═══════════════════════════════════════════════════════════════

export const employeeLoginSchema = Joi.object({
    employeeId: Joi.string().required(),
    password: Joi.string().required(),
});

export const employeeChangePasswordSchema = Joi.object({
    employeeId: Joi.string().required(),
    currentPassword: Joi.string().required(),
    newPassword: Joi.string().min(8).required(),
});

// ═══════════════════════════════════════════════════════════════
// AUTH (refresh / logout)
// ═══════════════════════════════════════════════════════════════

export const refreshTokenSchema = Joi.object({
    refreshToken: Joi.string().required(),
});

export const logoutSchema = Joi.object({
    refreshToken: Joi.string().allow("", null),
});

// ═══════════════════════════════════════════════════════════════
// BUSINESS
// ═══════════════════════════════════════════════════════════════

export const registerBusinessSchema = Joi.object({
    businessName: Joi.string().required(),
    businessTypeId: objectId.required(),
    businessEmail: Joi.string().email().required(),
    businessPhone: Joi.string().allow(""),
    address: Joi.object({
        street: Joi.string().allow(""),
        city: Joi.string().allow(""),
        state: Joi.string().allow(""),
        zipCode: Joi.string().allow(""),
        country: Joi.string().allow(""),
    }),
    currency: Joi.string().default("PKR"),
    taxRate: Joi.number().min(0).max(100).default(0),
    taxLabel: Joi.string().default("GST"),
    adminName: Joi.string().required(),
    adminEmail: Joi.string().email().required(),
    adminPassword: Joi.string().min(8).required(),
});

export const updateBusinessSchema = Joi.object({
    name: Joi.string(),
    email: Joi.string().email(),
    phone: Joi.string().allow(""),
    address: Joi.object(),
    currency: Joi.string(),
    taxRate: Joi.number().min(0).max(100),
    taxLabel: Joi.string(),
    businessType: objectId,
    cashTaxRate: Joi.number().min(0).max(100),
    cardTaxRate: Joi.number().min(0).max(100),
    settings: Joi.object(),
    receiptFooter: Joi.string().max(60).allow(""),
    receiptNote: Joi.string().max(60).allow(""),
});

// ═══════════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════════

export const updateAdminSchema = Joi.object({
    name: Joi.string(),
    email: Joi.string().email(),
    password: Joi.forbidden().messages({ "any.unknown": "password cannot be updated via this endpoint" }),
    token: Joi.forbidden(),
    otp: Joi.forbidden(),
    otpExpiry: Joi.forbidden(),
    role: Joi.forbidden().messages({ "any.unknown": "role cannot be updated via this endpoint" }),
    business: Joi.forbidden(),
});

export const updateBusinessSettingsSchema = Joi.object({
    settings: Joi.object({
        language: Joi.string(),
        timezone: Joi.string(),
        dateFormat: Joi.string(),
        timeFormat: Joi.string(),
        enableTableManagement: Joi.boolean(),
        enableKitchenDisplay: Joi.boolean(),
        enableDeals: Joi.boolean(),
        requireTableForDineIn: Joi.boolean(),
        autoSendToKitchen: Joi.boolean(),
    }),
    cashTaxRate: Joi.number().min(0).max(100),
    cardTaxRate: Joi.number().min(0).max(100),
    taxLabel: Joi.string(),
});

// ═══════════════════════════════════════════════════════════════
// EMPLOYEE
// ═══════════════════════════════════════════════════════════════

export const createEmployeeSchema = Joi.object({
    name: Joi.string().required(),
    password: Joi.string().min(4).required(),
    employeeId: Joi.string(),
    username: Joi.string(),
    role: Joi.string().valid("employee", "senior", "manager", "chef", "head_chef", "waiter"),
    phone: Joi.string().allow(""),
    email: Joi.string().email().allow(""),
    salary: Joi.number().min(0),
    requirePasswordChange: Joi.boolean(),
    status: Joi.string().valid("active", "inactive", "on_leave"),
    joiningDate: Joi.date(),
    workingHours: Joi.object({
        start: Joi.string(),
        end: Joi.string(),
    }),
    daysOff: Joi.array().items(Joi.string().valid("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")),
    commissionRate: Joi.number().min(0).max(100),
    specializations: Joi.array().items(Joi.string()),
});

export const updateEmployeeSchema = Joi.object({
    name: Joi.string(),
    role: Joi.string().valid("employee", "senior", "manager", "chef", "head_chef", "waiter"),
    phone: Joi.string().allow(""),
    email: Joi.string().email().allow(""),
    salary: Joi.number().min(0),
    status: Joi.string().valid("active", "inactive", "on_leave"),
    isActive: Joi.boolean(),
    joiningDate: Joi.date(),
    workingHours: Joi.object({
        start: Joi.string(),
        end: Joi.string(),
    }),
    daysOff: Joi.array().items(Joi.string().valid("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")),
    commissionRate: Joi.number().min(0).max(100),
    specializations: Joi.array().items(Joi.string()),
    password: Joi.forbidden().messages({ "any.unknown": "use reset-password endpoint to change password" }),
    employeeId: Joi.forbidden().messages({ "any.unknown": "employeeId cannot be changed" }),
});

export const resetEmployeePasswordSchema = Joi.object({
    newPassword: Joi.string().min(4).required(),
    requirePasswordChange: Joi.boolean(),
});

export const updateWorkStatusSchema = Joi.object({
    workStatus: Joi.string().valid("active", "on_break", "busy", "offline").required(),
});

// ═══════════════════════════════════════════════════════════════
// ACCESS CONTROL
// ═══════════════════════════════════════════════════════════════

const permissionFields = Joi.object().pattern(
    Joi.string(),
    Joi.boolean()
);

export const updateAccessSchema = Joi.object({
    permissions: Joi.object({
        pos: permissionFields,
        pendingBills: permissionFields,
        returns: permissionFields,
        products: permissionFields,
        vendors: permissionFields,
        supplies: permissionFields,
        expenses: permissionFields,
        customers: permissionFields,
        employees: permissionFields,
        cashbook: permissionFields,
        dashboard: permissionFields,
        reports: permissionFields,
        settings: permissionFields,
    }).required(),
});

// ═══════════════════════════════════════════════════════════════
// PRODUCT
// ═══════════════════════════════════════════════════════════════

export const createProductSchema = Joi.object({
    name: Joi.string().required(),
    description: Joi.string().allow(""),
    barcode: Joi.string().allow(""),
    autoBarcode: Joi.boolean(),
    sku: Joi.string().allow(""),
    costPrice: Joi.number().min(0),
    sellingPrice: Joi.number().min(0).required(),
    gst: Joi.number().min(0).max(100),
    category: Joi.string(),
    stockQuantity: Joi.number().min(0),
    lowStockAlert: Joi.number().min(0),
    unit: Joi.string().valid("piece", "kg", "gram", "liter", "ml", "box", "pack", "dozen"),
    trackStock: Joi.boolean(),
    isActive: Joi.boolean(),
});

export const updateProductSchema = Joi.object({
    name: Joi.string(),
    description: Joi.string().allow(""),
    barcode: Joi.string().allow(""),
    sku: Joi.string().allow(""),
    costPrice: Joi.number().min(0),
    sellingPrice: Joi.number().min(0),
    gst: Joi.number().min(0).max(100),
    category: Joi.string(),
    stockQuantity: Joi.number().min(0),
    lowStockAlert: Joi.number().min(0),
    unit: Joi.string().valid("piece", "kg", "gram", "liter", "ml", "box", "pack", "dozen"),
    trackStock: Joi.boolean(),
    isActive: Joi.boolean(),
});

export const updateStockSchema = Joi.object({
    quantity: Joi.number().required(),
    operation: Joi.string().valid("add", "subtract", "set").required(),
});

export const bulkUpdateStockSchema = Joi.object({
    items: Joi.array()
        .items(
            Joi.object({
                productId: objectId.required(),
                quantity: Joi.number().required(),
            })
        )
        .min(1)
        .required(),
});

// ═══════════════════════════════════════════════════════════════
// CUSTOMER
// ═══════════════════════════════════════════════════════════════

export const createCustomerSchema = Joi.object({
    name: Joi.string().required(),
    phone: Joi.string().required(),
    email: Joi.string().email().allow(""),
    address: Joi.string().allow(""),
    notes: Joi.string().allow(""),
    openingBalance: Joi.number().min(0),
});

export const updateCustomerSchema = Joi.object({
    name: Joi.string(),
    phone: Joi.string(),
    email: Joi.string().email().allow(""),
    address: Joi.string().allow(""),
    notes: Joi.string().allow(""),
    isActive: Joi.boolean(),
    creditDays: Joi.number().min(0),
    creditLimit: Joi.number().min(0),
});

export const collectFromCustomerSchema = Joi.object({
    amount: Joi.number().positive().required(),
    method: Joi.string().valid("cash", "card", "online", "store_credit").default("cash"),
    note: Joi.string().allow("").default(""),
    reference: Joi.string().allow("").default(""),
});

// ═══════════════════════════════════════════════════════════════
// VENDOR
// ═══════════════════════════════════════════════════════════════

export const createVendorSchema = Joi.object({
    name: Joi.string().required(),
    phone: Joi.string().allow(""),
    company: Joi.string().allow(""),
    address: Joi.string().allow(""),
    bankAccount: Joi.object({
        accountHolder: Joi.string().allow(""),
        accountNumber: Joi.string().allow(""),
        bankName: Joi.string().allow(""),
        ifscCode: Joi.string().allow(""),
    }),
    creditDays: Joi.number().min(0),
    creditLimit: Joi.number().min(0),
    notes: Joi.string().allow(""),
    openingBalance: Joi.number().min(0),
});

export const updateVendorSchema = Joi.object({
    name: Joi.string(),
    phone: Joi.string().allow(""),
    company: Joi.string().allow(""),
    address: Joi.string().allow(""),
    bankAccount: Joi.object({
        accountHolder: Joi.string().allow(""),
        accountNumber: Joi.string().allow(""),
        bankName: Joi.string().allow(""),
        ifscCode: Joi.string().allow(""),
    }),
    creditDays: Joi.number().min(0),
    creditLimit: Joi.number().min(0),
    notes: Joi.string().allow(""),
    isActive: Joi.boolean(),
});

export const vendorPaymentSchema = Joi.object({
    amount: Joi.number().positive().required(),
    method: Joi.string().valid("cash", "card", "bank_transfer", "cheque", "online"),
    note: Joi.string().allow(""),
    reference: Joi.string().allow(""),
});

// ═══════════════════════════════════════════════════════════════
// SUPPLY
// ═══════════════════════════════════════════════════════════════

const supplyItemSchema = Joi.object({
    product: objectId.required(),
    quantity: Joi.number().integer().positive().required(),
    unitPrice: Joi.number().min(0).required(),
    total: Joi.number().min(0),
    gst: Joi.number().min(0).max(100),
    name: Joi.string(),
});

export const createSupplySchema = Joi.object({
    vendor: objectId.required(),
    vendorName: Joi.string().allow(""),
    billNumber: Joi.string().allow(""),
    billDate: Joi.date(),
    items: Joi.array().items(supplyItemSchema).min(1).required(),
    totalAmount: Joi.number().min(0),
    paidAmount: Joi.number().min(0),
    notes: Joi.string().allow(""),
    paymentMethod: Joi.string().valid("cash", "card", "bank_transfer", "cheque", "online"),
    paymentReference: Joi.string().allow(""),
});

export const updateSupplySchema = Joi.object({
    billNumber: Joi.string().allow(""),
    billDate: Joi.date(),
    items: Joi.array().items(supplyItemSchema).min(1),
    paidAmount: Joi.number().min(0),
    notes: Joi.string().allow(""),
});

export const supplyPaymentSchema = Joi.object({
    amount: Joi.number().positive().required(),
    method: Joi.string().valid("cash", "card", "bank_transfer", "cheque", "online"),
    note: Joi.string().allow(""),
    reference: Joi.string().allow(""),
});

export const supplyReturnSchema = Joi.object({
    items: Joi.array()
        .items(
            Joi.object({
                product: objectId.required(),
                quantity: Joi.number().integer().positive().required(),
                reason: Joi.string().valid("defective", "wrong_item", "expired", "damaged", "excess", "other"),
            })
        )
        .min(1)
        .required(),
    note: Joi.string().allow(""),
});

// ═══════════════════════════════════════════════════════════════
// BILL
// ═══════════════════════════════════════════════════════════════

const billItemSchema = Joi.object({
    product: objectId.allow(null),
    name: Joi.string().required(),
    barcode: Joi.string().allow(""),
    category: Joi.string(),
    qty: Joi.number().integer().positive().required(),
    price: Joi.number().min(0).required(),
    costPrice: Joi.number().min(0),
    gst: Joi.number().min(0),
    discountAmount: Joi.number().min(0),
});

const billPaymentSchema = Joi.object({
    amount: Joi.number().positive().required(),
    method: Joi.string().valid("cash", "card", "online", "store_credit"),
    paidAt: Joi.date(),
    note: Joi.string().allow(""),
});

export const createBillSchema = Joi.object({
    items: Joi.array().items(billItemSchema).min(1).required(),
    status: Joi.string().valid("completed", "hold"),
    customer: objectId.allow(null),
    customerName: Joi.string().allow(""),
    customerPhone: Joi.string().allow(""),
    cashGiven: Joi.number().min(0),
    amountPaid: Joi.number().min(0),
    paymentMethod: Joi.string().valid("cash", "card", "online", "store_credit"),
    payments: Joi.array().items(billPaymentSchema),
    billDiscountAmount: Joi.number().min(0),
    billDiscountReason: Joi.string().allow(""),
    billName: Joi.string().allow(""),
    notes: Joi.string().allow(""),
    holdNote: Joi.string().allow(""),
    idempotencyKey: Joi.string().allow(""),
});

export const holdBillSchema = Joi.object({
    items: Joi.array().items(billItemSchema).min(1).required(),
    customer: objectId.allow(null),
    customerName: Joi.string().allow(""),
    customerPhone: Joi.string().allow(""),
    amountPaid: Joi.number().min(0),
    paymentMethod: Joi.string().valid("cash", "card", "online", "store_credit"),
    billDiscountAmount: Joi.number().min(0),
    billDiscountReason: Joi.string().allow(""),
    billName: Joi.string().allow(""),
    holdNote: Joi.string().allow(""),
    notes: Joi.string().allow(""),
});

export const cancelHoldBillSchema = Joi.object({
    cancelReason: Joi.string().allow(""),
    refundOnCancel: Joi.number().min(0),
});

export const processReturnSchema = Joi.object({
    items: Joi.array()
        .items(
            Joi.object({
                itemId: objectId.required(),
                quantity: Joi.number().integer().positive().required(),
                reason: Joi.string().valid("defective", "wrong_item", "changed_mind", "expired", "damaged", "other"),
                reasonNote: Joi.string().allow(""),
            })
        )
        .min(1)
        .required(),
    notes: Joi.string().allow(""),
});

export const standaloneRefundSchema = Joi.object({
    items: Joi.array()
        .items(
            Joi.object({
                product: objectId.allow(null),
                name: Joi.string().required(),
                barcode: Joi.string().allow(""),
                category: Joi.string().allow(""),
                qty: Joi.number().integer().positive().required(),
                price: Joi.number().positive().required(),
                reason: Joi.string().valid("defective", "wrong_item", "changed_mind", "expired", "damaged", "other"),
                reasonNote: Joi.string().allow(""),
            })
        )
        .min(1)
        .required(),
    refundMethod: Joi.string().valid("cash", "card", "store_credit").default("cash"),
    customerName: Joi.string().allow(""),
    customerPhone: Joi.string().allow(""),
    notes: Joi.string().allow(""),
    restock: Joi.boolean().default(false),
});

export const addPaymentSchema = Joi.object({
    amount: Joi.number().positive().required(),
    method: Joi.string().valid("cash", "card", "online", "store_credit"),
    note: Joi.string().allow(""),
    reference: Joi.string().allow(""),
});

export const updateBillSchema = Joi.object({
    customerName: Joi.string().allow(""),
    customerPhone: Joi.string().allow(""),
    cashGiven: Joi.number().min(0),
    notes: Joi.string().allow(""),
    billName: Joi.string().allow(""),
    holdNote: Joi.string().allow(""),
});

// ═══════════════════════════════════════════════════════════════
// EXPENSE
// ═══════════════════════════════════════════════════════════════

export const createExpenseSchema = Joi.object({
    category: Joi.string()
        .valid("rent", "utilities", "supplies", "wages", "maintenance", "transport", "marketing", "insurance", "taxes", "equipment", "bank_fees", "other")
        .required(),
    description: Joi.string().allow(""),
    amount: Joi.number().positive().required(),
    date: Joi.date(),
    paymentMethod: Joi.string().valid("cash", "card", "bank_transfer", "cheque", "other"),
    receiptUrl: Joi.string().allow(""),
    notes: Joi.string().allow(""),
});

export const updateExpenseSchema = Joi.object({
    category: Joi.string().valid("rent", "utilities", "supplies", "wages", "maintenance", "transport", "marketing", "insurance", "taxes", "equipment", "bank_fees", "other"),
    description: Joi.string().allow(""),
    amount: Joi.number().positive(),
    date: Joi.date(),
    paymentMethod: Joi.string().valid("cash", "card", "bank_transfer", "cheque", "other"),
    receiptUrl: Joi.string().allow(""),
    notes: Joi.string().allow(""),
});

export const rejectExpenseSchema = Joi.object({
    reason: Joi.string().required(),
});

// ═══════════════════════════════════════════════════════════════
// CASHBOOK
// ═══════════════════════════════════════════════════════════════

export const openingBalanceSchema = Joi.object({
    amount: Joi.number().min(0).required(),
    note: Joi.string().allow('').optional(),
});

export const cashbookTransactionSchema = Joi.object({
    amount: Joi.number().positive().required(),
    note: Joi.string().allow('').optional(),
    description: Joi.string().allow('').optional(),
});
