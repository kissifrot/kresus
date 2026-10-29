CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  opening_balance_cents INTEGER NOT NULL,
  bank TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operation_date TEXT NOT NULL,
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  cheque TEXT,
  amount_cents INTEGER NOT NULL,
  reconciled INTEGER NOT NULL DEFAULT 0 CHECK(reconciled IN (0, 1)),
  note TEXT
);
CREATE INDEX IF NOT EXISTS transactions_by_account_date
  ON transactions(account_id, operation_date, id);
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  debit_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  credit_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  CHECK(debit_id <> credit_id)
);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  next_due TEXT NOT NULL,
  frequency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('debit', 'credit'))
);
CREATE TABLE IF NOT EXISTS schedule_overrides (
  schedule_id TEXT PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  label TEXT NOT NULL, category TEXT NOT NULL, due_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('debit', 'credit'))
);
CREATE TABLE IF NOT EXISTS schedule_anchors (
  schedule_id TEXT PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
  anchor_day INTEGER NOT NULL CHECK(anchor_day BETWEEN 1 AND 31)
);
CREATE TABLE IF NOT EXISTS schedule_transfers (
  schedule_id TEXT PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
  destination_account_id TEXT NOT NULL REFERENCES accounts(id)
);
CREATE TABLE IF NOT EXISTS schedule_transfer_overrides (
  schedule_id TEXT PRIMARY KEY REFERENCES schedule_overrides(schedule_id) ON DELETE CASCADE,
  destination_account_id TEXT NOT NULL REFERENCES accounts(id)
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES categories(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS categories_unique_name ON categories(COALESCE(parent_id, ''), name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);

