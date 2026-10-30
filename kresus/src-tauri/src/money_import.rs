use crate::database::{AppState, database_error};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs};
use tauri_plugin_dialog::DialogExt;

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
    frequency: String,
    amount: i64,
    kind: String,
    #[serde(default)]
    payment_method: Option<String>,
    #[serde(default)]
    remaining_count: Option<i64>,
    #[serde(default)]
    end_date: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoneyOperation {
    id: i64,
    account_id: i64,
    date: String,
    label: String,
    category: String,
    amount: i64,
    reconciled: bool,
    note: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoneyPreview {
    accounts: Vec<MoneyAccount>,
    categories: Vec<MoneyCategory>,
    operations: Vec<MoneyOperation>,
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
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > 16 * 1024 * 1024 {
        return Err("Le fichier Money dépasse la limite de 16 Mo.".into());
    }
    fs::read(path)
        .map(Some)
        .map_err(|e| format!("Lecture du fichier impossible : {e}"))
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
            .set_file_name("kresus-import.sqlite3")
            .add_filter("Base SQLite", &["sqlite3"])
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
            .set_file_name("kresus-import.sqlite3")
            .add_filter("Base SQLite", &["sqlite3"])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        file.into_path().map_err(|e| e.to_string())?
    };
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
                c.name,
                c.parent_id.map(|id| format!("money-cat-{id}"))
            ],
        )
        .map_err(database_error)?;
    }
    if !preview
        .categories
        .iter()
        .any(|c| c.parent_id.is_none() && c.name.eq_ignore_ascii_case("Divers"))
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
                    account.name,
                    kind,
                    account.opening_balance
                ],
            )
            .map_err(database_error)?;
        }
    }
    for op in &preview.operations {
        if selected.contains_key(&op.account_id) {
            tx.execute("INSERT INTO transactions (id,account_id,operation_date,label,category,amount_cents,reconciled,note) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", params![format!("money-transaction-{}",op.id),format!("money-account-{}",op.account_id),op.date,op.label,op.category,op.amount,op.reconciled,op.note]).map_err(database_error)?;
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
        if !matches!(schedule.frequency.as_str(), "Mensuelle" | "Bimestrielle") {
            return Err("Périodicité Money non prise en charge.".into());
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
        tx.execute("INSERT INTO schedules (id,account_id,label,category,next_due,frequency,amount_cents,kind,payment_method) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![id,format!("money-account-{}",schedule.account_id),schedule.label,schedule.category,schedule.next_due,schedule.frequency,schedule.amount,stored_kind,schedule.payment_method]).map_err(database_error)?;
        tx.execute("INSERT INTO schedule_anchors (schedule_id,anchor_day) VALUES (?1, CAST(strftime('%d',?2) AS INTEGER))", params![id,schedule.next_due]).map_err(database_error)?;
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
mod tests {
    use super::*;

    fn fixture() -> MoneyPreview {
        serde_json::from_str(r#"{"accounts":[{"id":1,"name":"Compte","openingBalance":100000,"balance":87500,"count":2}],"categories":[{"id":3,"name":"Maison","parentId":null},{"id":4,"name":"Charges","parentId":3}],"operations":[{"id":1,"accountId":1,"date":"2026-01-01","label":"Loyer","category":"Maison · Charges","amount":-10000,"reconciled":false,"note":""},{"id":2,"accountId":1,"date":"2026-01-02","label":"Achat","category":"Divers","amount":-2500,"reconciled":true,"note":"Référence Money : 1Carte"}],"warnings":[]}"#).unwrap()
    }

    #[test]
    fn imports_selected_account_and_preserves_cents_categories_and_operations() {
        let mut db = Connection::open_in_memory().unwrap();
        import_into_database(
            &mut db,
            &fixture(),
            &[MoneySelection {
                id: 1,
                kind: "Épargne".into(),
            }],
        )
        .unwrap();
        let account = crate::accounts::list_accounts_in_db(&db).unwrap().remove(0);
        assert_eq!(
            (
                account.opening_balance,
                account.current_balance,
                account.kind.as_str()
            ),
            (100000, 87500, "Épargne")
        );
        let categories: i64 = db
            .query_row("SELECT count(*) FROM categories", [], |r| r.get(0))
            .unwrap();
        assert_eq!(categories, 3);
        let note: String = db
            .query_row(
                "SELECT note FROM transactions WHERE id='money-transaction-2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(note.contains("1Carte"));
    }

    #[test]
    fn imports_verified_payment_method_and_rejects_invalid_values() {
        let mut preview = fixture();
        preview.schedules.push(MoneySchedule {
            id: 9,
            account_id: 1,
            destination_account_id: None,
            label: "Chèque".into(),
            category: "Divers".into(),
            next_due: "2028-01-31".into(),
            frequency: "Mensuelle".into(),
            amount: -1200,
            kind: "debit".into(),
            payment_method: Some("cheque".into()),
            remaining_count: None,
            end_date: None,
        });
        let mut db = Connection::open_in_memory().unwrap();
        import_into_database(
            &mut db,
            &preview,
            &[MoneySelection {
                id: 1,
                kind: "Compte courant".into(),
            }],
        )
        .unwrap();
        let method: Option<String> = db
            .query_row(
                "SELECT payment_method FROM schedules WHERE id='money-schedule-9'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(method.as_deref(), Some("cheque"));
        preview.schedules[0].payment_method = Some("invalid".into());
        let mut invalid = Connection::open_in_memory().unwrap();
        assert!(
            import_into_database(
                &mut invalid,
                &preview,
                &[MoneySelection {
                    id: 1,
                    kind: "Compte courant".into()
                }]
            )
            .is_err()
        );
        assert_eq!(
            invalid
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name='accounts'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn imported_transfer_series_requires_both_accounts_and_records_linked_operations() {
        let mut preview = fixture();
        preview.accounts.push(MoneyAccount {
            id: 2,
            name: "Livret".into(),
            opening_balance: 200000,
            balance: 200000,
            count: 0,
        });
        preview.schedules.push(MoneySchedule {
            id: 8,
            account_id: 1,
            destination_account_id: Some(2),
            label: "Virement".into(),
            category: "Divers".into(),
            next_due: "2028-01-31".into(),
            frequency: "Bimestrielle".into(),
            amount: -10000,
            kind: "transfer".into(),
            payment_method: None,
            remaining_count: None,
            end_date: None,
        });
        let mut missing = Connection::open_in_memory().unwrap();
        assert!(
            import_into_database(
                &mut missing,
                &preview,
                &[MoneySelection {
                    id: 1,
                    kind: "Compte courant".into()
                }]
            )
            .is_err()
        );
        assert_eq!(
            missing
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        let mut db = Connection::open_in_memory().unwrap();
        import_into_database(
            &mut db,
            &preview,
            &[
                MoneySelection {
                    id: 1,
                    kind: "Compte courant".into(),
                },
                MoneySelection {
                    id: 2,
                    kind: "Épargne".into(),
                },
            ],
        )
        .unwrap();
        crate::schedules::record_schedule_in_db(&mut db, "money-schedule-8", "import-transfer")
            .unwrap();
        let values: (String, i64, i64) = db.query_row("SELECT next_due, (SELECT amount_cents FROM transactions WHERE id='import-transfer-debit'), (SELECT amount_cents FROM transactions WHERE id='import-transfer-credit') FROM schedules WHERE id='money-schedule-8'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(values, ("2028-03-31".into(), -10000, 10000));
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM transfers WHERE id='import-transfer'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn imported_schedule_limits_are_atomic_and_enforced() {
        for (remaining_count, end_date) in [(Some(2), None), (None, Some("2028-02-29".to_string()))]
        {
            let mut preview = fixture();
            preview.schedules.push(MoneySchedule {
                id: 9,
                account_id: 1,
                destination_account_id: None,
                label: "Limitée".into(),
                category: "Divers".into(),
                next_due: "2028-01-31".into(),
                frequency: "Mensuelle".into(),
                amount: -1200,
                kind: "debit".into(),
                payment_method: None,
                remaining_count,
                end_date,
            });
            let mut db = Connection::open_in_memory().unwrap();
            import_into_database(
                &mut db,
                &preview,
                &[MoneySelection {
                    id: 1,
                    kind: "Compte courant".into(),
                }],
            )
            .unwrap();
            crate::schedules::record_schedule_in_db(&mut db, "money-schedule-9", "limit-first")
                .unwrap();
            assert_eq!(
                db.query_row(
                    "SELECT next_due FROM schedules WHERE id='money-schedule-9'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                "2028-02-29"
            );
            crate::schedules::record_schedule_in_db(&mut db, "money-schedule-9", "limit-last")
                .unwrap();
            assert_eq!(
                db.query_row(
                    "SELECT count(*) FROM schedules WHERE id='money-schedule-9'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
            assert_eq!(
                db.query_row(
                    "SELECT count(*) FROM transactions WHERE id LIKE 'limit-%'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                2
            );
        }
    }

    #[test]
    fn invalid_imported_schedule_limits_roll_back_the_import() {
        for (remaining_count, end_date) in [
            (Some(0), None),
            (Some(2), Some("2028-02-29".to_string())),
            (None, Some("2028-02-30".to_string())),
            (None, Some("2028-01-30".to_string())),
        ] {
            let mut preview = fixture();
            preview.schedules.push(MoneySchedule {
                id: 9,
                account_id: 1,
                destination_account_id: None,
                label: "Limitée".into(),
                category: "Divers".into(),
                next_due: "2028-01-31".into(),
                frequency: "Mensuelle".into(),
                amount: -1200,
                kind: "debit".into(),
                payment_method: None,
                remaining_count,
                end_date,
            });
            let mut db = Connection::open_in_memory().unwrap();
            assert!(
                import_into_database(
                    &mut db,
                    &preview,
                    &[MoneySelection {
                        id: 1,
                        kind: "Compte courant".into()
                    }]
                )
                .is_err()
            );
            assert_eq!(
                db.query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
        }
    }

    #[test]
    fn invalid_selection_rolls_back_all_schema_and_data() {
        let mut db = Connection::open_in_memory().unwrap();
        assert!(
            import_into_database(
                &mut db,
                &fixture(),
                &[MoneySelection {
                    id: 9,
                    kind: "Épargne".into()
                }]
            )
            .is_err()
        );
        let tables: i64 = db
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0);
    }
}
