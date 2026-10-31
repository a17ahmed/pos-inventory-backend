# Ledger QA dataset — primemart (dev)

Seeded 18/10/2026, 21:30 (Pakistan time). Log in as the business admin and open **Customers → search "QA"**.

Every value below was checked against the backend when the data was created. Cash book entries for these payments keep the time the seed ran (only bill / payment / return dates were moved to the scenario days).

Default view of the ledger = **Since last zero, oldest first**: everything after the last time the customer owed nothing (balance 0 or in credit). Never settled → all entries. Owes nothing now → the last completed cycle. Cards (Total Billed / Total Paid / Returns / Total Bills / Amount Due) must show the **All-time** numbers below whatever filter is selected.

## Overview

| # | Customer | Phone | What it tests | Amount Due |
|---|---|---|---|---|
| 01 | QA 01 Fully Paid | 03000000101 | Two bills, both paid in cash at the counter. | **0** |
| 02 | QA 02 Unpaid Bills | 03000000102 | Two bills on account, nothing paid yet. | **7,000** |
| 03 | QA 03 Partial + Later Payments | 03000000103 | One 10,000 bill: 3,000 paid at sale, 1,000 by Record Payment 5 days ago, 2,000 added on the bill today. | **4,000** |
| 04 | QA 04 FIFO Collection | 03000000104 | Three unpaid bills (3,000 / 4,000 / 5,000). Today Record Payment 5,000 pays the oldest first: first bill fully, second 2,000. | **7,000** |
| 05 | QA 05 Return on Unpaid Bill | 03000000105 | 6,000 unpaid bill; 3 days ago items worth 2,000 returned → simply reduces what is owed (no credit). | **4,000** |
| 06 | QA 06 Return Credit Pays Other Bill | 03000000106 | Bill A 3,000 paid; Bill B 5,000 unpaid. Yesterday 2,000 returned from paid Bill A → 2,000 credit automatically pays Bill B. | **3,000** |
| 07 | QA 07 Advance Credit | 03000000107 | 2,500 bill paid in cash, fully returned today, no other bills → shop owes the customer 2,500 (credit). | **Cr 2,500** |
| 08 | QA 08 Credit Used On New Bill | 03000000108 | 1,000 bill paid, fully returned 3 days ago (1,000 credit). Today a new 3,000 bill on account → credit used automatically, 2,000 left. | **2,000** |
| 09 | QA 09 Cancelled Bill | 03000000109 | A 4,000 cash bill made by mistake and cancelled; a real 1,000 unpaid bill. | **1,000** |
| 10 | QA 10 Full Return Unpaid | 03000000110 | 3,000 unpaid bill fully returned 2 days ago → nothing owed. | **0** |
| 11 | QA 11 Opening Balance | 03000000111 | Customer added with an 8,000 opening balance (40 days ago), a 2,000 bill last month, and 3,000 paid today (goes to the oldest = opening balance). | **7,000** |
| 12 | QA 12 Last Month Only | 03000000112 | All activity last month: 1,500 bill paid, 2,500 bill unpaid, 1,000 paid on 25th. Nothing this month. | **1,500** |
| 13 | QA 13 Card & Online | 03000000113 | 4,000 bill paid by card; 3,000 bill unpaid, paid today by online transfer. | **0** |
| 14 | QA 14 Big Ledger Paging | 03000000114 | 70 bills of 1,000, one per day for 70 days (oldest 69 days ago, newest today); every other one paid at sale → 105 lines (3 pages of 50). | **35,000** |
| 15 | QA 15 Two Returns Partly Paid | 03000000115 | 5 cartons × 1,000 = 5,000, 2,000 paid. 6 days ago 1 carton returned (reduces due). 2 days ago 3 cartons returned: 2,000 clears the rest, 1,000 becomes credit. | **Cr 1,000** |

## QA 01 Fully Paid  (03000000101)

Two bills, both paid in cash at the counter.

**Cards (all-time, never change with filters)**

| Total Billed | Total Paid | Returns | Total Bills | Amount Due | Available credit |
|---|---|---|---|---|---|
| 3,700 | 3,700 | 0 | 2 | **0** | 0 |

**Period bar**

