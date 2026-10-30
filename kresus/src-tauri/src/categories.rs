use crate::database::{AppState, database_error};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[cfg(test)]
#[path = "categories_tests.rs"]
mod tests;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) parent_id: Option<String>,
}

// Import existing text labels exactly once so old operations remain accessible.
pub(crate) fn migrate_categories(db: &Connection) -> rusqlite::Result<()> {
    let tx = db.unchecked_transaction()?;
    let done: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM app_metadata WHERE key='categories_v1')",
        [],
        |r| r.get(0),
    )?;
    if done {
        return tx.commit();
    }
    let labels: Vec<String> = {
        let mut q = tx.prepare("SELECT category FROM transactions UNION SELECT category FROM schedules UNION SELECT category FROM schedule_overrides")?;
        let rows = q.query_map([], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for label in labels.iter().map(String::as_str).chain([
        "Divers",
        "Alimentation",
        "Logement",
        "Transports",
        "Revenus",
    ]) {
        let (parent, child) = label
            .split_once(" · ")
            .map_or((label, None), |(p, c)| (p, Some(c)));
        if parent.is_empty() {
            continue;
        }
        tx.execute("INSERT OR IGNORE INTO categories (id,name,parent_id) VALUES (lower(hex(randomblob(16))),?1,NULL)", [parent])?;
        if let Some(child) = child.filter(|name| !name.is_empty()) {
            tx.execute("INSERT OR IGNORE INTO categories (id,name,parent_id) SELECT lower(hex(randomblob(16))),?1,id FROM categories WHERE parent_id IS NULL AND name = ?2 COLLATE NOCASE", params![child,parent])?;
        }
    }
    tx.execute("INSERT INTO app_metadata VALUES ('categories_v1','1')", [])?;
    tx.commit()
}

fn validate_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.contains('·') {
        return Err("Le nom doit contenir de 1 à 80 caractères, sans le signe ·.".into());
    }
    Ok(name)
}

