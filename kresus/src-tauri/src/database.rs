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
    writable
        .execute_batch(include_str!("schedule_future_schema.sql"))
        .map_err(database_error)?;
    writable.execute_batch("CREATE TABLE IF NOT EXISTS schedule_estimates (schedule_id TEXT PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE)").map_err(database_error)?;
    migrate_schedule_payment(&writable).map_err(database_error)?;
    migrate_transaction_reference(&writable).map_err(database_error)?;
    migrate_account_number(&writable).map_err(database_error)?;
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

pub(crate) fn switch_database(state: &AppState, path: &Path) -> Result<(), String> {
    let next = open_existing_database(path)?;
    let mut current = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    *current = next;
    Ok(())
}

pub(crate) fn validate_kresus_extension(path: &Path) -> Result<(), String> {
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("kresus"))
    {
        Ok(())
    } else {
        Err("Choisissez un fichier .kresus.".into())
    }
}

// Open an explicitly requested file using the same validation as the native chooser.
#[tauri::command]
pub fn open_database_path(path: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    validate_kresus_extension(Path::new(&path))?;
    switch_database(&state, Path::new(&path))?;
    *state
        .money_preview
        .lock()
        .map_err(|_| "Aperçu indisponible.".to_string())? = None;
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
        .add_filter("Base Kresus", &["kresus"])
        .blocking_pick_file();
    let Some(file) = selected else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|e| e.to_string())?;
    validate_kresus_extension(&path)?;
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
            .set_file_name("kresus-sauvegarde.kresus")
            .add_filter("Base Kresus", &["kresus"])
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
            .set_file_name("kresus-sauvegarde.kresus")
            .add_filter("Base Kresus", &["kresus"])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        file.into_path().map_err(|e| e.to_string())?
    };
    validate_kresus_extension(&path)?;
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
        .add_filter("Base Kresus", &["kresus"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn restore_database(path: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    validate_kresus_extension(Path::new(&path))?;
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
    let tx = connection.unchecked_transaction()?;
    tx.execute_batch(include_str!("schema.sql"))?;
    tx.execute_batch(include_str!("schedule_future_schema.sql"))?;
    migrate_schedule_payment(&tx)?;
    migrate_transaction_reference(&tx)?;
    migrate_account_number(&tx)?;
    // Preserve the intended day even when February has fewer days.
    tx.execute("INSERT OR IGNORE INTO schedule_anchors SELECT id, CAST(strftime('%d', next_due) AS INTEGER) FROM schedules", [])?;
    tx.commit()?;
    crate::categories::migrate_categories(connection)?;
    Ok(())
}

fn migrate_account_number(connection: &Connection) -> Result<(), rusqlite::Error> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('accounts') WHERE name='account_number')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        connection.execute_batch("ALTER TABLE accounts ADD COLUMN account_number TEXT")?;
    }
    Ok(())
}

// Preserve historical operations while adding a separate reference field.
fn migrate_transaction_reference(connection: &Connection) -> Result<(), rusqlite::Error> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('transactions') WHERE name='reference')",
        [],
        |r| r.get(0),
    )?;
    if !exists {
        connection.execute_batch("ALTER TABLE transactions ADD COLUMN reference TEXT")?;
    }
    Ok(())
}

// Add nullable schedule fields to existing databases without changing their data.
pub(crate) fn migrate_schedule_payment(connection: &Connection) -> Result<(), rusqlite::Error> {
    for table in [
        "schedules",
        "schedule_overrides",
        "schedule_future_overrides",
    ] {
        for column in ["payment_method", "cheque", "note"] {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
                params![table, column],
                |row| row.get(0),
            )?;
            if !exists {
                connection
                    .execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT"))?;
            }
        }
    }
    Ok(())
}
