use crate::database::{AppState, database_error};
use crate::transactions::{NewTransfer, insert_transfer_in_tx, validate_cheque};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

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
    #[serde(default)]
    pub(crate) remaining_count: Option<i64>,
    #[serde(default)]
    pub(crate) end_date: Option<String>,
    #[serde(default)]
    pub(crate) payment_method: Option<String>,
    #[serde(default)]
    pub(crate) cheque: Option<String>,
    #[serde(default, skip_deserializing)]
    pub(crate) series: Option<ScheduleSeries>,
    #[serde(default, skip_deserializing)]
    pub(crate) future_overrides: Vec<FutureOverride>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FutureOverride {
    payment_method: Option<String>,
    cheque: Option<String>,
    original_due: String,
    account_id: String,
    label: String,
    category: String,
    next_due: String,
    amount: i64,
    kind: String,
    destination_account_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduleSeries {
    payment_method: Option<String>,
    pub(crate) account_id: String,
    label: String,
    category: String,
    next_due: String,
    amount: i64,
    kind: String,
    anchor_day: i64,
    destination_account_id: Option<String>,
}

// A cheque number identifies one occurrence and is never reused automatically.
fn validate_payment(schedule: &Schedule) -> Result<(), String> {
    validate_cheque(schedule.cheque.as_deref())?;
    if !matches!(
        schedule.payment_method.as_deref(),
        None | Some("cheque" | "bank_transfer" | "direct_debit")
    ) || schedule.cheque.as_ref().is_some_and(|n| {
        !n.trim().is_empty() && schedule.payment_method.as_deref() != Some("cheque")
    }) || (schedule.kind == "transfer"
        && schedule
            .payment_method
            .as_deref()
            .is_some_and(|m| m != "bank_transfer"))
    {
        return Err("Méthode de paiement ou numéro de chèque invalide.".into());
    }
    Ok(())
}

#[tauri::command]
/// Returns the next occurrence of each schedule.
pub fn list_schedules(state: tauri::State<'_, AppState>) -> Result<Vec<Schedule>, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    list_schedules_in_db(&connection)
}

fn list_schedules_in_db(connection: &Connection) -> Result<Vec<Schedule>, String> {
    let mut statement = connection
        .prepare(
            "SELECT s.id,
                    COALESCE(o.account_id, s.account_id),
                    COALESCE(o.label, s.label),
                    COALESCE(o.category, s.category),
                    COALESCE(o.due_date, s.next_due),
                    s.frequency, COALESCE(o.amount_cents, s.amount_cents),
                    CASE WHEN (CASE WHEN o.schedule_id IS NOT NULL
                                    THEN ot.destination_account_id
                                    ELSE st.destination_account_id END) IS NOT NULL
                         THEN 'transfer' ELSE COALESCE(o.kind, s.kind) END,
                    s.account_id, s.label, s.category, s.next_due, s.amount_cents,
                    CASE WHEN st.destination_account_id IS NOT NULL THEN 'transfer' ELSE s.kind END,
                    a.anchor_day,
                    CASE WHEN o.schedule_id IS NOT NULL THEN ot.destination_account_id
                         ELSE st.destination_account_id END,
                    st.destination_account_id, lim.remaining_count, lim.end_date,
                    CASE WHEN o.schedule_id IS NOT NULL THEN o.payment_method ELSE s.payment_method END,
                    CASE WHEN o.schedule_id IS NOT NULL THEN o.cheque ELSE s.cheque END, s.payment_method
             FROM schedules s
             LEFT JOIN schedule_limits lim ON lim.schedule_id = s.id
             LEFT JOIN schedule_overrides o ON o.schedule_id = s.id
             LEFT JOIN schedule_transfers st ON st.schedule_id = s.id
             LEFT JOIN schedule_transfer_overrides ot ON ot.schedule_id = s.id
             JOIN schedule_anchors a ON a.schedule_id = s.id
             ORDER BY COALESCE(o.due_date, s.next_due), s.id",
        )
        .map_err(database_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(Schedule {
                id: row.get(0)?,
                account_id: row.get(1)?,
                label: row.get(2)?,
                category: row.get(3)?,
                next_due: row.get(4)?,
                frequency: row.get(5)?,
                amount: row.get(6)?,
                kind: row.get(7)?,
                destination_account_id: row.get(15)?,
                remaining_count: row.get(17)?,
                end_date: row.get(18)?,
                payment_method: row.get(19)?,
                cheque: row.get(20)?,
                future_overrides: Vec::new(),
                series: Some(ScheduleSeries {
                    payment_method: row.get(21)?,
                    account_id: row.get(8)?,
                    label: row.get(9)?,
                    category: row.get(10)?,
                    next_due: row.get(11)?,
                    amount: row.get(12)?,
                    kind: row.get(13)?,
                    anchor_day: row.get(14)?,
                    destination_account_id: row.get(16)?,
                }),
            })
        })
        .map_err(database_error)?;
    let mut schedules = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(database_error)?;
    let mut future = connection.prepare("SELECT original_due, account_id, label, category, due_date, amount_cents, CASE WHEN destination_account_id IS NOT NULL THEN 'transfer' ELSE kind END, destination_account_id, payment_method, cheque FROM schedule_future_overrides WHERE schedule_id=?1 ORDER BY original_due").map_err(database_error)?;
    for schedule in &mut schedules {
        schedule.future_overrides = future
            .query_map([&schedule.id], |r| {
                Ok(FutureOverride {
                    original_due: r.get(0)?,
                    account_id: r.get(1)?,
                    label: r.get(2)?,
                    category: r.get(3)?,
                    next_due: r.get(4)?,
                    amount: r.get(5)?,
                    kind: r.get(6)?,
                    destination_account_id: r.get(7)?,
                    payment_method: r.get(8)?,
                    cheque: r.get(9)?,
                })
            })
            .map_err(database_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(database_error)?;
    }
    Ok(schedules)
}

#[tauri::command]
/// Creates a recurring debit or credit, with its next occurrence stored in SQLite.
pub fn create_schedule(
    schedule: Schedule,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    save_schedule(schedule, state, false)
}

// Future overrides apply only to one original occurrence, never to the series.
#[tauri::command]
pub fn update_future_occurrence(
    schedule: Schedule,
    original_due: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut db = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    update_future_in_db(&mut db, schedule, &original_due)
}

fn update_future_in_db(
    db: &mut Connection,
    schedule: Schedule,
    original: &str,
) -> Result<(), String> {
    validate_payment(&schedule)?;
    if schedule.label.trim().is_empty()
        || schedule.category.trim().is_empty()
        || schedule.amount == 0
        || schedule.amount.unsigned_abs() > 100_000_000_000
        || !matches!(
            (schedule.kind.as_str(), schedule.amount > 0),
            ("debit", false) | ("credit", true) | ("transfer", false)
        )
        || (schedule.kind == "transfer"
            && schedule
                .destination_account_id
                .as_deref()
                .is_none_or(|id| id.is_empty() || id == schedule.account_id))
    {
        return Err("Échéance invalide.".into());
    }
    let valid: bool = db
        .query_row(
            "SELECT COALESCE(length(?1)=10 AND date(?1,'+0 days')=?1,0)",
            [&schedule.next_due],
            |r| r.get(0),
        )
        .map_err(database_error)?;
    if !valid {
        return Err("Date d’échéance invalide.".into());
    }
    // Validate the original date against the recurrence and its remaining limit.
    let eligible: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM schedules s JOIN schedule_anchors a ON a.schedule_id=s.id LEFT JOIN schedule_limits l ON l.schedule_id=s.id WHERE s.id=?1 AND length(?2)=10 AND date(?2,'+0 days')=?2 AND ?2>s.next_due AND (l.end_date IS NULL OR ?2<=l.end_date) AND ((CAST(strftime('%Y',?2) AS INTEGER)-CAST(strftime('%Y',s.next_due) AS INTEGER))*12 + CAST(strftime('%m',?2) AS INTEGER)-CAST(strftime('%m',s.next_due) AS INTEGER)) % CASE s.frequency WHEN 'Mensuelle' THEN 1 WHEN 'Bimestrielle' THEN 2 WHEN 'Trimestrielle' THEN 3 WHEN 'Semestrielle' THEN 6 WHEN 'Annuelle' THEN 12 END = 0 AND (l.remaining_count IS NULL OR ((CAST(strftime('%Y',?2) AS INTEGER)-CAST(strftime('%Y',s.next_due) AS INTEGER))*12 + CAST(strftime('%m',?2) AS INTEGER)-CAST(strftime('%m',s.next_due) AS INTEGER)) / CASE s.frequency WHEN 'Mensuelle' THEN 1 WHEN 'Bimestrielle' THEN 2 WHEN 'Trimestrielle' THEN 3 WHEN 'Semestrielle' THEN 6 WHEN 'Annuelle' THEN 12 END < l.remaining_count) AND CAST(strftime('%d',?2) AS INTEGER)=MIN(a.anchor_day,CAST(strftime('%d',date(?2,'start of month','+1 month','-1 day')) AS INTEGER)))", params![schedule.id,original], |r|r.get(0)).map_err(database_error)?;
    if !eligible {
        return Err("Cette occurrence future n’appartient pas à la série.".into());
    }
    let kind = if schedule.kind == "transfer" {
        "debit"
    } else {
        &schedule.kind
    };
    let destination = if schedule.kind == "transfer" {
        schedule.destination_account_id
    } else {
        None
    };
    db.execute("INSERT INTO schedule_future_overrides (schedule_id,original_due,account_id,label,category,due_date,amount_cents,kind,destination_account_id,payment_method,cheque) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULLIF(TRIM(?11),'')) ON CONFLICT(schedule_id,original_due) DO UPDATE SET account_id=excluded.account_id,label=excluded.label,category=excluded.category,due_date=excluded.due_date,amount_cents=excluded.amount_cents,kind=excluded.kind,destination_account_id=excluded.destination_account_id,payment_method=excluded.payment_method,cheque=excluded.cheque", params![schedule.id,original,schedule.account_id,schedule.label.trim(),schedule.category.trim(),schedule.next_due,schedule.amount,kind,destination,schedule.payment_method,schedule.cheque.as_deref().map(str::trim)]).map_err(database_error)?;
    Ok(())
}

