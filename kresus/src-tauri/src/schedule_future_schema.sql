-- Exceptions are keyed by the original series date, not the edited date.
CREATE TABLE IF NOT EXISTS schedule_future_overrides (
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  original_due TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  due_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('debit', 'credit')),
  destination_account_id TEXT REFERENCES accounts(id),
  PRIMARY KEY(schedule_id, original_due)
);
