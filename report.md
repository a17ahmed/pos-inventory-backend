# API Test Report

**Date:** 2026-04-09
**Server:** http://localhost:3000
**Purpose:** Full user journey simulation — Fresh start, all collections cleared

---

## Phase 1: User Journey (APIs #1–30)

### API #1: GET `/health`
- **Status:** 200 ✅
- **Latency:** 6ms
- **Response:** `{"status":"ok","uptime":12.5,"database":"connected"}`
- **Conclusion:** Server is running, database connected.

---

### API #2: GET `/business-types`
- **Status:** 200 ✅
- **Latency:** 218ms
- **Response:** 1 business type — `Retail Store` (ID: `69d78c97925fe67099f35063`)
- **Conclusion:** Business types available after seeding.

---

### API #3: POST `/business/register`
- **Status:** 201 ✅
- **Latency:** 1394ms
- **Request:** `{ businessName: "TestMart", adminName: "Ali Khan", adminEmail: "ali@testmart.com", currency: "PKR", taxRate: 17 }`
- **Response:** Business "TestMart" created. Admin "Ali Khan" (owner) created. JWT token issued.
- **IDs:** Business: `69d78cc63bd11edaa3e64490`, Admin: `69d78cc73bd11edaa3e64492`
- **Conclusion:** Registration works. Joi validation passed. Token returned for immediate use.

---

### API #4: POST `/adminAuth/login`
- **Status:** 200 ✅
- **Latency:** 1191ms
- **Request:** `{ email: "ali@testmart.com", password: "Test@1234" }`
- **Response:** Login successful. Access token + refresh token issued. Business settings returned with full details.
- **Conclusion:** Admin login works. Returns both tokens and full business config.

---

### API #5: GET `/admin/business/settings`
- **Status:** 200 ✅
- **Latency:** 220ms
- **Response:** Settings returned — language: en, timezone: Asia/Karachi, 12h format, deals enabled.
- **Conclusion:** Business settings endpoint works correctly with auth.

---

### API #6: GET `/employee/prefix`
- **Status:** 200 ✅
- **Latency:** 218ms
- **Response:** `{"prefix":"testmart@"}`
- **Conclusion:** Prefix generated from business name. Employee IDs will be `testmart@username`.

---

### API #7: POST `/employee/`
- **Status:** 201 ✅
- **Latency:** 734ms
- **Request:** `{ name: "Ahmed Raza", employeeId: "testmart@ahmed", role: "employee", salary: 25000 }`
- **Response:** Employee created. ID: `69d78d683bd11edaa3e6449e`, requirePasswordChange: true.
- **Conclusion:** Employee creation works. Joi validation passed.

---

### API #8: PUT `/access/:employeeId`
- **Status:** 200 ✅
- **Latency:** 447ms
- **Request:** Cashier permissions — POS, pending bills, returns, view products, create customers enabled. Admin features disabled.
- **Response:** Permissions updated successfully.
- **Conclusion:** Access control works. Joi validated the permissions object structure.

---

### API #9: POST `/product/` — Coca Cola 500ml
- **Status:** 201 ✅
- **Latency:** 258ms
- **Request:** `{ name: "Coca Cola 500ml", costPrice: 80, sellingPrice: 120, stockQuantity: 50 }`
- **Response:** Product created. ID: `69d78dc83bd11edaa3e644a4`, stockQuantity: 50 ✅
- **Conclusion:** Product creation works. `stockQuantity` field accepted correctly.

---

### API #10: POST `/product/` — Lays Classic Chips (no barcode — testing fix)
- **Status:** 201 ✅
- **Latency:** 227ms
- **Request:** `{ name: "Lays Classic Chips", costPrice: 50, sellingPrice: 80, stockQuantity: 100 }`
- **Response:** Product created. ID: `69d78dd73bd11edaa3e644a6`, stockQuantity: 100 ✅
- **Conclusion:** ✅ **BARCODE FIX CONFIRMED** — Two products with empty barcodes created successfully. Partial index working.

---

### API #11: POST `/product/` — Joi Validation Test (wrong field)
- **Status:** 400 ✅ (expected failure)
- **Latency:** 3ms
- **Request:** `{ name: "Test", sellingPrice: 100, stock: 50 }` (wrong field `stock`)
- **Response:** `{ "message": "Validation failed", "errors": [{ "field": "stock", "message": "stock is not allowed" }] }`
- **Conclusion:** ✅ **JOI VALIDATION WORKING** — Returns 400 with clear error instead of silently ignoring or crashing with 500.

