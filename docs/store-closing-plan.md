# Feature: Store Closing (sales settlement reconciliation + period snapshot)

## Context

The POS backend can report profit and payment-method splits on the fly, but there is
no way for an owner to **lock a financial snapshot for a period** and prove that every
rupee of goods sold was accounted for. This feature adds a "Closing" — an immutable,
back-to-back period record that answers two questions:

1. **Reconciliation:** does the value of goods sold (COGS + gross profit = net sales)
   equal how it was settled (cash + card + online + credit extended)?
2. **Profitability:** what were sales, COGS, expenses, and net profit for the period?

Closings are contiguous (next starts where the last ended), timezone-aware
(Asia/Karachi via `process.env.TZ`, accepting full ISO datetimes), and **frozen at
finalize** — viewing history never recomputes from live data. This lets the app show
"Last closed: X" and re-download a period PDF from the stored snapshot.

### Verified facts (from codebase exploration)

- **Payment-method keys** emitted by `/bill/report/payment-methods` are
  `cash`, `card`, `online`, `store_credit` — it is **`online`, not `upi`**
  (`controllers/bill.mjs:2711-2751`, enum at `models/bill.mjs:138-142`). Null → `"unknown"`.
- **Partial payments** are stored per-bill as a **`payments[]` array**
  (`{ amount, method, paidAt, receivedByName, ... }`, `models/bill.mjs:136-148`), with
  derived `amountPaid` (cumulative) and `amountDue` (residual receivable, can be
  negative). **There is no `creditAmount` field** — the receivable is `amountDue`.
  `customerBalanceBefore` (`models/bill.mjs:166`) freezes the prior ledger balance.
- **Key consequence:** `amountPaid` is *cumulative*, so "paid at sale" and
  "credit extended in the period" must be **reconstructed from `payments[].paidAt`**,
  not read from one field.
- Bill total field is **`total`** (post-discount+tax), not `billTotal`. Customer ref is
  **`customer`** (ObjectId), display name **`customerName`**. Per-line profit is
  `itemProfit`/`netProfit` (no `lineProfit`).
- No separate ledger collection: `Customer.balance = Σ amountDue` across bills, rebuilt
  by the Bill post-save hook (`models/bill.mjs:381-441`).

### Decisions confirmed with the owner

- **creditExtended / settlement split:** reconstruct from `payments[].paidAt` within the
  range (accurate for any range, including historical/backdated re-runs).
