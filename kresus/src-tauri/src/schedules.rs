use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use crate::database::{AppState, database_error};
use crate::transactions::{insert_transfer_in_tx, NewTransfer};

#[cfg(test)]
#[path = "schedules_tests.rs"]
mod tests;

// Occurrence and series amounts use integer cents throughout the API.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub(crate) id: String,
    pub(crate) account_id: String,
    pub(crate) label: String,
    pub(crate) category: String,
    pub(crate) next_due: String,
    pub(crate) frequency: String,
    pub(crate) amount: i64,
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) destination_account_id: Option<String>,
    #[serde(default, skip_deserializing)]
    pub(crate) series: Option<ScheduleSeries>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduleSeries {
    pub(crate) account_id: String, label: String, category: String, next_due: String, amount: i64, kind: String, anchor_day: i64, destination_account_id: Option<String>,
}

#[tauri::command]
/// Returns the next occurrence of each schedule.
pub fn list_schedules(state: tauri::State<'_, AppState>) -> Result<Vec<Schedule>, String> {
    let connection = state.database.lock().map_err(|_| "La base de données est indisponible.".to_string())?;
    list_schedules_in_db(&connection)
}

fn list_schedules_in_db(connection: &Connection) -> Result<Vec<Schedule>, String> {
    let mut statement = connection.prepare("SELECT s.id, COALESCE(o.account_id,s.account_id), COALESCE(o.label,s.label), COALESCE(o.category,s.category), COALESCE(o.due_date,s.next_due), s.frequency, COALESCE(o.amount_cents,s.amount_cents), CASE WHEN (CASE WHEN o.schedule_id IS NOT NULL THEN ot.destination_account_id ELSE st.destination_account_id END) IS NOT NULL THEN 'transfer' ELSE COALESCE(o.kind,s.kind) END, s.account_id, s.label, s.category, s.next_due, s.amount_cents, CASE WHEN st.destination_account_id IS NOT NULL THEN 'transfer' ELSE s.kind END, a.anchor_day, CASE WHEN o.schedule_id IS NOT NULL THEN ot.destination_account_id ELSE st.destination_account_id END, st.destination_account_id FROM schedules s LEFT JOIN schedule_overrides o ON o.schedule_id = s.id LEFT JOIN schedule_transfers st ON st.schedule_id=s.id LEFT JOIN schedule_transfer_overrides ot ON ot.schedule_id=s.id JOIN schedule_anchors a ON a.schedule_id = s.id ORDER BY COALESCE(o.due_date,s.next_due), s.id").map_err(database_error)?;
    let rows = statement.query_map([], |row| Ok(Schedule {
        id: row.get(0)?, account_id: row.get(1)?, label: row.get(2)?, category: row.get(3)?, next_due: row.get(4)?, frequency: row.get(5)?, amount: row.get(6)?, kind: row.get(7)?, destination_account_id: row.get(15)?, series: Some(ScheduleSeries { account_id: row.get(8)?, label: row.get(9)?, category: row.get(10)?, next_due: row.get(11)?, amount: row.get(12)?, kind: row.get(13)?, anchor_day: row.get(14)?, destination_account_id: row.get(16)? }),
    })).map_err(database_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(database_error)
}

#[tauri::command]
/// Creates a recurring debit or credit, with its next occurrence stored in SQLite.
pub fn create_schedule(schedule: Schedule, state: tauri::State<'_, AppState>) -> Result<(), String> {
    save_schedule(schedule, state, false)
}

#[tauri::command]
/// Deletes a series without removing operations already recorded from it.
pub fn delete_schedule(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let connection = state.database.lock().map_err(|_| "La base de données est indisponible.".to_string())?;
    delete_schedule_in_db(&connection, &id)
}

fn delete_schedule_in_db(connection: &Connection, id: &str) -> Result<(), String> {
    // Foreign keys remove the series' anchor, overrides and transfer settings.
    let deleted = connection.execute("DELETE FROM schedules WHERE id = ?1", [id]).map_err(database_error)?;
    if deleted == 0 { return Err("Échéance introuvable.".into()); }
    Ok(())
}

#[tauri::command]
/// Updates an existing recurring schedule and its next occurrence.
pub fn update_schedule(schedule: Schedule, scope: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    if !matches!(scope.as_str(), "occurrence" | "series") { return Err("Portée de modification invalide.".into()); }
    save_schedule_with_scope(schedule, state, Some(scope.as_str()))
}

fn save_schedule(schedule: Schedule, state: tauri::State<'_, AppState>, update: bool) -> Result<(), String> {
    save_schedule_with_scope(schedule, state, if update { Some("series") } else { None })
}

fn save_schedule_with_scope(schedule: Schedule, state: tauri::State<'_, AppState>, scope: Option<&str>) -> Result<(), String> {
    let mut connection = state.database.lock().map_err(|_| "La base de données est indisponible.".to_string())?;
    save_schedule_in_db(&mut connection, schedule, scope)
}

// The database operations are independent of the Tauri runtime for isolated tests.
pub(crate) fn save_schedule_in_db(connection: &mut Connection, schedule: Schedule, scope: Option<&str>) -> Result<(), String> {
    if schedule.id.trim().is_empty() || schedule.label.trim().is_empty() || schedule.category.trim().is_empty() {
        return Err("Le libellé et la catégorie sont obligatoires.".into());
    }
    if !matches!(schedule.frequency.as_str(), "Mensuelle" | "Trimestrielle" | "Semestrielle" | "Annuelle") {
        return Err("Périodicité invalide.".into());
    }
    if schedule.amount == 0 || schedule.amount.unsigned_abs() > 100_000_000_000
        || !matches!((schedule.kind.as_str(), schedule.amount > 0), ("credit", true) | ("debit", false) | ("transfer", false)) {
        return Err("Montant ou type d’opération invalide.".into());
    }
    if schedule.kind == "transfer" && (schedule.destination_account_id.as_deref().is_none_or(|id| id.is_empty() || id == schedule.account_id)) { return Err("Choisissez deux comptes différents pour le virement.".into()); }
    let valid_date: bool = connection.query_row("SELECT COALESCE(length(?1) = 10 AND date(?1, '+0 days') = ?1, 0)", [&schedule.next_due], |row| row.get(0)).map_err(database_error)?;
    if !valid_date { return Err("Date d’échéance invalide.".into()); }
    let tx = connection.transaction().map_err(database_error)?;
    // A single-occurrence override leaves the series date and frequency intact.
    if scope == Some("occurrence") {
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM schedules WHERE id = ?1)", [&schedule.id], |row| row.get(0)).map_err(database_error)?;
        if !exists { return Err("Échéance introuvable.".into()); }
        let stored_kind = if schedule.kind == "transfer" { "debit" } else { &schedule.kind };
        tx.execute("INSERT INTO schedule_overrides (schedule_id, account_id, label, category, due_date, amount_cents, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(schedule_id) DO UPDATE SET account_id=excluded.account_id, label=excluded.label, category=excluded.category, due_date=excluded.due_date, amount_cents=excluded.amount_cents, kind=excluded.kind", params![schedule.id, schedule.account_id, schedule.label.trim(), schedule.category.trim(), schedule.next_due, schedule.amount, stored_kind]).map_err(database_error)?;
        tx.execute("DELETE FROM schedule_transfer_overrides WHERE schedule_id=?1", [&schedule.id]).map_err(database_error)?;
        if schedule.kind == "transfer" { tx.execute("INSERT INTO schedule_transfer_overrides VALUES (?1,?2)", params![schedule.id,schedule.destination_account_id]).map_err(database_error)?; }
        return tx.commit().map_err(database_error);
    }
    let previous_date: Option<String> = if scope.is_some() { tx.query_row("SELECT next_due FROM schedules WHERE id = ?1", [&schedule.id], |row| row.get(0)).ok() } else { None };
    let sql = if scope.is_some() { "UPDATE schedules SET account_id = ?2, label = ?3, category = ?4, next_due = ?5, frequency = ?6, amount_cents = ?7, kind = ?8 WHERE id = ?1" } else { "INSERT INTO schedules (id, account_id, label, category, next_due, frequency, amount_cents, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)" };
    let stored_kind = if schedule.kind == "transfer" { "debit" } else { &schedule.kind };
    let changed = tx.execute(sql, params![schedule.id, schedule.account_id, schedule.label.trim(), schedule.category.trim(), schedule.next_due, schedule.frequency, schedule.amount, stored_kind]).map_err(database_error)?;
    if changed == 0 { return Err("Échéance introuvable.".into()); }
    tx.execute("DELETE FROM schedule_transfers WHERE schedule_id=?1", [&schedule.id]).map_err(database_error)?;
    if schedule.kind == "transfer" { tx.execute("INSERT INTO schedule_transfers VALUES (?1,?2)", params![schedule.id,schedule.destination_account_id]).map_err(database_error)?; }
    if previous_date.as_deref() != Some(schedule.next_due.as_str()) {
        tx.execute("INSERT INTO schedule_anchors (schedule_id, anchor_day) VALUES (?1, CAST(strftime('%d', ?2) AS INTEGER)) ON CONFLICT(schedule_id) DO UPDATE SET anchor_day = excluded.anchor_day", params![schedule.id, schedule.next_due]).map_err(database_error)?;
    }
    tx.execute("DELETE FROM schedule_overrides WHERE schedule_id = ?1", [&schedule.id]).map_err(database_error)?;
    tx.commit().map_err(database_error)
}

