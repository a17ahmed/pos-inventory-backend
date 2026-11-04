# Platform Admin Panel — API documentation (for the frontend)

A **web admin panel for the software owner** (not for shops). From it you can see every shop
(business): what they sell, their bills, products, counter users, customers, cash book, reports,
how much they use the system — and **block / warn / unblock** a shop (e.g. unpaid subscription).

- Base URL: same backend as the POS (e.g. `https://<backend>/platform/...`)
- All responses are JSON. Dates are ISO strings (UTC) — show them in **Asia/Karachi** time.
- Money is in the shop's currency (PKR), numbers rounded to 2 decimals.
- The panel's web address must be added to the backend's `CORS_ORIGINS` env var in production.

---

## 1. Auth

The panel has its **own users** (`PlatformAdmin`) and its **own tokens**. Shop logins can't open
the panel, and panel tokens don't work on the shop API.

Roles:
| Role | Can |
|---|---|
| `superadmin` | everything: block / warn / unblock, subscription, revoke sessions, manage panel users |
| `support` | read-only (every GET) |

The first superadmin is created on the server with a script (no sign-up page):
`PLATFORM_ADMIN_PASSWORD='…' node scripts/create-platform-admin.mjs --email you@x.com --name "Ahmed"`

### `POST /platform/auth/login`
```json
{ "email": "you@x.com", "password": "…" }
```
→ 200
```json
{ "token": "<jwt>", "admin": { "id": "…", "name": "Ahmed", "email": "you@x.com", "role": "superadmin", "isActive": true, "lastLoginAt": "…", "createdAt": "…" } }
```
- 401 `{ message: "Invalid credentials" }` (wrong email/password or disabled user)
- Sign-in is limited to **10 attempts per 15 min per email** → 429 (see Rate limits below)
- Send the token on every other call: `Authorization: Bearer <token>`. Token lasts **12 hours**; no refresh — log in again.

### `POST /platform/auth/logout` → `{ message: "Signed out" }`
Ends **every** session of this panel user (all devices / tabs): their old tokens get 401 `TOKEN_REVOKED`.
The panel should also delete its own cookie.

### `GET /platform/auth/me` → `{ admin }`
### `POST /platform/auth/change-password` `{ currentPassword, newPassword }` (min 8) → `{ message, token }`
Other sessions of this user end; **replace the stored token with the returned `token`** so this session continues.