| Period | Opening | Bills | Paid | Returns | Closing | Lines | Cancelled hidden |
|---|---|---|---|---|---|---|---|
| Since last zero (default) — settled 18/10 · last cycle from 28/09 | 0 | 1,200 | 1,200 | 0 | **0** | 2 | 0 |
| Today | 0 | 1,200 | 1,200 | 0 | **0** | 2 | 0 |
| All time | 0 | 3,700 | 3,700 | 0 | **0** | 4 | 0 |

**Amount Due panel (pending bills, oldest first)**

No pending bills.

**All-time ledger lines (oldest first)**

| Date | Bill | Type | Description | Method | Debit | Credit | Balance | Notes |
|---|---|---|---|---|---|---|---|---|
| 28/09/2026, 11:00 | #19 | SALE | Bill #19 |  | 2,500 | — | 2,500 |  |
| 28/09/2026, 11:00 | #19 | PAID | Payment for Bill #19 | CASH | — | 2,500 | 0 |  |
| 18/10/2026, 21:22 | #20 | SALE | Bill #20 |  | 1,200 | — | 1,200 |  |
| 18/10/2026, 21:22 | #20 | PAID | Payment for Bill #20 | CASH | — | 1,200 | 0 |  |

## QA 02 Unpaid Bills  (03000000102)

Two bills on account, nothing paid yet.

**Cards (all-time, never change with filters)**

| Total Billed | Total Paid | Returns | Total Bills | Amount Due | Available credit |
|---|---|---|---|---|---|
| 7,000 | 0 | 0 | 2 | **7,000** | 0 |

**Period bar**

| Period | Opening | Bills | Paid | Returns | Closing | Lines | Cancelled hidden |
|---|---|---|---|---|---|---|---|
| Since last zero (default) — never settled · all entries | 0 | 7,000 | 0 | 0 | **7,000** | 2 | 0 |
| Today | 5,000 | 2,000 | 0 | 0 | **7,000** | 1 | 0 |
| All time | 0 | 7,000 | 0 | 0 | **7,000** | 2 | 0 |

**Amount Due panel (pending bills, oldest first)**

| Bill | Date | Total | Paid | Returned | Still due | Age (days) |
|---|---|---|---|---|---|---|
| #21 | 03/10/2026 | 5,000 | 0 | 0 | **5,000** | 15 |
| #22 | 18/10/2026 | 2,000 | 0 | 0 | **2,000** | 0 |
| **Total** | | | | | **7,000** = **7,000** | |

**All-time ledger lines (oldest first)**

| Date | Bill | Type | Description | Method | Debit | Credit | Balance | Notes |
|---|---|---|---|---|---|---|---|---|
| 03/10/2026, 11:00 | #21 | SALE | Bill #21 |  | 5,000 | — | 5,000 |  |
| 18/10/2026, 21:22 | #22 | SALE | Bill #22 |  | 2,000 | — | 7,000 |  |

## QA 03 Partial + Later Payments  (03000000103)

One 10,000 bill: 3,000 paid at sale, 1,000 by Record Payment 5 days ago, 2,000 added on the bill today.

**Cards (all-time, never change with filters)**

| Total Billed | Total Paid | Returns | Total Bills | Amount Due | Available credit |
|---|---|---|---|---|---|
| 10,000 | 6,000 | 0 | 1 | **4,000** | 0 |

**Period bar**

| Period | Opening | Bills | Paid | Returns | Closing | Lines | Cancelled hidden |
|---|---|---|---|---|---|---|---|
| Since last zero (default) — never settled · all entries | 0 | 10,000 | 6,000 | 0 | **4,000** | 4 | 0 |
| Today | 6,000 | 0 | 2,000 | 0 | **4,000** | 1 | 0 |
| All time | 0 | 10,000 | 6,000 | 0 | **4,000** | 4 | 0 |

**Amount Due panel (pending bills, oldest first)**

| Bill | Date | Total | Paid | Returned | Still due | Age (days) |
|---|---|---|---|---|---|---|
| #23 | 06/10/2026 | 10,000 | 6,000 | 0 | **4,000** | 12 |
| **Total** | | | | | **4,000** = **4,000** | |

**All-time ledger lines (oldest first)**