---

### API #12: POST `/vendor/`
- **Status:** 201 ✅
- **Latency:** 243ms
- **Request:** `{ name: "PepsiCo Distributors", address: "Industrial Area, Lahore", creditDays: 30, creditLimit: 50000 }`
- **Response:** Vendor created. ID: `69d78e103bd11edaa3e644a8`. address, creditDays, creditLimit all saved correctly.
- **Conclusion:** ✅ **VENDOR FIX CONFIRMED** — All fields now saved properly (address, creditDays, creditLimit were previously ignored).

---

### API #13: POST `/customer/`
- **Status:** 200 ✅
- **Latency:** 443ms
- **Request:** `{ name: "Usman Ali", phone: "03331234567", email: "usman@gmail.com" }`
- **Response:** Customer created. ID: `69d78e21d18ec25d433569aa`, balance: 0.
- **Note:** Returns 200 (not 201) due to create-or-get pattern.
- **Conclusion:** Customer creation works.

---

### API #14: POST `/employeeAuth/login`
- **Status:** 200 ✅
- **Latency:** 972ms
- **Request:** `{ employeeId: "testmart@ahmed", password: "emp@1234" }`
- **Response:** Login successful. Access + refresh tokens issued. requirePasswordChange: true.
- **Conclusion:** Employee login works. Joi validation passed.

---

### API #15: POST `/supply/`
- **Status:** 201 ✅
- **Latency:** 2087ms
- **Request:** 50x Coca Cola @ 80 + 100x Lays @ 50 from PepsiCo
- **Response:** Supply #1 created. Total: 9000 PKR, unpaid. ID: `69d78e4b3bd11edaa3e644b5`
- **Conclusion:** Supply order works. Items auto-enriched with product names.

---

### API #16: PATCH `/supply/:id/pay`
- **Status:** 200 ✅
- **Latency:** 481ms
- **Request:** `{ amount: 5000, method: "cash" }`
- **Response:** Partial payment recorded. Paid: 5000/9000, remaining: 4000, status: partial.
- **Conclusion:** Supply payment works. Joi validated amount and method.

---

### API #17: POST `/bill/` — Employee POS Sale
- **Status:** 201 ✅
- **Latency:** 2783ms
- **Request:** 3x Coca Cola + 2x Lays, customer: Usman Ali, paid 520 cash
- **Response:** Bill #1 created. Total: 520 PKR, cost: 340, profit: 180. Cashier: Ahmed Raza. Fully paid.
- **Conclusion:** POS bill creation works from employee token. Cost auto-enriched from product data.

---

### API #18: POST `/bill/hold`
- **Status:** 201 ✅
- **Latency:** 880ms
- **Request:** 5x Coca Cola, holdNote: "Customer went to get money"
- **Response:** Hold bill #2 created. Total: 600 PKR, status: hold, unpaid. ID: `69d78ed23bd11edaa3e644d6`
- **Conclusion:** Hold bill works. Customer defaults to "Walk-in".

---

### API #19: PATCH `/bill/:id/resume`
- **Status:** 200 ✅
- **Latency:** 1533ms
- **Response:** Bill #2 status changed from "hold" → "completed". Stock deducted.
- **Conclusion:** Resume hold bill works. Status transitions correctly.

---

### API #20: POST `/bill/:id/payment`
- **Status:** 200 ✅
- **Latency:** 673ms
- **Request:** `{ amount: 600, method: "cash" }`
- **Response:** Payment added. Bill #2 now fully paid (600/600). paymentStatus: "paid".
- **Conclusion:** Add payment works. Joi validated amount and method.

---

### API #21: POST `/bill/:id/return` — Process Return
- **Status:** 500 ❌ → Fixed → 200 ✅
- **Latency:** 2378ms (after fix)
- **Request:** Return 1x Coca Cola from Bill #1, reason: damaged, refund: cash
- **Response (after fix):** Return RET-20260409-0001. Refund: 120 PKR. Bill profit reduced 180→140. Stock restored.
- **BUG FOUND & FIXED:** `restoreStock()` was called with items missing the `name` field. The `StockMovement` model requires `productName`. Fixed by including `name` and `price` from the bill item when building `stockItems` array in `controllers/bill.mjs:1001`.
- **Conclusion:** Return now works correctly. Refund calculated, stock restored, profit adjusted.

---

