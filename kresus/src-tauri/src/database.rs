use crate::config::Config;
use rusqlite::{
    Connection,
    backup::{Backup, StepResult},
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
    pub(crate) startup_warning: Mutex<Option<String>>,
    pub(crate) money_preview: Mutex<Option<crate::money_import::MoneyPreview>>,
    pub(crate) bank_preview: Mutex<Option<crate::bank_import::PendingStatement>>,
}

#[derive(serde::Serialize)]
pub struct StartupDatabase {
    path: Option<String>,
    warning: Option<String>,
}

fn config_path(default_path: &Path) -> PathBuf {
    default_path.with_file_name("config.json")
}

pub(crate) fn remember_startup_database(default_path: &Path, path: &Path) -> Result<(), String> {
    let preference = config_path(default_path);
    let result = (|| {
        let mut config = Config::load(&preference)?;
        if config.startup_database.is_none() {
            config.startup_database = Some(std::path::absolute(path)?);
            config.save(&preference)?;
        }
        Ok::<(), std::io::Error>(())
    })();
    result.map_err(|error| format!("Impossible de mémoriser la base de démarrage : {error}"))
}

fn forget_startup_database(default_path: &Path) -> Result<(), String> {
    let preference = config_path(default_path);
    let result = (|| {
        let mut config = Config::load(&preference)?;
        if config.startup_database.take().is_some() {
            config.save(&preference)?;
        }
        Ok::<(), std::io::Error>(())
    })();
    result.map_err(|error| format!("Impossible de rétablir la base de démarrage : {error}"))
}

pub(crate) fn open_startup_database(
    default_path: &Path,
) -> Result<(Connection, Option<String>), String> {
    let warning = match Config::load(&config_path(default_path))
        .map(|config| config.startup_database)
    {
        Ok(Some(path)) => {
            match validate_kresus_extension(&path).and_then(|()| open_existing_database(&path)) {
                Ok(db) => return Ok((db, None)),
                Err(error) => Some(format!(
                    "Impossible de rouvrir « {} » : {error}. La base habituelle est ouverte.",
                    path.display()
                )),
            }
        }
        Ok(None) => None,
        Err(error) => Some(format!(
            "Impossible de lire la base de démarrage mémorisée : {error}. La base habituelle est ouverte."
        )),
    };
    let db = Connection::open(default_path).map_err(database_error)?;
    initialize_database(&db)?;
    Ok((db, warning))
}

pub(crate) fn is_default_database(db: &Connection, default_path: &Path) -> bool {
    db.path().is_some_and(|path| {
        Path::new(path) == default_path
            || fs::canonicalize(default_path)
                .is_ok_and(|default| fs::canonicalize(path).is_ok_and(|active| active == default))
    })
}

#[tauri::command]
pub fn startup_database(state: tauri::State<'_, AppState>) -> Result<StartupDatabase, String> {
    let db = state.database.lock().map_err(|_| "Base indisponible.")?;
    let path = if is_default_database(&db, &state.default_path) {
        None
    } else {
        db.path().map(str::to_owned)
    };
    let warning = state
        .startup_warning
        .lock()
        .map_err(|_| "Base indisponible.")?
        .take();
    Ok(StartupDatabase { path, warning })
}

// Validate the file read-only before opening it for normal application use.
fn open_existing_database(path: &Path) -> Result<Connection, String> {
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Impossible d’ouvrir le fichier : {e}"))?;
    validate_database(&db)?;
    drop(db);
    let writable = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| format!("La base ne peut pas être ouverte en écriture : {e}"))?;
    writable
        .execute_batch("PRAGMA foreign_keys = ON")
        .map_err(database_error)?;
    initialize_schema_extensions(&writable)?;
    Ok(writable)
}

