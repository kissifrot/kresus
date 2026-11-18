use super::*;
use crate::test_support::{account, database};

#[test]
fn account_number_is_optional_text_and_can_be_changed_or_cleared() {
    let mut db = database();
    let mut new_account = account("numbered", "Compte courant", 10.0);
    new_account.account_number = Some("  00012 AB  ".into());
    create_account_in_db(&db, new_account).unwrap();
    let current = |db: &Connection| {
        list_accounts_in_db(db, "2027-01-01")
            .unwrap()
            .into_iter()
            .find(|account| account.id == "numbered")
            .unwrap()
    };
    let mut settings = AccountSettings {
        name: "Household".into(),
        bank: "Bank".into(),
        account_number: Some("00034".into()),
        archived: false,
    };
    assert_eq!(current(&db).account_number.as_deref(), Some("00012 AB"));
    update_account_in_db(&mut db, "numbered", &settings).unwrap();
    assert_eq!(current(&db).account_number.as_deref(), Some("00034"));
    settings.account_number = Some("   ".into());
    update_account_in_db(&mut db, "numbered", &settings).unwrap();
    assert_eq!(current(&db).account_number, None);
    assert_eq!(current(&db).opening_balance, 1000);
}

#[test]
fn edits_account_settings_and_archives_without_losing_history() {
    let mut db = database();
    db.execute_batch("INSERT INTO transactions (id, account_id, operation_date, label, category, amount_cents, reconciled)
                      VALUES ('kept','ccp','2027-01-01','Historique','Divers',-1234,1);").unwrap();
    let current = |db: &Connection| {
        list_accounts_in_db(db, "2027-01-01")
            .unwrap()
            .into_iter()
            .find(|account| account.id == "ccp")
            .unwrap()
    };
    let mut settings = AccountSettings {
        name: "  Compte renommé  ".into(),
        bank: "  Nouvelle banque  ".into(),
        account_number: None,
        archived: true,
    };
    update_account_in_db(&mut db, "ccp", &settings).unwrap();
    let saved = current(&db);
    assert!(saved.archived);
    assert_eq!(saved.name, "Compte renommé");
    assert_eq!(saved.bank, "Nouvelle banque");
    assert_eq!(saved.current_balance, -1234);
    let rows = crate::transactions::list_transactions_in_db(&db, "ccp").unwrap();
    assert_eq!(rows[0].label, "Historique");
    assert!(rows[0].reconciled);

    settings.bank = "😀".repeat(101);
    settings.archived = false;
    assert!(update_account_in_db(&mut db, "ccp", &settings).is_err());
    assert!(current(&db).archived);
    assert_eq!(current(&db).bank, "Nouvelle banque");

    settings.bank.clear();
    update_account_in_db(&mut db, "ccp", &settings).unwrap();
    assert!(!current(&db).archived);
    assert!(current(&db).bank.is_empty());
    assert!(update_account_in_db(&mut db, "missing", &settings).is_err());
}

#[test]
fn account_names_and_banks_obey_the_html_length_limit() {
    let db = database();
    let mut valid = account("length-ok", "Épargne", 0.0);
    valid.name = "é".repeat(200);
    valid.bank = "😀".repeat(100);
    create_account_in_db(&db, valid).unwrap();
    let mut invalid = account("length-bad", "Épargne", 0.0);
    invalid.bank = "😀".repeat(101);
    assert!(create_account_in_db(&db, invalid).is_err());
}

#[test]
fn current_balances_include_all_operations_for_each_account() {
    let db = database();
    create_account_in_db(&db, account("with-operations", "Compte courant", 100.0)).unwrap();
    create_account_in_db(&db, account("empty", "Épargne", -12.5)).unwrap();
    db.execute("INSERT INTO transactions (id, account_id, operation_date, label, category, amount_cents, reconciled) VALUES ('one', 'with-operations', '2027-01-01', 'Credit', 'Other', 5025, 1), ('two', 'with-operations', '2027-01-02', 'Debit', 'Other', -7550, 0)", []).unwrap();
    let accounts = list_accounts_in_db(&db, "2027-01-01").unwrap();
    let populated = accounts
        .iter()
        .find(|item| item.id == "with-operations")
        .unwrap();
    let empty = accounts.iter().find(|item| item.id == "empty").unwrap();
    assert_eq!(populated.opening_balance, 10000);
    assert_eq!(populated.current_balance, 15025);
    assert_eq!(populated.balance_with_future, 7475);
    assert_eq!(empty.current_balance, -1250);
}

#[test]
fn creates_all_account_types_with_trimmed_names_and_balances_in_cents() {
    let db = database();
    for (id, kind, balance, cents) in [
        ("checking", "Compte courant", -123.45, -12345),
        ("savings", "Épargne", 42.75, 4275),
        ("life", "Assurance vie", 0.0, 0),
    ] {
        create_account_in_db(&db, account(id, kind, balance)).unwrap();
        let saved: (String, String, String, i64) = db
            .query_row(
                "SELECT name, kind, bank, opening_balance_cents FROM accounts WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            saved,
            ("Household".into(), kind.into(), "Bank".into(), cents)
        );
    }
}

#[test]
fn invalid_account_data_and_duplicate_id_are_rejected() {
    let db = database();
    let mut blank = account("blank", "Compte courant", 0.0);
    blank.name = "  ".into();
    assert!(create_account_in_db(&db, blank).is_err());
    assert!(create_account_in_db(&db, account("bad-kind", "Other", 0.0)).is_err());

    assert!(create_account_in_db(&db, account("too-large", "Épargne", 1_000_000_001.0)).is_err());
    assert!(create_account_in_db(&db, account("ccp", "Compte courant", 0.0)).is_err());
    let count: i64 = db.query_row("SELECT COUNT(*) FROM accounts WHERE id IN ('blank','bad-kind','bad-amount','too-large')", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 0);
}
