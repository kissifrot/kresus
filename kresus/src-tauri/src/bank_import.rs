use crate::database::{AppState, database_error};
use crate::ofx::{self, ClosingBalance, Statement, StatementRow};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{fs::File, io::Read};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const STALE: &str = "L’aperçu n’est plus à jour. Ouvrez de nouveau le relevé.";
const NOT_AVAILABLE: &str = "L’aperçu du relevé est indisponible.";
const MATCH_DAYS: i64 = 7;
const MATCH_WINDOW: &str = "operation_date BETWEEN date(?3, -?4 || ' days')
    AND COALESCE(date(?3, '+' || ?4 || ' days'), '9999-12-31')";
const CANDIDATE_LIMIT: usize = 20;

pub(crate) struct PendingStatement {
    id: Uuid,
    parsed: Option<(String, Statement)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementPreview {
    preview_id: String,
    file_name: String,
    bank_id: String,
    bank_account: String,
    match_days: i64,
    closing: ClosingBalance,
    rows: Vec<PreviewRow>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewRow {
    #[serde(flatten)]
    row: StatementRow,
    duplicate: Option<Duplicate>,
    candidates: Vec<MatchCandidate>,
    more_candidates: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum Duplicate {
    AlreadyImported,
    Repeated,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MatchCandidate {
    id: String,
    date: String,
    label: String,
    category: String,
    reconciled: bool,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum StatementChoice {
    Add,
    Skip,
    Match {
        #[serde(rename = "transactionId")]
        transaction_id: String,
    },
}

#[derive(Default, Serialize)]
pub struct ImportResult {
    added: usize,
    matched: usize,
    skipped: usize,
}

pub(crate) fn initialize_schema(db: &Connection) -> Result<(), String> {
    db.execute_batch(include_str!("bank_statement_schema.sql"))
        .map_err(database_error)?;
    let has_bank_date: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('bank_statement_entries') WHERE name='bank_date')",
        [],
        |row| row.get(0),
    ).map_err(database_error)?;
    // Preserve duplicate detection for statements imported before bank dates were stored.
    if !has_bank_date {
        db.execute(
            "ALTER TABLE bank_statement_entries ADD COLUMN bank_date TEXT",
            [],
        )
        .map_err(database_error)?;
    }
    Ok(())
}

#[tauri::command]
pub fn reconciliation_balance(
    state: tauri::State<'_, AppState>,
    account_id: String,
    date: String,
) -> Result<i64, String> {
    let db = state.database.lock().map_err(|_| NOT_AVAILABLE)?;
    reconciliation_balance_in_db(&db, &account_id, &date)
}

fn reconciliation_balance_in_db(
    db: &Connection,
    account_id: &str,
    date: &str,
) -> Result<i64, String> {
    if date.len() != 10
        || date < "1970-01-01"
        || chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err()
    {
        return Err("Date de clôture invalide.".into());
    }
    db.query_row(
        "SELECT opening_balance_cents + COALESCE((
             SELECT SUM(t.amount_cents)
             FROM transactions t LEFT JOIN bank_statement_entries e ON e.transaction_id=t.id
             WHERE t.account_id=a.id AND t.reconciled=1 AND COALESCE(e.bank_date,t.operation_date)<=?2
         ),0) FROM accounts a WHERE a.id=?1",
        params![account_id, date],
        |row| row.get(0),
    ).optional().map_err(database_error)?
        .ok_or_else(|| "Compte introuvable.".into())
}

#[tauri::command]
pub async fn preview_bank_statement(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<Option<StatementPreview>, String> {
    let id = Uuid::new_v4();
    *state.bank_preview.lock().map_err(|_| NOT_AVAILABLE)? =
        Some(PendingStatement { id, parsed: None });
    let path = {
        #[cfg(all(feature = "e2e", debug_assertions))]
        let test_path = std::env::var_os("KRESUS_E2E_OFX_SOURCE").map(std::path::PathBuf::from);
        #[cfg(not(all(feature = "e2e", debug_assertions)))]
        let test_path: Option<std::path::PathBuf> = None;
        if let Some(path) = test_path {
            path
        } else {
            let Some(file) = app
                .dialog()
                .file()
                .add_filter("Relevé bancaire OFX", &["ofx"])
                .blocking_pick_file()
            else {
                discard_preview(&state, id)?;
                return Ok(None);
            };
            file.into_path().map_err(|error| error.to_string())?
        }
    };
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("ofx"))
    {
        return Err("Choisissez un relevé au format .ofx.".into());
    }
    let file =
        File::open(&path).map_err(|error| format!("Impossible d’ouvrir le relevé : {error}"))?;
    let mut bytes = Vec::new();
    file.take(ofx::MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Impossible de lire le relevé : {error}"))?;
    if bytes.len() as u64 > ofx::MAX_FILE_BYTES {
        return Err("La taille du relevé dépasse 8 Mio.".into());
    }
    let statement = ofx::parse(&bytes)?;
    let db = state.database.lock().map_err(|_| NOT_AVAILABLE)?;
    let mut pending = state.bank_preview.lock().map_err(|_| NOT_AVAILABLE)?;
    let pending = pending
        .as_mut()
        .filter(|pending| pending.id == id)
        .ok_or(STALE)?;
    ensure_account(&db, &account_id)?;
    let rows = preview_rows(&db, &account_id, &statement)?;
    let preview = StatementPreview {
        preview_id: id.to_string(),
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Relevé OFX")
            .into(),
        bank_id: statement.bank_id.clone(),
        bank_account: statement.account_number.clone(),
        match_days: MATCH_DAYS,
        closing: statement.closing.clone(),
        rows,
    };
    pending.parsed = Some((account_id, statement));
    Ok(Some(preview))
}

#[tauri::command]
pub fn discard_bank_statement(
    state: tauri::State<'_, AppState>,
    preview_id: String,
) -> Result<(), String> {
    discard_preview(&state, Uuid::parse_str(&preview_id).map_err(|_| STALE)?)
}

fn discard_preview(state: &AppState, id: Uuid) -> Result<(), String> {
    let mut pending = state.bank_preview.lock().map_err(|_| NOT_AVAILABLE)?;
    if pending.as_ref().is_some_and(|pending| pending.id == id) {
        *pending = None;
    }
    Ok(())
}

#[tauri::command]
pub fn import_bank_statement(
    state: tauri::State<'_, AppState>,
    preview_id: String,
    choices: Vec<StatementChoice>,
) -> Result<ImportResult, String> {
    let id = Uuid::parse_str(&preview_id).map_err(|_| STALE)?;
    let mut db = state.database.lock().map_err(|_| NOT_AVAILABLE)?;
    let mut pending = state.bank_preview.lock().map_err(|_| NOT_AVAILABLE)?;
    let (account_id, statement) = pending
        .as_ref()
        .filter(|pending| pending.id == id)
        .and_then(|pending| pending.parsed.as_ref())
        .ok_or(STALE)?;
    let result = apply_statement(&mut db, account_id, statement, &choices)?;
    *pending = None;
    Ok(result)
}

fn ensure_account(db: &Connection, account_id: &str) -> Result<(), String> {
    let found: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM accounts WHERE id=?1)",
            [account_id],
            |row| row.get(0),
        )
        .map_err(database_error)?;
    if !found {
        return Err("Le compte de destination est introuvable.".into());
    }
    Ok(())
}

