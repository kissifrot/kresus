CREATE TABLE IF NOT EXISTS bank_statement_entries (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    bank_id TEXT NOT NULL,
    bank_account TEXT NOT NULL,
    fit_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
    bank_date TEXT,
    PRIMARY KEY (account_id, bank_id, bank_account, fit_id)
) WITHOUT ROWID;

-- A transfer side moved to another account no longer represents the original statement entry.
CREATE TRIGGER IF NOT EXISTS bank_statement_detach_moved_transaction
AFTER UPDATE OF account_id ON transactions
WHEN OLD.account_id <> NEW.account_id
BEGIN
    DELETE FROM bank_statement_entries WHERE transaction_id = OLD.id;
END;