### Rate limits
Per **panel user**, not per IP (all panel traffic comes from the panel's server, i.e. one IP):
| What | Limit | Key |
|---|---|---|
| `POST /platform/auth/login` | 10 / 15 min per IP + email, and 100 / 15 min per IP | the caller's IP and the email |
| every other `/platform/*` call | 3000 / 15 min | the signed-in panel user |

On 429 the body is `{ message, code: "RATE_LIMITED" }` and the headers carry `Retry-After` (seconds)
and `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`. The shop API's per-IP limit no
longer applies to `/platform`.

### Auth errors (any endpoint)
| Status | `code` | Meaning → what the UI does |
|---|---|---|
| 401 | `PLATFORM_AUTH_REQUIRED` / `TOKEN_INVALID` | Go to login |
| 401 | `TOKEN_EXPIRED` | "Session expired" → login |
| 401 | `PLATFORM_USER_DISABLED` | "Your panel account was disabled" → login |
| 401 | `TOKEN_REVOKED` | Signed out (logout, password changed or role changed elsewhere) → login |
| 429 | `RATE_LIMITED` | "Too many requests" — wait `Retry-After` seconds |
| 403 | `PLATFORM_FORBIDDEN` | Support user tried a superadmin action — hide those buttons for `role: "support"` |

---

## 2. Dashboard

### `GET /platform/overview`
```json
{
  "shops": { "total": 15, "active": 13, "warning": 1, "blocked": 1, "newThisMonth": 2, "activeToday": 9 },
  "users": { "admins": 15, "activeEmployees": 31 },
  "today": { "bills": 412, "sales": 186500, "cancelled": 3, "creditGiven": 24000,
             "requests": 9120, "errors": 3, "activeUsers": 14, "logins": 22 },
  "topShopsToday": [{ "businessId": "…", "name": "HoReCa Mart", "bills": 143, "sales": 64200 }],
  "paymentsDue": [{ "businessId": "…", "name": "Kitchen Hub", "status": "warning", "paidUntil": "…", "daysLeft": -1 }],
  "generatedAt": "…"
}
```
- `today.*` = since 00:00 Pakistan time. `bills` = completed sale bills; `sales` = their total.
- `paymentsDue` = not-blocked shops whose `paidUntil` is within 3 days or past (`daysLeft` < 0 = overdue), soonest first.

Suggested page: 4 status cards (Total / Active / Warning / Blocked), today cards (Bills, Sales,
Active users, Requests, Errors), "Top shops today" table, "Payments due" list (click → shop).

---

## 3. Shops list

### `GET /platform/businesses?search=&status=&sort=&page=&limit=`
| Param | Values |
|---|---|
| `search` | name, email or phone (contains, case-insensitive) |
| `status` | `active` \| `warning` \| `blocked` (omit = all; any other value → 400 — don't send `status=all`) |
| `sort` | `lastActive` (default) \| `name` (A→Z, case-insensitive) \| `newest` \| `oldest` \| `paidUntil` (soonest first; shops without a date last) |
| `page`, `limit` | default 1 / 20, limit max 100 |

```json
{
  "businesses": [{
    "businessId": "…", "name": "HoReCa Mart", "email": "…", "phone": "…", "type": "Retail",
    "owner": { "id": "…", "name": "…", "email": "…" },
    "subscription": { "status": "active", "message": "", "contact": "", "paidUntil": "2026-11-30T18:59:59.999Z",
                      "daysLeft": 29, "plan": "Basic", "monthlyFee": 3000, "notes": "", "sessionsRevokedAt": null },
    "createdAt": "…", "lastActiveAt": "…",
    "today": { "bills": 143, "sales": 64200, "creditGiven": 5200, "cancelled": 1,
               "requests": 1840, "errors": 2, "errors5xx": 0, "logins": 9, "blockedRequests": 0, "activeUsers": 5 },
    "counts": { "employees": 4, "activeEmployees": 4, "products": 820, "customers": 38 }
  }],
  "pagination": { "page": 1, "limit": 20, "total": 15, "pages": 1, "hasMore": false }
}
```
Table columns: Name (+type), Owner, Status badge (green active / amber warning / red blocked),
Paid until (+ "3 days left" / "1 day overdue"), Last active ("5 min ago"), Bills today, Sales today,
Users, Products. Row click → shop page.

---

## 4. One shop — `/platform/businesses/:businessId/...`

Unknown / invalid id → 404 `{ message: "Business not found" }`.

### 4.1 `GET /platform/businesses/:businessId` — overview tab
```json
{
  "business": { "businessId": "…", "name": "…", "email": "…", "phone": "…", "address": {…}, "currency": "PKR",
                "type": { "name": "Retail", "code": "…", "icon": "…" }, "settings": {…},
                "createdAt": "…", "lastActiveAt": "…", "lastClosingAt": "…" },
  "subscription": { "status": "warning", "message": "Payment due by 10 Nov", "contact": "Call 0300-…",
                    "paidUntil": "…", "daysLeft": 9, "plan": "Basic", "monthlyFee": 3000,
                    "notes": "internal only", "sessionsRevokedAt": null },
  "subscriptionHistory": [{ "action": "warn", "reason": "…", "details": {…}, "at": "…", "byId": "…", "byName": "Ahmed" }],
  "owners": [{ "_id": "…", "name": "…", "email": "…", "role": "owner", "lastLoginAt": "…", "lastActiveAt": "…" }],
  "counts": { "employees": 4, "activeEmployees": 4, "products": 830, "activeProducts": 820, "lowStockProducts": 12,
              "customers": 38, "vendors": 6, "supplies": 125, "expenses": 40, "completedBills": 5210, "activeSessions": 5 },
  "inventory": { "units": 15400, "costValue": 1250000, "retailValue": 1610000 },
  "customersBalance": { "owedToShop": 85000, "creditHeld": 2500 },
  "cash": { "...same as the shop's cash balance (current balance + today in/out)..." },
  "today": { "stats": { "...same as the shop's GET /bill/stats?filter=today..." }, "usage": { "requests": 1840, "errors": 2, "logins": 9, "activeUsers": 5, … } },
  "lastClosing": { "closingNumber": 41, "periodStart": "…", "periodEnd": "…", "closedBy": {…} }
}
```
`subscriptionHistory` is newest first. `subscription.notes` is internal — the shop never sees it.

### 4.2 `GET .../activity?days=30` — charts tab (whole number 1–180, default 30; anything else → 400)
One row per day (oldest → newest), empty days are zeros:
```json
{
  "days": [{ "date": "2026-11-01", "bills": 143, "sales": 64200, "profit": 9100, "cancelled": 1,
             "returns": 2, "returnAmount": 900, "requests": 1840, "errors": 2, "logins": 9, "activeUsers": 5 }],
  "totals": { "bills": …, "sales": …, "profit": …, "cancelled": …, "returns": …, "returnAmount": …, "requests": …, "errors": …, "logins": … }
}
```
Charts: Sales per day (bars) + Bills per day (line); Requests per day; Active users per day.

### 4.3 `GET .../bills-summary?date=YYYY-MM-DD` — "bills today" (default today)
```json
{
  "date": "2026-11-01",
  "bills": 143, "sales": 64200, "paid": 59000, "paidByStoreCredit": 400, "creditGiven": 5200, "profit": 9100, "discount": 300,
  "itemsSold": 610, "billsWithCustomer": 40, "firstBillAt": "…", "lastBillAt": "…",
  "cancelled": 1, "onHold": 2,
  "byHour": [{ "hour": 9, "bills": 12, "sales": 4300 }],
  "byCashier": [{ "cashier": "Bilal", "bills": 80, "sales": 36000 }],
  "byPaymentMethod": [{ "method": "cash", "payments": 120, "amount": 52000 }]
}
```
`paid` and `byPaymentMethod` = **real money taken that day** on these bills (payments collected on a
later day and store credit are left out); `paidByStoreCredit` = store credit moved in from other bills.
`hour` is 0–23 Pakistan time (only hours with bills). `date` must be a real date (`2026-02-31` → 400).

### 4.4 `GET .../users` — users tab
```json
{
  "admins": [{ "id": "…", "name": "…", "email": "…", "role": "owner", "lastLoginAt": "…", "lastActiveAt": "…", "createdAt": "…", "activeSessions": 1 }],
  "employees": [{ "_id": "…", "name": "Bilal", "employeeId": "hm-bilal", "role": "employee", "status": "active",
                  "phone": "…", "lastLoginAt": "…", "lastActiveAt": "…", "activeSessions": 1,
                  "permissions": { "pos": { "view": true, "create": true, … }, "products": { … }, … } }]
}
```
No passwords are ever returned. `permissions: null` = no access record yet (defaults apply).

### 4.5 `GET .../usage?days=7` — usage tab (whole number 1–180, default 7; anything else → 400)
Newest day first; only days with activity:
```json
{
  "days": [{
    "date": "2026-11-01", "requests": 1840, "errors4xx": 12, "errors5xx": 0, "blockedRequests": 0, "logins": 9,
    "byArea": { "bill": 920, "product": 410, "customer": 150, "cashbook": 60 },
    "activeUsers": [{ "id": "…", "name": "Bilal", "employeeId": "hm-bilal", "kind": "employee" }, { "id": "…", "name": "Owner", "kind": "admin" }]
  }]
}
```
`byArea` keys are API areas (bill, product, customer, vendor, supply, expense, cashbook, closing,
employee, access, admin, dashboard, business). Usage counts are approximate (counted after each
response); bill/sales numbers elsewhere are exact.

### 4.6 Shop data (read-only) — same responses as the shop's own app
These run the shop's own endpoints, so the numbers match exactly what the shop sees, with full
detail (cost and profit included). Query params are the same as the shop app's.

| Panel endpoint | Same as shop endpoint | Useful params |
|---|---|---|
| `GET .../dashboard` | `GET /v1/dashboard/summary` | `filter=today\|week\|month` |
| `GET .../settings` | `GET /admin/business/settings` | |
| `GET .../bills` | `GET /bill` → `{ bills, pagination:{page,perPage,total,totalPages,hasMore} }` | `page, limit(≤100), status, type, paymentStatus, startDate, endDate (YYYY-MM-DD)` |
| `GET .../bills/stats` | `GET /bill/stats` | `filter=today\|week\|month`, `includeChart=true` |
| `GET .../bills/hold` | `GET /bill/hold` | |
| `GET .../bills/top-products` | `GET /bill/top-products` | `limit (≤50)` |
| `GET .../bills/:billId` | `GET /bill/:id` (full bill with items, payments, returns, revisions) | |
| `GET .../returns`, `.../returns/today-summary` | `GET /bill/returns`, `/bill/returns/today-summary` | |
| `GET .../reports/sales-by-product` | `GET /bill/report/sales-by-product` | `startDate, endDate` |
| `GET .../reports/sales-by-category` · `sales-by-cashier` · `payment-methods` · `tax` · `customer-sales` · `discounts` · `returns` · `timeline` · `profit` | `GET /bill/report/<same name>` | `startDate, endDate` |
| `GET .../products` | `GET /product` (array) | `search, category, lowStock, active` |
| `GET .../products/categories` · `low-stock` · `stock-movements` | `GET /product/categories` · `/low-stock` · `/stock-movements` | movements: `productId, type, reason, startDate, endDate, page, limit` |
| `GET .../products/report/valuation` · `dead-stock` · `stock` | `GET /product/report/<same>` | |
| `GET .../products/:productId` | `GET /product/:id` | |
| `GET .../customers` | `GET /customer` → `{ customers, total, page, totalPages }` | `search, hasDues, active, page, limit` |
| `GET .../customers/summary` | `GET /customer/summary` | |
| `GET .../customers/:customerId` | `GET /customer/:id` | |
| `GET .../customers/:customerId/statement` | `GET /customer/:id/statement` | `period (sinceZero default), type, sort, search, page, limit` |
| `GET .../customers/:customerId/pending-bills` · `ledger` · `rates` | `GET /customer/:id/pending-bills` · `/ledger` · `/rates` | |
| `GET .../vendors` · `.../vendors/:vendorId` · `.../vendors/:vendorId/ledger` | `GET /vendor`, `/vendor/:id`, `/vendor/:id/ledger` | |
| `GET .../supplies` · `.../supplies/stats` · `.../supplies/:supplyId` | `GET /supply`, `/supply/stats`, `/supply/:id` | |
| `GET .../expenses` · `.../expenses/stats` · `.../expenses/:expenseId` | `GET /expense`, `/expense/stats`, `/expense/:id` | |
| `GET .../cashbook` · `.../cashbook/balance` · `.../cashbook/summary` | `GET /cashbook`, `/cashbook/balance`, `/cashbook/summary` | cashbook: `type, startDate, endDate, page, limit` |
| `GET .../closings` · `.../closings/last` · `.../closings/:closingId` | `GET /closing`, `/closing/last`, `/closing/:id` | |
| `GET .../employees` · `.../employees/access` · `.../employees/:employeeId` | `GET /employee`, `/access`, `/employee/:id` | |

Date query params (`startDate`, `endDate`, `from`, `to`, `date`) must be `YYYY-MM-DD` (a real
date) or a full ISO date-time — anything else → 400 (`"startDate must be a real date (YYYY-MM-DD)"`).

`GET .../products` returns a plain array; add `?page=&limit=` (limit ≤ 200, default 50) to get
`{ products: [...], pagination: { page, limit, total, pages, hasMore } }` instead.

There are **no write routes** for shop data — the panel can't change bills, stock, money or users
of a shop. Any other path under a shop → 404.

---

## 5. Subscription controls (superadmin only)

All return `{ businessId, name, subscription }` (same `subscription` shape as above), add an entry
to `subscriptionHistory` and the audit log, and take effect on the shop **within ~1 minute**.

| Endpoint | Body | Effect | Errors |
|---|---|---|---|
| `POST .../warn` | `{ message, paidUntil?: "YYYY-MM-DD", contact? }` | Status `warning`: shop keeps working, sees a banner with `message` | 400 no message / bad date |
| `POST .../clear-warning` | `{ reason? }` | Back to `active` | 400 if not in warning |
| `POST .../block` | `{ reason, message?, contact? }` | Status `blocked`: **every login and request of the owner and all counter users is rejected**. Data untouched. `message` (default = reason) and `contact` are shown to the shop | 400 no reason / already blocked |
| `POST .../unblock` | `{ reason? }` | Back to `active`; existing sessions work again | 400 if not blocked |
| `PATCH .../subscription` | `{ paidUntil?: "YYYY-MM-DD" \| null, plan?, monthlyFee?, notes?, contact? }` | Edit plan details (status unchanged). `notes` is internal | 400 nothing to update / bad value |
| `POST .../revoke-sessions` | `{ reason? }` | Logs everyone in this shop out now (they can log in again) | |

UI: on the shop page show a status card with buttons (superadmin only):
- active → [Warn] [Block]   · warning → [Clear warning] [Block]   · blocked → [Unblock]
- Block/Warn open a dialog: reason (required for block), message shown to shop, contact, paid until.
- Always confirm Block: "Block {name}? The owner and all counter users will be locked out until you unblock. No data is deleted."
- Show `subscriptionHistory` as a timeline under it.

---

## 6. Audit log

### `GET /platform/audit-log?businessId=&action=&page=&limit=`
```json
{
  "entries": [{ "_id": "…", "actor": { "id": "…", "name": "Ahmed", "email": "…" }, "action": "business.block",
                "business": "…", "businessName": "Kitchen Hub", "details": { "reason": "Unpaid", "message": "…" },
                "ip": "…", "createdAt": "…" }],
  "pagination": { "page": 1, "limit": 50, "total": 120, "pages": 3, "hasMore": true }
}
```
Actions (`auth.login_failed` is recorded only for existing panel accounts): `auth.login`, `auth.logout`, `auth.login_failed`, `auth.change_password`, `business.warn`, `business.clear_warning`,
`business.block`, `business.unblock`, `business.update`, `business.revoke_sessions`, `admin.create`, `admin.update`.

---

## 7. Panel users (superadmin only)

| Endpoint | Body | Notes |
|---|---|---|
| `GET /platform/admins` | | `{ admins: [{ id, name, email, role, isActive, lastLoginAt, createdAt }] }` |
| `POST /platform/admins` | `{ name, email, password (≥8), role: "superadmin"\|"support" }` | 201; 409 email exists |
| `PATCH /platform/admins/:adminId` | `{ name?, role?, isActive? (true/false only), password? }` | 400 if it would leave no active superadmin; disabling, a role change or a password reset ends that user's sessions |

---

## 8. What the shop apps see (desktop POS / owner app) — for reference

Not part of the panel, but the panel's actions show up here:
- **Blocked:** every shop API call returns
  `403 { "code": "BUSINESS_BLOCKED", "message": "Your account is suspended. <message>", "contact": "<contact>" }`;
  admin / employee login and token refresh return the same.
- **Warning:** responses carry header `X-Account-Status: warning`.
- **Revoked sessions:** `401 { "code": "SESSION_REVOKED" }` on any request **and on token refresh** → log in again.
- `GET /account/status` (shop token; works even when blocked) →
  `{ "status": "active"|"warning"|"blocked", "message", "contact", "paidUntil" }`

---

## 9. Suggested pages

| Page | Uses |
|---|---|
| Login | `POST /platform/auth/login` |
| Dashboard | `GET /platform/overview` |
| Shops | `GET /platform/businesses` (search, status filter, sort, paging) |
| Shop → Overview | `GET /platform/businesses/:id` + status card + subscription controls |
| Shop → Today / Bills | `bills-summary` (date picker), `bills` (table, click → `bills/:billId`) |
| Shop → Activity | `activity?days=7\|30\|90` charts |
| Shop → Users | `users` (+ permissions drawer) |
| Shop → Usage | `usage?days=7` (requests by area, errors, who was active) |
| Shop → Products / Customers / Vendors & supplies / Expenses / Cash book / Closings / Reports | the section 4.6 endpoints |
| Shop → History | `subscriptionHistory` + `audit-log?businessId=` |
| Audit log | `GET /platform/audit-log` |
| Panel users | `/platform/admins` (superadmin) |
| Account | `auth/me`, `auth/change-password` |


---

## 10. Field reference and behaviour notes

### 10.1 Bill money fields (why `paid + due ≠ total`)
```
amountDue = max(0, total − totalLedgerRefunded) − amountPaid + creditUsed
⇒ total  = amountPaid + amountDue + totalLedgerRefunded − creditUsed      (when totalLedgerRefunded ≤ total)
```
| Field | Meaning |
|---|---|
| `total` | Bill total after discounts + tax |
| `amountPaid` | Σ `payments[].amount` — **includes** store credit received from other bills |
| `creditApplied` | Part of `amountPaid` that is store credit moved in from another bill (`payments[].creditFrom` set, `method: "store_credit"`) — not real money |
| `totalRefunded` | Σ of every return's `refundAmount` (any refund method) |
| `totalLedgerRefunded` | The part of returns that reduced what the customer owes (`refundMethod: "ledger_adjust"`) + unpaid debt written off on cash returns (`debtCancelled`) |
| `totalRefunded − totalLedgerRefunded` | Money actually handed back in cash / card |
| `creditUsed` | This bill's overpayment (e.g. after a return) moved to other bills as store credit — see `creditTransfers[]` (`toBillNumber`, `amount`) |
| `amountDue` | Still owed on this bill; **negative = store credit sitting on this bill** |
| `paymentStatus` | `paid` when `amountPaid ≥ total − totalLedgerRefunded` (so a fully returned unpaid bill is `paid`) |

Examples (primemart, dev):
- **#115:** total 450 · card payment 200 · return 300 (`ledger_adjust`) → bill is now worth 150 · paid 200 → 50 over → moved to Bill #14 (`creditUsed` 50) → due **0**.
  Show: `Total 450 · Returned −300 · Paid −200 · Credit moved to #14 +50 = Due 0`.
- **#116:** total 450 · nothing paid · everything returned (450 `ledger_adjust`) → worth 0 → due **0**, `paymentStatus: "paid"`, `returnStatus: "full"`.

### 10.2 Profit
- `bills-summary.profit`, `activity.days[].profit` / `totals.profit` = Σ bill **`netProfit`** = `billProfit − returnedProfit` → **after returns**.
- A return is counted on the **bill's own date** (it lowers that bill's `netProfit`), not on the day of the return. `activity.days[].returns` / `returnAmount` count returns by the **return date**.
- Cancelled bills are excluded (only `status: "completed"`).

### 10.3 Best sellers — `GET .../bills/top-products?limit=`
**All time**, completed sale bills, sorted by **quantity sold** (high → low), `limit` 1–50 (default 12).
No date filter. Quantities and revenue are gross (before returns); `totalProfit` is after returns.
For a period use `GET .../reports/sales-by-product?startDate=&endDate=`.

### 10.4 Expense stats — `GET .../expenses/stats`
`totalExpenses`, `expenseCount`, `todayExpenses`, `monthExpenses` and `byCategory` count **approved
expenses only**. Pending ones are in `pendingCount` / `pendingTotal`. Rejected are never counted.
Optional `startDate` / `endDate` limit the approved totals; pending is always all-time.

### 10.5 Usage
- `blockedRequests` = requests **rejected because the shop was blocked** (any API call + login
  attempts). primemart's 11 on 2026-11-01 are the desktop app's calls and login tries after it was blocked.
- `byArea` keys are the first part of the API path. `access` = `/access/*` — the apps loading the
  user's permissions (mostly `GET /access/me` on start), so "Permissions" is a fine label.
- Tracking started on **2026-11-01** (when this feature went live on dev). Nothing exists before that.
  Rows are kept 180 days.

### 10.6 Counter user permissions (`users.employees[].permissions`)
Areas and switches with their **defaults** (used when a new employee is created):

| Area | Switches (default) |
|---|---|
| `pos` | `view` (on), `create` (on), `viewProfit` (off), `saveCustomerRates` (off), `sellBeyondLimit` (off), `cancelBill` (off), `amendBill` (on) |
| `pendingBills` | `view` (on), `create` (on), `resume` (on), `cancel` (off) |
| `returns` | `view`, `create`, `standalone`, `cancel` (all off) |
| `products` | `view`, `create`, `edit`, `delete`, `updateStock` (all off) |
| `vendors` | `view`, `create`, `edit`, `delete`, `pay` (all off) |
| `supplies` | `view`, `create`, `edit`, `delete`, `recordPayment`, `processReturn` (all off) |
| `expenses` | `view`, `create`, `edit`, `delete`, `approve` (all off) |
| `customers` | `view`, `create`, `edit`, `delete` (all off) |
| `employees` | `view`, `create`, `edit`, `delete`, `resetPassword` (all off) |
| `cashbook` | `view`, `manage` (off) |
| `closing` | `view`, `create` (off) |
| `dashboard` | `view` (on) |
| `reports` | `view` (off) |
| `settings` | `view`, `edit` (off) |

- `pos.viewProfit` — see cost / profit figures. `pos.saveCustomerRates` — save a customer's special price.
- `pos.sellBeyondLimit` — finish a bill where an item's discount is above that product's maximum
  discount % (otherwise the POS blocks it).
- `pos.cancelBill` — cancel a completed sale (same day unless admin). `pos.amendBill` — add items to a customer's credit bill from today.
- `returns.standalone` — refund without the original bill/receipt (receiptless return).
- **Missing switch or area (older records) = DENIED**, with one exception: a missing `pos.amendBill`
  = allowed. So primemart "ali" can add to today's bill; "ayhab" (no `closing` area) can't view or create closings.
  Show a missing switch as **off** (except `amendBill` → on).

### 10.7 Closings — `GET .../closings`, `.../closings/last`, `.../closings/:closingId`
`closings` → `{ closings: [summary], pagination }` where a summary has `_id, closingNumber, periodStart,
periodEnd, closedBy, closedAt, netSales, netProfit, reconciled, tenderReconciliation`.
`closings/last` → the full record or `null`. `closings/:id` → the full record:

| Field | Meaning (money in PKR) |
|---|---|
| `closingNumber` | 1, 2, 3… per shop |
| `periodStart` / `periodEnd` | The period this closing covers (the next closing starts where this one ended) |
| `closedBy { id, name }`, `closedAt` | Who closed it and when |
| `grossSales` | Sales **before discounts** (Σ bill total + discount) |
| `totalDiscounts` | Discounts given |
| `totalReturns` | Value of returns made in the period (by return date) |
| `netSales` | Σ bill totals (after discounts) − `totalReturns` |
| `totalOrders`, `totalItemsSold` | Completed sale bills and units sold |
| `cogs` | Cost of goods sold |
| `grossProfit` | `netSales − cogs` |
| `totalExpenses` | Approved expenses in the period |
| `netProfit` | `grossProfit − totalExpenses` |
| `cashSales`, `cardSales`, `upiSales` | Payments on the period's bills by method, minus cash/card refunds in the period (`upiSales` = online) |
| `storeCreditUsed` | Paid with store credit (not money), minus store-credit refunds |
| `creditExtended` | Sales left unpaid (given on credit) |
| `creditExtendedByCustomer[]` | `{ customerId, customerName, customerPhone, amount, billCount }` — who got that credit |
| `settlementTotal` | `cash + card + online + storeCredit + creditExtended` |
| `costPlusProfit` | `cogs + grossProfit` |
| `reconciled`, `reconciliationDifference` | Books check: `netSales − settlementTotal` (reconciled when ≈ 0) |
| `collectionsReceived` | Money collected in the period for **older** credit bills |
| `outstandingReceivable` | Total customers still owe at period end |
| `expectedCash` | Cash in the drawer per the cash book at `periodEnd` (running balance, not per period) |
| `tenderReconciliation.{cash,card,online}` | `{ expected, counted, variance, reconciled }` — what was counted at closing; `counted/variance/reconciled` are `null` if not counted |
| `bills[]` | Snapshot per bill: `{ billNumber, date, customerName, items[{name,qty,price,costPrice,lineProfit}], billTotal, billProfit, paymentMethod, amountPaid, creditAmount }` |
| `notes` | Note typed at closing |

Dev data: **QA Open Shop** (`6ae75081eea4b9a0da5e36a8`) has closing #1 (3 bills: cash, card,
credit; one approved expense; cash and card counted).