#[tauri::command]
/// Deletes a series without removing operations already recorded from it.
pub fn delete_schedule(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    delete_schedule_in_db(&connection, &id)
}

fn delete_schedule_in_db(connection: &Connection, id: &str) -> Result<(), String> {
    // Foreign keys remove the series' anchor, overrides and transfer settings.
    let deleted = connection
        .execute("DELETE FROM schedules WHERE id = ?1", [id])
        .map_err(database_error)?;
    if deleted == 0 {
        return Err("Échéance introuvable.".into());
    }
    Ok(())
}

#[tauri::command]
/// Updates an existing recurring schedule and its next occurrence.
pub fn update_schedule(
    schedule: Schedule,
    scope: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if !matches!(scope.as_str(), "occurrence" | "series") {
        return Err("Portée de modification invalide.".into());
    }
    save_schedule_with_scope(schedule, state, Some(scope.as_str()))
}

fn save_schedule(
    schedule: Schedule,
    state: tauri::State<'_, AppState>,
    update: bool,
) -> Result<(), String> {
    save_schedule_with_scope(schedule, state, if update { Some("series") } else { None })
}

fn save_schedule_with_scope(
    schedule: Schedule,
    state: tauri::State<'_, AppState>,
    scope: Option<&str>,
) -> Result<(), String> {
    let mut connection = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    save_schedule_in_db(&mut connection, schedule, scope)
}

