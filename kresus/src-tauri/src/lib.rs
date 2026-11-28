mod accounts;
mod bank_import;
mod categories;
mod config;
mod database;
mod file_open;
mod frequency;
mod menu;
mod money_import;
mod ofx;
mod schedules;
#[cfg(test)]
mod test_support;
mod text_limits;
mod transactions;

use database::{AppState, open_startup_database};
use std::{fs, sync::Mutex};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The first plugin forwards file-open requests to the running instance.
        .plugin(tauri_plugin_single_instance::init(file_open::receive))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Keep the database in the platform-specific application data directory.
            let directory = app.path().app_data_dir()?;
            fs::create_dir_all(&directory)?;
            let default_path = directory.join("comptes.kresus");
            menu::install(app, database::show_transaction_comments(&default_path))?;
            let cwd = std::env::current_dir().unwrap_or_default();
            let args = std::env::args_os()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            app.manage(file_open::OpenRequests(Mutex::new(file_open::collect(
                args, &cwd,
            ))));
            let (connection, warning) = match open_startup_database(&default_path) {
                Ok(result) => result,
                Err(error) => {
                    let handle = app.handle().clone();
                    app.dialog()
                        .message(format!(
                            "{error}\n\nBase habituelle : {}",
                            default_path.display()
                        ))
                        .title("Impossible d’ouvrir la base habituelle")
                        .kind(MessageDialogKind::Error)
                        .show(move |_| handle.exit(1));
                    return Ok(());
                }
            };
            app.manage(AppState {
                database: Mutex::new(connection),
                default_path,
                startup_warning: Mutex::new(warning),
                money_preview: Mutex::new(None),
                bank_preview: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bank_import::preview_bank_statement,
            bank_import::discard_bank_statement,
            bank_import::import_bank_statement,
            bank_import::reconciliation_balance,
            money_import::choose_money_file,
            money_import::set_money_preview,
            money_import::import_money,
            database::backup_database,
            database::choose_restore_file,
            database::restore_database,
            database::choose_database,
            database::startup_database,
            database::set_show_transaction_comments,
            database::open_database_path,
            file_open::take_file_requests,
            database::use_default_database,
            accounts::list_accounts,
            accounts::create_account,
            accounts::update_account,
            categories::list_categories,
            categories::create_category,
            categories::rename_category,
            categories::delete_category,
            categories::merge_category,
            transactions::list_transactions,
            transactions::list_register,
            transactions::search_operations,
            transactions::balance_history,
            transactions::forecast_transactions,
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
        .build(tauri::generate_context!())
        .expect("error while building Kresus")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                file_open::receive_opened_urls(_app, urls);
            }
        });
}
