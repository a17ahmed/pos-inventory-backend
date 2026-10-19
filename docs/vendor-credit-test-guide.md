# Vendor credit: manual test guide

Test returns to a vendor, vendor credit, and the new supply safety rules in the desktop app.
Every expected value below was checked by running this exact scenario on the dev database.

---

## Before you start

1. `.env` → the **dev** `MONGODB_URI` line is active (NOT `pos-production`).
2. Start the backend from branch `feat/counstomer-discount-profile`: `npm run dev` (port 3000).
3. Point the desktop app at the local backend and log in: `admin@primemart.com` / `12345678`.
4. Open **Cash Book** and write down **cash in hand** → this is **C**. You need at least Rs 3,000.
   If it's less, add a manual deposit (e.g. Rs 10,000) and use the new cash in hand as C.
5. Create 2 products (Track stock ON, stock 0):

   | Product    | Selling price | Cost price |
   |------------|---------------|------------|
   | QA Ketchup | 150           | 100        |
   | QA Mayo    | 150           | 100        |

6. Create a vendor **QA Vendor** (no credit limit).

> Supply numbers below are called **S1, S2, S3, S4** — your real numbers will be different.
> All supplies use unit price **Rs 100**.

---

## Part A: Return on a paid supply → credit pays the oldest unpaid supply

### Step 1: Supply S1 (unpaid, older)
QA Vendor → New supply → **bill date = 2 days ago** → **20 × QA Mayo @ 100**, paid **0**.

| Check | Expected |
|---|---|
| S1 | Total **2,000**, Paid **0**, Remaining **2,000**, **Unpaid** |
| QA Mayo stock | **20** |
| Vendor | Total **2,000**, Paid **0**, Remaining **2,000** |

### Step 2: Supply S2 (fully paid, today)
New supply → **bill date = today** → **30 × QA Ketchup @ 100**, paid **3,000 cash**.

| Check | Expected |
|---|---|
| S2 | Total **3,000**, Paid **3,000**, Remaining **0**, **Paid** |
| QA Ketchup stock | **30** |
| Cash in hand | **C − 3,000** |
| Vendor | Total **5,000**, Paid **3,000**, Remaining **2,000** |

### Step 3: Return 10 Ketchup from S2 (Rs 1,000)
S2 → Return → **10 × QA Ketchup**.

**What happens:** S2 was already paid, so the vendor now owes you 1,000. No cash comes back —
the 1,000 is used on the oldest unpaid supply (S1).

| Check | Expected |
|---|---|
| Message | "Returned Rs 1,000 · Rs 1,000 credit used on Supply #S1" |
| QA Ketchup stock | **20** |
| S2 | Returned **1,000**, Remaining **0**, **Paid** |
| S1 | Paid **1,000** ("incl. Rs 1,000 vendor credit"), Remaining **1,000**, **Partial** |
| Cash in hand | **C − 3,000** (unchanged, no refund) |
| Vendor | Total **5,000**, Paid **3,000**, Returns **1,000**, Remaining **1,000**, Credit **0** |

**Vendor ledger now (6 rows):**

| Type | Description | Debit | Credit | Balance |
|---|---|---|---|---|
| SUPPLY | Supply #S1 | 2,000 | | 2,000 |
| SUPPLY | Supply #S2 | 3,000 | | 5,000 |
| PAID | Payment for Supply #S2 | | 3,000 | 2,000 |
| RETURN | Return on Supply #S2 (1 item) | | 1,000 | 1,000 |
| CREDIT MOVED | Credit from Supply #S2 used on Supply #S1 | 1,000 | | 2,000 |
| PAID *(grey/italic)* | Paid from credit of Supply #S2 *(row is on S1)* | | 1,000 | 1,000 |

Ledger cards: Total Supplies **5,000** · Total Paid **3,000** · Returns **1,000** · Amount Due **1,000**.

> The last two rows always come as a pair and cancel each other out (balance goes up 1,000, then down 1,000).
> They show *where* the credit went. "Total Paid" stays 3,000 because no real money was paid.

---

## Part B: Can't return what's already sold

### Step 4: Sell 14 Ketchup, then try to return 10
1. POS → sell **14 × QA Ketchup**, cash (Rs 2,100). Ketchup stock → **6**. Cash → **C − 900**.
2. S2 → Return → **10 × QA Ketchup**.

| Check | Expected |
|---|---|
| Result | **Blocked**: "Cannot return more than is currently in stock" (QA Ketchup: requested **10**, available **6**) |
| QA Ketchup stock | still **6** |
| S2 / Vendor / Ledger | nothing changed |

---

## Part C: Credit with nothing to pay → kept as vendor credit

### Step 5: Pay the rest of S1
1. S1 → Pay → **1,500** cash → **Blocked**: "Payment amount cannot exceed remaining balance of Rs 1000".
   *(If the app won't let you type more than 1,000, that's the app blocking it first. Also correct.)*
2. S1 → Pay → **1,000** cash.

| Check | Expected |
|---|---|
| S1 | Paid **2,000**, Remaining **0**, **Paid** |
| Cash in hand | **C − 1,900** |
| Vendor | Paid **4,000**, Remaining **0** |

### Step 6: Return 5 Mayo from S1 (Rs 500)
S1 → Return → **5 × QA Mayo**.

**What happens:** S1 was fully paid, so the vendor owes you 500. Nothing is unpaid, so the 500
is **kept** as vendor credit.

| Check | Expected |
|---|---|
| Message | "Returned Rs 500 · Vendor owes you Rs 500" (no "credit used" part) |
| QA Mayo stock | **15** |
| S1 | Returned **500**, **Paid**, shows "Vendor owes you Rs 500" (balance **−500**) |
| Cash in hand | **C − 1,900** (unchanged) |
| Vendor | Paid **4,000**, Returns **1,500**, Remaining **0**, **Credit 500** |
| Ledger | Last balance **−500**, card **Vendor Credit 500** |

