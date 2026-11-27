use crate::database::{AppState, database_error};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

#[cfg(test)]
#[path = "accounts_tests.rs"]
mod tests;

// Opening and current balances use integer cents in command payloads.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) opening_balance: i64,
    pub(crate) bank: String,
    pub(crate) account_number: Option<String>,
    #[serde(default, skip_deserializing)]
    pub(crate) archived: bool,
    #[serde(default, skip_deserializing)]
    pub(crate) current_balance: i64,
    #[serde(default, skip_deserializing)]
    pub(crate) balance_with_future: i64,
}

#[tauri::command]
/// Returns opening and current balances in cents for all accounts.
pub fn list_accounts(
    today: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Account>, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    list_accounts_in_db(&connection, &today)
}

pub(crate) fn list_accounts_in_db(
    connection: &Connection,
    today: &str,
) -> Result<Vec<Account>, String> {
    // The current balance uses the same local date cutoff as the forecast.
    let mut statement = connection.prepare("SELECT a.id, a.name, a.kind, a.opening_balance_cents, a.bank, a.account_number, ar.account_id IS NOT NULL,
        a.opening_balance_cents + COALESCE(SUM(t.amount_cents) FILTER (WHERE t.operation_date <= ?1), 0),
        a.opening_balance_cents + COALESCE(SUM(t.amount_cents), 0) FROM accounts a LEFT JOIN archived_accounts ar ON ar.account_id=a.id LEFT JOIN transactions t ON t.account_id = a.id GROUP BY a.id ORDER BY a.kind, a.name").map_err(database_error)?;
    let rows = statement
        .query_map([today], |row| {
            Ok(Account {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                opening_balance: row.get(3)?,
                bank: row.get(4)?,
                account_number: row.get(5)?,
                archived: row.get(6)?,
                current_balance: row.get(7)?,
                balance_with_future: row.get(8)?,
            })
        })
        .map_err(database_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
}

#[tauri::command]
/// Creates an account with its opening balance stored in cents.
pub fn create_account(account: Account, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut connection = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    create_account_in_db(&mut connection, account)
}

pub(crate) fn create_account_in_db(
    connection: &mut Connection,
    account: Account,
) -> Result<(), String> {
    let name = account.name.trim();
    let bank = account.bank.trim();
    let account_number = normalize_account_number(account.account_number.as_deref())?;
    crate::text_limits::validate_name_length(name, false)?;
    crate::text_limits::validate_name_length(bank, false)?;
    if name.is_empty() || !valid_account_kind(&account.kind) {
        return Err("Veuillez saisir un nom et un type de compte valide.".to_string());
    }
    if account.opening_balance.unsigned_abs() > 100_000_000_000 {
        return Err("Le solde initial est invalide.".to_string());
    }
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(database_error)?;
    check_account_uniqueness(&tx, None, Some(name), account_number)?;
    tx.execute("INSERT INTO accounts (id, name, kind, opening_balance_cents, bank, account_number) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![account.id, name, account.kind, account.opening_balance, bank, account_number]).map_err(database_error)?;
    tx.commit().map_err(database_error)
}

pub(crate) fn valid_account_kind(kind: &str) -> bool {
    matches!(kind, "Compte courant" | "Épargne" | "Assurance vie")
}

fn check_account_uniqueness(
    db: &Connection,
    current_id: Option<&str>,
    name: Option<&str>,
    number: Option<&str>,
) -> Result<(), String> {
    if name.is_none() && number.is_none() {
        return Ok(());
    }
    let name = name.map(str::to_lowercase);
    let number = number.map(account_number_key);
    let mut statement = db
        .prepare("SELECT name, account_number FROM accounts WHERE id IS NOT ?1")
        .map_err(database_error)?;
    let mut rows = statement.query([current_id]).map_err(database_error)?;
    while let Some(row) = rows.next().map_err(database_error)? {
        let existing_name: String = row.get(0).map_err(database_error)?;
        if name
            .as_ref()
            .is_some_and(|name| *name == existing_name.trim().to_lowercase())
        {
            return Err("Ce nom de compte est déjà utilisé.".into());
        }
        let existing_number: Option<String> = row.get(1).map_err(database_error)?;
        if let (Some(number), Some(existing_number)) = (&number, existing_number)
            && *number == account_number_key(&existing_number)
        {
            return Err("Ce numéro de compte est déjà utilisé.".into());
        }
    }
    Ok(())
}

fn account_number_key(number: &str) -> String {
    number.replace(char::is_whitespace, "").to_lowercase()
}

fn normalize_account_number(value: Option<&str>) -> Result<Option<&str>, String> {
    let value = value.map(str::trim).filter(|number| !number.is_empty());
    if let Some(number) = value {
        crate::text_limits::validate_name_length(number, false)?;
    }
    Ok(value)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSettings {
    name: String,
    kind: Option<String>,
    bank: String,
    account_number: Option<String>,
    archived: bool,
}

#[tauri::command]
pub fn update_account(
    id: String,
    settings: AccountSettings,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut connection = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    update_account_in_db(&mut connection, &id, &settings)
}

fn update_account_in_db(
    db: &mut Connection,
    id: &str,
    settings: &AccountSettings,
) -> Result<(), String> {
    let name = settings.name.trim();
    let bank = settings.bank.trim();
    let account_number = settings
        .account_number
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if name.is_empty() {
        return Err("Saisissez un nom de compte.".into());
    }
    if settings
        .kind
        .as_deref()
        .is_some_and(|kind| !valid_account_kind(kind))
    {
        return Err("Choisissez un type de compte valide.".into());
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(database_error)?;
    let (old_name, old_bank, old_number): (String, String, Option<String>) = tx
        .query_row(
            "SELECT name,bank,account_number FROM accounts WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(database_error)?
        .ok_or("Compte introuvable.")?;
    crate::text_limits::validate_name_length(name, name == old_name)?;
    crate::text_limits::validate_name_length(bank, bank == old_bank)?;
    if let Some(number) = account_number {
        crate::text_limits::validate_name_length(number, Some(number) == old_number.as_deref())?;
    }
    // Existing duplicates can be corrected one field at a time.
    check_account_uniqueness(
        &tx,
        Some(id),
        (name != old_name.trim()).then_some(name),
        account_number.filter(|number| Some(*number) != old_number.as_deref().map(str::trim)),
    )?;
    tx.execute(
        "UPDATE accounts SET name=?1, bank=?2, account_number=?3, kind=COALESCE(?4, kind) WHERE id=?5",
        params![name, bank, account_number, settings.kind, id],
    )
    .map_err(database_error)?;
    if settings.archived {
        tx.execute(
            "INSERT OR IGNORE INTO archived_accounts (account_id) VALUES (?1)",
            [id],
        )
        .map_err(database_error)?;
    } else {
        tx.execute("DELETE FROM archived_accounts WHERE account_id=?1", [id])
            .map_err(database_error)?;
    }
    tx.commit().map_err(database_error)
}