fn path(db: &Connection, id: &str) -> Result<(String, Option<String>), String> {
    db.query_row("SELECT CASE WHEN p.id IS NULL THEN c.name ELSE p.name || ' · ' || c.name END,c.parent_id FROM categories c LEFT JOIN categories p ON p.id=c.parent_id WHERE c.id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(database_error)?.ok_or_else(|| "Catégorie introuvable.".into())
}

// Replace whole labels, including references held by recurring and exceptional occurrences.
fn replace_label(db: &Connection, old: &str, new: &str) -> Result<(), String> {
    for table in ["transactions", "schedules", "schedule_overrides"] {
        db.execute(
            &format!("UPDATE {table} SET category=?1 WHERE category=?2"),
            params![new, old],
        )
        .map_err(database_error)?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_categories(state: tauri::State<'_, AppState>) -> Result<Vec<Category>, String> {
    let db = state
        .database
        .lock()
        .map_err(|_| "Base indisponible.".to_string())?;
    let mut q = db.prepare("SELECT id,name,parent_id FROM categories ORDER BY parent_id IS NOT NULL, name COLLATE NOCASE, id").map_err(database_error)?;
    let rows = q
        .query_map([], |r| {
            Ok(Category {
                id: r.get(0)?,
                name: r.get(1)?,
                parent_id: r.get(2)?,
            })
        })
        .map_err(database_error)?;
    rows.collect::<rusqlite::Result<_>>()
        .map_err(database_error)
}

#[tauri::command]
pub fn create_category(
    category: Category,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let db = state
        .database
        .lock()
        .map_err(|_| "Base indisponible.".to_string())?;
    create_in_db(&db, category)
}

fn create_in_db(db: &Connection, category: Category) -> Result<(), String> {
    let name = validate_name(&category.name)?;
    if category.id.trim().is_empty() {
        return Err("Identifiant invalide.".into());
    }
    if let Some(parent) = &category.parent_id {
        if path(&db, parent)?.1.is_some() {
            return Err("Choisissez une catégorie principale.".into());
        }
    }
    db.execute(
        "INSERT INTO categories (id,name,parent_id) VALUES (?1,?2,?3)",
        params![category.id, name, category.parent_id],
    )
    .map_err(|_| "Cette catégorie existe déjà ou ne peut pas être créée.".to_string())?;
    Ok(())
}

#[tauri::command]
pub fn rename_category(
    id: String,
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut db = state
        .database
        .lock()
        .map_err(|_| "Base indisponible.".to_string())?;
    rename_in_db(&mut db, id, name)
}

fn rename_in_db(db: &mut Connection, id: String, name: String) -> Result<(), String> {
    let name = validate_name(&name)?;
    let tx = db.transaction().map_err(database_error)?;
    let (old, parent) = path(&tx, &id)?;
    let new = match &parent {
        Some(p) => format!("{} · {}", path(&tx, p)?.0, name),
        None => name.to_string(),
    };
    let children: Vec<String> = {
        let mut q = tx
            .prepare("SELECT name FROM categories WHERE parent_id=?1")
            .map_err(database_error)?;
        let rows = q.query_map([&id], |r| r.get(0)).map_err(database_error)?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(database_error)?
    };
    tx.execute(
        "UPDATE categories SET name=?1 WHERE id=?2",
        params![name, id],
    )
    .map_err(|_| "Ce nom est déjà utilisé.".to_string())?;
    replace_label(&tx, &old, &new)?;
    for child in children {
        replace_label(
            &tx,
            &format!("{old} · {child}"),
            &format!("{new} · {child}"),
        )?;
    }
    tx.commit().map_err(database_error)
}

#[tauri::command]
pub fn delete_category(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut db = state
        .database
        .lock()
        .map_err(|_| "Base indisponible.".to_string())?;
    delete_in_db(&mut db, id)
}

fn delete_in_db(db: &mut Connection, id: String) -> Result<(), String> {
    let tx = db.transaction().map_err(database_error)?;
    let (label, _) = path(&tx, &id)?;
    let used: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM transactions WHERE category=?1 UNION ALL SELECT 1 FROM schedules WHERE category=?1 UNION ALL SELECT 1 FROM schedule_overrides WHERE category=?1 UNION ALL SELECT 1 FROM categories WHERE parent_id=?2)",params![label,id],|r|r.get(0)).map_err(database_error)?;
    if used {
        return Err("Cette catégorie est utilisée ou contient des sous-catégories. Fusionnez-la ou retirez ses références avant de la supprimer.".into());
    }
    tx.execute("DELETE FROM categories WHERE id=?1", [id])
        .map_err(database_error)?;
    tx.commit().map_err(database_error)
}

#[tauri::command]
pub fn merge_category(
    source_id: String,
    target_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut db = state
        .database
        .lock()
        .map_err(|_| "Base indisponible.".to_string())?;
    merge_in_db(&mut db, source_id, target_id)
}

fn merge_in_db(db: &mut Connection, source_id: String, target_id: String) -> Result<(), String> {
    if source_id == target_id {
        return Err("Choisissez deux catégories différentes.".into());
    }
    let tx = db.transaction().map_err(database_error)?;
    let (source, source_parent) = path(&tx, &source_id)?;
    let (target, target_parent) = path(&tx, &target_id)?;
    if source_parent.is_some() != target_parent.is_some() {
        return Err("Les catégories à fusionner doivent être au même niveau.".into());
    }
    replace_label(&tx, &source, &target)?;
    if source_parent.is_none() {
        let children: Vec<(String, String)> = {
            let mut q = tx
                .prepare("SELECT id,name FROM categories WHERE parent_id=?1")
                .map_err(database_error)?;
            let rows = q
                .query_map([&source_id], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(database_error)?;
            rows.collect::<rusqlite::Result<_>>()
                .map_err(database_error)?
        };
        for (child_id, child_name) in children {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM categories WHERE parent_id=?1 AND name=?2 COLLATE NOCASE",
                    params![target_id, child_name],
                    |r| r.get(0),
                )
                .optional()
                .map_err(database_error)?;
            let target_name: String = if let Some(ref existing_id) = existing {
                tx.query_row(
                    "SELECT name FROM categories WHERE id=?1",
                    [existing_id],
                    |r| r.get(0),
                )
                .map_err(database_error)?
            } else {
                child_name.clone()
            };
            replace_label(
                &tx,
                &format!("{source} · {child_name}"),
                &format!("{target} · {target_name}"),
            )?;
            if existing.is_some() {
                tx.execute("DELETE FROM categories WHERE id=?1", [child_id])
                    .map_err(database_error)?;
            } else {
                tx.execute(
                    "UPDATE categories SET parent_id=?1 WHERE id=?2",
                    params![target_id, child_id],
                )
                .map_err(database_error)?;
            }
        }
    }
    tx.execute("DELETE FROM categories WHERE id=?1", [source_id])
        .map_err(database_error)?;
    tx.commit().map_err(database_error)
}