### Step 7: Try to delete the vendor
Delete **QA Vendor** → **Blocked**: "Cannot delete vendor — they still owe you Rs 500 in credit from returns".

### Step 8: New supply S3 → the credit pays it automatically
New supply → today → **10 × QA Mayo @ 100**, paid **0**.

| Check | Expected |
|---|---|
| S3 | Total **1,000**, Paid **500** ("incl. Rs 500 vendor credit"), Remaining **500**, **Partial** |
| QA Mayo stock | **25** |
| Cash in hand | **C − 1,900** (unchanged) |
| Vendor | Total **6,000**, Paid **4,000**, Remaining **500**, Credit **0** |

---

## Part D: Pay vendor is capped

### Step 9: Pay vendor (FIFO)
1. Ledger → Pay Vendor → **600** → **Blocked**: "Payment amount (Rs 600) exceeds total outstanding (Rs 500)".
   *(The app may already stop you at 500. Also correct.)*
2. Pay Vendor → **500** cash.

| Check | Expected |
|---|---|
| S3 | Paid **1,000**, Remaining **0**, **Paid** |
| Cash in hand | **C − 2,400** |
| Vendor | Paid **4,500**, Remaining **0**, Credit **0** |

---

## Part E: Safety rules on edit / delete / create

| # | Do this | Expected |
|---|---|---|
| 10 | Edit S2 → change **Paid amount** to 4,000 → Save | Field should be locked. If not, it's **blocked**: "Paid amount can't be edited. Use "Pay" to record a payment." |
| 11 | Edit S2 → change only **Bill number** (e.g. INV-777) → Save | **Saves.** Ketchup stock stays **6** (items didn't change, so no stock movement) |
| 12 | Edit S2 → change Ketchup qty 30 → 25 → Save | **Blocked**: "This supply has returns, so its items can't be changed. Undo the returns first." |
| 13 | Delete S2 (or S1) | **Blocked**: "This supply has payments, so it can't be deleted." |
| 14a | New supply S4 → today → **10 × QA Ketchup @ 100**, paid 0 | S4 Total **1,000**, Unpaid. Ketchup stock **16** |
| 14b | POS → sell **10 × QA Ketchup** cash (Rs 1,500) | Ketchup stock **6**. Cash **C − 900** |
| 14c | Delete S4 | **Blocked**: "Some items from this supply were already sold, so it can't be deleted" (requested **10**, available **6**) |
| 14d | Edit S4 → Ketchup qty 10 → **2** | **Blocked**: "…quantity can't be reduced that much" (requested **8**, available **6**) |
| 14e | Edit S4 → Ketchup qty 10 → **5** | **Saves.** S4 Total **500**, Remaining **500**. Ketchup stock **1** |
| 15 | New supply → 1 × QA Mayo @ 100, paid **200** | **Blocked**: paid can't be more than the total (the app checks this first too) |

---

## Final check: everything should match this

**Vendor (QA Vendor):**

| Total Supplies | Total Paid (real money) | Returns | Remaining | Vendor Credit |
|---|---|---|---|---|
| **6,500** | **4,500** | **1,500** | **500** | **0** |

Check: 6,500 − 4,500 − 1,500 = **500** ✔

**Supplies:**

| Supply | Total | Returned | Paid | of which vendor credit | Remaining | Status |
|---|---|---|---|---|---|---|
| S1 | 2,000 | 500 | 2,000 | 1,000 (from S2) | 0 | Paid |
| S2 | 3,000 | 1,000 | 3,000 | 0 | 0 | Paid |
| S3 | 1,000 | 0 | 1,000 | 500 (from S1) | 0 | Paid |
| S4 | 500 | 0 | 0 | 0 | 500 | Unpaid |

**Stock:** QA Ketchup **1** · QA Mayo **25**

**Cash in hand:** **C − 900**

**Cash Book:** exactly these new vendor entries (all "Vendor payment", out):

| Amount | Description |
|---|---|
| 3,000 | Supply payment - QA Vendor (Supply #S2) |
| 1,000 | Supply payment - QA Vendor (Supply #S1) |
| 500 | Vendor payment to QA Vendor (1 supplies) |

Plus the two POS sales (+2,100 and +1,500). **No cash entries for returns or for credit moves.**

---

## Optional: deleting a cash expense (bug fix)

1. Add an expense Rs 100, payment **cash**, approve it → cash in hand −100.
2. Delete the expense.

Expected: it deletes (before this fix it failed). Cash Book gets an **"Expense reversed"** entry, **in 100**,
and cash in hand goes back up by 100.

---

## If something doesn't match

Write down the step number, what you expected, and what you saw (a screenshot of the supply/ledger helps).
The backend values come from these fields if you check the network tab:

| Where | Fields |
|---|---|
| Supply | `totalAmount`, `totalReturned`, `paidAmount`, `creditApplied` (credit received), `creditUsed` (credit given away), `remainingAmount`, `balance` (negative = vendor owes you), `paymentStatus` |
| Vendor | `totalBusiness`, `totalPaid`, `totalReturned`, `totalRemaining`, `totalCredit`, `netBalance` |
| Ledger summary | `totalSupplies`, `totalPaid`, `totalReturns`, `amountDue`, `vendorCredit`, `netBalance` |
| Return response | `creditSettlement: [{ fromNumber, toNumber, amount }]` |
| Pay vendor response | `creditApplied: [{ fromNumber, toNumber, amount }]` |