| Date | Bill | Type | Description | Method | Debit | Credit | Balance | Notes |
|---|---|---|---|---|---|---|---|---|
| 06/10/2026, 11:00 | #23 | SALE | Bill #23 |  | 10,000 | — | 10,000 |  |
| 06/10/2026, 11:00 | #23 | PAID | Payment for Bill #23 | CASH | — | 3,000 | 7,000 |  |
| 13/10/2026, 11:00 | #23 | PAID | Payment for Bill #23 | CASH | — | 1,000 | 6,000 |  |
| 18/10/2026, 21:22 | #23 | PAID | Payment for Bill #23 | CASH | — | 2,000 | 4,000 |  |

## QA 04 FIFO Collection  (03000000104)

Three unpaid bills (3,000 / 4,000 / 5,000). Today Record Payment 5,000 pays the oldest first: first bill fully, second 2,000.

**Cards (all-time, never change with filters)**

| Total Billed | Total Paid | Returns | Total Bills | Amount Due | Available credit |
|---|---|---|---|---|---|
| 12,000 | 5,000 | 0 | 3 | **7,000** | 0 |

**Period bar**

| Period | Opening | Bills | Paid | Returns | Closing | Lines | Cancelled hidden |
|---|---|---|---|---|---|---|---|
| Since last zero (default) — never settled · all entries | 0 | 12,000 | 5,000 | 0 | **7,000** | 5 | 0 |
| Today | 12,000 | 0 | 5,000 | 0 | **7,000** | 2 | 0 |
| All time | 0 | 12,000 | 5,000 | 0 | **7,000** | 5 | 0 |

**Amount Due panel (pending bills, oldest first)**

| Bill | Date | Total | Paid | Returned | Still due | Age (days) |
|---|---|---|---|---|---|---|
| #25 | 28/09/2026 | 4,000 | 2,000 | 0 | **2,000** | 20 |
| #26 | 08/10/2026 | 5,000 | 0 | 0 | **5,000** | 10 |
| **Total** | | | | | **7,000** = **7,000** | |

**All-time ledger lines (oldest first)**

| Date | Bill | Type | Description | Method | Debit | Credit | Balance | Notes |
|---|---|---|---|---|---|---|---|---|
| 18/09/2026, 11:00 | #24 | SALE | Bill #24 |  | 3,000 | — | 3,000 |  |
| 28/09/2026, 11:00 | #25 | SALE | Bill #25 |  | 4,000 | — | 7,000 |  |
| 08/10/2026, 11:00 | #26 | SALE | Bill #26 |  | 5,000 | — | 12,000 |  |
| 18/10/2026, 21:22 | #24 | PAID | Payment for Bill #24 | CASH | — | 3,000 | 9,000 |  |
| 18/10/2026, 21:22 | #25 | PAID | Payment for Bill #25 | CASH | — | 2,000 | 7,000 |  |

## QA 05 Return on Unpaid Bill  (03000000105)

6,000 unpaid bill; 3 days ago items worth 2,000 returned → simply reduces what is owed (no credit).

**Cards (all-time, never change with filters)**

| Total Billed | Total Paid | Returns | Total Bills | Amount Due | Available credit |
|---|---|---|---|---|---|
| 6,000 | 0 | 2,000 | 1 | **4,000** | 0 |

**Period bar**

| Period | Opening | Bills | Paid | Returns | Closing | Lines | Cancelled hidden |
|---|---|---|---|---|---|---|---|
| Since last zero (default) — never settled · all entries | 0 | 6,000 | 0 | 2,000 | **4,000** | 2 | 0 |
| Today | 4,000 | 0 | 0 | 0 | **4,000** | 0 | 0 |
| All time | 0 | 6,000 | 0 | 2,000 | **4,000** | 2 | 0 |

**Amount Due panel (pending bills, oldest first)**

| Bill | Date | Total | Paid | Returned | Still due | Age (days) |
|---|---|---|---|---|---|---|
| #27 | 10/10/2026 | 6,000 | 0 | 2,000 | **4,000** | 8 |
| **Total** | | | | | **4,000** = **4,000** | |

**All-time ledger lines (oldest first)**

| Date | Bill | Type | Description | Method | Debit | Credit | Balance | Notes |
|---|---|---|---|---|---|---|---|---|
| 10/10/2026, 11:00 | #27 | SALE | Bill #27 |  | 6,000 | — | 6,000 |  |
| 15/10/2026, 11:00 | #27 | RETURN | Return on Bill #27 (RET-20261018-0007) |  | — | 2,000 | 4,000 | unpaid amount reduced 2,000 |

## QA 06 Return Credit Pays Other Bill  (03000000106)

