use crate::database::{AppState, database_error};
use crate::frequency::Frequency;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::Path,
};
use tauri_plugin_dialog::DialogExt;

const MAX_MONEY_FILE_BYTES: u64 = 64 * 1024 * 1024;

// Bound the read as well as checking metadata, in case the file grows during import.
fn read_money_file(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| format!("Lecture du fichier impossible : {e}"))?;
    let too_large = || "Le fichier Money dépasse la limite de 64 Mio.".to_string();
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_MONEY_FILE_BYTES {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    file.take(MAX_MONEY_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Lecture du fichier impossible : {e}"))?;
    if bytes.len() as u64 > MAX_MONEY_FILE_BYTES {
        return Err(too_large());
    }
    Ok(bytes)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoneyAccount {
    id: i64,
    name: String,
    opening_balance: i64,
    balance: i64,
    count: usize,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoneyCategory {
    id: i64,
    name: String,
    parent_id: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoneySchedule {
    id: i64,
    account_id: i64,
    destination_account_id: Option<i64>,
    label: String,
    category: String,
    next_due: String,
    frequency: Frequency,
    amount: i64,
    kind: String,
    #[serde(default)]
    payment_method: Option<String>,
    #[serde(default)]
    anchor_day: Option<i64>,
    #[serde(default)]
    remaining_count: Option<i64>,
    #[serde(default)]
    end_date: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoneyOperation {
    #[serde(default)]
    reference: Option<String>,
    id: i64,
    account_id: i64,
    date: String,
    label: String,
    category: String,
    amount: i64,
    reconciled: bool,
    note: String,
}
// A reviewed Money pair keeps the original debit and credit records independently.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoneyTransfer {
    debit_id: i64,
    credit_id: i64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoneyPreview {
    accounts: Vec<MoneyAccount>,
    categories: Vec<MoneyCategory>,
    operations: Vec<MoneyOperation>,
    #[serde(default)]
    transfers: Vec<MoneyTransfer>,
    #[serde(default)]
    schedules: Vec<MoneySchedule>,
    warnings: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoneySelection {
    id: i64,
    kind: String,
}

// Read the selected file only; parsing happens locally in the WebView.
#[tauri::command]
pub async fn choose_money_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<Vec<u8>>, String> {
    *state
        .money_preview
        .lock()
        .map_err(|_| "Aperçu indisponible.".to_string())? = None;
    // The dedicated debug-only E2E build supplies paths when no desktop portal exists.
    #[cfg(all(feature = "e2e", debug_assertions))]
    let path = if let Some(path) = std::env::var_os("KRESUS_E2E_MONEY_SOURCE") {
        std::path::PathBuf::from(path)
    } else {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("Microsoft Money", &["mny"])
            .blocking_pick_file()
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
            .add_filter("Microsoft Money", &["mny"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        file.into_path().map_err(|e| e.to_string())?
    };
    read_money_file(&path).map(Some)
}

// Freeze the parsed preview on the backend until the user confirms the import.
#[tauri::command]
pub fn set_money_preview(
    preview: MoneyPreview,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    *state
        .money_preview
        .lock()
        .map_err(|_| "Aperçu indisponible.".to_string())? = Some(preview);
    Ok(())
}

#[tauri::command]
pub async fn import_money(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    selection: Vec<MoneySelection>,
) -> Result<Option<String>, String> {
    let preview = state
        .money_preview
        .lock()
        .map_err(|_| "Aperçu indisponible.".to_string())?
        .clone()
        .ok_or("Veuillez d’abord analyser le fichier Money.")?;
    if selection.is_empty() {
        return Err("Sélectionnez au moins un compte.".into());
    }
    #[cfg(all(feature = "e2e", debug_assertions))]
    let path = if let Some(path) = std::env::var_os("KRESUS_E2E_MONEY_DESTINATION") {
        std::path::PathBuf::from(path)
    } else {
        let Some(file) = app
            .dialog()
            .file()
            .set_file_name("kresus-import.kresus")
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
            .set_file_name("kresus-import.kresus")
            .add_filter("Base Kresus", &["kresus"])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        file.into_path().map_err(|e| e.to_string())?
    };
    crate::database::validate_kresus_extension(&path)?;
    // create_new prevents overwriting any existing file, including a live database.
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("Impossible de créer une nouvelle base : {e}"))?;
    let result = (|| {
        let mut db = Connection::open(&path).map_err(database_error)?;
        import_into_database(&mut db, &preview, &selection)?;
        let mut current = state
            .database
            .lock()
            .map_err(|_| "Base indisponible.".to_string())?;
        *current = db;
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    *state
        .money_preview
        .lock()
        .map_err(|_| "Aperçu indisponible.".to_string())? = None;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn import_into_database(
    db: &mut Connection,
    preview: &MoneyPreview,
    selection: &[MoneySelection],
) -> Result<(), String> {
    db.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(database_error)?;
    let tx = db.transaction().map_err(database_error)?;
    tx.execute_batch(include_str!("schema.sql"))
        .map_err(database_error)?;
    tx.execute_batch(include_str!("schedule_future_schema.sql"))
        .map_err(database_error)?;
    crate::database::migrate_schedule_payment(&tx).map_err(database_error)?;
    let selected: HashMap<i64, &str> = selection.iter().map(|s| (s.id, s.kind.as_str())).collect();
    if selected.len() != selection.len()
        || selected.is_empty()
        || selected.iter().any(|(id, kind)| {
            !matches!(*kind, "Compte courant" | "Épargne")
                || !preview.accounts.iter().any(|a| a.id == *id)
        })
    {
        return Err("Sélection de comptes invalide.".into());
    }
    // Never import half a transfer or associate one operation with several pairs.
    let mut paired = HashSet::new();
    for transfer in &preview.transfers {
        let debit = preview
            .operations
            .iter()
            .find(|op| op.id == transfer.debit_id)
            .ok_or("Virement Money incomplet.")?;
        let credit = preview
            .operations
            .iter()
            .find(|op| op.id == transfer.credit_id)
            .ok_or("Virement Money incomplet.")?;
        if !paired.insert(debit.id)
            || !paired.insert(credit.id)
            || debit.account_id == credit.account_id
            || debit.amount >= 0
            || debit.amount.checked_neg() != Some(credit.amount)
        {
            return Err("Virement Money incohérent.".into());
        }
        if selected.contains_key(&debit.account_id) != selected.contains_key(&credit.account_id) {
            return Err(
                "Sélectionnez les deux comptes de chaque virement Money, ou aucun des deux.".into(),
            );
        }
    }
    // Insert parents before children and preserve source IDs only within this new database.
    for c in preview
        .categories
        .iter()
        .filter(|c| c.parent_id.is_none())
        .chain(preview.categories.iter().filter(|c| c.parent_id.is_some()))
    {
        tx.execute(
            "INSERT INTO categories (id,name,parent_id) VALUES (?1,?2,?3)",
            params![
                format!("money-cat-{}", c.id),
                c.name.trim(),
                c.parent_id.map(|id| format!("money-cat-{id}"))
            ],
        )
        .map_err(database_error)?;
    }
    if !preview
        .categories
        .iter()
        .any(|c| c.parent_id.is_none() && c.name.trim().eq_ignore_ascii_case("Divers"))
    {
        tx.execute(
            "INSERT INTO categories VALUES ('money-fallback','Divers',NULL)",
            [],
        )
        .map_err(database_error)?;
    }
    for account in &preview.accounts {
        if let Some(kind) = selected.get(&account.id) {
            tx.execute(
                "INSERT INTO accounts VALUES (?1,?2,?3,?4,'')",
                params![
                    format!("money-account-{}", account.id),
                    account.name.trim(),
                    kind,
                    account.opening_balance
                ],
            )
            .map_err(database_error)?;
        }
    }
    for op in &preview.operations {
        if selected.contains_key(&op.account_id) {
            tx.execute("INSERT INTO transactions (id,account_id,operation_date,label,category,amount_cents,reconciled,note,reference) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![format!("money-transaction-{}",op.id),format!("money-account-{}",op.account_id),op.date,op.label.trim(),op.category.trim(),op.amount,op.reconciled,op.note.trim(),op.reference.as_deref().map(str::trim)]).map_err(database_error)?;
        }
    }
    for transfer in &preview.transfers {
        let debit = preview
            .operations
            .iter()
            .find(|op| op.id == transfer.debit_id)
            .expect("validated transfer");
        if selected.contains_key(&debit.account_id) {
            tx.execute(
                "INSERT INTO transfers (id,debit_id,credit_id) VALUES (?1,?2,?3)",
                params![
                    format!(
                        "money-transfer-{}-{}",
                        transfer.debit_id, transfer.credit_id
                    ),
                    format!("money-transaction-{}", transfer.debit_id),
                    format!("money-transaction-{}", transfer.credit_id)
                ],
            )
            .map_err(database_error)?;
        }
    }
    for schedule in &preview.schedules {
        if !selected.contains_key(&schedule.account_id) {
            continue;
        }
        if let Some(destination) = schedule.destination_account_id {
            if !selected.contains_key(&destination) {
                return Err(format!(
                    "Sélectionnez les deux comptes du virement récurrent « {} ».",
                    schedule.label
                ));
            }
            if schedule.kind != "transfer"
                || schedule.amount >= 0
                || destination == schedule.account_id
            {
                return Err("Virement récurrent Money invalide.".into());
            }
        } else if !matches!(
            (schedule.kind.as_str(), schedule.amount > 0),
            ("credit", true) | ("debit", false)
        ) || schedule.amount == 0
        {
            return Err("Échéance Money invalide.".into());
        }
        if !matches!(
            schedule.payment_method.as_deref(),
            None | Some("cheque" | "bank_transfer" | "direct_debit")
        ) || (schedule.kind == "transfer"
            && schedule
                .payment_method
                .as_deref()
                .is_some_and(|m| m != "bank_transfer"))
        {
            return Err("Méthode de paiement Money invalide.".into());
        }
        if schedule.frequency == Frequency::Annual {
            return Err("Périodicité Money non prise en charge.".into());
        }
        // Reject an invalid twice-monthly phase even if a preview was altered.
        if schedule.frequency == Frequency::TwiceMonthly {
            let valid: bool = tx.query_row(
                "SELECT COALESCE(strftime('%d',?1)='15' OR ?1=date(?1,'start of month','+1 month','-1 day'),0)",
                [&schedule.next_due], |r| r.get(0),
            ).map_err(database_error)?;
            if !valid {
                return Err("Date d’échéance bimensuelle invalide.".into());
            }
        }
        if schedule
            .remaining_count
            .is_some_and(|n| !(1..=100_000).contains(&n))
            || (schedule.remaining_count.is_some() && schedule.end_date.is_some())
        {
            return Err("Limite d’échéance Money invalide.".into());
        }
        if let Some(end) = &schedule.end_date {
            let valid: bool = tx
                .query_row(
                    "SELECT COALESCE(length(?1)=10 AND date(?1,'+0 days')=?1, 0)",
                    [end],
                    |r| r.get(0),
                )
                .map_err(database_error)?;
            if !valid || end < &schedule.next_due {
                return Err("Date de fin d’échéance Money invalide.".into());
            }
        }
        let id = format!("money-schedule-{}", schedule.id);
        let stored_kind = if schedule.kind == "transfer" {
            "debit"
        } else {
            &schedule.kind
        };
        tx.execute("INSERT INTO schedules (id,account_id,label,category,next_due,frequency,amount_cents,kind,payment_method) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![id,format!("money-account-{}",schedule.account_id),schedule.label.trim(),schedule.category.trim(),schedule.next_due,schedule.frequency,schedule.amount,stored_kind,schedule.payment_method]).map_err(database_error)?;
        // A partially recorded Money series retains its original day across short months.
        let day: i64 = tx
            .query_row(
                "SELECT CAST(strftime('%d',?1) AS INTEGER)",
                [&schedule.next_due],
                |r| r.get(0),
            )
            .map_err(database_error)?;
        let anchor = schedule.anchor_day.unwrap_or(day);
        let expected: i64 = tx.query_row("SELECT MIN(?1, CAST(strftime('%d',date(?2,'start of month','+1 month','-1 day')) AS INTEGER))", params![anchor, schedule.next_due], |r| r.get(0)).map_err(database_error)?;
        if !(1..=31).contains(&anchor) || day != expected {
            return Err("Jour d’ancrage Money invalide.".into());
        }
        tx.execute(
            "INSERT INTO schedule_anchors (schedule_id,anchor_day) VALUES (?1, ?2)",
            params![id, anchor],
        )
        .map_err(database_error)?;
        // Persist the reviewed limit alongside the imported series.
        tx.execute(
            "INSERT INTO schedule_limits (schedule_id,remaining_count,end_date) VALUES (?1,?2,?3)",
            params![id, schedule.remaining_count, schedule.end_date],
        )
        .map_err(database_error)?;
        if let Some(destination) = schedule.destination_account_id {
            tx.execute(
                "INSERT INTO schedule_transfers VALUES (?1,?2)",
                params![id, format!("money-account-{destination}")],
            )
            .map_err(database_error)?;
        }
    }
    tx.execute("INSERT INTO app_metadata VALUES ('categories_v1','1')", [])
        .map_err(database_error)?;
    tx.commit().map_err(database_error)
}

#[cfg(test)]
#[path = "money_import_tests.rs"]
mod tests;