fn imported(
    lookup: &mut rusqlite::Statement<'_>,
    account_id: &str,
    statement: &Statement,
    row: &StatementRow,
) -> Result<bool, String> {
    lookup
        .exists(params![
            account_id,
            statement.bank_id,
            statement.account_number,
            row.fit_id
        ])
        .map_err(database_error)
}

const IMPORTED_SQL: &str = "SELECT 1 FROM bank_statement_entries
    WHERE account_id=?1 AND bank_id=?2 AND bank_account=?3 AND fit_id=?4";
const FREE_OPERATION: &str =
    "NOT EXISTS(SELECT 1 FROM bank_statement_entries WHERE transaction_id=transactions.id)";

fn preview_rows(
    db: &Connection,
    account_id: &str,
    statement: &Statement,
) -> Result<Vec<PreviewRow>, String> {
    let mut lookup = db.prepare(IMPORTED_SQL).map_err(database_error)?;
    let mut suggestions = db
        .prepare(&format!(
            "SELECT id, operation_date, label, category, reconciled FROM transactions
         WHERE account_id=?1 AND amount_cents=?2 AND {MATCH_WINDOW} AND {FREE_OPERATION}
         ORDER BY ABS(julianday(operation_date)-julianday(?3)), entry_order DESC LIMIT ?5"
        ))
        .map_err(database_error)?;
    statement
        .rows
        .iter()
        .zip(&statement.repeated)
        .map(|(row, repeated)| {
            let duplicate = if imported(&mut lookup, account_id, statement, row)? {
                Some(Duplicate::AlreadyImported)
            } else if *repeated {
                Some(Duplicate::Repeated)
            } else {
                None
            };
            let mut candidates = if duplicate.is_none() {
                suggestions
                    .query_map(
                        params![
                            account_id,
                            row.amount,
                            row.date,
                            MATCH_DAYS,
                            (CANDIDATE_LIMIT + 1) as i64
                        ],
                        |candidate| {
                            Ok(MatchCandidate {
                                id: candidate.get(0)?,
                                date: candidate.get(1)?,
                                label: candidate.get(2)?,
                                category: candidate.get(3)?,
                                reconciled: candidate.get(4)?,
                            })
                        },
                    )
                    .map_err(database_error)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(database_error)?
            } else {
                Vec::new()
            };
            let more_candidates = candidates.len() > CANDIDATE_LIMIT;
            candidates.truncate(CANDIDATE_LIMIT);
            Ok(PreviewRow {
                row: row.clone(),
                duplicate,
                candidates,
                more_candidates,
            })
        })
        .collect()
}