### API #22: GET `/vendor/:id/ledger`
- **Status:** 200 ✅
- **Latency:** 429ms
- **Response:** 2 ledger entries — Supply debit 9000 + Payment credit 5000. Balance: 4000 PKR outstanding.
- **Conclusion:** Vendor ledger correctly tracks supplies and payments.

---

### API #23: GET `/customer/:id/ledger`
- **Status:** 200 ✅
- **Latency:** 427ms
- **Response:** 3 entries — Bill debit 520, payment credit 520, return credit 120. Balance: -120 (customer overpaid due to return).
- **Conclusion:** Customer ledger correctly tracks bills, payments, and returns.

---

### API #24: POST `/expense/`
- **Status:** 201 ✅
- **Latency:** 493ms
- **Request:** `{ category: "rent", description: "Shop rent for April", amount: 15000, paymentMethod: "bank_transfer" }`
- **Response:** Expense #1 created. Status: pending. ID: `69d792f30cdda75c7242e731`
- **Conclusion:** Expense creation works. Joi validated category enum and amount.

---

### API #25: POST `/expense/:id/approve`
- **Status:** 200 ✅
- **Latency:** 429ms
- **Response:** Expense approved by Admin. Status: pending → approved.
- **Conclusion:** Expense approval workflow works.

---

### API #26: GET `/bill/stats`
- **Status:** 200 ✅
- **Latency:** 215ms
- **Response:** Gross revenue: 1120, net revenue: 1000, total refunded: 120, net profit: 340, 2 orders, 10 items.
- **Conclusion:** Bill stats correctly aggregate sales, returns, and profit.

---

### API #27: GET `/product/low-stock`
- **Status:** 200 ✅
- **Latency:** 213ms
- **Response:** Empty array (no low-stock products — stock is above alert thresholds).
- **Conclusion:** Low stock endpoint works correctly.

---

### API #28: POST `/auth/refresh`
- **Status:** 200 ✅
- **Latency:** 657ms
- **Request:** `{ refreshToken: "313087..." }`
- **Response:** New access token + new refresh token issued. Token rotation working (old token revoked).
- **Conclusion:** Token refresh with rotation works correctly.

---

### API #29: GET `/expense/stats`
- **Status:** 200 ✅
- **Latency:** 640ms
- **Response:** Total expenses: 15000, 1 expense, category breakdown: rent 15000.
- **Conclusion:** Expense stats aggregation works.

---

### API #30: POST `/auth/logout`
- **Status:** 200 ✅
- **Latency:** 220ms
- **Request:** `{ refreshToken: "65a24a..." }`
- **Response:** `{ "message": "Logged out" }`. Refresh token revoked.
- **Conclusion:** Logout works. Refresh token deleted from database.

---

## Phase 2: Full CRUD & Remaining Endpoints (APIs #31–104)

### API #31: GET `/employee/` — List All Employees
- **Status:** 200 ✅
- **Latency:** 217ms
- **Response:** 1 employee returned — Ahmed Raza, role: employee, status: active.
- **Conclusion:** Employee listing works with business isolation.

---

### API #32: GET `/employee/count`
- **Status:** 200 ✅
- **Latency:** 214ms
- **Response:** `{"count":1}`
- **Conclusion:** Employee count works.

---

### API #33: GET `/employee/check-id?employeeId=testmart@ahmed`
- **Status:** 200 ✅
- **Latency:** 218ms
- **Response:** `{"available":false}` — ID already taken.
- **Conclusion:** Employee ID availability check works.

---

### API #34: GET `/employee/:id`
- **Status:** 200 ✅
- **Latency:** 215ms
- **Response:** Full employee details returned — Ahmed Raza with salary, working hours, joining date.
- **Conclusion:** Single employee fetch works.

---

### API #35: PATCH `/employee/:id`
- **Status:** 200 ✅
- **Latency:** 221ms
- **Request:** `{ salary: 30000, phone: "03211234567" }`
- **Response:** Salary updated 25000→30000, phone updated. updatedAt changed.
- **Conclusion:** Employee update works. Joi validation passed.

---

### API #36: PATCH `/employee/:id/status`
- **Status:** 400 ✅ → 200 ✅ (retry with correct enum)
- **Latency:** 269ms
- **Request:** `{ workStatus: "on_break" }`
- **Response:** `{"success":true,"workStatus":"on_break"}`
- **Note:** First attempt with "On Break" correctly rejected by Joi. Valid values: `active`, `on_break`, `busy`, `offline`.
- **Conclusion:** Work status update works. Joi enum validation working correctly.