- **Returns:** subtract from both sides of the equation, and — critically —
  **recognize returns by when they are processed (`returnedAt`), not by the original
  sale's period.** This keeps finalized closings immutable: a return in July of a
  June-2 item hits July's closing as a refund; June's frozen closing is untouched. Net
  across periods still reconciles. (This directly answers the owner's June-2 example.)
- **store_credit tender:** tracked as its own settlement line (`storeCreditUsed`) so
  `cash + card + online + creditExtended + storeCreditUsed = netSales`. It is neither
  new cash nor new receivable (customer draws down a prior positive balance).

---

## Reconciliation model (authoritative formulas)

All aggregations match `business`, `type: "sale"`, `status: "completed"`, and scope
**sales** by `createdAt ∈ [periodStart, periodEnd]`, **returns** by `returnedAt ∈` range.

**Sales (created in period):**
- `grossSales   = Σ (total + totalDiscount)`
- `totalDiscounts = Σ totalDiscount`
- `totalOrders  = Σ 1`, `totalItemsSold = Σ totalQty`

**Returns (processed in period — by `returnedAt`, any original sale date):**
- `$unwind: "$returns"`, `$match returns.returnedAt ∈ range`
- `totalReturns = Σ returns.refundAmount`, plus `returnedProfit = Σ returns.profitLost`
- Also capture `refundsByMethod` from `returns.refundMethod`
  (`cash|card|store_credit|ledger_adjust`) — used to reduce the settlement side.

**Net sales:**  `netSales = Σ total (period sales) − totalReturns`

**Cost / profit:**
- `cogs` = COGS of kept goods = `Σ items.costPrice × (items.qty − items.returnedQty)`
  (reuse the `adjustedCogs` unwind pass from `profitReport`, `controllers/bill.mjs:2471-2487`).
- `grossProfit = netSales − cogs`
- `totalExpenses` = `Expense` where `status:"approved"`, `date ∈` range
  (reuse `controllers/bill.mjs:2488-2503`).
- `netProfit = grossProfit − totalExpenses`
- `costPlusProfit = cogs + grossProfit`  (== netSales by construction — cost view)

**Settlement split (reconstructed from `payments[].paidAt ∈ range`, on period sale bills):**
- `cashSales   = Σ payments.amount where method="cash"`
- `cardSales   = Σ … "card"`
- `upiSales    = Σ … "online"`   (field named `upiSales` per concept; **sourced from `online`**)
- `storeCreditUsed = Σ … "store_credit"`
- `creditExtended = Σ over period sale bills of ( total − Σ in-period payments − Σ in-period ledger_adjust refunds )`
  = new receivable outstanding at periodEnd from this period's sales.
- Reduce cash/card sides by in-period `refundsByMethod` cash/card refunds
  (refund is money paid back out). `ledger_adjust` refunds already reduce `creditExtended`;
  `store_credit` refunds reduce `storeCreditUsed`.

**Reconciliation:**
- `settlementTotal = cashSales + cardSales + upiSales + creditExtended + storeCreditUsed`
- `reconciliationDifference = netSales − settlementTotal`
- `reconciled = Math.abs(reconciliationDifference) <= TOLERANCE` (₹1.00, for rounding)

**Receivables (informational, not in the equation):**
- `creditExtended` (above)
- `collectionsReceived` = `Σ payments.amount where paidAt ∈ range AND parent bill.createdAt < periodStart`
  (customers paying off *prior-period* credit — a cash movement, not a period sale).
- `outstandingReceivable` (as of periodEnd) = reconstruct:
  `Σ over sale bills with createdAt ≤ periodEnd of (total − Σ payments paidAt≤periodEnd − Σ ledger_adjust refunds returnedAt≤periodEnd)`.
  (Correct even for historical closings; when periodEnd≈now this equals `Σ Customer.balance`.)

**Line detail (snapshot array, powers PDF):** for each period sale bill store
`{ billNumber, date: createdAt, customerName, items:[{name, qty, price, costPrice, lineProfit:netProfit}], billTotal: total, billProfit: netProfit, paymentMethod (primary/derived), amountPaid (in-period), creditAmount (total − in-period paid) }`.

---

## 1. New model — `models/closing.mjs`

Mongoose schema, `{ timestamps: true }`, immutable snapshot (store every computed number
above; never recompute on read). Fields:

- `closingNumber` (Number), `business` (ObjectId ref, required, indexed)
- `periodStart`, `periodEnd` (Date)
- `closedBy` (`{ id, name }`), `closedAt` (Date)
- **Sales:** `grossSales, totalDiscounts, totalReturns, netSales, totalOrders, totalItemsSold`
- **Profit:** `cogs, grossProfit, totalExpenses, netProfit`
- **Settlement:** `cashSales, cardSales, upiSales, storeCreditUsed, creditExtended`
- **Reconciliation:** `settlementTotal, costPlusProfit, reconciled (Boolean), reconciliationDifference`
- **Receivables:** `creditExtended, collectionsReceived, outstandingReceivable`
- **Line detail:** `bills: [ lineDetailSchema ]` (snapshot, shape above)
- `notes` (String, from `countedNote`)
- Compound index `{ business: 1, periodStart: 1 }` and `{ business: 1, closingNumber: 1 }`.

## 2. Shared compute helper

Put a single `computeClosing(businessId, periodStart, periodEnd)` in
`controllers/closing.mjs` (or `utils/closingCompute.mjs`) returning the full record
shape. Both **preview** and **POST** call it, so preview and finalize are identical.
Reuse date helpers `startOfDay`/`endOfDay` from `utils/dateHelpers.mjs` (they honor
time-of-day, `utils/dateHelpers.mjs:39-63`) and the aggregation patterns from
`profitReport` / `paymentMethodReport`.

## 3. Endpoints — `routes/closing.mjs` (register static paths before `/:id`)

- `GET  /closing/last` → most recent closing for business (by `closingNumber` desc) or `null`.
- `GET  /closing/preview?startDate=&endDate=` → runs `computeClosing`, returns full
  shape **without saving**. Default `startDate` = last closing's `periodEnd` (or business
  earliest bill / owner start); default `endDate` = now.