### 10.8 Shop-data shapes (section 4.6) — stable
These are the shop app's own responses and are kept stable. Top-level keys and item fields:

| Endpoint | Shape |
|---|---|
| `bills` | `{ bills: [Bill], pagination: { page, perPage, total, totalPages, hasMore } }` |
| `bills/:billId` | `Bill`: `_id, billNumber, status, type, paymentStatus, returnStatus, items[], payments[], returns[], revisions[], creditTransfers[], discountMode, billDiscountAmount, totalItemDiscount, totalDiscount, discountHistory[], subtotal, totalTax, total, totalQty, totalCost, billProfit, returnedProfit, netProfit, amountPaid, amountDue, creditUsed, creditApplied, totalRefunded, totalLedgerRefunded, netAmount, cashier, cashierName, customer, customerName, customerPhone, customerBalanceBefore, cancelReason, cancelledAt, holdNote, notes, date, time, createdAt` |
| `customers` | `{ customers: [{ _id, name, phone, email, address, balance, creditLimit, creditDays, isActive, totalBilled, totalPaid, totalReturns, totalPurchases, lastPurchase, openingBalance, specialRates[] }], total, page, totalPages }` |
| `customers/:id/statement` | see the shop's statement doc: `{ customer, summary, period, entries, pagination }` |
| `products` | `[{ _id, name, sku, barcode, category, costPrice, sellingPrice, gst, maxDiscountPercent, stockQuantity, lowStockAlert, unit, trackStock, isActive }]` (or paged, see 4.6) |
| `products/stock-movements` | `{ movements: [{ product, productName, type, quantity, previousStock, newStock, referenceType, referenceNumber, unitPrice, reason, adjustmentReason, note, performedBy, createdAt }], total, page, totalPages }` |
| `products/report/valuation` | `{ items: [{ name, category, stockQuantity, costPrice, sellingPrice, costValue, retailValue, potentialProfit, margin }], byCategory, summary }` |
| `products/report/dead-stock?days=30` | `{ deadStock: [{ _id, name, category, stockQuantity, costPrice, sellingPrice, stockValue }], days, summary: { deadProducts, totalProducts, deadPercentage, totalDeadValue } }` — products in stock with **no sale in the last `days` days**. Empty on dev because every stocked product sold recently; try `days=1` |
| `vendors` | `[{ _id, name, phone, company, creditLimit, isActive, totalBusiness, totalPaid, totalReturned, totalRemaining, totalCredit, netBalance, supplyCount }]` |
| `vendors/:id/ledger` | `{ vendor, ledger: [{ type, date, description, supplyNumber, debit, credit, balance, … }], summary }` |
| `supplies` | `{ supplies: [{ supplyNumber, vendorName, billNumber, billDate, items[], totalAmount, totalReturned, paidAmount, remainingAmount, balance, paymentStatus, payments[], returns[] }], total, page, totalPages }` — filters: `vendor, paymentStatus, startDate, endDate, page, limit`. **No `search`** (ignored) |
| `supplies/stats` | `{ overall, thisMonth, thisWeek, byVendor, byStatus }` |
| `expenses` | `{ expenses: [{ expenseNumber, category, description, amount, date, paymentMethod, status, createdByName, approvedByName, rejectionReason }], total, page, totalPages }` |
| `expenses/stats` | `{ totalExpenses, expenseCount, todayExpenses, monthExpenses, byCategory[{ category, label, total, count }], pendingCount, pendingTotal, categoryLabels }` |
| `cashbook` | `{ entries: [{ entryNumber, type, amount, direction, runningBalance, referenceNumber, description, note, performedBy, createdAt }], dailySummary, rangeSummary, pagination }` |
| `cashbook/balance` | `{ balance, today }` · `cashbook/summary` → `{ currentBalance, today, thisMonth }` |
| `closings` | see 10.7 |

### 10.9 Subscription history notes
- `warn` records `details: { message, paidUntil, contact }`; `block` records `details: { message, contact }`.
- **Clearing a warning / unblocking clears `subscription.message` on purpose**: it's the text the shop
  sees for the *current* state. The old text stays in `subscriptionHistory`. `contact`, `paidUntil`,
  `plan`, `monthlyFee` and `notes` are kept.
