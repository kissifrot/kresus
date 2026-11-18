PRAGMA user_version = 2;

CREATE TABLE accounts (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  opening_balance_cents INTEGER NOT NULL,
  bank TEXT NOT NULL,
  account_number TEXT
);
CREATE TABLE transactions (
  entry_order INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operation_date TEXT NOT NULL,
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  cheque TEXT,
  amount_cents INTEGER NOT NULL,
  reconciled INTEGER NOT NULL DEFAULT 0 CHECK(reconciled IN (0, 1)),
  note TEXT,
  reference TEXT
);
CREATE INDEX transactions_by_account_date
  ON transactions(account_id, operation_date, entry_order);
CREATE TABLE transfers (
  id TEXT NOT NULL PRIMARY KEY,
  debit_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  credit_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  CHECK(debit_id <> credit_id)
);
CREATE TABLE schedules (
  id TEXT NOT NULL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  next_due TEXT NOT NULL,
  frequency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('debit', 'credit')),
  payment_method TEXT,
  cheque TEXT,
  note TEXT
);
CREATE TABLE schedule_estimates (
  schedule_id TEXT NOT NULL PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE
);
CREATE TABLE schedule_overrides (
  schedule_id TEXT NOT NULL PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  label TEXT NOT NULL, category TEXT NOT NULL, due_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('debit', 'credit')),
  payment_method TEXT,
  cheque TEXT,
  note TEXT
);
CREATE TABLE schedule_anchors (
  schedule_id TEXT NOT NULL PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
  anchor_day INTEGER NOT NULL CHECK(anchor_day BETWEEN 1 AND 31)
);
CREATE TABLE schedule_transfers (
  schedule_id TEXT NOT NULL PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
  destination_account_id TEXT NOT NULL REFERENCES accounts(id)
);
CREATE TABLE schedule_transfer_overrides (
  schedule_id TEXT NOT NULL PRIMARY KEY REFERENCES schedule_overrides(schedule_id) ON DELETE CASCADE,
  destination_account_id TEXT NOT NULL REFERENCES accounts(id)
);
CREATE TABLE categories (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES categories(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX categories_unique_name ON categories(COALESCE(parent_id, ''), name COLLATE NOCASE);

-- Optional series limits; remaining_count includes the next pending occurrence.
CREATE TABLE schedule_limits (
    schedule_id TEXT NOT NULL PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
    remaining_count INTEGER CHECK (remaining_count > 0),
    end_date TEXT,
    CHECK (remaining_count IS NULL OR end_date IS NULL)
);

-- Exceptions are keyed by the original series date, not the edited date.
CREATE TABLE schedule_future_overrides (
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  original_due TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  due_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('debit', 'credit')),
  destination_account_id TEXT REFERENCES accounts(id),
  payment_method TEXT,
  cheque TEXT,
  note TEXT,
  PRIMARY KEY(schedule_id, original_due)
);
