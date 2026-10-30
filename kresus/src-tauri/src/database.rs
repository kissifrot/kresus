use rusqlite::{
    Connection,
    backup::{Backup, StepResult},
    params,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri_plugin_dialog::DialogExt;

#[cfg(test)]
#[path = "database_tests.rs"]
mod tests;

// Serialize access to the shared SQLite connection across Tauri commands.
pub(crate) struct AppState {
    pub(crate) database: Mutex<Connection>,
    pub(crate) default_path: PathBuf,
    pub(crate) money_preview: Mutex<Option<crate::money_import::MoneyPreview>>,
}

// Validate the file read-only before opening it for normal application use.
fn open_existing_database(path: &Path) -> Result<Connection, String> {
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Impossible d’ouvrir le fichier : {e}"))?;
    validate_database(&db)?;
    drop(db);
    let writable = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| format!("La base ne peut pas être ouverte en écriture : {e}"))?;
    writable.execute_batch("PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS schedule_limits (schedule_id TEXT PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE, remaining_count INTEGER CHECK (remaining_count > 0), end_date TEXT, CHECK (remaining_count IS NULL OR end_date IS NULL));").map_err(database_error)?;
    Ok(writable)
}

// Validate without modifying the file selected for restoration.
fn validate_database(db: &Connection) -> Result<(), String> {
    let check: String = db
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(database_error)?;
    if check != "ok" {
        return Err("La base SQLite est endommagée.".into());
    }
    for query in [
        "SELECT id,name,kind,opening_balance_cents,bank FROM accounts LIMIT 0",
        "SELECT id,account_id,operation_date,label,category,cheque,amount_cents,reconciled,note FROM transactions LIMIT 0",
        "SELECT id,debit_id,credit_id FROM transfers LIMIT 0",
        "SELECT id,account_id,label,category,next_due,frequency,amount_cents,kind FROM schedules LIMIT 0",
        "SELECT schedule_id,account_id,label,category,due_date,amount_cents,kind FROM schedule_overrides LIMIT 0",
        "SELECT schedule_id,anchor_day FROM schedule_anchors LIMIT 0",
        "SELECT schedule_id,destination_account_id FROM schedule_transfers LIMIT 0",
        "SELECT schedule_id,destination_account_id FROM schedule_transfer_overrides LIMIT 0",
        "SELECT id,name,parent_id FROM categories LIMIT 0",
        "SELECT key,value FROM app_metadata LIMIT 0",
    ] {
        db.prepare(query)
            .map_err(|_| "Ce fichier n’est pas une base Kresus compatible.".to_string())?;
    }
    let count: i64 = db
        .query_row("SELECT COUNT(*) FROM accounts", [], |row| row.get(0))
        .map_err(database_error)?;
    if count == 0 {
        return Err("Cette base ne contient aucun compte.".into());
    }
    let foreign_key_error: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)",
            [],
            |row| row.get(0),
        )
        .map_err(database_error)?;
    if foreign_key_error {
        return Err("La base contient des références incohérentes.".into());
    }
    Ok(())
}

fn switch_database(state: &AppState, path: &Path) -> Result<(), String> {
    let next = open_existing_database(path)?;
    let mut current = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    *current = next;
    Ok(())
}

#[tauri::command]
pub async fn choose_database(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter("Base SQLite", &["sqlite3", "sqlite", "db"])
        .blocking_pick_file();
    let Some(file) = selected else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|e| e.to_string())?;
    switch_database(&state, &path)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn use_default_database(state: tauri::State<'_, AppState>) -> Result<(), String> {
    switch_database(&state, &state.default_path)
}

// Copy through SQLite so uncheckpointed WAL data is included.
fn copy_database(source: &Connection, destination: &mut Connection) -> Result<(), String> {
    let backup = Backup::new(source, destination).map_err(database_error)?;
    match backup.step(-1).map_err(database_error)? {
        StepResult::Done => Ok(()),
        _ => Err("La base est occupée ; réessayez.".into()),
    }
}