Bill A 3,000 paid; Bill B 5,000 unpaid. Yesterday 2,000 returned from paid Bill A → 2,000 credit automatically pays Bill B.

**Cards (all-time, never change with filters)**

| Total Billed | Total Paid | Returns | Total Bills | Amount Due | Available credit |
|---|---|---|---|---|---|
| 8,000 | 3,000 | 2,000 | 2 | **3,000** | 0 |

**Period bar**

| Period | Opening | Bills | Paid | Returns | Closing | Lines | Cancelled hidden |
|---|---|---|---|---|---|---|---|
| Since last zero (default) — after 0 on 09/10 | 0 | 5,000 | 0 | 2,000 | **3,000** | 4 | 0 |
| Today | 3,000 | 0 | 0 | 0 | **3,000** | 0 | 0 |
| All time | 0 | 8,000 | 3,000 | 2,000 | **3,000** | 6 | 0 |

**Amount Due panel (pending bills, oldest first)**

| Bill | Date | Total | Paid | Returned | Still due | Age (days) |
|---|---|---|---|---|---|---|
| #29 | 12/10/2026 | 5,000 | 2,000 | 0 | **3,000** | 6 |
| **Total** | | | | | **3,000** = **3,000** | |

**All-time ledger lines (oldest first)**

| Date | Bill | Type | Description | Method | Debit | Credit | Balance | Notes |
|---|---|---|---|---|---|---|---|---|
| 09/10/2026, 11:00 | #28 | SALE | Bill #28 |  | 3,000 | — | 3,000 |  |
| 09/10/2026, 11:00 | #28 | PAID | Payment for Bill #28 | CASH | — | 3,000 | 0 |  |
| 12/10/2026, 11:00 | #29 | SALE | Bill #29 |  | 5,000 | — | 5,000 |  |
| 17/10/2026, 16:00 | #28 | RETURN | Return on Bill #28 (RET-20261018-0008) |  | — | 2,000 | 3,000 | credit 2,000 |
| 17/10/2026, 16:00 | #28 | CREDIT MOVED | Credit from Bill #28 moved to Bill #29 |  | 2,000 | — | 5,000 |  |
| 17/10/2026, 16:00 | #29 | PAID | Payment for Bill #29 (credit from Bill #28) | STORE CREDIT | — | 2,000 | 3,000 |  |

## QA 07 Advance Credit  (03000000107)

2,500 bill paid in cash, fully returned today, no other bills → shop owes the customer 2,500 (credit).

**Cards (all-time, never change with filters)**

| Total Billed | Total Paid | Returns | Total Bills | Amount Due | Available credit |
|---|---|---|---|---|---|
| 2,500 | 2,500 | 2,500 | 1 | **Cr 2,500** | 2,500 |

**Period bar**

| Period | Opening | Bills | Paid | Returns | Closing | Lines | Cancelled hidden |
|---|---|---|---|---|---|---|---|
| Since last zero (default) — settled 14/10 · from the start | 0 | 2,500 | 2,500 | 2,500 | **Cr 2,500** | 3 | 0 |
| Today | 0 | 0 | 0 | 2,500 | **Cr 2,500** | 1 | 0 |
| All time | 0 | 2,500 | 2,500 | 2,500 | **Cr 2,500** | 3 | 0 |

**Amount Due panel (pending bills, oldest first)**

No pending bills. Available credit: **2,500**.

**All-time ledger lines (oldest first)**

| Date | Bill | Type | Description | Method | Debit | Credit | Balance | Notes |
|---|---|---|---|---|---|---|---|---|
| 14/10/2026, 11:00 | #30 | SALE | Bill #30 |  | 2,500 | — | 2,500 |  |
| 14/10/2026, 11:00 | #30 | PAID | Payment for Bill #30 | CASH | — | 2,500 | 0 |  |
| 18/10/2026, 21:22 | #30 | RETURN | Return on Bill #30 (RET-20261018-0009) |  | — | 2,500 | Cr 2,500 | credit 2,500 |

## QA 08 Credit Used On New Bill  (03000000108)

1,000 bill paid, fully returned 3 days ago (1,000 credit). Today a new 3,000 bill on account → credit used automatically, 2,000 left.

**Cards (all-time, never change with filters)**

