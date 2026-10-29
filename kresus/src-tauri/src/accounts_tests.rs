use super::*;
use crate::test_support::{account, database};

#[test]
fn current_balances_include_all_operations_for_each_account() {
    let db = database();
    create_account_in_db(&db, account("with-operations", "Compte courant", 100.0)).unwrap();
    create_account_in_db(&db, account("empty", "Épargne", -12.5)).unwrap();
    db.execute("INSERT INTO transactions (id, account_id, operation_date, label, category, amount_cents, reconciled) VALUES ('one', 'with-operations', '2027-01-01', 'Credit', 'Other', 5025, 1), ('two', 'with-operations', '2027-01-02', 'Debit', 'Other', -7550, 0)", []).unwrap();
    let accounts = list_accounts_in_db(&db).unwrap();
    let populated = accounts.iter().find(|item| item.id == "with-operations").unwrap();
    let empty = accounts.iter().find(|item| item.id == "empty").unwrap();
    assert_eq!(populated.opening_balance, 10000);
    assert_eq!(populated.current_balance, 7475);
    assert_eq!(empty.current_balance, -1250);
}

#[test]
fn creates_all_account_types_with_trimmed_names_and_balances_in_cents() {
    let db = database();
    for (id, kind, balance, cents) in [("checking", "Compte courant", -123.45, -12345), ("savings", "Épargne", 42.75, 4275), ("life", "Assurance vie", 0.0, 0)] {
        create_account_in_db(&db, account(id, kind, balance)).unwrap();
        let saved: (String, String, String, i64) = db.query_row("SELECT name, kind, bank, opening_balance_cents FROM accounts WHERE id = ?1", [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).unwrap();
        assert_eq!(saved, ("Household".into(), kind.into(), "Bank".into(), cents));
    }
}

#[test]
fn invalid_account_data_and_duplicate_id_are_rejected() {
    let db = database();
    let mut blank = account("blank", "Compte courant", 0.0); blank.name = "  ".into();
    assert!(create_account_in_db(&db, blank).is_err());
    assert!(create_account_in_db(&db, account("bad-kind", "Other", 0.0)).is_err());

    assert!(create_account_in_db(&db, account("too-large", "Épargne", 1_000_000_001.0)).is_err());
    assert!(create_account_in_db(&db, account("ccp", "Compte courant", 0.0)).is_err());
    let count: i64 = db.query_row("SELECT COUNT(*) FROM accounts WHERE id IN ('blank','bad-kind','bad-amount','too-large')", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 0);
}
