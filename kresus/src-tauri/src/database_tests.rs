use super::{backup_to_path, initialize_database, restore_from_path};
use crate::test_support::temporary_database_path;
use rusqlite::Connection;

#[test]
fn new_database_seeds_once_and_deleted_examples_stay_deleted_after_reopening() {
    let path = temporary_database_path();
    {
        let db = Connection::open(&path.0).unwrap();
        initialize_database(&db).unwrap();
        for (table, id) in [
            ("accounts", "sylvie"),
            ("transactions", "t1"),
            ("schedules", "schedule-loyer"),
        ] {
            let count: i64 = db
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE id = ?1"),
                    [id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1);
            db.execute(&format!("DELETE FROM {table} WHERE id = ?1"), [id])
                .unwrap();
        }
    }
    let db = Connection::open(&path.0).unwrap();
    initialize_database(&db).unwrap();
    for (table, id) in [
        ("accounts", "sylvie"),
        ("transactions", "t1"),
        ("schedules", "schedule-loyer"),
    ] {
        let count: i64 = db
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE id = ?1"),
                [id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
    let other: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM transactions WHERE id = 't2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(other, 1);
}

#[test]
fn existing_database_without_demo_data_is_not_seeded() {
    let db = Connection::open_in_memory().unwrap();
    // Model a legacy installation, including a user account with no demo IDs.
    db.execute_batch("CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, opening_balance_cents INTEGER NOT NULL, bank TEXT NOT NULL); INSERT INTO accounts VALUES ('custom', 'Personnel', 'Compte courant', 100, '');").unwrap();
    initialize_database(&db).unwrap();
    let accounts: Vec<String> = db
        .prepare("SELECT id FROM accounts")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(accounts, vec!["custom"]);
    let count: i64 = db
        .query_row(
            "SELECT (SELECT COUNT(*) FROM transactions) + (SELECT COUNT(*) FROM schedules)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
#[ignore = "manual performance reference; run with --ignored --nocapture"]
fn performance_reference_10000_operations() {
    use crate::accounts::list_accounts_in_db;
    use crate::transactions::{list_payees_in_db, list_register_in_db, list_transactions_in_db};
    use rusqlite::params;
    use std::time::Instant;

    let path = temporary_database_path();
    let mut db = Connection::open(&path.0).unwrap();
    initialize_database(&db).unwrap();
    db.execute(
        "INSERT INTO accounts VALUES ('benchmark', 'Test', 'Compte courant', 10000, '')",
        [],
    )
    .unwrap();
    let start = Instant::now();
    {
        let tx = db.transaction().unwrap();
        {
            let mut insert = tx.prepare("INSERT INTO transactions (id, account_id, operation_date, label, category, amount_cents, reconciled) VALUES (?1, 'benchmark', date('2017-01-01', ?2), ?3, 'Divers', ?4, ?5)").unwrap();
            for i in 0..10_000 {
                insert
                    .execute(params![
                        format!("perf-{i:05}"),
                        format!("+{} days", i * 3652 / 10_000),
                        format!("Destinataire {}", i % 100),
                        if i % 2 == 0 { -500 } else { 1000 },
                        i % 2
                    ])
                    .unwrap();
            }
        }
        tx.commit().unwrap();
    }
    println!(
        "Insertion de 10 000 opérations en une transaction : {:.1} ms",
        start.elapsed().as_secs_f64() * 1000.0
    );
    let start = Instant::now();
    let accounts = list_accounts_in_db(&db).unwrap();
    println!(
        "Soldes des comptes : {:.1} ms",
        start.elapsed().as_secs_f64() * 1000.0
    );
    assert_eq!(
        accounts
            .iter()
            .find(|a| a.id == "benchmark")
            .unwrap()
            .current_balance,
        2_510_000
    );
    let start = Instant::now();
    let entries = list_transactions_in_db(&db, "benchmark").unwrap();
    println!(
        "Lecture de 10 000 opérations : {:.1} ms",
        start.elapsed().as_secs_f64() * 1000.0
    );
    assert_eq!(entries.len(), 10_000);
    let start = Instant::now();
    let json = serde_json::to_vec(&entries).unwrap();
    println!(
        "Sérialisation JSON : {:.1} ms ({} octets)",
        start.elapsed().as_secs_f64() * 1000.0,
        json.len()
    );
    let start = Instant::now();
    let page = list_register_in_db(&db, "benchmark", "all", 1, "2026-01", "").unwrap();
    println!(
        "Lecture paginée avec totaux : {:.1} ms",
        start.elapsed().as_secs_f64() * 1000.0
    );
    let start = Instant::now();
    let page_json = serde_json::to_vec(&page).unwrap();
    println!(
        "Sérialisation de la page : {:.1} ms ({} octets)",
        start.elapsed().as_secs_f64() * 1000.0,
        page_json.len()
    );
    assert_eq!(
        serde_json::to_value(page).unwrap()["rows"]
            .as_array()
            .unwrap()
            .len(),
        100
    );
    let start = Instant::now();
    let payees = list_payees_in_db(&db).unwrap();
    println!(
        "Suggestions de destinataires : {:.1} ms ({} résultats)",
        start.elapsed().as_secs_f64() * 1000.0,
        payees.len()
    );
}

#[test]
fn switching_databases_preserves_each_file_and_rejects_invalid_candidates() {
    use super::{AppState, switch_database};
    use std::sync::Mutex;
    let first = temporary_database_path();
    let second = temporary_database_path();
    let invalid = temporary_database_path();
    let primary = Connection::open(&first.0).unwrap();
    initialize_database(&primary).unwrap();
    primary
        .execute(
            "UPDATE accounts SET name = 'Base principale' WHERE id='ccp'",
            [],
        )
        .unwrap();
    let other = Connection::open(&second.0).unwrap();
    initialize_database(&other).unwrap();
    other
        .execute(
            "UPDATE accounts SET name = 'Base de test' WHERE id='ccp'",
            [],
        )
        .unwrap();
    drop(other);
    let bad = Connection::open(&invalid.0).unwrap();
    bad.execute("CREATE TABLE unrelated (value TEXT)", [])
        .unwrap();
    drop(bad);
    let before = std::fs::read(&invalid.0).unwrap();
    let state = AppState {
        database: Mutex::new(primary),
        default_path: first.0.clone(),
        money_preview: Mutex::new(None),
    };
    switch_database(&state, &second.0).unwrap();
    let name: String = state
        .database
        .lock()
        .unwrap()
        .query_row("SELECT name FROM accounts WHERE id='ccp'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(name, "Base de test");
    assert!(switch_database(&state, &invalid.0).is_err());
    assert_eq!(std::fs::read(&invalid.0).unwrap(), before);
    let name: String = state
        .database
        .lock()
        .unwrap()
        .query_row("SELECT name FROM accounts WHERE id='ccp'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(name, "Base de test");
    switch_database(&state, &first.0).unwrap();
    let name: String = state
        .database
        .lock()
        .unwrap()
        .query_row("SELECT name FROM accounts WHERE id='ccp'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(name, "Base principale");
}

#[test]
fn backup_includes_wal_and_restore_preserves_backup_and_existing_files() {
    let active = temporary_database_path();
    let saved = temporary_database_path();
    let mut db = Connection::open(&active.0).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    initialize_database(&db).unwrap();
    db.execute(
        "UPDATE accounts SET name='Avant sauvegarde' WHERE id='ccp'",
        [],
    )
    .unwrap();
    backup_to_path(&db, &saved.0).unwrap();
    db.execute(
        "UPDATE accounts SET name='Après sauvegarde' WHERE id='ccp'",
        [],
    )
    .unwrap();
    assert!(backup_to_path(&db, &saved.0).is_err());
    restore_from_path(&mut db, &saved.0).unwrap();
    let name: String = db
        .query_row("SELECT name FROM accounts WHERE id='ccp'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(name, "Avant sauvegarde");
    assert!(restore_from_path(&mut db, &active.0).is_err());
    let backup =
        Connection::open_with_flags(&saved.0, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        backup
            .query_row("SELECT name FROM accounts WHERE id='ccp'", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "Avant sauvegarde"
    );
}

#[test]
fn restore_rejects_incompatible_database_without_touching_current_data() {
    let invalid = temporary_database_path();
    let source = Connection::open(&invalid.0).unwrap();
    source
        .execute_batch("CREATE TABLE other (id INTEGER);")
        .unwrap();
    let mut current = Connection::open_in_memory().unwrap();
    initialize_database(&current).unwrap();
    current
        .execute(
            "UPDATE accounts SET name='Données conservées' WHERE id='ccp'",
            [],
        )
        .unwrap();
    assert!(restore_from_path(&mut current, &invalid.0).is_err());
    assert_eq!(
        current
            .query_row("SELECT name FROM accounts WHERE id='ccp'", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "Données conservées"
    );
}

#[test]
fn legacy_schedules_are_migrated_without_losing_data() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("schema.sql")).unwrap();
    db.execute_batch(include_str!("schedule_future_schema.sql"))
        .unwrap();
    db.execute("INSERT INTO accounts (id,name,kind,opening_balance_cents,bank) VALUES ('old','Ancien','Compte courant',0,'')", []).unwrap();
    db.execute("INSERT INTO schedules (id,account_id,label,category,next_due,frequency,amount_cents,kind) VALUES ('old-schedule','old','Loyer','Logement','2028-01-01','Mensuelle',-100,'debit')", []).unwrap();
    initialize_database(&db).unwrap();
    initialize_database(&db).unwrap();
    let (label, method, cheque): (String, Option<String>, Option<String>) = db
        .query_row(
            "SELECT label,payment_method,cheque FROM schedules WHERE id='old-schedule'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(label, "Loyer");
    assert_eq!((method, cheque), (None, None));
}
