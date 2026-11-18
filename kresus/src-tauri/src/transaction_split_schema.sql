CREATE TABLE IF NOT EXISTS transaction_splits (
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    category TEXT NOT NULL CHECK (length(trim(category)) > 0),
    amount_cents INTEGER NOT NULL,
    note TEXT,
    PRIMARY KEY (transaction_id, position)
) WITHOUT ROWID;