| Total Billed | Total Paid | Returns | Total Bills | Amount Due | Available credit |
|---|---|---|---|---|---|
| 4,000 | 1,000 | 1,000 | 2 | **2,000** | 0 |

**Period bar**

| Period | Opening | Bills | Paid | Returns | Closing | Lines | Cancelled hidden |
|---|---|---|---|---|---|---|---|
| Since last zero (default) — after 0 on 15/10 | Cr 1,000 | 3,000 | 0 | 0 | **2,000** | 3 | 0 |
| Today | Cr 1,000 | 3,000 | 0 | 0 | **2,000** | 3 | 0 |
| All time | 0 | 4,000 | 1,000 | 1,000 | **2,000** | 6 | 0 |

**Amount Due panel (pending bills, oldest first)**

| Bill | Date | Total | Paid | Returned | Still due | Age (days) |
|---|---|---|---|---|---|---|
| #32 | 18/10/2026 | 3,000 | 1,000 | 0 | **2,000** | 0 |
| **Total** | | | | | **2,000** = **2,000** | |

**All-time ledger lines (oldest first)**

| Date | Bill | Type | Description | Method | Debit | Credit | Balance | Notes |
|---|---|---|---|---|---|---|---|---|
| 12/10/2026, 11:00 | #31 | SALE | Bill #31 |  | 1,000 | — | 1,000 |  |
| 12/10/2026, 11:00 | #31 | PAID | Payment for Bill #31 | CASH | — | 1,000 | 0 |  |
| 15/10/2026, 11:00 | #31 | RETURN | Return on Bill #31 (RET-20261018-0010) |  | — | 1,000 | Cr 1,000 | credit 1,000 |
| 18/10/2026, 21:22 | #32 | SALE | Bill #32 |  | 3,000 | — | 2,000 |  |
| 18/10/2026, 21:22 | #31 | CREDIT MOVED | Credit from Bill #31 moved to Bill #32 |  | 1,000 | — | 3,000 |  |
| 18/10/2026, 21:22 | #32 | PAID | Payment for Bill #32 (credit from Bill #31) | STORE CREDIT | — | 1,000 | 2,000 |  |

## QA 09 Cancelled Bill  (03000000109)

A 4,000 cash bill made by mistake and cancelled; a real 1,000 unpaid bill.

**Cards (all-time, never change with filters)**

| Total Billed | Total Paid | Returns | Total Bills | Amount Due | Available credit |
|---|---|---|---|---|---|
| 1,000 | 0 | 0 | 1 | **1,000** | 0 |

**Period bar**

| Period | Opening | Bills | Paid | Returns | Closing | Lines | Cancelled hidden |
|---|---|---|---|---|---|---|---|
| Since last zero (default) — after 0 on 11/10 | 0 | 1,000 | 0 | 0 | **1,000** | 1 | 0 |
| Today | 1,000 | 0 | 0 | 0 | **1,000** | 0 | 0 |
| All time | 0 | 1,000 | 0 | 0 | **1,000** | 1 | 1 |

**Amount Due panel (pending bills, oldest first)**

| Bill | Date | Total | Paid | Returned | Still due | Age (days) |
|---|---|---|---|---|---|---|
| #34 | 16/10/2026 | 1,000 | 0 | 0 | **1,000** | 2 |
| **Total** | | | | | **1,000** = **1,000** | |

**All-time ledger lines (oldest first)**

| Date | Bill | Type | Description | Method | Debit | Credit | Balance | Notes |
|---|---|---|---|---|---|---|---|---|
| 16/10/2026, 11:00 | #34 | SALE | Bill #34 |  | 1,000 | — | 1,000 |  |

**Cancelled filter**

- #33 11/10/2026, 11:00 · 4,000 · reason: "Created by mistake (QA)" · counts as 0

## QA 10 Full Return Unpaid  (03000000110)

3,000 unpaid bill fully returned 2 days ago → nothing owed.

**Cards (all-time, never change with filters)**

| Total Billed | Total Paid | Returns | Total Bills | Amount Due | Available credit |
|---|---|---|---|---|---|
| 3,000 | 0 | 3,000 | 1 | **0** | 0 |

**Period bar**

| Period | Opening | Bills | Paid | Returns | Closing | Lines | Cancelled hidden |
|---|---|---|---|---|---|---|---|
| Since last zero (default) — settled 16/10 · from the start | 0 | 3,000 | 0 | 3,000 | **0** | 2 | 0 |
| Today | 0 | 0 | 0 | 0 | **0** | 0 | 0 |
| All time | 0 | 3,000 | 0 | 3,000 | **0** | 2 | 0 |

