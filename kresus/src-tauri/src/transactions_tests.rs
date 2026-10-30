use super::*;
use crate::accounts::create_account_in_db;
use crate::test_support::{account, database};

fn operation(id: &str, account_id: &str, amount: f64) -> NewTransaction {
    NewTransaction { id: id.into(), account_id: account_id.into(), date: "2027-01-15".into(), label: "Groceries".into(), category: "Food".into(), cheque: Some("0012345".into()), amount: (amount * 100.0).round() as i64, note: None }
}

#[test]
fn payee_suggestions_are_distinct_shared_across_accounts_and_exclude_transfers() {
    let mut db = database();
    let mut first = operation("payee-one", "ccp", -10.0); first.label = "  Boulangerie Test  ".into();
    let mut second = operation("payee-two", "sylvie", -5.0); second.label = "boulangerie test".into();
    let mut empty = operation("payee-empty", "ccp", -1.0); empty.label = "   ".into();
    create_transaction_in_db(&db, first).unwrap(); create_transaction_in_db(&db, second).unwrap(); create_transaction_in_db(&db, empty).unwrap();
    create_transfer_in_db(&mut db, transfer()).unwrap();
    let labels = list_payees_in_db(&db).unwrap();
    assert_eq!(labels.iter().filter(|label| label.eq_ignore_ascii_case("Boulangerie Test")).count(), 1);
    assert!(!labels.iter().any(|label| label.trim().is_empty() || label.starts_with("Virement vers ") || label.starts_with("Virement depuis ")));
    delete_transaction_in_db(&db, "payee-one").unwrap();
    assert!(list_payees_in_db(&db).unwrap().contains(&"boulangerie test".to_string()));
    delete_transaction_in_db(&db, "payee-two").unwrap();
    assert!(!list_payees_in_db(&db).unwrap().iter().any(|label| label.eq_ignore_ascii_case("Boulangerie Test")));
}

fn transfer() -> NewTransfer {
    NewTransfer { id: "transfer".into(), source_id: "ccp".into(), destination_id: "sylvie".into(), date: "2027-03-15".into(), amount: 12345, category: "Divers".into(), note: "Épargne familiale".into() }
}