---

### API #37: POST `/employee/:id/reset-password`
- **Status:** 200 ✅
- **Latency:** 947ms
- **Request:** `{ newPassword: "NewPass@123" }`
- **Response:** `{"message":"Password reset successfully"}`
- **Conclusion:** Admin password reset for employee works.

---

### API #38: GET `/admin/:id`
- **Status:** 200 ✅
- **Latency:** 214ms
- **Response:** Admin details — Ali Khan, owner role, business linked.
- **Conclusion:** Admin fetch works.

---

### API #39: GET `/admin/email/:email`
- **Status:** 200 ✅
- **Latency:** 217ms
- **Response:** Same admin details found by email lookup.
- **Conclusion:** Admin email lookup works.

---

### API #40: PATCH `/admin/:id`
- **Status:** 200 ✅
- **Latency:** 217ms
- **Request:** `{ name: "Ali Khan Updated" }`
- **Response:** Name updated successfully. Joi correctly rejected `phone` field (not in schema).
- **Conclusion:** Admin update works with strict Joi validation.

---

### API #41: PUT `/admin/business/settings`
- **Status:** 200 ✅
- **Latency:** 220ms
- **Request:** `{ settings: { timeFormat: "24h", enableDeals: true }, taxLabel: "Sales Tax" }`
- **Response:** Settings updated — timeFormat changed to 24h, taxLabel changed to "Sales Tax".
- **Conclusion:** Business settings update works. Nested `settings` object validated correctly.

---

### API #42: GET `/product/` — List All Products
- **Status:** 200 ✅
- **Latency:** 218ms
- **Response:** 2 products — Coca Cola 500ml (stock: 93) and Lays Classic Chips (stock: 198).
- **Conclusion:** Product listing works.

---

### API #43: GET `/product/:id`
- **Status:** 200 ✅
- **Latency:** 217ms
- **Response:** Full Coca Cola product details with all fields.
- **Conclusion:** Single product fetch works.

---

### API #44: GET `/product/categories`
- **Status:** 200 ✅
- **Latency:** 214ms
- **Response:** `["Beverages","Snacks"]`
- **Conclusion:** Category listing works.

---

### API #45: GET `/product/generate-barcode`
- **Status:** 200 ✅
- **Latency:** 217ms
- **Response:** `{"barcode":"574578610418"}` — 12-digit EAN generated.
- **Conclusion:** Barcode generation works.

---

### API #46: GET `/product/stock-movements`
- **Status:** 200 ✅
- **Latency:** 1284ms
- **Response:** 6 movements — supply_in (2), bill_sold (3), bill_return (1). Full audit trail.
- **Conclusion:** Stock movement history works with pagination.

---

### API #47: GET `/product/report/valuation`
- **Status:** 200 ✅
- **Latency:** 218ms
- **Response:** Total cost value: 17,340, retail value: 27,000, potential profit: 9,660. By category breakdown.
- **Conclusion:** Inventory valuation report works.

---

### API #48: GET `/product/report/dead-stock`
- **Status:** 200 ✅
- **Latency:** 852ms
- **Response:** No dead stock (all products sold recently).
- **Conclusion:** Dead stock report works.

---

### API #49: GET `/product/report/stock`
- **Status:** 200 ✅
- **Latency:** 215ms
- **Response:** Full stock report by category — Beverages (93 items), Snacks (198 items). Grand total: 291 items.
- **Conclusion:** Stock report works.

---

### API #50: PATCH `/product/:id` — Update Product
- **Status:** 200 ✅
- **Latency:** 222ms
- **Request:** `{ sellingPrice: 130, description: "500ml bottle" }`
- **Response:** Selling price updated 120→130, description added.
- **Conclusion:** Product update works.

---

### API #51: PATCH `/product/:id/stock` — Update Stock
- **Status:** 200 ✅
- **Latency:** 440ms
- **Request:** `{ quantity: 10, operation: "add" }`
- **Response:** Stock updated 93→103.
- **Conclusion:** Manual stock adjustment works. Joi requires `quantity` and `operation` fields.

---

### API #52: POST `/product/bulk-stock`
- **Status:** 200 ✅
- **Latency:** 1286ms
- **Request:** `{ items: [{ productId, quantity: 5 }, { productId, quantity: -2 }] }`
- **Response:** `{"message":"Stock updated successfully"}`
- **Conclusion:** Bulk stock update works. Joi requires `items` array.

