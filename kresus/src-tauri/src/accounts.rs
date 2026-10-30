use crate::database::{AppState, database_error};
use rusqlite::{Connection, params};
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
    #[serde(default, skip_deserializing)]
    pub(crate) current_balance: i64,
}

#[tauri::command]
/// Returns opening and current balances in cents for all accounts.
pub fn list_accounts(state: tauri::State<'_, AppState>) -> Result<Vec<Account>, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    list_accounts_in_db(&connection)
}

pub(crate) fn list_accounts_in_db(connection: &Connection) -> Result<Vec<Account>, String> {
    // Sum the stored integer cents, including unreconciled operations.
    let mut statement = connection.prepare("SELECT a.id, a.name, a.kind, a.opening_balance_cents, a.bank, a.opening_balance_cents + COALESCE(SUM(t.amount_cents), 0) FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id GROUP BY a.id ORDER BY a.kind, a.name").map_err(database_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(Account {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                opening_balance: row.get(3)?,
                bank: row.get(4)?,
                current_balance: row.get(5)?,
            })
        })
        .map_err(database_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
}

#[tauri::command]
/// Creates an account with its opening balance stored in cents.
pub fn create_account(account: Account, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    create_account_in_db(&connection, account)
}

pub(crate) fn create_account_in_db(
    connection: &Connection,
    account: Account,
) -> Result<(), String> {
    let name = account.name.trim();
    let bank = account.bank.trim();
    if name.is_empty()
        || !matches!(
            account.kind.as_str(),
            "Compte courant" | "Épargne" | "Assurance vie"
        )
    {
        return Err("Veuillez saisir un nom et un type de compte valide.".to_string());
    }
    if account.opening_balance.unsigned_abs() > 100_000_000_000 {
        return Err("Le solde initial est invalide.".to_string());
    }
    connection.execute("INSERT INTO accounts (id, name, kind, opening_balance_cents, bank) VALUES (?1, ?2, ?3, ?4, ?5)", params![account.id, name, account.kind, account.opening_balance, bank]).map_err(database_error)?;
    Ok(())
}
