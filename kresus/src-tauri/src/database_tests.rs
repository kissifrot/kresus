use super::{backup_to_path, initialize_database, restore_from_path};
use crate::test_support::{initialize_test_accounts, temporary_database_path};
use rusqlite::Connection;

#[test]
fn new_database_starts_empty_and_an_empty_backup_can_be_opened() {
    let path = temporary_database_path();
    let backup = temporary_database_path();
    let db = Connection::open(&path.0).unwrap();
    initialize_database(&db).unwrap();
    backup_to_path(&db, &backup.0).unwrap();
    drop(db);

    for path in [&path.0, &backup.0] {
        let db = super::open_existing_database(path).unwrap();
        initialize_database(&db).unwrap();
        for table in ["accounts", "transactions", "schedules"] {
            let count: i64 = db
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0);
        }
    }
}

#[test]
fn missing_startup_database_falls_back_to_the_default_and_can_be_retried() {
    let default_path = temporary_database_path();
    let imported_path = temporary_database_path();
    super::remember_startup_database(&default_path.0, &imported_path.0).unwrap();

    let (db, warning) = super::open_startup_database(&default_path.0).unwrap();
    assert!(super::is_default_database(&db, &default_path.0));
    assert!(
        warning
            .unwrap()
            .contains(&*imported_path.0.to_string_lossy())
    );
    assert!(!imported_path.0.exists());
    drop(db);

    let db = Connection::open(&imported_path.0).unwrap();
    initialize_test_accounts(&db);
    drop(db);
    let (db, warning) = super::open_startup_database(&default_path.0).unwrap();
    assert_eq!(
        db.path().map(std::path::Path::new),
        Some(imported_path.0.as_path())
    );
    assert!(warning.is_none());
    super::forget_startup_database(&default_path.0).unwrap();
    std::fs::remove_file(super::config_path(&default_path.0)).unwrap();
}

#[test]
fn startup_choice_is_migrated_to_config_json() {
    let default_path = temporary_database_path();
    let imported_path = temporary_database_path();
    let db = Connection::open(&imported_path.0).unwrap();
    initialize_test_accounts(&db);
    drop(db);
    let legacy = default_path.0.with_file_name("base-demarrage.json");
    std::fs::write(&legacy, serde_json::to_vec(&imported_path.0).unwrap()).unwrap();

    let (db, warning) = super::open_startup_database(&default_path.0).unwrap();
    assert!(warning.is_none());
    assert_eq!(
        db.path().map(std::path::Path::new),
        Some(imported_path.0.as_path())
    );
    let config_path = super::config_path(&default_path.0);
    let config = crate::config::Config::load(&config_path).unwrap();
    assert_eq!(config.startup_database.as_ref(), Some(&imported_path.0));
    assert!(!legacy.exists());
    std::fs::remove_file(config_path).unwrap();
}

#[test]
fn saving_and_resetting_the_startup_choice_preserves_other_settings() {
    let default_path = temporary_database_path();
    let imported_path = temporary_database_path();
    let config_path = super::config_path(&default_path.0);
    let settings = serde_json::json!({"appearance": {"theme": "dark"}});
    std::fs::write(&config_path, serde_json::to_vec(&settings).unwrap()).unwrap();
    let read = || -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap()
    };

    super::remember_startup_database(&default_path.0, &imported_path.0).unwrap();
    let saved = read();
    assert_eq!(
        saved["startupDatabase"],
        serde_json::to_value(&imported_path.0).unwrap()
    );
    assert_eq!(saved["appearance"], settings["appearance"]);
    super::forget_startup_database(&default_path.0).unwrap();
    assert_eq!(read(), settings);
    std::fs::remove_file(config_path).unwrap();
}

#[test]
fn transaction_comments_are_hidden_by_default_and_the_preference_preserves_the_startup_choice() {
    let default_path = temporary_database_path();
    let imported_path = temporary_database_path();
    let config_path = super::config_path(&default_path.0);
    let load = || crate::config::Config::load(&config_path).unwrap();
    super::remember_startup_database(&default_path.0, &imported_path.0).unwrap();
    assert!(!load().show_transaction_comments);

    for show in [true, false] {
        super::save_show_transaction_comments(&default_path.0, show).unwrap();
        let config = load();
        assert_eq!(config.show_transaction_comments, show);
        assert_eq!(config.startup_database.as_ref(), Some(&imported_path.0));
    }
    std::fs::remove_file(config_path).unwrap();
}

#[test]
#[ignore = "manual performance reference; run with --ignored --nocapture"]
fn performance_reference_10000_operations() {
    performance_reference(10_000, 3652);
}

#[test]
#[ignore = "manual extreme performance reference; run with --ignored --nocapture"]
fn performance_reference_60000_operations() {
    performance_reference(60_000, 7305);
}

