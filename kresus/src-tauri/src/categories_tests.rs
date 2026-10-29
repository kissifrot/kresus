use super::*;
use crate::test_support::database;

#[test]
fn migration_preserves_existing_labels_and_is_idempotent() {
    let db = database();
    let count: i64 = db.query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0)).unwrap();
    migrate_categories(&db).unwrap();
    let after: i64 = db.query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0)).unwrap();
    assert_eq!(count, after);
    let labels: Vec<String> = { let mut q=db.prepare("SELECT p.name || ' · ' || c.name FROM categories c JOIN categories p ON p.id=c.parent_id").unwrap(); q.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap() };
    assert!(labels.contains(&"Factures · Électricité".to_string()));
}

fn category(id: &str, name: &str, parent: Option<&str>) -> Category {
    Category { id: id.into(), name: name.into(), parent_id: parent.map(str::to_string) }
}

#[test]
fn creates_and_deletes_only_unused_categories_with_one_level_of_children() {
    let mut db = database();
    create_in_db(&db, category("root", "Maison", None)).unwrap();
    create_in_db(&db, category("child", "Travaux", Some("root"))).unwrap();
    assert!(create_in_db(&db, category("duplicate", "Travaux", Some("root"))).is_err());
    assert!(create_in_db(&db, category("nested", "Interdit", Some("child"))).is_err());
    assert!(delete_in_db(&mut db, "root".into()).is_err());
    delete_in_db(&mut db, "child".into()).unwrap();
    delete_in_db(&mut db, "root".into()).unwrap();
}

#[test]
fn renaming_updates_transactions_schedules_and_exception_labels() {
    let mut db = database();
    create_in_db(&db, category("root", "Maison", None)).unwrap();
    create_in_db(&db, category("child", "Travaux", Some("root"))).unwrap();
    db.execute("INSERT INTO transactions (id,account_id,operation_date,label,category,amount_cents) VALUES ('cat-op','ccp','2027-01-01','Test','Maison · Travaux',100)", []).unwrap();
    db.execute("INSERT INTO schedules (id,account_id,label,category,next_due,frequency,amount_cents,kind) VALUES ('cat-sched','ccp','Test','Maison · Travaux','2027-01-01','Mensuelle',100,'credit')", []).unwrap();
    db.execute("INSERT INTO schedule_overrides (schedule_id,account_id,label,category,due_date,amount_cents,kind) VALUES ('cat-sched','ccp','Test','Maison · Travaux','2027-01-02',100,'credit')", []).unwrap();
    rename_in_db(&mut db, "root".into(), "Habitat".into()).unwrap();
    rename_in_db(&mut db, "child".into(), "Réparation".into()).unwrap();
    for table in ["transactions", "schedules", "schedule_overrides"] {
        let count: i64 = db.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE category='Habitat · Réparation'"), [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
    }
    assert!(delete_in_db(&mut db, "child".into()).is_err());
}

#[test]
fn merging_roots_combines_children_and_preserves_operations() {
    let mut db = database();
    for item in [category("source", "Ancien", None), category("target", "Nouveau", None), category("a", "Commun", Some("source")), category("b", "Commun", Some("target")), category("c", "Unique", Some("source"))] { create_in_db(&db,item).unwrap(); }
    db.execute("INSERT INTO transactions (id,account_id,operation_date,label,category,amount_cents) VALUES ('op-a','ccp','2027-01-01','Test','Ancien · Commun',100), ('op-c','ccp','2027-01-01','Test','Ancien · Unique',200)", []).unwrap();
    merge_in_db(&mut db, "source".into(), "target".into()).unwrap();
    let labels: Vec<String> = { let mut q=db.prepare("SELECT category FROM transactions WHERE id IN ('op-a','op-c') ORDER BY id").unwrap(); q.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap() };
    assert_eq!(labels, vec!["Nouveau · Commun", "Nouveau · Unique"]);
    let children: i64 = db.query_row("SELECT COUNT(*) FROM categories WHERE parent_id='target'", [], |r| r.get(0)).unwrap();
    assert_eq!(children, 2);
    assert!(path(&db,"source").is_err());
}
