# Idempotent write endpoints (offline-first POS sync)

The desktop POS queues writes while offline and re-sends them when the
connection returns. A queued request may arrive **more than once**, so the four
write endpoints below dedupe on a client-supplied `idempotencyKey` (UUID v4)
sent as a **field in the JSON body** (not a header).

| Endpoint | Dedup anchor | Replay result |
|---|---|---|
| `POST /bill` | `Bill.idempotencyKey` | existing bill (`409` + `{ bill }`) |
| `POST /customer/:id/collect` | `Payment.idempotencyKey` | existing payment (`200`) |
| `POST /customer` | upsert-by-phone + `Customer.idempotencyKey` | existing customer (`200`) |
| `PATCH /customer/:id` | inherently idempotent | updated customer (`200`) |

## Contract

- **No key** → behaves exactly as an online write (unchanged).
- **First time a key is seen** (scoped per business) → apply the write, persist
  the key on the record, return the record.
- **Replay** → do **not** create a duplicate; return the existing record with
  `200`/`201` **or** `409`, always with the id at one of
  `_id | id | bill._id | customer._id | data._id`.

### Status codes the client acts on (`outboxEngine.js`)

- `200`/`201`/`409` → synced.
- other `4xx` → **permanent** rejection → op quarantined (never retried). Use
  only for genuine, unrecoverable business rejections (validation, insufficient
  stock, credit limit, deactivated customer).
- `5xx`/connection error → **transient** → client retries with backoff.

> A duplicate must never come back as a generic `400`/`500` — that would either
> quarantine a valid sale or make the client retry forever.

## Data model

- Partial, per-business unique indexes constrain only keyed rows, so online
  writes (no key) are unaffected:

  ```js
  schema.index(
    { business: 1, idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
  );
  ```

  - `Bill` — already had a partial unique index on `idempotencyKey`.
  - `Customer` — `idempotencyKey` field + partial unique index added.
  - `Payment` — new collection; the dedup anchor for `collect` (see below).

- **Bill offline metadata:** `source: "offline" | "online"` and
  `clientCreatedAt`. For offline bills the sale's real time (`clientCreatedAt`)
  is mirrored into `createdAt`, `date`, and `time` so sales reports reflect when
  the sale happened, not when it synced. The cashbook running-balance ledger is
  **not** backdated (that sequence must stay in real cash-drawer order).

## Per-endpoint notes

### `POST /bill`
Pre-check by `(business, idempotencyKey)` → `409` with the existing bill.
Create + stock decrement + customer ledger run in one transaction. A lost race
surfaces as a duplicate-key error (`11000`) → we re-read and return the winner.

### `POST /customer/:id/collect`
Each keyed collect writes one `Payment` record **inside the transaction**, so it
commits atomically with the per-bill payment allocations. The idempotency
pre-check runs **before** the "no outstanding bills" guard — on replay the dues
are already settled, and returning the stored `Payment` (`200`) prevents the
client from quarantining an already-applied payment. A lost race → `11000` →
return the existing `Payment`.

### `POST /customer`
Naturally deduped by the existing upsert on `(phone, business)`; the key is
persisted on insert only (`$setOnInsert`) and also checked up front, covering
the case where the phone was edited between the original create and a replay.
Returns the real `_id` so the client can map its temp id (`local-…`).

### `PATCH /customer/:id`
Applying the same field updates twice yields the same document, so no anchor is
needed. The key is accepted (so validation passes) but not stored — that would
overwrite the create-time key. Returns the updated customer.

## Deploying the new indexes

`autoIndex` is on, so Mongoose builds the new `Customer` / `Payment` indexes on
startup. To build them without waiting for a restart, or on a large collection:

```js
await Customer.syncIndexes();
await Payment.syncIndexes();
```

## Verify

```bash
# ⚠️ point at a TEST database, not production
MONGODB_URI="mongodb+srv://.../pos-test" node scripts/test-bill-idempotency.mjs
```

Sends each key twice and asserts exactly one record is created, the replay
returns the same id, an offline bill is dated by `clientCreatedAt`, and keyless
writes still create distinct records.