---

### API #53: GET `/vendor/` — List All Vendors
- **Status:** 200 ✅
- **Latency:** 1315ms
- **Response:** 1 vendor — PepsiCo Distributors. Aggregated totals: business 9000, paid 5000, remaining 4000.
- **Conclusion:** Vendor listing works with supply aggregation.

---

### API #54: GET `/vendor/:id`
- **Status:** 200 ✅
- **Latency:** 1198ms
- **Response:** Full vendor details with supplies, payments, totals.
- **Conclusion:** Single vendor fetch with supply history works.

---

### API #55: PATCH `/vendor/:id`
- **Status:** 200 ✅
- **Latency:** 214ms
- **Request:** `{ phone: "03451234567", creditLimit: 75000 }`
- **Response:** Phone and credit limit updated.
- **Conclusion:** Vendor update works.

---

### API #56: POST `/vendor/:id/pay` — FIFO Vendor Payment
- **Status:** 200 ✅
- **Latency:** 841ms
- **Request:** `{ amount: 2000, method: "bank_transfer", note: "Monthly settlement" }`
- **Response:** Rs 2000 distributed across 1 supply. Outstanding reduced 4000→2000.
- **Conclusion:** FIFO vendor payment works. Allocates to oldest unpaid supply first.

---

### API #57: GET `/customer/` — List All Customers
- **Status:** 200 ✅
- **Latency:** 421ms
- **Response:** 1 customer — Usman Ali. totalPurchases: 1, totalBilled: 520, totalPaid: 520.
- **Conclusion:** Customer listing with purchase stats works.

---

### API #58: GET `/customer/search?q=Usman`
- **Status:** 200 ✅
- **Latency:** 211ms
- **Response:** 1 match — Usman Ali.
- **Conclusion:** Customer search works.

---

### API #59: GET `/customer/:id`
- **Status:** 200 ✅
- **Latency:** 780ms
- **Response:** Full customer details with recent bills, return history, total refunded.
- **Conclusion:** Single customer fetch with bill history works.

---

### API #60: PATCH `/customer/:id`
- **Status:** 200 ✅
- **Latency:** 213ms
- **Request:** `{ name: "Usman Ali Khan", address: "DHA Phase 5, Lahore" }`
- **Response:** Name and address updated.
- **Conclusion:** Customer update works.

---

### API #61: GET `/bill/` — List All Bills
- **Status:** 200 ✅
- **Latency:** 1252ms
- **Response:** 2 bills with full details, pagination info (page 1/1, total 2).
- **Conclusion:** Bill listing with pagination works.

---

### API #62: GET `/bill/:id`
- **Status:** 200 ✅
- **Latency:** 212ms
- **Response:** Full bill details — items, payments, returns, profit breakdown.
- **Conclusion:** Single bill fetch works.

---

