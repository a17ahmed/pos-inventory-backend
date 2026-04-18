# Backend Issues Report

**Date:** 2026-04-16
**Scope:** All routes, controllers, models, middleware

---

## CRITICAL — Will crash or corrupt data

| # | Issue | File | Line |
|---|-------|------|------|
| C1 | Customer `phone` has `unique: true` globally — two businesses can't have same customer phone. Multi-tenant collision. | `models/customer.mjs` | 12 |
| C2 | `createAdmin` returns full document including password hash to client | `controllers/adminAuth.mjs` | 36 |
| C3 | `createAdmin` no duplicate-email check — crashes with raw E11000 error | `controllers/adminAuth.mjs` | 20 |
| C4 | `registerBusiness` is NOT atomic — if admin save fails, orphaned business remains | `controllers/business.mjs` | 56-86 |
| C5 | Employee `changePassword` is a public endpoint — no auth middleware, only rate limit | `routes/employee.mjs` | 60-66 |
| C6 | Supply routes have NO Joi validation — schemas exist but never wired to routes | `routes/supply.mjs` | 22, 25 |
| C7 | Supply `recordPayment` is NOT transactional — supply saved but cashbook entry could fail | `controllers/supply.mjs` | 449-531 |

---

## HIGH — Broken functionality or security holes

| # | Issue | File | Line |
|---|-------|------|------|
| H1 | `POST /business-types` is completely unprotected — anyone can create business types | `routes/businessType.mjs` | 11 |
| H2 | `updateBusiness` allows any authenticated user to update ANY business — no ownership check | `controllers/business.mjs` | 135-152 |
| H3 | `getBusinessById` allows any authenticated user to read ANY business — no ownership check | `controllers/business.mjs` | 118-131 |
| H4 | `deleteExpense` deletes approved expenses without reversing cashbook entries — phantom withdrawals | `controllers/expense.mjs` | 188-205 |
| H5 | `approveExpense` cashbook entry is outside transaction — could fail silently | `controllers/expense.mjs` | 234-248 |
| H6 | `bcrypt.hashSync` used everywhere — blocks event loop 100-200ms per call | Multiple auth controllers |
| H7 | Socket.IO `join:role` has no validation — any user can join admin room | `index.mjs` | 310-314 |

---

## MEDIUM — Should fix before go-live

| # | Issue | File |
|---|-------|------|
| M1 | `createAdmin` token missing `adminId` and `businessId` claims — token unusable for API calls | `controllers/adminAuth.mjs:23-25` |
| M2 | `getAllBills` with `all=true` has no limit — can OOM on large datasets | `controllers/bill.mjs:508-509` |
| M3 | Product search filters in JavaScript, not MongoDB — loads all products into memory | `controllers/product.mjs:110-119` |
| M4 | `updateStock` is NOT atomic — race condition with concurrent requests (read-modify-write) | `controllers/product.mjs:235-273` |
| M5 | Error responses leak `error.message` internals to clients in multiple controllers | Multiple controllers |
| M6 | Cashbook running balance is NOT concurrent-safe — can permanently corrupt ledger | `controllers/cashbook.mjs:46-56` |
| M7 | `deleteBill` customer balance sync ignores ledger refunds — balance discrepancy | `controllers/bill.mjs:644` |
| M8 | `deleteSupply` does NOT reverse cashbook entries — phantom withdrawals remain | `controllers/supply.mjs:535-601` |
| M9 | No `unhandledRejection`/`uncaughtException` handlers — process crashes silently | `index.mjs` |
| M10 | `patchAdmin` uses denylist for field filtering — fragile if new sensitive fields added | `controllers/admin.mjs:58` |
| M11 | Token stored in admin/employee document on every login — unnecessary DB writes | `controllers/adminAuth.mjs:73`, `controllers/employeeAuth.mjs:51` |
| M12 | `createAdmin` endpoint has no rate limiting beyond global — anyone can create admin accounts | `routes/adminAuth.mjs:15` |
| M13 | `deleteBill` customer balance recalc uses `totalBilled - totalPaid` (ignores ledger refunds) | `controllers/bill.mjs:644` |

---

## LOW — Nice to have

| # | Issue | File |
|---|-------|------|
| L1 | `validateAllowUnknown` exported from validate middleware but never used | `middleware/validate.mjs` |
| L2 | Private key read synchronously (`fs.readFileSync`) in 4 separate files — should centralize | Multiple auth files |
| L3 | Business route file duplicates entire `jwtAuth` middleware as `requireAuth` | `routes/business.mjs:26-47` |
| L4 | `morgan` is in package.json but never imported or used | `package.json:25` |
| L5 | `io` exported from index.mjs but never imported by any controller — real-time not implemented | `index.mjs:323` |
| L6 | No custom error handler for malformed JSON bodies — returns HTML instead of JSON | `index.mjs` |
| L7 | `xss-clean` package is deprecated and no longer maintained | `package.json:33` |
| L8 | Report aggregations have no date filter defaults — can scan entire history | Multiple report endpoints |
| L9 | `Expense` model imported in index.mjs only for counter initialization | `index.mjs:89` |

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 7 |
| HIGH | 7 |
| MEDIUM | 13 |
| LOW | 9 |
| **Total** | **36** |

### Top Priority Fixes
1. **C1** — Remove `unique: true` from phone field (keep compound index)
2. **C2** — Strip password/token/otp from createAdmin response
3. **C5** — Add jwtAuth middleware to employee changePassword route
4. **H2/H3** — Add `req.user.businessId` ownership check to business routes
5. **H4** — Reverse cashbook entry when deleting approved expense
6. **C4** — Wrap registerBusiness in a transaction
7. **C6** — Wire Joi validation to supply routes
