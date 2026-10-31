mod accounts;
mod categories;
mod database;
mod money_import;
mod schedules;
#[cfg(test)]
mod test_support;
mod transactions;

use database::{AppState, initialize_database};
use rusqlite::Connection;
use std::{fs, sync::Mutex};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Keep the database in the platform-specific application data directory.
            let directory = app.path().app_data_dir()?;
            fs::create_dir_all(&directory)?;
            let default_path = directory.join("kresus.sqlite3");
            let connection = Connection::open(&default_path)?;
            initialize_database(&connection)?;
            app.manage(AppState {
                database: Mutex::new(connection),
                default_path,
                money_preview: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            money_import::choose_money_file,
            money_import::set_money_preview,
            money_import::import_money,
            database::backup_database,
            database::choose_restore_file,
            database::restore_database,
            database::choose_database,
            database::use_default_database,
            accounts::list_accounts,
            accounts::create_account,
            categories::list_categories,
            categories::create_category,
            categories::rename_category,
            categories::delete_category,
            categories::merge_category,
            transactions::list_transactions,
            transactions::list_register,
            transactions::balance_history,
            transactions::list_payees,
            schedules::list_schedules,
            schedules::create_schedule,
            schedules::update_schedule,
            schedules::update_future_occurrence,
            schedules::delete_schedule,
            transactions::create_transaction,
            transactions::create_transfer,
            transactions::get_transfer,
            transactions::update_transfer,
            transactions::update_transaction,
            transactions::toggle_transaction_reconciliation,
            transactions::delete_transaction,
            schedules::record_schedule
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kresus");
}