**Amount Due panel (pending bills, oldest first)**

No pending bills.

**All-time ledger lines (oldest first)**

| Date | Bill | Type | Description | Method | Debit | Credit | Balance | Notes |
|---|---|---|---|---|---|---|---|---|
| 13/10/2026, 11:00 | #35 | SALE | Bill #35 |  | 3,000 | — | 3,000 |  |
| 16/10/2026, 11:00 | #35 | RETURN | Return on Bill #35 (RET-20261018-0011) |  | — | 3,000 | 0 | unpaid amount reduced 3,000 |

## QA 11 Opening Balance  (03000000111)

Customer added with an 8,000 opening balance (40 days ago), a 2,000 bill last month, and 3,000 paid today (goes to the oldest = opening balance).

**Cards (all-time, never change with filters)**

| Total Billed | Total Paid | Returns | Total Bills | Amount Due | Available credit |
|---|---|---|---|---|---|
| 10,000 | 3,000 | 0 | 2 | **7,000** | 0 |

**Period bar**

| Period | Opening | Bills | Paid | Returns | Closing | Lines | Cancelled hidden |
|---|---|---|---|---|---|---|---|
| Since last zero (default) — never settled · all entries | 0 | 10,000 | 3,000 | 0 | **7,000** | 3 | 0 |
| Today | 10,000 | 0 | 3,000 | 0 | **7,000** | 1 | 0 |
| All time | 0 | 10,000 | 3,000 | 0 | **7,000** | 3 | 0 |

**Amount Due panel (pending bills, oldest first)**

| Bill | Date | Total | Paid | Returned | Still due | Age (days) |
|---|---|---|---|---|---|---|
| #36 | 08/09/2026 | 8,000 | 3,000 | 0 | **5,000** | 40 |
| #37 | 15/09/2026 | 2,000 | 0 | 0 | **2,000** | 33 |
| **Total** | | | | | **7,000** = **7,000** | |

**All-time ledger lines (oldest first)**

| Date | Bill | Type | Description | Method | Debit | Credit | Balance | Notes |
|---|---|---|---|---|---|---|---|---|
| 08/09/2026, 11:00 | #36 | OPENING | Opening Balance |  | 8,000 | — | 8,000 |  |
| 15/09/2026, 11:00 | #37 | SALE | Bill #37 |  | 2,000 | — | 10,000 |  |
| 18/10/2026, 21:22 | #36 | PAID | Payment for Bill #36 | CASH | — | 3,000 | 7,000 |  |

## QA 12 Last Month Only  (03000000112)

All activity last month: 1,500 bill paid, 2,500 bill unpaid, 1,000 paid on 25th. Nothing this month.

**Cards (all-time, never change with filters)**

| Total Billed | Total Paid | Returns | Total Bills | Amount Due | Available credit |
|---|---|---|---|---|---|
| 4,000 | 2,500 | 0 | 2 | **1,500** | 0 |

**Period bar**

| Period | Opening | Bills | Paid | Returns | Closing | Lines | Cancelled hidden |
|---|---|---|---|---|---|---|---|
| Since last zero (default) — after 0 on 10/09 | 0 | 2,500 | 1,000 | 0 | **1,500** | 2 | 0 |
| Today | 1,500 | 0 | 0 | 0 | **1,500** | 0 | 0 |
| All time | 0 | 4,000 | 2,500 | 0 | **1,500** | 4 | 0 |

**Amount Due panel (pending bills, oldest first)**

| Bill | Date | Total | Paid | Returned | Still due | Age (days) |
|---|---|---|---|---|---|---|
| #39 | 20/09/2026 | 2,500 | 1,000 | 0 | **1,500** | 28 |
| **Total** | | | | | **1,500** = **1,500** | |

**All-time ledger lines (oldest first)**

| Date | Bill | Type | Description | Method | Debit | Credit | Balance | Notes |
|---|---|---|---|---|---|---|---|---|
| 10/09/2026, 11:00 | #38 | SALE | Bill #38 |  | 1,500 | — | 1,500 |  |
| 10/09/2026, 11:00 | #38 | PAID | Payment for Bill #38 | CASH | — | 1,500 | 0 |  |
| 20/09/2026, 11:00 | #39 | SALE | Bill #39 |  | 2,500 | — | 2,500 |  |
| 25/09/2026, 11:00 | #39 | PAID | Payment for Bill #39 | CASH | — | 1,000 | 1,500 |  |