#[tauri::command]
/// Creates an unpointed operation and advances the schedule's next date.
pub fn record_schedule(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let transaction_id = format!("schedule-{}", SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "L'horloge système est indisponible.".to_string())?.as_millis());
    let mut connection = state.database.lock().map_err(|_| "La base de données est indisponible.".to_string())?;
    record_schedule_in_db(&mut connection, &id, &transaction_id)
}

pub(crate) fn record_schedule_in_db(connection: &mut Connection, id: &str, transaction_id: &str) -> Result<(), String> {
    let tx = connection.transaction().map_err(database_error)?;
    // Resolve the effective occurrence, including a one-time transfer override.
    let occurrence: Option<(String, Option<String>, String, String, String, i64)> = tx.query_row("SELECT COALESCE(o.account_id,s.account_id), CASE WHEN o.schedule_id IS NOT NULL THEN ot.destination_account_id ELSE st.destination_account_id END, COALESCE(o.due_date,s.next_due), COALESCE(o.label,s.label), COALESCE(o.category,s.category), COALESCE(o.amount_cents,s.amount_cents) FROM schedules s LEFT JOIN schedule_overrides o ON o.schedule_id=s.id LEFT JOIN schedule_transfers st ON st.schedule_id=s.id LEFT JOIN schedule_transfer_overrides ot ON ot.schedule_id=s.id WHERE s.id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(database_error)?;
    let (source, destination, date, label, category, cents) = occurrence.ok_or_else(|| "Échéance introuvable.".to_string())?;
    if let Some(destination) = destination {
        if source == destination || cents >= 0 { return Err("Virement récurrent invalide.".into()); }
        let transfer = NewTransfer { id: transaction_id.into(), source_id: source, destination_id: destination, date, amount: -cents, category, note: format!("Créée depuis une échéance : {label}") };
        insert_transfer_in_tx(&tx, &transfer)?;
    } else {
    tx.execute(
        "INSERT INTO transactions (id, account_id, operation_date, label, category, amount_cents, reconciled, note)
         SELECT ?1, COALESCE(o.account_id,s.account_id), COALESCE(o.due_date,s.next_due), COALESCE(o.label,s.label), COALESCE(o.category,s.category), COALESCE(o.amount_cents,s.amount_cents), 0, 'Créée depuis une échéance'
         FROM schedules s LEFT JOIN schedule_overrides o ON o.schedule_id = s.id WHERE s.id = ?2",
        params![transaction_id, id],
    ).map_err(database_error)?;
    }
    tx.execute(
        "UPDATE schedules SET next_due = (
          SELECT date(target_month, printf('+%d days', MIN(anchor_day, CAST(strftime('%d', date(target_month, '+1 month', '-1 day')) AS INTEGER)) - 1))
          FROM (SELECT date(schedules.next_due, 'start of month', CASE schedules.frequency WHEN 'Mensuelle' THEN '+1 month' WHEN 'Trimestrielle' THEN '+3 months' WHEN 'Semestrielle' THEN '+6 months' WHEN 'Annuelle' THEN '+12 months' END) AS target_month), schedule_anchors WHERE schedule_id = schedules.id
        ) WHERE id = ?1",
        [id],
    ).map_err(database_error)?;
    tx.execute("DELETE FROM schedule_overrides WHERE schedule_id = ?1", [id]).map_err(database_error)?;
    tx.commit().map_err(database_error)
}