fn performance_reference(count: usize, days: usize) {
    use crate::accounts::list_accounts_in_db;
    use crate::transactions::{list_payees_in_db, list_register_in_db, list_transactions_in_db};
    use rusqlite::params;
    use std::time::Instant;

    let path = temporary_database_path();
    let mut db = Connection::open(&path.0).unwrap();
    initialize_database(&db).unwrap();
    db.execute(
        "INSERT INTO accounts (id,name,kind,opening_balance_cents,bank) VALUES ('benchmark', 'Test', 'Compte courant', 10000, '')",
        [],
    )
    .unwrap();
    let start = Instant::now();
    {
        let tx = db.transaction().unwrap();
        {
            let mut insert = tx.prepare("INSERT INTO transactions (id, account_id, operation_date, label, category, amount_cents, reconciled) VALUES (?1, 'benchmark', date('2017-01-01', ?2), ?3, 'Divers', ?4, ?5)").unwrap();
            for i in 0..count {
                insert
                    .execute(params![
                        format!("perf-{i:05}"),
                        format!("+{} days", i * days / count),
                        format!("Destinataire {}", i % 100),
                        if i % 2 == 0 { -500 } else { 1000 },
                        (i % 2) as i64
                    ])
                    .unwrap();
            }
        }
        tx.commit().unwrap();
    }
    println!(
        "Insertion de {count} opérations en une transaction : {:.1} ms",
        start.elapsed().as_secs_f64() * 1000.0
    );
    let start = Instant::now();
    let accounts = list_accounts_in_db(&db, "2026-12-31").unwrap();
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
        10_000 + (count as i64 / 2 * 500)
    );
    let start = Instant::now();
    let entries = list_transactions_in_db(&db, "benchmark").unwrap();
    println!(
        "Lecture de {count} opérations : {:.1} ms",
        start.elapsed().as_secs_f64() * 1000.0
    );
    assert_eq!(entries.len(), count);
    let start = Instant::now();
    let json = serde_json::to_vec(&entries).unwrap();
    println!(
        "Sérialisation JSON : {:.1} ms ({} octets)",
        start.elapsed().as_secs_f64() * 1000.0,
        json.len()
    );
    let start = Instant::now();
    let page = list_register_in_db(
        &db,
        "benchmark",
        "all",
        1,
        "2026-01",
        "",
        Default::default(),
    )
    .unwrap();
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
    initialize_test_accounts(&primary);
    primary
        .execute(
            "UPDATE accounts SET name = 'Base principale' WHERE id='ccp'",
            [],
        )
        .unwrap();
    let other = Connection::open(&second.0).unwrap();
    initialize_test_accounts(&other);
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
        startup_warning: Mutex::new(None),
        money_preview: Mutex::new(None),
        bank_preview: Mutex::new(None),
    };
    switch_database(&state, &second.0, false).unwrap();
    let name: String = state
        .database
        .lock()
        .unwrap()
        .query_row("SELECT name FROM accounts WHERE id='ccp'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(name, "Base de test");
    assert!(switch_database(&state, &invalid.0, false).is_err());
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
    switch_database(&state, &first.0, false).unwrap();
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
    initialize_test_accounts(&db);
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
    initialize_test_accounts(&current);
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
fn file_extension_rejects_other_sqlite_documents() {
    use super::validate_kresus_extension;
    use std::path::Path;
    assert!(validate_kresus_extension(Path::new("famille.kresus")).is_ok());
    assert!(validate_kresus_extension(Path::new("famille.KRESUS")).is_ok());
    assert!(validate_kresus_extension(Path::new("autre.sqlite3")).is_err());
    assert!(validate_kresus_extension(Path::new("sans-extension")).is_err());
}

#[test]
fn text_primary_keys_are_required() {
    let db = Connection::open_in_memory().unwrap();
    initialize_database(&db).unwrap();
    let missing: i64 = db.query_row(
        "SELECT COUNT(*) FROM sqlite_schema AS schema JOIN pragma_table_info(schema.name) AS field
         WHERE schema.type='table' AND field.pk>0 AND field.type='TEXT' AND field.\"notnull\"=0",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(missing, 0);
    assert!(db.execute("INSERT INTO accounts(id,name,kind,opening_balance_cents,bank) VALUES (NULL,'Test','Compte courant',0,'')", []).is_err());
}

#[test]
fn older_schema_is_rejected_without_changing_either_file() {
    let path = temporary_database_path();
    let old = Connection::open(&path.0).unwrap();
    initialize_database(&old).unwrap();
    old.execute_batch("PRAGMA user_version=1").unwrap();
    let bytes = std::fs::read(&path.0).unwrap();
    assert!(
        initialize_database(&old)
            .unwrap_err()
            .contains("schéma Kresus incompatible")
    );
    drop(old);
    assert!(super::open_existing_database(&path.0).is_err());
    let mut current = Connection::open_in_memory().unwrap();
    initialize_test_accounts(&current);
    assert!(restore_from_path(&mut current, &path.0).is_err());
    assert_eq!(std::fs::read(&path.0).unwrap(), bytes);
    let count: i64 = current
        .query_row("SELECT count(*) FROM accounts", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 3);
}