fn backup_to_path(source: &Connection, path: &Path) -> Result<(), String> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("Impossible de créer la sauvegarde : {e}"))?;
    let result = (|| {
        let mut destination = Connection::open(path).map_err(database_error)?;
        copy_database(source, &mut destination)?;
        validate_database(&destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

fn restore_from_path(current: &mut Connection, path: &Path) -> Result<(), String> {
    if let Some(active) = current.path() {
        if fs::canonicalize(active).ok() == fs::canonicalize(path).ok() {
            return Err("Choisissez une sauvegarde différente de la base active.".into());
        }
    }
    let source = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Impossible d’ouvrir la sauvegarde : {e}"))?;
    validate_database(&source)?;
    // Upgrade a private copy first; a failure leaves both files untouched.
    let mut staged = Connection::open_in_memory().map_err(database_error)?;
    copy_database(&source, &mut staged)?;
    initialize_database(&staged).map_err(database_error)?;
    validate_database(&staged)?;
    copy_database(&staged, current)
}

#[tauri::command]
pub async fn backup_database(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    #[cfg(all(feature = "e2e", debug_assertions))]
    let path = if let Some(path) = std::env::var_os("KRESUS_E2E_BACKUP") {
        PathBuf::from(path)
    } else {
        let Some(file) = app
            .dialog()
            .file()
            .set_file_name("kresus-sauvegarde.sqlite3")
            .add_filter("Base SQLite", &["sqlite3", "sqlite", "db"])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        file.into_path().map_err(|e| e.to_string())?
    };
    #[cfg(not(all(feature = "e2e", debug_assertions)))]
    let path = {
        let Some(file) = app
            .dialog()
            .file()
            .set_file_name("kresus-sauvegarde.sqlite3")
            .add_filter("Base SQLite", &["sqlite3", "sqlite", "db"])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        file.into_path().map_err(|e| e.to_string())?
    };
    let current = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    backup_to_path(&current, &path)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn choose_restore_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(all(feature = "e2e", debug_assertions))]
    if let Some(path) = std::env::var_os("KRESUS_E2E_BACKUP") {
        return Ok(Some(PathBuf::from(path).to_string_lossy().into_owned()));
    }
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("Base SQLite", &["sqlite3", "sqlite", "db"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn restore_database(path: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut current = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    let mut preview = state
        .money_preview
        .lock()
        .map_err(|_| "Aperçu indisponible.".to_string())?;
    restore_from_path(&mut current, Path::new(&path))?;
    *preview = None;
    Ok(())
}

pub(crate) fn database_error(error: rusqlite::Error) -> String {
    error.to_string()
}

// Monetary values remain integer cents in SQLite and in the Tauri API.
pub(crate) fn initialize_database(connection: &Connection) -> Result<(), rusqlite::Error> {
    connection.execute_batch("PRAGMA foreign_keys = ON;")?;
    // Existing databases must never receive missing demo records again.
    let existing: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accounts')",
        [],
        |row| row.get(0),
    )?;
    let tx = connection.unchecked_transaction()?;
    initialize_schema_and_data(&tx, !existing)?;
    tx.commit()?;
    crate::categories::migrate_categories(connection)?;
    Ok(())
}

fn initialize_schema_and_data(
    connection: &Connection,
    seed_demo: bool,
) -> Result<(), rusqlite::Error> {
    connection.execute_batch(include_str!("schema.sql"))?;

    // Seed only a new database, in the same transaction as schema creation.
    if seed_demo {
        let accounts = [
            (
                "ccp",
                "CCP",
                "Compte courant",
                284672_i64,
                "La Banque Postale",
            ),
            (
                "sylvie",
                "Compte Sylvie",
                "Compte courant",
                193218,
                "Crédit Mutuel",
            ),
            (
                "livret-michel",
                "Livret A Michel",
                "Épargne",
                1245000,
                "La Banque Postale",
            ),
            (
                "livret-sylvie",
                "Livret A Sylvie",
                "Épargne",
                865034,
                "Crédit Mutuel",
            ),
            (
                "ldds",
                "LDDS Michel",
                "Épargne",
                612090,
                "La Banque Postale",
            ),
            ("cel", "CEL Michel", "Épargne", 347520, "Crédit Mutuel"),
            (
                "assurance",
                "GMO Poste Avenir",
                "Assurance vie",
                1874265,
                "La Banque Postale",
            ),
            (
                "vivaccio",
                "Vivaccio",
                "Assurance vie",
                928012,
                "La Banque Postale",
            ),
        ];
        let operations = [
            (
                "t1",
                "2026-10-28",
                "Carrefour Market",
                "Alimentation · Épicerie",
                None,
                -8463,
                1,
                None,
            ),
            (
                "t2",
                "2026-10-27",
                "EDF — mensualité",
                "Factures · Électricité",
                None,
                -11240,
                1,
                Some("Prélèvement automatique"),
            ),
            (
                "t3",
                "2026-10-26",
                "Pension Michel",
                "Revenus · Retraite",
                None,
                184230,
                0,
                None,
            ),
            (
                "t4",
                "2026-10-24",
                "Pharmacie du Centre",
                "Santé · Pharmacie",
                None,
                -2380,
                1,
                None,
            ),
            (
                "t5",
                "2026-10-22",
                "Loyer — appartement",
                "Revenus · Encaissement de loyer",
                None,
                72000,
                0,
                None,
            ),
            (
                "t6",
                "2026-10-20",
                "Chèque — école de musique",
                "Enfants · Frais divers",
                Some("0042817"),
                -9600,
                1,
                None,
            ),
            (
                "t7",
                "2026-10-18",
                "Boulangerie des Tilleuls",
                "Alimentation",
                None,
                -1220,
                1,
                None,
            ),
        ];
        let mut statement = connection.prepare("INSERT OR IGNORE INTO accounts (id, name, kind, opening_balance_cents, bank) VALUES (?1, ?2, ?3, ?4, ?5)")?;
        for account in accounts {
            statement.execute(params![
                account.0, account.1, account.2, account.3, account.4
            ])?;
        }
        let mut statement = connection.prepare("INSERT OR IGNORE INTO transactions (id, account_id, operation_date, label, category, cheque, amount_cents, reconciled, note) VALUES (?1, 'ccp', ?2, ?3, ?4, ?5, ?6, ?7, ?8)")?;
        for operation in operations {
            statement.execute(params![
                operation.0,
                operation.1,
                operation.2,
                operation.3,
                operation.4,
                operation.5,
                operation.6,
                operation.7
            ])?;
        }
        let schedules = [
            (
                "schedule-loyer",
                "Loyer appartement",
                "Revenus · Encaissement de loyer",
                "2026-11-05",
                "Mensuelle",
                72000_i64,
                "credit",
            ),
            (
                "schedule-edf",
                "EDF — mensualité",
                "Factures · Électricité",
                "2026-11-08",
                "Mensuelle",
                -11240,
                "debit",
            ),
            (
                "schedule-mutuelle",
                "Mutuelle santé",
                "Santé · Mutuelle",
                "2026-11-12",
                "Mensuelle",
                -86_50,
                "debit",
            ),
            (
                "schedule-assurance",
                "Assurance habitation",
                "Assurance · Habitation",
                "2026-11-18",
                "Mensuelle",
                -29_80,
                "debit",
            ),
            (
                "schedule-retraite",
                "Pension Michel",
                "Revenus · Retraite",
                "2026-11-26",
                "Mensuelle",
                184230,
                "credit",
            ),
            (
                "schedule-taxes",
                "Impôts fonciers",
                "Impôts · Impôts fonciers",
                "2026-11-30",
                "Annuelle",
                -98000,
                "debit",
            ),
        ];
        let mut statement = connection.prepare("INSERT OR IGNORE INTO schedules (id, account_id, label, category, next_due, frequency, amount_cents, kind) VALUES (?1, 'ccp', ?2, ?3, ?4, ?5, ?6, ?7)")?;
        for schedule in schedules {
            statement.execute(params![
                schedule.0, schedule.1, schedule.2, schedule.3, schedule.4, schedule.5, schedule.6
            ])?;
        }
    }
    // Preserve the intended day even when February has fewer days.
    connection.execute("INSERT OR IGNORE INTO schedule_anchors SELECT id, CAST(strftime('%d', next_due) AS INTEGER) FROM schedules", [])?;
    Ok(())
}
