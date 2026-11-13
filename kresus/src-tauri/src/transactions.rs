use crate::database::{AppState, database_error};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[cfg(test)]
#[path = "transactions_tests.rs"]
mod tests;

// The monetary fields of all command payloads are integer cents.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub(crate) id: String,
    pub(crate) account_id: String,
    pub(crate) date: String,
    pub(crate) label: String,
    pub(crate) category: String,
    pub(crate) cheque: Option<String>,
    pub(crate) amount: i64,
    pub(crate) reconciled: bool,
    pub(crate) note: Option<String>,
    pub(crate) transfer_id: Option<String>,
    pub(crate) reference: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTransfer {
    pub(crate) id: String,
    pub(crate) source_id: String,
    pub(crate) destination_id: String,
    pub(crate) date: String,
    pub(crate) amount: i64,
    pub(crate) category: String,
    pub(crate) note: String,
    #[serde(default)]
    pub(crate) debit_reference: Option<String>,
    #[serde(default)]
    pub(crate) credit_reference: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTransaction {
    pub(crate) id: String,
    pub(crate) account_id: String,
    pub(crate) date: String,
    pub(crate) label: String,
    pub(crate) category: String,
    pub(crate) cheque: Option<String>,
    pub(crate) amount: i64,
    // Missing notes preserve existing data on updates from older clients.
    #[serde(default)]
    pub(crate) note: Option<String>,
    #[serde(default)]
    pub(crate) reference: Option<String>,
}

#[tauri::command]
/// Returns an account's operations in date and ID order.
pub fn list_transactions(
    account_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Transaction>, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    list_transactions_in_db(&connection, &account_id)
}

pub(crate) fn list_transactions_in_db(
    connection: &Connection,
    account_id: &str,
) -> Result<Vec<Transaction>, String> {
    let mut statement = connection.prepare("SELECT t.id, t.account_id, t.operation_date, t.label, t.category, t.cheque, t.amount_cents, t.reconciled, t.note, x.id, t.reference FROM transactions t LEFT JOIN transfers x ON x.debit_id=t.id OR x.credit_id=t.id WHERE t.account_id = ?1 ORDER BY t.operation_date, t.id").map_err(database_error)?;
    let rows = statement
        .query_map([account_id], |row| {
            Ok(Transaction {
                id: row.get(0)?,
                account_id: row.get(1)?,
                date: row.get(2)?,
                label: row.get(3)?,
                category: row.get(4)?,
                cheque: row.get(5)?,
                amount: row.get(6)?,
                reconciled: row.get::<_, i64>(7)? != 0,
                note: row.get(8)?,
                transfer_id: row.get(9)?,
                reference: row.get(10)?,
            })
        })
        .map_err(database_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
}

// The chart exchanges daily balances in integer cents.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalancePoint {
    date: String,
    balance: i64,
}

#[tauri::command]
pub fn balance_history(
    account_id: String,
    today: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<BalancePoint>, String> {
    let db = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    balance_history_in_db(&db, &account_id, &today)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForecastTransaction {
    date: String,
    label: String,
    amount: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForecastTransactions {
    balance: i64,
    transactions: Vec<ForecastTransaction>,
}

#[tauri::command]
pub fn forecast_transactions(
    account_id: String,
    today: String,
    end: String,
    state: tauri::State<'_, AppState>,
) -> Result<ForecastTransactions, String> {
    let db = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    forecast_transactions_in_db(&db, &account_id, &today, &end)
}

fn forecast_transactions_in_db(
    db: &Connection,
    account_id: &str,
    today: &str,
    end: &str,
) -> Result<ForecastTransactions, String> {
    let valid: bool = db.query_row("SELECT COALESCE(length(?1)=10 AND date(?1,'+0 days')=?1 AND length(?2)=10 AND date(?2,'+0 days')=?2 AND ?2>=?1,0)", params![today,end], |r| r.get(0)).map_err(database_error)?;
    if !valid {
        return Err("Période invalide.".into());
    }
    // Future-dated entries are kept out of the opening balance and returned separately.
    let balance = db.query_row("SELECT opening_balance_cents + COALESCE((SELECT SUM(amount_cents) FROM transactions WHERE account_id=?1 AND operation_date<=?2),0) FROM accounts WHERE id=?1", params![account_id,today], |r| r.get(0)).optional().map_err(database_error)?.ok_or_else(|| "Compte introuvable.".to_string())?;
    let mut statement = db.prepare("SELECT operation_date,label,amount_cents FROM transactions WHERE account_id=?1 AND operation_date>?2 AND operation_date<=?3 ORDER BY operation_date,id").map_err(database_error)?;
    let transactions = statement
        .query_map(params![account_id, today, end], |r| {
            Ok(ForecastTransaction {
                date: r.get(0)?,
                label: r.get(1)?,
                amount: r.get(2)?,
            })
        })
        .map_err(database_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(database_error)?;
    Ok(ForecastTransactions {
        balance,
        transactions,
    })
}

fn balance_history_in_db(
    db: &Connection,
    account_id: &str,
    today: &str,
) -> Result<Vec<BalancePoint>, String> {
    let valid: bool = db
        .query_row(
            "SELECT COALESCE(length(?1)=10 AND date(?1,'+0 days')=?1,0)",
            [today],
            |r| r.get(0),
        )
        .map_err(database_error)?;
    if !valid {
        return Err("Date invalide.".into());
    }
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM accounts WHERE id=?1)",
            [account_id],
            |r| r.get(0),
        )
        .map_err(database_error)?;
    if !exists {
        return Err("Compte introuvable.".into());
    }
    // Keep the beginning and end of the period, plus one point per day with activity.
    let mut statement = db.prepare("WITH movements AS (
        SELECT operation_date AS day, SUM(amount_cents) AS amount FROM transactions
        WHERE account_id=?1 AND operation_date>=date(?2,'start of month','-11 months') AND operation_date<=?2 GROUP BY operation_date
      ), dates AS (
        SELECT date(?2,'start of month','-11 months') AS day
        UNION SELECT day FROM movements UNION SELECT ?2
      ), baseline AS (
        SELECT opening_balance_cents + COALESCE((SELECT SUM(amount_cents) FROM transactions WHERE account_id=?1 AND operation_date<date(?2,'start of month','-11 months')),0) AS amount
        FROM accounts WHERE id=?1
      )
      SELECT dates.day, baseline.amount + SUM(COALESCE(movements.amount,0)) OVER (ORDER BY dates.day)
      FROM dates CROSS JOIN baseline LEFT JOIN movements ON movements.day=dates.day ORDER BY dates.day").map_err(database_error)?;
    let rows = statement
        .query_map(params![account_id, today], |r| {
            Ok(BalancePoint {
                date: r.get(0)?,
                balance: r.get(1)?,
            })
        })
        .map_err(database_error)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(database_error)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRow {
    #[serde(flatten)]
    transaction: Transaction,
    running_balance: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterPage {
    rows: Vec<RegisterRow>,
    total_count: i64,
    filtered_count: i64,
    unreconciled_count: i64,
    income: i64,
    expenses: i64,
    credit_count: i64,
    debit_count: i64,
    page: i64,
    page_count: i64,
}

#[tauri::command]
/// Loads one filtered register page and account-wide summaries in cents.
pub fn list_register(
    account_id: String,
    filter: String,
    page: i64,
    month: String,
    search: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<RegisterPage, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    list_register_in_db(
        &connection,
        &account_id,
        &filter,
        page,
        &month,
        search.as_deref().unwrap_or(""),
    )
}

pub(crate) fn list_register_in_db(
    db: &Connection,
    account_id: &str,
    filter: &str,
    page: i64,
    month: &str,
    search: &str,
) -> Result<RegisterPage, String> {
    let predicate = match filter {
        "all" => "1",
        "unreconciled" => "reconciled = 0",
        "reconciled" => "reconciled = 1",
        "debit" => "amount_cents < 0",
        "credit" => "amount_cents > 0",
        "month-debit" => "amount_cents < 0 AND substr(operation_date,1,7)=?2",
        "month-credit" => "amount_cents > 0 AND substr(operation_date,1,7)=?2",
        _ => return Err("Filtre invalide.".into()),
    };
    if page < 1
        || page > 10_000_000
        || month.len() != 7
        || !month.bytes().enumerate().all(|(i, b)| {
            if i == 4 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
    {
        return Err("Page ou mois invalide.".into());
    }
    // SQLite's built-in case folding is ASCII-only; preserve Unicode case matching.
    db.create_scalar_function(
        "text_contains",
        2,
        rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let value = ctx.get::<Option<String>>(0)?.unwrap_or_default();
            let needle = ctx.get::<String>(1)?;
            Ok(value.to_lowercase().contains(&needle))
        },
    )
    .map_err(database_error)?;
    let search = search.trim().to_lowercase();
    let predicate = format!(
        "({predicate}) AND (?3 = '' OR text_contains(label,?3) OR text_contains(category,?3) OR text_contains(cheque,?3) OR text_contains(note,?3) OR text_contains(reference,?3))"
    );
    let sql = format!(
        "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN {predicate} THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(reconciled = 0), 0),
                COALESCE(SUM(CASE WHEN substr(operation_date, 1, 7) = ?2 AND amount_cents > 0 THEN amount_cents ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN substr(operation_date, 1, 7) = ?2 AND amount_cents < 0 THEN amount_cents ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN substr(operation_date, 1, 7) = ?2 AND amount_cents > 0 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN substr(operation_date, 1, 7) = ?2 AND amount_cents < 0 THEN 1 ELSE 0 END), 0)
         FROM transactions
         WHERE account_id = ?1"
    );
    let (
        total_count,
        filtered_count,
        unreconciled_count,
        income,
        expenses,
        credit_count,
        debit_count,
    ): (i64, i64, i64, i64, i64, i64, i64) = db
        .query_row(&sql, params![account_id, month, search], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })
        .map_err(database_error)?;
    let page_count = ((filtered_count + 99) / 100).max(1);
    let page = page.min(page_count);
    // Select the visible page first, then calculate balances over its complete
    // unfiltered span. Hidden rows between visible entries still affect balances.
    let sql = format!(
        "WITH selected AS MATERIALIZED (
           SELECT id, operation_date FROM transactions
           WHERE account_id=?1 AND {predicate}
           ORDER BY operation_date DESC, id DESC LIMIT 100 OFFSET ?4
         ), bounds AS (
           SELECT
             (SELECT operation_date FROM selected ORDER BY operation_date, id LIMIT 1) AS first_date,
             (SELECT id FROM selected ORDER BY operation_date, id LIMIT 1) AS first_id,
             (SELECT operation_date FROM selected ORDER BY operation_date DESC, id DESC LIMIT 1) AS last_date,
             (SELECT id FROM selected ORDER BY operation_date DESC, id DESC LIMIT 1) AS last_id
         ), baseline AS (
           SELECT a.opening_balance_cents + COALESCE((
             SELECT SUM(amount_cents) FROM transactions, bounds
             WHERE account_id=?1 AND (operation_date,id)<(bounds.first_date,bounds.first_id)
           ),0) AS amount FROM accounts a WHERE a.id=?1
         ), history AS (
           SELECT t.*, baseline.amount + SUM(t.amount_cents) OVER (
                      ORDER BY t.operation_date, t.id ROWS UNBOUNDED PRECEDING
                  ) AS running_balance
           FROM transactions t CROSS JOIN bounds CROSS JOIN baseline
           WHERE t.account_id=?1
             AND (t.operation_date,t.id)>=(bounds.first_date,bounds.first_id)
             AND (t.operation_date,t.id)<=(bounds.last_date,bounds.last_id)
         )
         SELECT h.id, h.account_id, h.operation_date, h.label, h.category, h.cheque,
                h.amount_cents, h.reconciled, h.note, x.id, h.running_balance, h.reference
         FROM history h
         JOIN selected s ON s.id=h.id
         LEFT JOIN transfers x ON x.debit_id = h.id OR x.credit_id = h.id
         ORDER BY h.operation_date DESC, h.id DESC"
    );
    let mut statement = db.prepare(&sql).map_err(database_error)?;
    let rows = statement
        .query_map(
            params![account_id, month, search, (page - 1) * 100],
            |row| {
                Ok(RegisterRow {
                    transaction: Transaction {
                        id: row.get(0)?,
                        account_id: row.get(1)?,
                        date: row.get(2)?,
                        label: row.get(3)?,
                        category: row.get(4)?,
                        cheque: row.get(5)?,
                        amount: row.get(6)?,
                        reconciled: row.get::<_, i64>(7)? != 0,
                        note: row.get(8)?,
                        transfer_id: row.get(9)?,
                        reference: row.get(11)?,
                    },
                    running_balance: row.get(10)?,
                })
            },
        )
        .map_err(database_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(database_error)?;
    Ok(RegisterPage {
        rows,
        total_count,
        filtered_count,
        unreconciled_count,
        income,
        expenses,
        credit_count,
        debit_count,
        page,
        page_count,
    })
}

#[tauri::command]
/// Suggest payees already used in any account, excluding generated transfer labels.
pub fn list_payees(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    list_payees_in_db(&connection)
}

pub(crate) fn list_payees_in_db(connection: &Connection) -> Result<Vec<String>, String> {
    let mut statement = connection.prepare("SELECT MIN(TRIM(t.label)) FROM transactions t WHERE TRIM(t.label) <> '' AND NOT EXISTS (SELECT 1 FROM transfers x WHERE x.debit_id=t.id OR x.credit_id=t.id) GROUP BY TRIM(t.label) COLLATE NOCASE ORDER BY MIN(TRIM(t.label)) COLLATE NOCASE").map_err(database_error)?;
    let rows = statement
        .query_map([], |row| row.get(0))
        .map_err(database_error)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(database_error)
}

#[tauri::command]
/// Creates the two sides of a transfer in one database transaction.
pub fn create_transfer(
    transfer: NewTransfer,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut db = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    create_transfer_in_db(&mut db, transfer)
}

pub(crate) fn create_transfer_in_db(
    db: &mut Connection,
    transfer: NewTransfer,
) -> Result<(), String> {
    validate_transfer(db, &transfer)?;
    let tx = db.transaction().map_err(database_error)?;
    insert_transfer_in_tx(&tx, &transfer)?;
    tx.commit().map_err(database_error)
}

// Shared by immediate transfers and recurring transfers in an existing transaction.
pub(crate) fn insert_transfer_in_tx(
    tx: &rusqlite::Transaction<'_>,
    transfer: &NewTransfer,
) -> Result<(), String> {
    let name = |id: &str| -> Result<String, String> {
        tx.query_row("SELECT name FROM accounts WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .map_err(|_| "Compte introuvable.".to_string())
    };
    let source = name(&transfer.source_id)?;
    let destination = name(&transfer.destination_id)?;
    let debit_id = format!("{}-debit", transfer.id);
    let credit_id = format!("{}-credit", transfer.id);
    let cents = transfer.amount;
    let note = transfer.note.trim();
    tx.execute("INSERT INTO transactions (id,account_id,operation_date,label,category,amount_cents,note,reference) VALUES (?1,?2,?3,?4,?5,?6,?7,NULLIF(TRIM(?8),''))", params![debit_id,transfer.source_id,transfer.date,format!("Virement vers {destination}"),transfer.category.trim(),-cents,note,transfer.debit_reference.as_deref()]).map_err(database_error)?;
    tx.execute("INSERT INTO transactions (id,account_id,operation_date,label,category,amount_cents,note,reference) VALUES (?1,?2,?3,?4,?5,?6,?7,NULLIF(TRIM(?8),''))", params![credit_id,transfer.destination_id,transfer.date,format!("Virement depuis {source}"),transfer.category.trim(),cents,note,transfer.credit_reference.as_deref()]).map_err(database_error)?;
    tx.execute(
        "INSERT INTO transfers (id,debit_id,credit_id) VALUES (?1,?2,?3)",
        params![transfer.id, debit_id, credit_id],
    )
    .map_err(database_error)?;
    Ok(())
}

// Validate inputs consistently for creation and modification.
fn validate_transfer(db: &Connection, transfer: &NewTransfer) -> Result<(), String> {
    crate::text_limits::validate_reference_length(transfer.debit_reference.as_deref())?;
    crate::text_limits::validate_reference_length(transfer.credit_reference.as_deref())?;
    if transfer.id.trim().is_empty()
        || transfer.source_id == transfer.destination_id
        || transfer.category.trim().is_empty()
    {
        return Err("Choisissez deux comptes différents et une catégorie.".into());
    }
    if transfer.amount < 1 || transfer.amount > 100_000_000_000 {
        return Err("Saisissez un montant positif en euros et centimes.".into());
    }
    let valid_date: bool = db
        .query_row(
            "SELECT COALESCE(length(?1)=10 AND date(?1, '+0 days')=?1, 0)",
            [&transfer.date],
            |row| row.get(0),
        )
        .map_err(database_error)?;
    if !valid_date {
        return Err("Date de virement invalide.".into());
    }
    Ok(())
}

#[tauri::command]
/// Returns the original direction and common fields of a linked transfer.
pub fn get_transfer(id: String, state: tauri::State<'_, AppState>) -> Result<NewTransfer, String> {
    let db = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    get_transfer_in_db(&db, &id)
}

fn get_transfer_in_db(db: &Connection, id: &str) -> Result<NewTransfer, String> {
    db.query_row("SELECT x.id, d.account_id, c.account_id, d.operation_date, -d.amount_cents, d.category, COALESCE(d.note,''), d.reference, c.reference FROM transfers x JOIN transactions d ON d.id=x.debit_id JOIN transactions c ON c.id=x.credit_id WHERE x.id=?1", [id], |r| Ok(NewTransfer { id:r.get(0)?, source_id:r.get(1)?, destination_id:r.get(2)?, date:r.get(3)?, amount:r.get(4)?, category:r.get(5)?, note:r.get(6)?, debit_reference:r.get(7)?, credit_reference:r.get(8)? })).optional().map_err(database_error)?.ok_or_else(|| "Virement introuvable.".into())
}

#[tauri::command]
/// Atomically updates both sides while preserving each reconciliation flag.
pub fn update_transfer(
    transfer: NewTransfer,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut db = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    update_transfer_in_db(&mut db, transfer)
}

pub(crate) fn update_transfer_in_db(
    db: &mut Connection,
    transfer: NewTransfer,
) -> Result<(), String> {
    validate_transfer(db, &transfer)?;
    let tx = db.transaction().map_err(database_error)?;
    let (debit, credit): (String, String) = tx
        .query_row(
            "SELECT debit_id,credit_id FROM transfers WHERE id=?1",
            [&transfer.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(database_error)?
        .ok_or_else(|| "Virement introuvable.".to_string())?;
    let name = |id: &str| -> Result<String, String> {
        tx.query_row("SELECT name FROM accounts WHERE id=?1", [id], |r| r.get(0))
            .map_err(|_| "Compte introuvable.".to_string())
    };
    let source = name(&transfer.source_id)?;
    let destination = name(&transfer.destination_id)?;
    let cents = transfer.amount;
    for (id, account, label, amount, reference) in [
        (
            debit,
            &transfer.source_id,
            format!("Virement vers {destination}"),
            -cents,
            &transfer.debit_reference,
        ),
        (
            credit,
            &transfer.destination_id,
            format!("Virement depuis {source}"),
            cents,
            &transfer.credit_reference,
        ),
    ] {
        let changed = tx.execute("UPDATE transactions SET account_id=?1, operation_date=?2, label=?3, category=?4, amount_cents=?5, note=?6, reference=CASE WHEN ?8 IS NULL THEN reference ELSE NULLIF(TRIM(?8),'') END WHERE id=?7", params![account,transfer.date,label,transfer.category.trim(),amount,transfer.note.trim(),id,reference]).map_err(database_error)?;
        if changed != 1 {
            return Err("Opération liée introuvable.".into());
        }
    }
    tx.commit().map_err(database_error)
}

#[tauri::command]
/// Stores a new operation in cents.
pub fn create_transaction(
    transaction: NewTransaction,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    create_transaction_in_db(&connection, transaction)
}

pub(crate) fn create_transaction_in_db(
    connection: &Connection,
    transaction: NewTransaction,
) -> Result<(), String> {
    validate_transaction_amount(transaction.amount)?;
    crate::text_limits::validate_reference_length(transaction.reference.as_deref())?;
    validate_cheque(transaction.cheque.as_deref())?;
    crate::text_limits::validate_name_length(&transaction.label, false)?;
    let cents = transaction.amount;
    connection.execute("INSERT INTO transactions (id, account_id, operation_date, label, category, cheque, amount_cents, note, reference) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULLIF(?8, ''), NULLIF(?9, ''))", params![transaction.id, transaction.account_id, transaction.date, transaction.label.trim(), transaction.category.trim(), transaction.cheque.as_deref().map(str::trim), cents, transaction.note.as_deref().map(str::trim), transaction.reference.as_deref().map(str::trim)]).map_err(database_error)?;
    Ok(())
}

#[tauri::command]
/// Switches an operation's manual reconciliation state.
pub fn toggle_transaction_reconciliation(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    toggle_transaction_in_db(&connection, &id)
}

pub(crate) fn toggle_transaction_in_db(connection: &Connection, id: &str) -> Result<(), String> {
    connection
        .execute(
            "UPDATE transactions SET reconciled = 1 - reconciled WHERE id = ?1",
            [id],
        )
        .map_err(database_error)?;
    Ok(())
}

#[tauri::command]
/// Updates an operation in its original account, preserving its reconciliation state.
pub fn update_transaction(
    transaction: NewTransaction,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    update_transaction_in_db(&connection, transaction)
}

pub(crate) fn update_transaction_in_db(
    connection: &Connection,
    transaction: NewTransaction,
) -> Result<(), String> {
    validate_transaction_amount(transaction.amount)?;
    crate::text_limits::validate_reference_length(transaction.reference.as_deref())?;
    validate_cheque(transaction.cheque.as_deref())?;
    let unchanged: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM transactions WHERE id=?1 AND account_id=?2 AND label=?3)",
            params![
                transaction.id,
                transaction.account_id,
                transaction.label.trim()
            ],
            |row| row.get(0),
        )
        .map_err(database_error)?;
    crate::text_limits::validate_name_length(&transaction.label, unchanged)?;
    let linked: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM transfers WHERE debit_id=?1 OR credit_id=?1)",
            [&transaction.id],
            |row| row.get(0),
        )
        .map_err(database_error)?;
    if linked {
        return Err("La modification d’un virement lié n’est pas encore disponible.".into());
    }
    let changed = connection.execute("UPDATE transactions SET operation_date = ?1, label = ?2, category = ?3, cheque = ?4, amount_cents = ?5, note = CASE WHEN ?8 IS NULL THEN note ELSE NULLIF(?8, '') END, reference = CASE WHEN ?9 IS NULL THEN reference ELSE NULLIF(TRIM(?9), '') END WHERE id = ?6 AND account_id = ?7", params![transaction.date, transaction.label.trim(), transaction.category.trim(), transaction.cheque.as_deref().map(str::trim), transaction.amount, transaction.id, transaction.account_id, transaction.note.as_deref().map(str::trim), transaction.reference.as_deref().map(str::trim)]).map_err(database_error)?;
    if changed == 0 {
        return Err("Opération introuvable.".to_string());
    }
    Ok(())
}

// A cheque reference is optional, but when supplied it must contain seven ASCII digits.
pub(crate) fn validate_cheque(cheque: Option<&str>) -> Result<(), String> {
    if let Some(number) = cheque.map(str::trim).filter(|number| !number.is_empty()) {
        if number.len() != 7 || !number.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err("Le numéro de chèque doit comporter 7 chiffres.".into());
        }
    }
    Ok(())
}

fn validate_transaction_amount(cents: i64) -> Result<(), String> {
    if cents == 0 || cents.unsigned_abs() > 100_000_000_000 {
        return Err("Montant d’opération invalide.".into());
    }
    Ok(())
}

#[tauri::command]
/// Removes an operation by ID.
pub fn delete_transaction(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    delete_transaction_in_db(&connection, &id)
}

pub(crate) fn delete_transaction_in_db(connection: &Connection, id: &str) -> Result<(), String> {
    // Read both IDs before deletion; the transfer link is removed by foreign-key cascade.
    let tx = connection.unchecked_transaction().map_err(database_error)?;
    let pair: Option<(String, String)> = tx
        .query_row(
            "SELECT debit_id,credit_id FROM transfers WHERE debit_id=?1 OR credit_id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(database_error)?;
    if let Some((debit, credit)) = pair {
        tx.execute(
            "DELETE FROM transactions WHERE id IN (?1,?2)",
            params![debit, credit],
        )
        .map_err(database_error)?;
    } else {
        tx.execute("DELETE FROM transactions WHERE id=?1", [id])
            .map_err(database_error)?;
    }
    tx.commit().map_err(database_error)
}