## QA 13 Card & Online  (03000000113)

4,000 bill paid by card; 3,000 bill unpaid, paid today by online transfer.

**Cards (all-time, never change with filters)**

| Total Billed | Total Paid | Returns | Total Bills | Amount Due | Available credit |
|---|---|---|---|---|---|
| 7,000 | 7,000 | 0 | 2 | **0** | 0 |

**Period bar**

| Period | Opening | Bills | Paid | Returns | Closing | Lines | Cancelled hidden |
|---|---|---|---|---|---|---|---|
| Since last zero (default) — settled 18/10 · last cycle from 15/10 | 0 | 3,000 | 3,000 | 0 | **0** | 2 | 0 |
| Today | 3,000 | 0 | 3,000 | 0 | **0** | 1 | 0 |
| All time | 0 | 7,000 | 7,000 | 0 | **0** | 4 | 0 |

**Amount Due panel (pending bills, oldest first)**

No pending bills.

**All-time ledger lines (oldest first)**

| Date | Bill | Type | Description | Method | Debit | Credit | Balance | Notes |
|---|---|---|---|---|---|---|---|---|
| 15/10/2026, 11:00 | #40 | SALE | Bill #40 |  | 4,000 | — | 4,000 |  |
| 15/10/2026, 11:00 | #40 | PAID | Payment for Bill #40 | CARD | — | 4,000 | 0 |  |
| 17/10/2026, 11:00 | #41 | SALE | Bill #41 |  | 3,000 | — | 3,000 |  |
| 18/10/2026, 21:23 | #41 | PAID | Payment for Bill #41 | ONLINE | — | 3,000 | 0 |  |

## QA 14 Big Ledger Paging  (03000000114)

70 bills of 1,000, one per day for 70 days (oldest 69 days ago, newest today); every other one paid at sale → 105 lines (3 pages of 50).

**Cards (all-time, never change with filters)**

| Total Billed | Total Paid | Returns | Total Bills | Amount Due | Available credit |
|---|---|---|---|---|---|
| 70,000 | 35,000 | 0 | 70 | **35,000** | 0 |

**Period bar**

| Period | Opening | Bills | Paid | Returns | Closing | Lines | Cancelled hidden |
|---|---|---|---|---|---|---|---|
| Since last zero (default) — after 0 on 10/08 | 0 | 69,000 | 34,000 | 0 | **35,000** | 103 | 0 |
| Today | 34,000 | 1,000 | 0 | 0 | **35,000** | 1 | 0 |
| All time | 0 | 70,000 | 35,000 | 0 | **35,000** | 105 | 0 |

**Amount Due panel (pending bills, oldest first)**

| Bill | Date | Total | Paid | Returned | Still due | Age (days) |
|---|---|---|---|---|---|---|
| #43 | 11/08/2026 | 1,000 | 0 | 0 | **1,000** | 68 |
| #45 | 13/08/2026 | 1,000 | 0 | 0 | **1,000** | 66 |
| #47 | 15/08/2026 | 1,000 | 0 | 0 | **1,000** | 64 |
| #49 | 17/08/2026 | 1,000 | 0 | 0 | **1,000** | 62 |
| … | | | | | | |
| #109 | 16/10/2026 | 1,000 | 0 | 0 | **1,000** | 2 |
| #111 | 18/10/2026 | 1,000 | 0 | 0 | **1,000** | 0 |
| **Total** | | | | | **35,000** = **35,000** | |

**All-time ledger lines (oldest first) — first 6 and last 6 of 105**