// Validate without modifying the file selected for restoration.
fn validate_database(db: &Connection) -> Result<(), String> {
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(database_error)?;
    if version != 2 {
        return Err("Cette base utilise un schéma Kresus incompatible avec cette version.".into());
    }
    let check: String = db
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(database_error)?;
    if check != "ok" {
        return Err("La base SQLite est endommagée.".into());
    }
    for query in [
        "SELECT id,name,kind,opening_balance_cents,bank,account_number FROM accounts LIMIT 0",
        "SELECT entry_order,id,account_id,operation_date,label,category,cheque,amount_cents,reconciled,note,reference FROM transactions LIMIT 0",
        "SELECT id,debit_id,credit_id FROM transfers LIMIT 0",
        "SELECT id,account_id,label,category,next_due,frequency,amount_cents,kind,payment_method,cheque,note FROM schedules LIMIT 0",
        "SELECT schedule_id,account_id,label,category,due_date,amount_cents,kind,payment_method,cheque,note FROM schedule_overrides LIMIT 0",
        "SELECT schedule_id,anchor_day FROM schedule_anchors LIMIT 0",
        "SELECT schedule_id,destination_account_id FROM schedule_transfers LIMIT 0",
        "SELECT schedule_id,destination_account_id FROM schedule_transfer_overrides LIMIT 0",
        "SELECT id,name,parent_id FROM categories LIMIT 0",
        "SELECT schedule_id,original_due,account_id,label,category,due_date,amount_cents,kind,destination_account_id,payment_method,cheque,note FROM schedule_future_overrides LIMIT 0",
        "SELECT schedule_id,remaining_count,end_date FROM schedule_limits LIMIT 0",
        "SELECT schedule_id FROM schedule_estimates LIMIT 0",
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

pub(crate) fn switch_database(
    state: &AppState,
    path: &Path,
    reset_startup: bool,
) -> Result<(), String> {
    let next = open_existing_database(path)?;
    let mut current = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    let mut bank_preview = state
        .bank_preview
        .lock()
        .map_err(|_| "Aperçu indisponible.")?;
    if reset_startup {
        forget_startup_database(&state.default_path)?;
    }
    *bank_preview = None;
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
    switch_database(&state, Path::new(&path), false)?;
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
    switch_database(&state, &path, false)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn use_default_database(state: tauri::State<'_, AppState>) -> Result<(), String> {
    switch_database(&state, &state.default_path, true)
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
    // Check the snapshot before replacing the active database.
    let mut staged = Connection::open_in_memory().map_err(database_error)?;
    copy_database(&source, &mut staged)?;
    validate_database(&staged)?;
    initialize_schema_extensions(&staged)?;
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
    let mut bank_preview = state
        .bank_preview
        .lock()
        .map_err(|_| "Aperçu indisponible.")?;
    restore_from_path(&mut current, Path::new(&path))?;
    *preview = None;
    *bank_preview = None;
    Ok(())
}

pub(crate) fn database_error(error: rusqlite::Error) -> String {
    error.to_string()
}

pub(crate) fn initialize_database(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch("PRAGMA foreign_keys = ON")
        .map_err(database_error)?;
    let empty: bool = connection.query_row(
        "SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%') AND user_version=0 FROM pragma_user_version",
        [], |row| row.get(0),
    ).map_err(database_error)?;
    if !empty {
        validate_database(connection)?;
        return initialize_schema_extensions(connection);
    }
    let tx = connection.unchecked_transaction().map_err(database_error)?;
    create_schema(&tx)?;
    tx.execute_batch(include_str!("default_categories.sql"))
        .map_err(database_error)?;
    tx.commit().map_err(database_error)
}

pub(crate) fn create_schema(db: &Connection) -> Result<(), String> {
    db.execute_batch(include_str!("schema.sql"))
        .map_err(database_error)?;
    initialize_schema_extensions(db)
}

fn initialize_schema_extensions(db: &Connection) -> Result<(), String> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS category_kinds (
            category_id TEXT PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN ('debit', 'credit'))
        ) WITHOUT ROWID;",
    )
    .map_err(database_error)?;
    db.execute_batch(include_str!("account_archive_schema.sql"))
        .map_err(database_error)?;
    db.execute_batch(include_str!("transaction_split_schema.sql"))
        .map_err(database_error)?;
    crate::bank_import::initialize_schema(db)
}