// The database operations are independent of the Tauri runtime for isolated tests.
pub(crate) fn save_schedule_in_db(
    connection: &mut Connection,
    schedule: Schedule,
    scope: Option<&str>,
) -> Result<(), String> {
    validate_payment(&schedule)?;
    if schedule.id.trim().is_empty()
        || schedule.label.trim().is_empty()
        || schedule.category.trim().is_empty()
    {
        return Err("Le libellé et la catégorie sont obligatoires.".into());
    }
    if !matches!(
        schedule.frequency.as_str(),
        "Mensuelle" | "Bimestrielle" | "Trimestrielle" | "Semestrielle" | "Annuelle"
    ) {
        return Err("Périodicité invalide.".into());
    }
    if schedule.amount == 0
        || schedule.amount.unsigned_abs() > 100_000_000_000
        || !matches!(
            (schedule.kind.as_str(), schedule.amount > 0),
            ("credit", true) | ("debit", false) | ("transfer", false)
        )
    {
        return Err("Montant ou type d’opération invalide.".into());
    }
    if schedule.kind == "transfer"
        && (schedule
            .destination_account_id
            .as_deref()
            .is_none_or(|id| id.is_empty() || id == schedule.account_id))
    {
        return Err("Choisissez deux comptes différents pour le virement.".into());
    }
    let valid_date: bool = connection
        .query_row(
            "SELECT COALESCE(length(?1) = 10 AND date(?1, '+0 days') = ?1, 0)",
            [&schedule.next_due],
            |row| row.get(0),
        )
        .map_err(database_error)?;
    if !valid_date {
        return Err("Date d’échéance invalide.".into());
    }
    if scope != Some("occurrence") {
        if schedule
            .remaining_count
            .is_some_and(|count| count <= 0 || count > 100_000)
            || (schedule.remaining_count.is_some() && schedule.end_date.is_some())
        {
            return Err("Limite d’échéance invalide.".into());
        }
        if let Some(end) = &schedule.end_date {
            let valid: bool = connection
                .query_row(
                    "SELECT COALESCE(length(?1)=10 AND date(?1, '+0 days')=?1, 0)",
                    [end],
                    |row| row.get(0),
                )
                .map_err(database_error)?;
            if !valid || end < &schedule.next_due {
                return Err("La date de fin doit être valide et postérieure ou égale à la prochaine échéance.".into());
            }
        }
    }
    let tx = connection.transaction().map_err(database_error)?;
    // A single-occurrence override leaves the series date and frequency intact.
    if scope == Some("occurrence") {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schedules WHERE id = ?1)",
                [&schedule.id],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        if !exists {
            return Err("Échéance introuvable.".into());
        }
        let stored_kind = if schedule.kind == "transfer" {
            "debit"
        } else {
            &schedule.kind
        };
        tx.execute("INSERT INTO schedule_overrides (schedule_id, account_id, label, category, due_date, amount_cents, kind, payment_method, cheque) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULLIF(TRIM(?9),'')) ON CONFLICT(schedule_id) DO UPDATE SET account_id=excluded.account_id, label=excluded.label, category=excluded.category, due_date=excluded.due_date, amount_cents=excluded.amount_cents, kind=excluded.kind,payment_method=excluded.payment_method,cheque=excluded.cheque", params![schedule.id, schedule.account_id, schedule.label.trim(), schedule.category.trim(), schedule.next_due, schedule.amount, stored_kind, schedule.payment_method, schedule.cheque.as_deref().map(str::trim)]).map_err(database_error)?;
        tx.execute(
            "DELETE FROM schedule_transfer_overrides WHERE schedule_id=?1",
            [&schedule.id],
        )
        .map_err(database_error)?;
        if schedule.kind == "transfer" {
            tx.execute(
                "INSERT INTO schedule_transfer_overrides VALUES (?1,?2)",
                params![schedule.id, schedule.destination_account_id],
            )
            .map_err(database_error)?;
        }
        return tx.commit().map_err(database_error);
    }
    let previous_date: Option<String> = if scope.is_some() {
        tx.query_row(
            "SELECT next_due FROM schedules WHERE id = ?1",
            [&schedule.id],
            |row| row.get(0),
        )
        .ok()
    } else {
        None
    };
    let sql = if scope.is_some() {
        "UPDATE schedules SET account_id = ?2, label = ?3, category = ?4, next_due = ?5, frequency = ?6, amount_cents = ?7, kind = ?8, payment_method = ?9, cheque = NULLIF(TRIM(?10),'') WHERE id = ?1"
    } else {
        "INSERT INTO schedules (id, account_id, label, category, next_due, frequency, amount_cents, kind, payment_method, cheque) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULLIF(TRIM(?10),''))"
    };
    let stored_kind = if schedule.kind == "transfer" {
        "debit"
    } else {
        &schedule.kind
    };
    let changed = tx
        .execute(
            sql,
            params![
                schedule.id,
                schedule.account_id,
                schedule.label.trim(),
                schedule.category.trim(),
                schedule.next_due,
                schedule.frequency,
                schedule.amount,
                stored_kind,
                schedule.payment_method,
                schedule.cheque.as_deref().map(str::trim)
            ],
        )
        .map_err(database_error)?;
    if changed == 0 {
        return Err("Échéance introuvable.".into());
    }
    tx.execute("INSERT INTO schedule_limits (schedule_id, remaining_count, end_date) VALUES (?1, ?2, ?3) ON CONFLICT(schedule_id) DO UPDATE SET remaining_count=excluded.remaining_count, end_date=excluded.end_date", params![schedule.id, schedule.remaining_count, schedule.end_date]).map_err(database_error)?;
    tx.execute(
        "DELETE FROM schedule_transfers WHERE schedule_id=?1",
        [&schedule.id],
    )
    .map_err(database_error)?;
    if schedule.kind == "transfer" {
        tx.execute(
            "INSERT INTO schedule_transfers VALUES (?1,?2)",
            params![schedule.id, schedule.destination_account_id],
        )
        .map_err(database_error)?;
    }
    if previous_date.as_deref() != Some(schedule.next_due.as_str()) {
        tx.execute("INSERT INTO schedule_anchors (schedule_id, anchor_day) VALUES (?1, CAST(strftime('%d', ?2) AS INTEGER)) ON CONFLICT(schedule_id) DO UPDATE SET anchor_day = excluded.anchor_day", params![schedule.id, schedule.next_due]).map_err(database_error)?;
    }
    // A series change invalidates future overrides tied to the previous cadence.
    tx.execute(
        "DELETE FROM schedule_future_overrides WHERE schedule_id=?1",
        [&schedule.id],
    )
    .map_err(database_error)?;
    tx.execute(
        "DELETE FROM schedule_overrides WHERE schedule_id = ?1",
        [&schedule.id],
    )
    .map_err(database_error)?;
    tx.commit().map_err(database_error)
}