#[test]
fn transfer_creates_linked_opposite_operations_and_can_be_deleted_from_either_account() {
    for delete_id in ["transfer-debit", "transfer-credit"] {
        let mut db = database();
        create_transfer_in_db(&mut db, transfer()).unwrap();
        let debit = list_transactions_in_db(&db, "ccp").unwrap().into_iter().find(|item| item.id == "transfer-debit").unwrap();
        let credit = list_transactions_in_db(&db, "sylvie").unwrap().into_iter().find(|item| item.id == "transfer-credit").unwrap();
        assert_eq!((debit.amount, credit.amount), (-12345, 12345));
        assert_eq!((debit.transfer_id.as_deref(), credit.transfer_id.as_deref()), (Some("transfer"), Some("transfer")));
        assert_eq!((debit.date.as_str(), credit.date.as_str()), ("2027-03-15", "2027-03-15"));
        assert_eq!(debit.note.as_deref(), Some("Épargne familiale"));
        assert!(!debit.reconciled && !credit.reconciled);
        assert!(update_transaction_in_db(&db, operation("transfer-debit", "ccp", 2.0)).is_err());
        toggle_transaction_in_db(&db, "transfer-debit").unwrap();
        let flags: (i64, i64) = db.query_row("SELECT (SELECT reconciled FROM transactions WHERE id='transfer-debit'), (SELECT reconciled FROM transactions WHERE id='transfer-credit')", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(flags, (1, 0));
        delete_transaction_in_db(&db, delete_id).unwrap();
        let remaining: i64 = db.query_row("SELECT COUNT(*) FROM transactions WHERE id IN ('transfer-debit','transfer-credit')", [], |r| r.get(0)).unwrap();
        let links: i64 = db.query_row("SELECT COUNT(*) FROM transfers WHERE id='transfer'", [], |r| r.get(0)).unwrap();
        assert_eq!((remaining, links), (0, 0));
    }
}

#[test]
fn invalid_or_failed_transfer_never_leaves_a_partial_operation() {
    let mut db = database();
    let mut same = transfer(); same.destination_id = same.source_id.clone();
    assert!(create_transfer_in_db(&mut db, same).is_err());
    let mut missing = transfer(); missing.destination_id = "missing".into();
    assert!(create_transfer_in_db(&mut db, missing).is_err());
    let mut bad_amount = transfer(); bad_amount.amount = 0;
    assert!(create_transfer_in_db(&mut db, bad_amount).is_err());
    let mut bad_date = transfer(); bad_date.date = "2027-02-29".into();
    assert!(create_transfer_in_db(&mut db, bad_date).is_err());
    db.execute_batch("CREATE TRIGGER reject_credit BEFORE INSERT ON transactions WHEN NEW.id = 'transfer-credit' BEGIN SELECT RAISE(ABORT, 'failure'); END;").unwrap();
    assert!(create_transfer_in_db(&mut db, transfer()).is_err());
    let count: i64 = db.query_row("SELECT COUNT(*) FROM transactions WHERE id LIKE 'transfer-%'", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 0);
}

#[test]
fn updating_transfer_changes_both_sides_and_preserves_reconciliation() {
    let mut db = database();
    create_transfer_in_db(&mut db, transfer()).unwrap();
    toggle_transaction_in_db(&db, "transfer-debit").unwrap();
    let loaded = get_transfer_in_db(&db, "transfer").unwrap();
    assert_eq!((loaded.source_id.as_str(), loaded.destination_id.as_str(), loaded.amount), ("ccp", "sylvie", 12345));
    let mut changed = loaded;
    changed.source_id = "sylvie".into(); changed.destination_id = "livret-michel".into();
    changed.date = "2028-02-29".into(); changed.amount = 7890; changed.category = "Alimentation".into(); changed.note = "Updated".into();
    update_transfer_in_db(&mut db, changed).unwrap();
    let debit = list_transactions_in_db(&db, "sylvie").unwrap().into_iter().find(|item| item.id == "transfer-debit").unwrap();
    let credit = list_transactions_in_db(&db, "livret-michel").unwrap().into_iter().find(|item| item.id == "transfer-credit").unwrap();
    assert_eq!((debit.amount, credit.amount), (-7890, 7890));
    assert_eq!((debit.date.as_str(), credit.date.as_str()), ("2028-02-29", "2028-02-29"));
    assert_eq!((debit.category.as_str(), credit.category.as_str()), ("Alimentation", "Alimentation"));
    assert_eq!((debit.note.as_deref(), credit.note.as_deref()), (Some("Updated"), Some("Updated")));
    assert!(debit.reconciled && !credit.reconciled);
    assert_eq!((debit.transfer_id.as_deref(), credit.transfer_id.as_deref()), (Some("transfer"), Some("transfer")));
    assert!(!list_transactions_in_db(&db, "ccp").unwrap().iter().any(|item| item.id == "transfer-debit"));
}

#[test]
fn failed_transfer_update_rolls_back_both_operations() {
    let mut db = database();
    create_transfer_in_db(&mut db, transfer()).unwrap();
    let mut invalid = transfer(); invalid.destination_id = invalid.source_id.clone();
    assert!(update_transfer_in_db(&mut db, invalid).is_err());
    let mut missing = transfer(); missing.destination_id = "missing".into();
    assert!(update_transfer_in_db(&mut db, missing).is_err());
    db.execute_batch("CREATE TRIGGER reject_transfer_credit BEFORE UPDATE ON transactions WHEN NEW.id = 'transfer-credit' BEGIN SELECT RAISE(ABORT, 'failure'); END;").unwrap();
    let mut changed = transfer(); changed.amount = 2000; changed.date = "2027-04-01".into();
    assert!(update_transfer_in_db(&mut db, changed).is_err());
    let saved = get_transfer_in_db(&db, "transfer").unwrap();
    assert_eq!((saved.amount, saved.date.as_str()), (12345, "2027-03-15"));
    let amounts: (i64, i64) = db.query_row("SELECT (SELECT amount_cents FROM transactions WHERE id='transfer-debit'), (SELECT amount_cents FROM transactions WHERE id='transfer-credit')", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(amounts, (-12345, 12345));
}

#[test]
fn operations_are_saved_as_cents_and_listed_by_account_and_date() {
    let db = database();
    create_account_in_db(&db, account("new-account", "Compte courant", 0.0)).unwrap();
    let mut later = operation("later", "new-account", 123.45); later.date = "2027-02-10".into();
    create_transaction_in_db(&db, later).unwrap();
    create_transaction_in_db(&db, operation("earlier", "new-account", -12.34)).unwrap();
    let rows = list_transactions_in_db(&db, "new-account").unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!((&rows[0].id, rows[0].amount, &rows[0].cheque, rows[0].reconciled), (&"earlier".to_string(), -1234, &Some("0012345".into()), false));
    assert_eq!((&rows[1].id, rows[1].amount), (&"later".to_string(), 12345));
    let cents: i64 = db.query_row("SELECT amount_cents FROM transactions WHERE id = 'earlier'", [], |row| row.get(0)).unwrap();
    assert_eq!(cents, -1234);
    assert!(create_transaction_in_db(&db, operation("no-account", "missing", 1.0)).is_err());
    assert!(create_transaction_in_db(&db, operation("earlier", "new-account", 1.0)).is_err());
    assert_eq!(list_transactions_in_db(&db, "new-account").unwrap().len(), 2);
}

#[test]
fn operation_edit_preserves_reconciliation_and_note_and_checks_account() {
    let db = database();
    create_transaction_in_db(&db, operation("edit-me", "ccp", -12.34)).unwrap();
    db.execute("UPDATE transactions SET note = 'Original note' WHERE id = 'edit-me'", []).unwrap();
    toggle_transaction_in_db(&db, "edit-me").unwrap();
    let mut wrong_account = operation("edit-me", "sylvie", 99.0); wrong_account.label = "Wrong".into();
    assert!(update_transaction_in_db(&db, wrong_account).is_err());
    let mut edit = operation("edit-me", "ccp", 99.95); edit.label = "Updated".into(); edit.cheque = None;
    update_transaction_in_db(&db, edit).unwrap();
    let saved: (String, i64, Option<String>, i64, String) = db.query_row("SELECT label, amount_cents, cheque, reconciled, note FROM transactions WHERE id = 'edit-me'", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).unwrap();
    assert_eq!(saved, ("Updated".into(), 9995, None, 1, "Original note".into()));
    toggle_transaction_in_db(&db, "edit-me").unwrap();
    let reconciled: i64 = db.query_row("SELECT reconciled FROM transactions WHERE id = 'edit-me'", [], |row| row.get(0)).unwrap();
    assert_eq!(reconciled, 0);
}

#[test]
fn operation_comments_are_saved_edited_cleared_and_survive_reopening() {
    let path = crate::test_support::temporary_database_path();
    {
        let db = Connection::open(&path.0).unwrap();
        crate::database::initialize_database(&db).unwrap();
        let mut entry = operation("comment-test", "ccp", -1.0);
        entry.note = Some("Première ligne\n<seconde ligne>".into());
        create_transaction_in_db(&db, entry).unwrap();
    }
    let db = Connection::open(&path.0).unwrap();
    crate::database::initialize_database(&db).unwrap();
    let stored = list_transactions_in_db(&db, "ccp").unwrap().into_iter().find(|item| item.id == "comment-test").unwrap();
    assert_eq!(stored.note.as_deref(), Some("Première ligne\n<seconde ligne>"));
    let mut edit = operation("comment-test", "ccp", -1.0);
    edit.note = Some("Commentaire modifié".into());
    update_transaction_in_db(&db, edit).unwrap();
    let stored = list_transactions_in_db(&db, "ccp").unwrap().into_iter().find(|item| item.id == "comment-test").unwrap();
    assert_eq!(stored.note.as_deref(), Some("Commentaire modifié"));
    let mut clear = operation("comment-test", "ccp", -1.0);
    clear.note = Some(String::new());
    update_transaction_in_db(&db, clear).unwrap();
    let stored = list_transactions_in_db(&db, "ccp").unwrap().into_iter().find(|item| item.id == "comment-test").unwrap();
    assert_eq!(stored.note, None);
}

#[test]
fn deleting_an_operation_keeps_other_operations() {
    let db = database();
    create_transaction_in_db(&db, operation("delete-me", "ccp", -10.0)).unwrap();
    create_transaction_in_db(&db, operation("keep-me", "ccp", 20.0)).unwrap();
    delete_transaction_in_db(&db, "delete-me").unwrap();
    let ids: Vec<String> = list_transactions_in_db(&db, "ccp").unwrap().into_iter().map(|entry| entry.id).collect();
    assert!(!ids.contains(&"delete-me".into()));
    assert!(ids.contains(&"keep-me".into()));
}

#[test]
fn api_amounts_are_integer_cents_and_reject_fractional_values() {
    let db = database();
    create_transaction_in_db(&db, operation("cent-test", "ccp", 0.29)).unwrap();
    let entry = list_transactions_in_db(&db, "ccp").unwrap().into_iter().find(|item| item.id == "cent-test").unwrap();
    assert_eq!(entry.amount, 29);
    let serialized = serde_json::to_value(entry).unwrap();
    assert_eq!(serialized["amount"], 29);
    let invalid = serde_json::json!({ "id": "x", "accountId": "ccp", "date": "2027-01-01", "label": "Test", "category": "Divers", "amount": 0.29 });
    assert!(serde_json::from_value::<NewTransaction>(invalid).is_err());
    let mut invalid = operation("zero", "ccp", 0.0);
    assert!(create_transaction_in_db(&db, invalid).is_err());
    invalid = operation("large", "ccp", 1_000_000_001.0);
    assert!(create_transaction_in_db(&db, invalid).is_err());
}

#[test]
fn register_pages_filter_after_calculating_balances_and_clamp_page() {
    let db = database();
    create_account_in_db(&db, account("paged", "Compte courant", 100.0)).unwrap();
    for i in 0..205 {
        let mut item = operation(&format!("row-{i:03}"), "paged", if i % 2 == 0 { 0.2 } else { -0.1 });
        item.date = "2027-01-01".into();
        create_transaction_in_db(&db, item).unwrap();
    }
    let first = list_register_in_db(&db, "paged", "all", 1, "2027-01", "").unwrap();
    assert_eq!((first.total_count, first.filtered_count, first.page_count, first.rows.len()), (205, 205, 3, 100));
    assert_eq!((&first.rows[0].transaction.id, first.rows[0].running_balance), (&"row-204".to_string(), 11040));
    assert_eq!((first.income, first.expenses, first.credit_count, first.debit_count, first.unreconciled_count), (2060, -1020, 103, 102, 205));
    let monthly = list_register_in_db(&db, "paged", "month-credit", 1, "2027-01", "").unwrap();
    assert_eq!((monthly.filtered_count, monthly.rows.len()), (103, 100));
    let other_month = list_register_in_db(&db, "paged", "month-debit", 1, "2027-02", "").unwrap();
    assert_eq!((other_month.filtered_count, other_month.rows.len()), (0, 0));
    let second = list_register_in_db(&db, "paged", "all", 2, "2027-01", "").unwrap();
    assert_eq!((&second.rows[0].transaction.id, second.rows[0].running_balance), (&"row-104".to_string(), 10540));
    let debit = list_register_in_db(&db, "paged", "debit", 99, "2027-02", "").unwrap();
    assert_eq!((debit.page, debit.page_count, debit.filtered_count, debit.rows.len()), (2, 2, 102, 2));
    assert_eq!((&debit.rows[1].transaction.id, debit.rows[1].running_balance), (&"row-001".to_string(), 10010));
    assert_eq!((debit.income, debit.expenses), (0, 0));
    assert!(list_register_in_db(&db, "paged", "invalid", 1, "2027-01", "").is_err());
    toggle_transaction_in_db(&db, "row-001").unwrap();
    let reconciled = list_register_in_db(&db, "paged", "reconciled", 1, "2027-01", "").unwrap();
    assert_eq!((reconciled.filtered_count, reconciled.unreconciled_count, reconciled.rows[0].running_balance), (1, 204, 10010));
    for i in 0..5 { delete_transaction_in_db(&db, &format!("row-{i:03}")).unwrap(); }
    let last = list_register_in_db(&db, "paged", "all", 3, "2027-01", "").unwrap();
    assert_eq!((last.page, last.page_count, last.total_count), (2, 2, 200));
}

#[test]
fn register_page_includes_linked_transfer_identity() {
    let mut db = database();
    create_transfer_in_db(&mut db, transfer()).unwrap();
    let page = list_register_in_db(&db, "sylvie", "credit", 1, "2027-03", "").unwrap();
    let item = page.rows.iter().find(|row| row.transaction.id == "transfer-credit").unwrap();
    assert_eq!(item.transaction.transfer_id.as_deref(), Some("transfer"));
}

#[test]
fn register_search_matches_text_across_history_and_combines_with_filters() {
    let db = database();
    create_account_in_db(&db, account("search", "Compte courant", 100.0)).unwrap();
    for i in 0..105 {
        let mut item = operation(&format!("search-{i:03}"), "search", -1.0);
        item.date = "2027-01-01".into();
        if i == 0 { item.label = "Électricité".into(); item.note = Some("Facture annuelle".into()); item.cheque = Some("1234567".into()); }
        create_transaction_in_db(&db, item).unwrap();
    }
    let result = list_register_in_db(&db, "search", "debit", 1, "2027-01", "  ÉLECTRICITÉ  ").unwrap();
    assert_eq!((result.total_count, result.filtered_count, result.rows[0].running_balance), (105, 1, 9900));
    assert_eq!(list_register_in_db(&db, "search", "credit", 1, "2027-01", "électricité").unwrap().filtered_count, 0);
    for query in ["annuelle", "1234567"] {
        assert_eq!(list_register_in_db(&db, "search", "all", 1, "2027-01", query).unwrap().filtered_count, 1);
    }
    assert_eq!(list_register_in_db(&db, "search", "all", 1, "2027-01", "%").unwrap().filtered_count, 0);
}