| Date | Bill | Type | Description | Method | Debit | Credit | Balance | Notes |
|---|---|---|---|---|---|---|---|---|
| 10/08/2026, 11:00 | #42 | SALE | Bill #42 |  | 1,000 | — | 1,000 |  |
| 10/08/2026, 11:00 | #42 | PAID | Payment for Bill #42 | CASH | — | 1,000 | 0 |  |
| 11/08/2026, 11:00 | #43 | SALE | Bill #43 |  | 1,000 | — | 1,000 |  |
| 12/08/2026, 11:00 | #44 | SALE | Bill #44 |  | 1,000 | — | 2,000 |  |
| 12/08/2026, 11:00 | #44 | PAID | Payment for Bill #44 | CASH | — | 1,000 | 1,000 |  |
| 13/08/2026, 11:00 | #45 | SALE | Bill #45 |  | 1,000 | — | 2,000 |  |
| … | | | | | | | | |
| 15/10/2026, 11:00 | #108 | SALE | Bill #108 |  | 1,000 | — | 34,000 |  |
| 15/10/2026, 11:00 | #108 | PAID | Payment for Bill #108 | CASH | — | 1,000 | 33,000 |  |
| 16/10/2026, 11:00 | #109 | SALE | Bill #109 |  | 1,000 | — | 34,000 |  |
| 17/10/2026, 11:00 | #110 | SALE | Bill #110 |  | 1,000 | — | 35,000 |  |
| 17/10/2026, 11:00 | #110 | PAID | Payment for Bill #110 | CASH | — | 1,000 | 34,000 |  |
| 18/10/2026, 21:30 | #111 | SALE | Bill #111 |  | 1,000 | — | 35,000 |  |

## QA 15 Two Returns Partly Paid  (03000000115)

5 cartons × 1,000 = 5,000, 2,000 paid. 6 days ago 1 carton returned (reduces due). 2 days ago 3 cartons returned: 2,000 clears the rest, 1,000 becomes credit.

**Cards (all-time, never change with filters)**

| Total Billed | Total Paid | Returns | Total Bills | Amount Due | Available credit |
|---|---|---|---|---|---|
| 5,000 | 2,000 | 4,000 | 1 | **Cr 1,000** | 1,000 |

**Period bar**

| Period | Opening | Bills | Paid | Returns | Closing | Lines | Cancelled hidden |
|---|---|---|---|---|---|---|---|
| Since last zero (default) — settled 16/10 · from the start | 0 | 5,000 | 2,000 | 4,000 | **Cr 1,000** | 4 | 0 |
| Today | Cr 1,000 | 0 | 0 | 0 | **Cr 1,000** | 0 | 0 |
| All time | 0 | 5,000 | 2,000 | 4,000 | **Cr 1,000** | 4 | 0 |

**Amount Due panel (pending bills, oldest first)**

No pending bills. Available credit: **1,000**.

**All-time ledger lines (oldest first)**

| Date | Bill | Type | Description | Method | Debit | Credit | Balance | Notes |
|---|---|---|---|---|---|---|---|---|
| 08/10/2026, 11:00 | #112 | SALE | Bill #112 |  | 5,000 | — | 5,000 |  |
| 08/10/2026, 11:00 | #112 | PAID | Payment for Bill #112 | CASH | — | 2,000 | 3,000 |  |
| 12/10/2026, 11:00 | #112 | RETURN | Return on Bill #112 (RET-20261018-0012) |  | — | 1,000 | 2,000 | unpaid amount reduced 1,000 |
| 16/10/2026, 11:00 | #112 | RETURN | Return on Bill #112 (RET-20261018-0013) |  | — | 3,000 | Cr 1,000 | unpaid amount reduced 2,000 · credit 1,000 |

## Checks to run on every customer

1. Cards stay identical when switching Today / Yesterday / This week / This month / Last month / All time / Custom, type filters, sort and pages.
2. Period bar: Opening + Bills − Paid − Returns = Closing. For Today and All time, Closing = Amount Due.
3. Amount Due card = total of the pending-bills panel (minus available credit) = Record Payment total.
4. Sort Newest first: same lines reversed, every line keeps the same Balance.
5. Type = Payments shows PAID and CREDIT MOVED lines only; opening/closing unchanged.
6. Negative balances show as "Cr …" (QA 07, QA 15).
7. QA 14: 105 lines → 3 pages of 50; balances continue across pages; Last line balance = 35,000.
8. QA 12: Last month filter shows its 4 lines (opening 0 → closing 1,500); This month is empty with opening = closing = 1,500.
9. QA 09: Cancelled bill hidden by default ("1 cancelled bill hidden"), shown greyed with Cancelled filter, counts as 0.
10. QA 03 / QA 04: payments made today on old bills appear under Today.
11. Print / PDF of a period: opening, all lines, closing, all-time Amount Due; no cancelled bills.