- `POST /closing` — body `{ periodStart, periodEnd, countedNote? }`.
  Server **recomputes authoritatively** (ignore any client figures), then inside a
  Mongoose transaction: reject if `[periodStart, periodEnd]` overlaps an existing
  closing (`business` + range-overlap query); assign `closingNumber` via
  `Counter.getNextSequence("closingNumber", businessId, session)`
  (`models/counter.mjs:16-25`); set `closedBy` from `req.user`, `closedAt = now`; save;
  update `business.lastClosingAt = periodEnd`. Return 201 with the saved doc.
- `GET  /closing?page=&limit=` → paginated summary list (history table fields:
  closingNumber, period, netSales, netProfit, reconciled, closedAt).
- `GET  /closing/:id` → one full stored record (for view / PDF re-download).

Follow controller conventions: `businessId` from `req.user.businessId` cast to ObjectId;
`try/catch` → 500 `{message}`; 400 for validation/overlap; `res.status(201).json(...)`
on create (mirror `controllers/cashbook.mjs`).

## 4. Wiring & guards

- **`index.mjs`:** `import closingRouter from './routes/closing.mjs';` and
  `app.use("/closing", jwtAuth, accessControl, closingRouter);` (mirror `index.mjs:266`).
  Optionally add a `closingNumber` block to `initializeCounters` (`index.mjs:91-133`) if
  closings could pre-exist (not needed for a fresh feature).
- **`models/access.mjs`:** add a `closing: { view, create }` permission block (mirror
  `cashbook: { view, manage }` at `models/access.mjs:86-89`).
- **`middleware/accessControl.mjs`:** add to `ROUTE_PERMISSIONS`
  (`accessControl.mjs:65-168`):
  ```
  '/closing': {
    GET:  { _default: { module: 'closing', action: 'view' } },
    POST: { _default: { module: 'closing', action: 'create' } },
  }
  ```
- **`models/business.mjs`:** add `lastClosingAt: { type: Date, default: null }` alongside
  `isActive` (`models/business.mjs:99-102`).
- **`middleware/validationSchemas.mjs`:** add `createClosingSchema` (body: periodStart,
  periodEnd required ISO datetimes; countedNote optional string) and
  `closingPreviewSchema` (query: optional startDate/endDate). Wire via `validate`
  middleware in the router.

## Files

**Create:** `models/closing.mjs`, `routes/closing.mjs`, `controllers/closing.mjs`.
**Modify:** `index.mjs` (import + mount), `models/access.mjs` (permission block),
`middleware/accessControl.mjs` (`ROUTE_PERMISSIONS['/closing']`),
`models/business.mjs` (`lastClosingAt`),
`middleware/validationSchemas.mjs` (two schemas).

## Edge cases

- **First closing:** no prior closing → default start = business earliest sale
  `createdAt` (min-date query) or owner-supplied start.
- **Contiguity:** default next start = last `periodEnd`; overlap query rejects overlaps.
  Gaps are allowed only if the owner explicitly picks a later start.
- **Late returns on a closed period:** recognized in the current open period by
  `returnedAt`; finalized snapshots never change.
- **Walk-in sales:** `customer=null`, `customerBalanceBefore=0`; contribute to tenders,
  never to creditExtended.
- **Negative `amountDue`** (store owes customer / overpayment): flows through as a
  negative creditExtended contribution — surfaced, not hidden.
- **Empty period:** all zeros, `reconciled = true`.

## Verification

1. Start the server (`node index.mjs` or the project's dev script); confirm `/closing`
   routes mount and are gated (a token lacking `closing.view` gets 403).
2. Seed / use existing bills across a known range. Call
   `GET /closing/preview?startDate=&endDate=` and hand-check: `costPlusProfit === netSales`,
   and `settlementTotal` vs `netSales` (difference within ₹1 for clean data). Craft a bill
   paid partly by `store_credit` and confirm `storeCreditUsed` populates and the equation
   still balances.
3. `POST /closing` for the range; verify `closingNumber` increments, `business.lastClosingAt`
   updates, and a second POST overlapping the range is rejected (400).
4. Process a **return** (`returnedAt` today) on a bill from a *prior* finalized period;
   re-fetch the old closing via `GET /closing/:id` and confirm its numbers are unchanged;
   confirm a new preview for the current period reflects the refund.
5. `GET /closing/last` returns the just-created record; `GET /closing?page=1&limit=10`
   paginates; `GET /closing/:id` returns the frozen full record.
6. Confirm timezone: pass a full ISO datetime with a mid-day time as `endDate` and verify
   bills after that time are excluded (respects `Asia/Karachi`).
