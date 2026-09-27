-- Persistent ledger of every payment decision.
--
-- Monetary amounts are stored as exact decimal strings of bigint base units
-- (never floating point). A CHECK constraint guarantees digit-only strings.
-- SQLite INTEGER is limited to 64 bits; decimal strings preserve arbitrary
-- precision and are parsed back to bigint for comparisons.

CREATE TABLE IF NOT EXISTS payment_decisions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp         TEXT    NOT NULL,
  seller            TEXT    NOT NULL,
  endpoint          TEXT    NOT NULL,
  decision          TEXT    NOT NULL CHECK (decision IN ('ACCEPTED', 'REFUSED')),
  reason            TEXT    NOT NULL,
  amount_base_units TEXT    CHECK (amount_base_units IS NULL OR (
                        amount_base_units GLOB '[0-9]*' AND
                        amount_base_units NOT GLOB '*[^0-9]*')),
  asset             TEXT,
  network           TEXT,
  payment_required  INTEGER NOT NULL CHECK (payment_required IN (0, 1)),
  payment_signed    INTEGER NOT NULL DEFAULT 0 CHECK (payment_signed IN (0, 1)),
  payment_submitted INTEGER NOT NULL DEFAULT 0 CHECK (payment_submitted IN (0, 1)),
  transaction_hash  TEXT,
  run_id            TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_decisions_run_id ON payment_decisions(run_id);
CREATE INDEX IF NOT EXISTS idx_payment_decisions_decision ON payment_decisions(decision);