fn apply_statement(
    db: &mut Connection,
    account_id: &str,
    statement: &Statement,
    choices: &[StatementChoice],
) -> Result<ImportResult, String> {
    if choices.len() != statement.rows.len() {
        return Err("Chaque ligne du relevé doit avoir une décision.".into());
    }
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(database_error)?;
    ensure_account(&tx, account_id)?;
    let mut result = ImportResult::default();
    {
        let mut lookup = tx.prepare(IMPORTED_SQL).map_err(database_error)?;
        let mut recover_bank_date = tx.prepare(
            "UPDATE bank_statement_entries SET bank_date=?5
             WHERE account_id=?1 AND bank_id=?2 AND bank_account=?3 AND fit_id=?4 AND bank_date IS NULL"
        ).map_err(database_error)?;
        let mut attach = tx.prepare(
            "INSERT INTO bank_statement_entries (account_id,bank_id,bank_account,fit_id,transaction_id,bank_date)
             VALUES (?1,?2,?3,?4,?5,?6)"
        ).map_err(database_error)?;
        let mut reconcile = tx.prepare(&format!(
            "UPDATE transactions SET reconciled=1
             WHERE account_id=?1 AND amount_cents=?2 AND {MATCH_WINDOW} AND id=?5 AND {FREE_OPERATION}"
        )).map_err(database_error)?;
        let mut insert = tx.prepare(
            "INSERT INTO transactions (id,account_id,operation_date,label,category,amount_cents,reconciled,note,reference)
             VALUES (?1,?2,?3,?4,?5,?6,1,?7,?8)"
        ).map_err(database_error)?;
        let mut category = None;
        for (index, ((row, repeated), choice)) in statement
            .rows
            .iter()
            .zip(&statement.repeated)
            .zip(choices)
            .enumerate()
        {
            if matches!(choice, StatementChoice::Skip) {
                // Reopening an older import can recover the date without touching the operation.
                recover_bank_date
                    .execute(params![
                        account_id,
                        statement.bank_id,
                        statement.account_number,
                        row.fit_id,
                        row.date
                    ])
                    .map_err(database_error)?;
                result.skipped += 1;
                continue;
            }
            if *repeated || imported(&mut lookup, account_id, statement, row)? {
                return Err(format!(
                    "Ligne {} déjà importée ou répétée. {STALE}",
                    index + 1
                ));
            }
            let id = match choice {
                StatementChoice::Add => {
                    let name = match &category {
                        Some(name) => name,
                        None => category.insert(divers(&tx)?),
                    };
                    let id = Uuid::new_v4().to_string();
                    // Keep long bank references in the note so the operation remains editable.
                    let (mut note, mut reference) = (row.note.clone(), row.reference.as_deref());
                    if crate::text_limits::validate_reference_length(reference).is_err() {
                        let detail = format!("Réf. bancaire : {}", reference.take().unwrap());
                        note = Some(match note {
                            Some(note) => format!("{note}\n{detail}"),
                            None => detail,
                        });
                    }
                    insert
                        .execute(params![
                            id, account_id, row.date, row.label, name, row.amount, note, reference
                        ])
                        .map_err(database_error)?;
                    result.added += 1;
                    id
                }
                StatementChoice::Match { transaction_id } => {
                    if reconcile
                        .execute(params![
                            account_id,
                            row.amount,
                            row.date,
                            MATCH_DAYS,
                            transaction_id
                        ])
                        .map_err(database_error)?
                        != 1
                    {
                        return Err(format!(
                            "Ligne {} : l’opération choisie a changé ou est déjà rapprochée d’une autre ligne. {STALE}",
                            index + 1
                        ));
                    }
                    result.matched += 1;
                    transaction_id.clone()
                }
                StatementChoice::Skip => unreachable!(),
            };
            attach
                .execute(params![
                    account_id,
                    statement.bank_id,
                    statement.account_number,
                    row.fit_id,
                    id,
                    row.date
                ])
                .map_err(database_error)?;
        }
    }
    tx.commit().map_err(database_error)?;
    Ok(result)
}

fn divers(db: &Connection) -> Result<String, String> {
    if let Some(category) = db
        .query_row(
            "SELECT name FROM categories WHERE parent_id IS NULL AND name='Divers' COLLATE NOCASE",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(database_error)?
    {
        return Ok(category);
    }
    db.execute(
        "INSERT INTO categories (id,name) VALUES (?1,'Divers')",
        [Uuid::new_v4().to_string()],
    )
    .map_err(database_error)?;
    Ok("Divers".into())
}

#[cfg(test)]
#[path = "bank_import_tests.rs"]
mod tests;