### API #63: GET `/bill/hold` — List Hold Bills
- **Status:** 200 ✅
- **Latency:** 210ms
- **Response:** Empty array (no held bills — Bill #2 was already resumed).
- **Conclusion:** Hold bills listing works.

---

### API #64: GET `/bill/top-products`
- **Status:** 200 ✅
- **Latency:** 419ms
- **Response:** Coca Cola: 8 qty, 960 revenue, 280 profit. Lays: 2 qty, 160 revenue, 60 profit.
- **Conclusion:** Top products report works.

---

### API #65: GET `/bill/report/sales-by-product`
- **Status:** 200 ✅
- **Latency:** 215ms
- **Response:** Detailed per-product breakdown — qty sold, returned, net revenue, cost, profit, margin (30.36%).
- **Conclusion:** Sales by product report works.

---

### API #66: GET `/bill/report/sales-by-category`
- **Status:** 200 ✅
- **Latency:** 209ms
- **Response:** 1 category "General" — net revenue 1120, profit 340, margin 30.36%.
- **Conclusion:** Sales by category report works.

---

### API #67: GET `/bill/report/sales-by-cashier`
- **Status:** 200 ✅
- **Latency:** 209ms
- **Response:** Ahmed Raza — 2 bills, net sales 1000, profit 340, avg order 560.
- **Conclusion:** Sales by cashier report works.

---

### API #68: GET `/bill/report/payment-methods`
- **Status:** 200 ✅
- **Latency:** 209ms
- **Response:** Cash: 1120 total (100%).
- **Conclusion:** Payment methods report works.

---

### API #69: GET `/bill/report/tax`
- **Status:** 200 ✅
- **Latency:** 624ms
- **Response:** No tax collected (products had 0% GST).
- **Conclusion:** Tax report works (returns empty when no tax applied).

---

### API #70: GET `/bill/report/customer-sales`
- **Status:** 200 ✅
- **Latency:** 418ms
- **Response:** Usman Ali: 520 spent, 1 bill. Walk-in: 600, 1 bill.
- **Conclusion:** Customer sales report works.

---

### API #71: GET `/bill/report/discounts`
- **Status:** 200 ✅
- **Latency:** 622ms
- **Response:** No discounts applied.
- **Conclusion:** Discount report works (returns empty when no discounts).

---

### API #72: GET `/bill/report/returns`
- **Status:** 200 ✅
- **Latency:** 209ms
- **Response:** By product: Coca Cola 1 qty, 120 refund. By reason: damaged. Return rate: 50%.
- **Conclusion:** Returns analysis report works.

---

### API #73: GET `/bill/report/timeline`
- **Status:** 200 ✅
- **Latency:** 210ms
- **Response:** 1 day entry — 1120 sales, 120 refunded, 1000 net, 340 profit, 2 bills.
- **Conclusion:** Sales timeline report works.

---

### API #74: GET `/bill/report/profit`
- **Status:** 200 ✅
- **Latency:** 421ms
- **Response:** Gross revenue 1120, net profit 340, expenses 15000, true net profit -14660.
- **Conclusion:** Profit report works. Correctly includes expense deduction.

---

### API #75: GET `/bill/returns`
- **Status:** 200 ✅
- **Latency:** 240ms
- **Response:** 1 bill with returns — Bill #1 with partial return.
- **Conclusion:** Returns list endpoint works.

---

### API #76: GET `/bill/returns/today-summary`
- **Status:** 200 ✅
- **Latency:** 209ms
- **Response:** 1 return today, 120 refunded, 1 item.
- **Conclusion:** Today's returns summary works.

---

### API #77: GET `/bill/returns/receipt/:billNumber`
- **Status:** 200 ✅
- **Latency:** 211ms
- **Response:** Bill #1 with return history, `hasReturns: true`, return details.
- **Conclusion:** Bill-for-return lookup by bill number works.

---

### API #78: GET `/supply/` — List All Supplies
- **Status:** 200 ✅
- **Latency:** 1901ms
- **Response:** 1 supply — SUP-1, 9000 total, 7000 paid, 2000 remaining. Vendor populated.
- **Conclusion:** Supply listing with vendor population works.

---

### API #79: GET `/supply/:id`
- **Status:** 200 ✅
- **Latency:** 419ms
- **Response:** Full supply details — items, payments (cash + bank_transfer), vendor info.
- **Conclusion:** Single supply fetch works.

---

### API #80: GET `/supply/stats`
- **Status:** 200 ✅
- **Latency:** 623ms
- **Response:** Overall: 9000 total, 7000 paid, 2000 remaining. By vendor breakdown. By status.
- **Conclusion:** Supply stats aggregation works.

---

### API #81: GET `/expense/` — List All Expenses
- **Status:** 200 ✅
- **Latency:** 210ms
- **Response:** 1 expense — Shop rent 15000, approved. Pagination info.
- **Conclusion:** Expense listing works.

---

### API #82: GET `/expense/:id`
- **Status:** 200 ✅
- **Latency:** 213ms
- **Response:** Full expense details — category, amount, approver, status.
- **Conclusion:** Single expense fetch works.

---

### API #83: PATCH `/expense/:id` — Update Approved Expense (expected rejection)
- **Status:** 400 ✅ (expected)
- **Latency:** 212ms
- **Response:** `{"error":"Cannot update expense that has been approved or rejected"}`
- **Conclusion:** Business rule enforced — approved expenses cannot be modified.

---

### API #84: POST `/expense/` — Create Second Expense (for testing update/reject)
- **Status:** 201 ✅
- **Latency:** 474ms
- **Request:** `{ category: "utilities", description: "Electricity bill", amount: 5000, paymentMethod: "cash" }`
- **Response:** Expense #2 created, status: pending.
- **Conclusion:** Second expense created for workflow testing.

---

### API #85: PATCH `/expense/:id` — Update Pending Expense
- **Status:** 200 ✅
- **Latency:** 431ms
- **Request:** `{ description: "Electricity bill - April 2026", amount: 5500 }`
- **Response:** Description and amount updated while status is pending.
- **Conclusion:** Pending expense update works correctly.

---

### API #86: POST `/expense/:id/reject`
- **Status:** 200 ✅
- **Latency:** 839ms
- **Request:** `{ reason: "Duplicate entry" }`
- **Response:** Status: pending → rejected. Rejection reason saved.
- **Conclusion:** Expense rejection workflow works.

---

### API #87: GET `/access/` — List All Access
- **Status:** 200 ✅
- **Latency:** 2267ms
- **Response:** 1 employee with full permission details — Ahmed Raza with cashier permissions.
- **Conclusion:** Access listing works.

---

### API #88: GET `/access/:employeeId`
- **Status:** 200 ✅
- **Latency:** 418ms
- **Response:** Employee info + full permissions object.
- **Conclusion:** Single employee access fetch works.

---

### API #89: GET `/business/:id`
- **Status:** 200 ✅
- **Latency:** 424ms
- **Response:** Full business details — name, settings, address, tax config, business type.
- **Conclusion:** Business fetch works.

---

### API #90: PATCH `/business/:id`
- **Status:** 200 ✅
- **Latency:** 424ms
- **Request:** `{ phone: "03009999999" }`
- **Response:** Phone updated successfully.
- **Conclusion:** Business update works.

---

### API #91: POST `/supply/:id/return`
- **Status:** 200 ✅
- **Latency:** 2107ms
- **Request:** `{ items: [{ product, quantity: 5, reason: "expired" }], note: "Returned expired Lays chips" }`
- **Response:** 5x Lays returned. Refund: 250 PKR. Remaining reduced 2000→1750. Stock adjusted.
- **Note:** First attempt with `reason: "Expired items"` correctly rejected by Joi. Valid values: `defective`, `wrong_item`, `expired`, `damaged`, `excess`, `other`.
- **Conclusion:** Supply return works. Joi enum validation working.

---

### API #92: POST `/employeeAuth/change-password`
- **Status:** 200 ✅
- **Latency:** 760ms
- **Request:** `{ employeeId: "testmart@ahmed", currentPassword: "NewPass@123", newPassword: "Ahmed@2026" }`
- **Response:** `{"message":"Password changed successfully"}`
- **Conclusion:** Employee password change works.

---

### API #93: DELETE `/expense/:id` — Delete Rejected Expense
- **Status:** 200 ✅
- **Latency:** 1885ms
- **Response:** Expense deleted. Full expense data returned for confirmation.
- **Conclusion:** Expense deletion works.

---

### API #94: POST `/bill/hold` — Create Hold Bill for Cancel Test
- **Status:** 201 ✅
- **Latency:** 842ms
- **Request:** `{ items: [{ product, name: "Lays Classic Chips", qty: 3, price: 80 }], holdNote: "Test cancel" }`
- **Response:** Hold bill #3 created. Total: 240 PKR. Status: hold.
- **Conclusion:** Hold bill creation works.

---

### API #95: POST `/bill/:id/refund`
- **Status:** 500 ❌ → Fixed → 200 ✅
- **Latency:** 2273ms (after fix)
- **Request:** `{ amount: 600, reason: "Customer dissatisfied", method: "cash" }`
- **Response (after fix):** Refund bill #4 created as type "refund". Original bill referenced. Stock restored.
- **BUG FOUND & FIXED:** `restoreStock()` called with items missing `name` and `price`. Same root cause as Bug #4. Fixed in `controllers/bill.mjs:1752` by adding `name` and `price` to stockItems mapping.
- **Conclusion:** Full bill refund works after fix.

---

### API #96: PATCH `/bill/:id/cancel` — Cancel Hold Bill
- **Status:** 200 ✅
- **Latency:** 1068ms
- **Request:** `{ cancelReason: "Customer changed mind" }`
- **Response:** Bill #3 status: hold → cancelled. cancelledBy and cancelledAt set.
- **Conclusion:** Cancel hold bill works.

---

### API #97: PATCH `/bill/:id/return/:returnId/cancel` — Cancel Return
- **Status:** 500 ❌ → Fixed → 200 ✅
- **Latency:** 2531ms (after fix)
- **Response (after fix):** Return cancelled. Bill returnedQty restored to 0. Stock re-deducted.
- **BUG FOUND & FIXED:** `deductStock()` called with items missing `name` and `price`. Same root cause. Fixed in `controllers/bill.mjs:1228` by adding `name` and `price` to stockItems.
- **Conclusion:** Cancel return works after fix.

---

### API #98: DELETE `/access/:employeeId`
- **Status:** 200 ✅
- **Latency:** 661ms
- **Response:** `{"message":"Access removed. Employee will have no permissions."}`
- **Conclusion:** Access deletion works.

---

### API #99: DELETE `/customer/:id`
- **Status:** 200 ✅
- **Latency:** 854ms
- **Response:** `{"message":"Customer deleted successfully"}`
- **Conclusion:** Customer deletion works.

---

### API #100: DELETE `/vendor/:id` — Vendor with Outstanding Balance
- **Status:** 400 ✅ (expected)
- **Latency:** 835ms
- **Response:** `{"message":"Cannot delete vendor with outstanding balance of Rs 1750"}`
- **Conclusion:** Business rule enforced — vendors with outstanding balances cannot be deleted.

---

### API #101: DELETE `/product/:id`
- **Status:** 200 ✅
- **Latency:** 215ms
- **Response:** Product soft-deleted (isActive: false).
- **Conclusion:** Product soft deletion works.

---

### API #102: DELETE `/supply/:id`
- **Status:** 200 ✅
- **Latency:** 1776ms
- **Response:** Supply deleted.
- **Conclusion:** Supply deletion works.

---

### API #103: DELETE `/bill/:id`
- **Status:** 200 ✅
- **Latency:** 464ms
- **Response:** Cancelled bill deleted. Full bill data returned for confirmation.
- **Conclusion:** Bill deletion works.

---

### API #104: DELETE `/employee/:id`
- **Status:** 200 ✅
- **Latency:** 420ms
- **Response:** `{"message":"Employee deleted successfully"}`
- **Conclusion:** Employee deletion works.

---

## Final Summary

| Metric | Count |
|--------|-------|
| **Total APIs Tested** | 104 |
| **Passed** | 100 |
| **Failed (then fixed)** | 3 (return, refund, cancel return) |
| **Validation Tests** | 5 (Joi rejection confirmed on wrong fields/enums) |
| **Business Rule Tests** | 2 (approved expense update blocked, vendor delete with balance blocked) |
| **Bugs Found & Fixed** | 6 |

### Bugs Found & Fixed During Testing

| # | Bug | Severity | File | Fix |
|---|-----|----------|------|-----|
| 1 | Empty barcode duplicate index | High | `models/product.mjs` | Changed to partial index (`$gt: ""`) |
| 2 | 500 on validation errors (bill) | High | `controllers/bill.mjs` | Added ValidationError → 400 handling |
| 3 | Vendor fields not saved (address, creditDays) | Medium | `controllers/vendor.mjs` | Added missing fields to destructuring |
| 4 | Return fails — missing `productName` in stock movement | High | `controllers/bill.mjs:1001` | Added `name` and `price` to stockItems mapping |
| 5 | Refund fails — missing `name`/`price` in restoreStock call | High | `controllers/bill.mjs:1752` | Added `name` and `price` to stockItems mapping |
| 6 | Cancel return fails — missing `name`/`price` in deductStock call | High | `controllers/bill.mjs:1228` | Added `name` and `price` to stockItems mapping |

### Improvements Added

| # | Improvement | Files |
|---|-------------|-------|
| 1 | Joi validation on all write routes | `middleware/validate.mjs`, `middleware/validationSchemas.mjs` |
| 2 | All 11 route files updated with validation middleware | `routes/*.mjs` |
| 3 | Clear 400 errors for wrong field names, missing fields, invalid types | All routes |

### Routes Tested by Category

| Category | Routes Tested |
|----------|---------------|
| **Auth** | Login (admin/employee), refresh, logout, change password |
| **Business** | Register, get, update, settings get/update |
| **Employee** | Create, list, get, count, check-id, update, status, reset-password, delete |
| **Access** | List, get, update (put), delete |
| **Product** | Create, list, get, update, stock update, bulk stock, categories, generate-barcode, stock-movements, low-stock, valuation, dead-stock, stock report, delete |
| **Vendor** | Create, list, get, update, ledger, FIFO payment, delete |
| **Customer** | Create, list, get, search, update, ledger, delete |
| **Supply** | Create, list, get, pay, return, stats, delete |
| **Bill** | Create, hold, resume, cancel, list, get, hold list, payment, return, cancel return, refund, delete, stats, top-products, 10 report endpoints |
| **Expense** | Create, list, get, update, approve, reject, stats, delete |