#[tauri::command]
/// Creates an unpointed operation and advances the schedule's next date.
pub fn record_schedule(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let transaction_id = format!(
        "schedule-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "L'horloge système est indisponible.".to_string())?
            .as_millis()
    );
    let mut connection = state
        .database
        .lock()
        .map_err(|_| "La base de données est indisponible.".to_string())?;
    record_schedule_in_db(&mut connection, &id, &transaction_id)
}

pub(crate) fn record_schedule_in_db(
    connection: &mut Connection,
    id: &str,
    transaction_id: &str,
) -> Result<(), String> {
    let tx = connection.transaction().map_err(database_error)?;
    // Resolve the effective occurrence, including a one-time transfer override.
    let occurrence: Option<(String, Option<String>, String, String, String, i64)> = tx.query_row("SELECT COALESCE(o.account_id,s.account_id), CASE WHEN o.schedule_id IS NOT NULL THEN ot.destination_account_id ELSE st.destination_account_id END, COALESCE(o.due_date,s.next_due), COALESCE(o.label,s.label), COALESCE(o.category,s.category), COALESCE(o.amount_cents,s.amount_cents) FROM schedules s LEFT JOIN schedule_overrides o ON o.schedule_id=s.id LEFT JOIN schedule_transfers st ON st.schedule_id=s.id LEFT JOIN schedule_transfer_overrides ot ON ot.schedule_id=s.id WHERE s.id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(database_error)?;
    let (source, destination, date, label, category, cents) =
        occurrence.ok_or_else(|| "Échéance introuvable.".to_string())?;
    // Old databases may contain an invalid number; ask for correction without changing data.
    let cheque: Option<String> = tx.query_row("SELECT CASE WHEN o.schedule_id IS NOT NULL THEN o.cheque ELSE s.cheque END FROM schedules s LEFT JOIN schedule_overrides o ON o.schedule_id=s.id WHERE s.id=?1", [id], |row| row.get(0)).map_err(database_error)?;
    validate_cheque(cheque.as_deref())?;
    if let Some(destination) = destination {
        if source == destination || cents >= 0 {
            return Err("Virement récurrent invalide.".into());
        }
        let transfer = NewTransfer {
            id: transaction_id.into(),
            source_id: source,
            destination_id: destination,
            date,
            amount: -cents,
            category,
            note: format!("Créée depuis une échéance : {label}"),
        };
        insert_transfer_in_tx(&tx, &transfer)?;
    } else {
        tx.execute(
        "INSERT INTO transactions (id, account_id, operation_date, label, category, cheque, amount_cents, reconciled, note)
         SELECT ?1, COALESCE(o.account_id,s.account_id), COALESCE(o.due_date,s.next_due), COALESCE(o.label,s.label), COALESCE(o.category,s.category), CASE WHEN o.schedule_id IS NOT NULL THEN o.cheque ELSE s.cheque END, COALESCE(o.amount_cents,s.amount_cents), 0, 'Créée depuis une échéance'
         FROM schedules s LEFT JOIN schedule_overrides o ON o.schedule_id = s.id WHERE s.id = ?2",
        params![transaction_id, id],
    ).map_err(database_error)?;
    }
    tx.execute(
        "UPDATE schedules SET next_due = (
          SELECT date(target_month, printf('+%d days', MIN(anchor_day, CAST(strftime('%d', date(target_month, '+1 month', '-1 day')) AS INTEGER)) - 1))
          FROM (SELECT date(schedules.next_due, 'start of month', CASE schedules.frequency WHEN 'Mensuelle' THEN '+1 month' WHEN 'Bimestrielle' THEN '+2 months' WHEN 'Trimestrielle' THEN '+3 months' WHEN 'Semestrielle' THEN '+6 months' WHEN 'Annuelle' THEN '+12 months' END) AS target_month), schedule_anchors WHERE schedule_id = schedules.id
        ) WHERE id = ?1",
        [id],
    ).map_err(database_error)?;
    // Never reuse a cheque number on the next occurrence.
    tx.execute("UPDATE schedules SET cheque=NULL WHERE id=?1", [id])
        .map_err(database_error)?;
    // Advance and consume one occurrence atomically; expired series leave recorded operations intact.
    tx.execute("DELETE FROM schedules WHERE id=?1 AND EXISTS (SELECT 1 FROM schedule_limits WHERE schedule_id=?1 AND (remaining_count=1 OR (end_date IS NOT NULL AND schedules.next_due > end_date)))", [id]).map_err(database_error)?;
    tx.execute("UPDATE schedule_limits SET remaining_count=remaining_count-1 WHERE schedule_id=?1 AND remaining_count IS NOT NULL", [id]).map_err(database_error)?;
    tx.execute(
        "DELETE FROM schedule_overrides WHERE schedule_id = ?1",
        [id],
    )
    .map_err(database_error)?;
    // Promote an exception when its original occurrence becomes the next pending one.
    tx.execute("INSERT INTO schedule_overrides (schedule_id,account_id,label,category,due_date,amount_cents,kind,payment_method,cheque) SELECT f.schedule_id,f.account_id,f.label,f.category,f.due_date,f.amount_cents,f.kind,f.payment_method,f.cheque FROM schedule_future_overrides f JOIN schedules s ON s.id=f.schedule_id AND s.next_due=f.original_due WHERE s.id=?1", [id]).map_err(database_error)?;
    tx.execute("INSERT INTO schedule_transfer_overrides (schedule_id,destination_account_id) SELECT f.schedule_id,f.destination_account_id FROM schedule_future_overrides f JOIN schedules s ON s.id=f.schedule_id AND s.next_due=f.original_due WHERE s.id=?1 AND f.destination_account_id IS NOT NULL", [id]).map_err(database_error)?;
    tx.execute("DELETE FROM schedule_future_overrides WHERE schedule_id=?1 AND original_due=(SELECT next_due FROM schedules WHERE id=?1)", [id]).map_err(database_error)?;
    tx.commit().map_err(database_error)
}
