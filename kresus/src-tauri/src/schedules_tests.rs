use super::*;
use crate::database::initialize_database;
use crate::test_support::{database, temporary_database_path};

fn schedule(date: &str, frequency: &str) -> Schedule {
    Schedule {
        id: "test-schedule".into(),
        account_id: "ccp".into(),
        label: "Example".into(),
        category: "Bills".into(),
        next_due: date.into(),
        frequency: frequency.into(),
        amount: -4275,
        kind: "debit".into(),
        destination_account_id: None,
        remaining_count: None,
        end_date: None,
        payment_method: None,
        cheque: None,
        series: None,
        future_overrides: vec![],
    }
}

fn next_date(db: &Connection) -> String {
    db.query_row(
        "SELECT next_due FROM schedules WHERE id = 'test-schedule'",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

fn recurring_transfer() -> Schedule {
    let mut item = schedule("2028-01-31", "Mensuelle");
    item.kind = "transfer".into();
    item.destination_account_id = Some("sylvie".into());
    item
}

#[test]
fn deleting_series_removes_overrides_but_keeps_recorded_transfers_after_reopening() {
    let path = temporary_database_path();
    {
        let mut db = Connection::open(&path.0).unwrap();
        initialize_database(&db).unwrap();
        save_schedule_in_db(&mut db, recurring_transfer(), None).unwrap();
        record_schedule_in_db(&mut db, "test-schedule", "already-recorded").unwrap();
        save_schedule_in_db(&mut db, recurring_transfer(), Some("occurrence")).unwrap();
        delete_schedule_in_db(&db, "test-schedule").unwrap();
        assert!(delete_schedule_in_db(&db, "test-schedule").is_err());
        for table in [
            "schedule_anchors",
            "schedule_overrides",
            "schedule_transfers",
            "schedule_transfer_overrides",
        ] {
            let count: i64 = db
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE schedule_id = 'test-schedule'"),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 0);
        }
    }
    let db = Connection::open(&path.0).unwrap();
    initialize_database(&db).unwrap();
    assert!(
        !list_schedules_in_db(&db)
            .unwrap()
            .iter()
            .any(|item| item.id == "test-schedule")
    );
    let count: i64 = db.query_row("SELECT COUNT(*) FROM transactions WHERE id IN ('already-recorded-debit', 'already-recorded-credit')", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 2);
    let links: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM transfers WHERE id='already-recorded'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(links, 1);
}

#[test]
fn recurring_transfer_records_linked_operations_and_advances_on_leap_year() {
    let mut db = database();
    save_schedule_in_db(&mut db, recurring_transfer(), None).unwrap();
    let loaded = list_schedules_in_db(&db)
        .unwrap()
        .into_iter()
        .find(|item| item.id == "test-schedule")
        .unwrap();
    assert_eq!(
        (
            loaded.kind.as_str(),
            loaded.destination_account_id.as_deref()
        ),
        ("transfer", Some("sylvie"))
    );
    assert_eq!(
        loaded.series.unwrap().destination_account_id.as_deref(),
        Some("sylvie")
    );
    record_schedule_in_db(&mut db, "test-schedule", "recurring-transfer").unwrap();
    let amounts: (i64, i64) = db.query_row("SELECT (SELECT amount_cents FROM transactions WHERE id='recurring-transfer-debit'), (SELECT amount_cents FROM transactions WHERE id='recurring-transfer-credit')", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(amounts, (-4275, 4275));
    let accounts: (String, String) = db.query_row("SELECT d.account_id,c.account_id FROM transfers t JOIN transactions d ON d.id=t.debit_id JOIN transactions c ON c.id=t.credit_id WHERE t.id='recurring-transfer'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(accounts, ("ccp".into(), "sylvie".into()));
    assert_eq!(next_date(&db), "2028-02-29");
    crate::transactions::delete_transaction_in_db(&db, "recurring-transfer-credit").unwrap();
    let count: i64 = db.query_row("SELECT COUNT(*) FROM transactions WHERE id IN ('recurring-transfer-debit','recurring-transfer-credit')", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 0);
    assert_eq!(next_date(&db), "2028-02-29");
}

#[test]
fn one_time_transfer_override_and_series_following_it_are_independent() {
    let mut db = database();
    save_schedule_in_db(&mut db, recurring_transfer(), None).unwrap();
    let mut exceptional = recurring_transfer();
    exceptional.destination_account_id = Some("livret-michel".into());
    exceptional.amount = -1000;
    save_schedule_in_db(&mut db, exceptional, Some("occurrence")).unwrap();
    let loaded = list_schedules_in_db(&db)
        .unwrap()
        .into_iter()
        .find(|item| item.id == "test-schedule")
        .unwrap();
    assert_eq!(
        loaded.destination_account_id.as_deref(),
        Some("livret-michel")
    );
    assert_eq!(
        loaded.series.unwrap().destination_account_id.as_deref(),
        Some("sylvie")
    );
    record_schedule_in_db(&mut db, "test-schedule", "first-transfer").unwrap();
    record_schedule_in_db(&mut db, "test-schedule", "second-transfer").unwrap();
    let first: (String, i64) = db
        .query_row(
            "SELECT account_id,amount_cents FROM transactions WHERE id='first-transfer-credit'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let second: (String, i64) = db
        .query_row(
            "SELECT account_id,amount_cents FROM transactions WHERE id='second-transfer-credit'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(first, ("livret-michel".into(), 1000));
    assert_eq!(second, ("sylvie".into(), 4275));
    assert_eq!(next_date(&db), "2028-03-31");
}

#[test]
fn replacing_an_occurrence_type_does_not_change_the_series_type() {
    let mut db = database();
    save_schedule_in_db(&mut db, recurring_transfer(), None).unwrap();
    save_schedule_in_db(
        &mut db,
        schedule("2028-01-31", "Mensuelle"),
        Some("occurrence"),
    )
    .unwrap();
    let loaded = list_schedules_in_db(&db)
        .unwrap()
        .into_iter()
        .find(|item| item.id == "test-schedule")
        .unwrap();
    assert_eq!(loaded.kind, "debit");
    assert_eq!(loaded.series.unwrap().kind, "transfer");
    record_schedule_in_db(&mut db, "test-schedule", "regular").unwrap();
    record_schedule_in_db(&mut db, "test-schedule", "next-transfer").unwrap();
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM transfers WHERE id IN ('regular','next-transfer')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn failed_recurring_transfer_rolls_back_both_movements_and_due_date() {
    let mut db = database();
    let mut same = recurring_transfer();
    same.destination_account_id = Some("ccp".into());
    assert!(save_schedule_in_db(&mut db, same, None).is_err());
    let mut missing = recurring_transfer();
    missing.destination_account_id = Some("missing".into());
    assert!(save_schedule_in_db(&mut db, missing, None).is_err());
    save_schedule_in_db(&mut db, recurring_transfer(), None).unwrap();
    db.execute_batch("CREATE TRIGGER reject_recurring_credit BEFORE INSERT ON transactions WHEN NEW.id='fail-credit' BEGIN SELECT RAISE(ABORT, 'failure'); END;").unwrap();
    assert!(record_schedule_in_db(&mut db, "test-schedule", "fail").is_err());
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM transactions WHERE id IN ('fail-debit','fail-credit')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(next_date(&db), "2028-01-31");
}

#[test]
fn changing_transfer_series_updates_following_occurrences_and_removes_override() {
    let mut db = database();
    save_schedule_in_db(&mut db, recurring_transfer(), None).unwrap();
    let mut exception = recurring_transfer();
    exception.amount = -100;
    save_schedule_in_db(&mut db, exception, Some("occurrence")).unwrap();
    let mut updated = recurring_transfer();
    updated.destination_account_id = Some("livret-michel".into());
    updated.amount = -7500;
    updated.frequency = "Trimestrielle".into();
    save_schedule_in_db(&mut db, updated, Some("series")).unwrap();
    for id in ["changed-first", "changed-second"] {
        record_schedule_in_db(&mut db, "test-schedule", id).unwrap();
    }
    let total: i64 = db.query_row("SELECT SUM(amount_cents) FROM transactions WHERE id IN ('changed-first-credit','changed-second-credit') AND account_id='livret-michel'", [], |r| r.get(0)).unwrap();
    assert_eq!(total, 15000);
    assert_eq!(next_date(&db), "2028-07-31");
}

#[test]
fn failed_due_date_advance_rolls_back_link_and_both_transfer_sides() {
    let mut db = database();
    save_schedule_in_db(&mut db, recurring_transfer(), None).unwrap();
    db.execute_batch("CREATE TRIGGER fail_transfer_advance BEFORE UPDATE ON schedules BEGIN SELECT RAISE(ABORT, 'failure'); END;").unwrap();
    assert!(record_schedule_in_db(&mut db, "test-schedule", "rollback").is_err());
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM transactions WHERE id IN ('rollback-debit','rollback-credit')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let links: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM transfers WHERE id='rollback'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!((count, links), (0, 0));
    assert_eq!(next_date(&db), "2028-01-31");
}

#[test]
fn annual_leap_day_returns_after_non_leap_years() {
    let mut db = database();
    save_schedule_in_db(&mut db, schedule("2024-02-29", "Annuelle"), None).unwrap();
    for (id, expected) in [
        ("a", "2025-02-28"),
        ("b", "2026-02-28"),
        ("c", "2027-02-28"),
        ("d", "2028-02-29"),
    ] {
        record_schedule_in_db(&mut db, "test-schedule", id).unwrap();
        assert_eq!(next_date(&db), expected);
    }
}

#[test]
fn monthly_end_of_month_preserves_day_and_crosses_year() {
    let mut db = database();
    save_schedule_in_db(&mut db, schedule("2027-01-31", "Mensuelle"), None).unwrap();
    for (id, expected) in [
        ("a", "2027-02-28"),
        ("b", "2027-03-31"),
        ("c", "2027-04-30"),
    ] {
        record_schedule_in_db(&mut db, "test-schedule", id).unwrap();
        assert_eq!(next_date(&db), expected);
    }
    let mut year_end = schedule("2027-12-31", "Mensuelle");
    year_end.id = "year-end".into();
    save_schedule_in_db(&mut db, year_end, None).unwrap();
    record_schedule_in_db(&mut db, "year-end", "year-op").unwrap();
    let next: String = db
        .query_row(
            "SELECT next_due FROM schedules WHERE id = 'year-end'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(next, "2028-01-31");
}

#[test]
fn schedules_advance_by_their_period() {
    for (frequency, expected) in [
        ("Mensuelle", "2027-02-28"),
        ("Bimestrielle", "2027-03-31"),
        ("Trimestrielle", "2027-04-30"),
        ("Semestrielle", "2027-07-31"),
        ("Annuelle", "2028-01-31"),
    ] {
        let mut db = database();
        save_schedule_in_db(&mut db, schedule("2027-01-31", frequency), None).unwrap();
        record_schedule_in_db(&mut db, "test-schedule", "operation").unwrap();
        assert_eq!(next_date(&db), expected, "frequency: {frequency}");
    }
}

#[test]
fn occurrence_override_is_recorded_once_and_series_is_preserved() {
    let mut db = database();
    save_schedule_in_db(&mut db, schedule("2027-01-31", "Mensuelle"), None).unwrap();
    let mut override_schedule = schedule("2027-02-02", "Mensuelle");
    override_schedule.amount = -1005;
    override_schedule.label = "Exceptional".into();
    save_schedule_in_db(&mut db, override_schedule, Some("occurrence")).unwrap();
    record_schedule_in_db(&mut db, "test-schedule", "first").unwrap();
    let recorded: (String, String, i64, i64) = db.query_row("SELECT operation_date, label, amount_cents, reconciled FROM transactions WHERE id = 'first'", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).unwrap();
    assert_eq!(
        recorded,
        ("2027-02-02".into(), "Exceptional".into(), -1005, 0)
    );
    assert_eq!(next_date(&db), "2027-02-28");
    record_schedule_in_db(&mut db, "test-schedule", "second").unwrap();
    let original: (String, i64) = db
        .query_row(
            "SELECT label, amount_cents FROM transactions WHERE id = 'second'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(original, ("Example".into(), -4275));
    assert_eq!(next_date(&db), "2027-03-31");
}

#[test]
fn series_update_replaces_override_and_changes_following_occurrences() {
    let mut db = database();
    save_schedule_in_db(&mut db, schedule("2027-01-15", "Mensuelle"), None).unwrap();
    save_schedule_in_db(
        &mut db,
        schedule("2027-01-16", "Mensuelle"),
        Some("occurrence"),
    )
    .unwrap();
    let mut updated = schedule("2027-02-20", "Trimestrielle");
    updated.amount = 12345;
    updated.kind = "credit".into();
    save_schedule_in_db(&mut db, updated, Some("series")).unwrap();
    record_schedule_in_db(&mut db, "test-schedule", "updated").unwrap();
    let amount: i64 = db
        .query_row(
            "SELECT amount_cents FROM transactions WHERE id = 'updated'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(amount, 12345);
    assert_eq!(next_date(&db), "2027-05-20");
    let overrides: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM schedule_overrides WHERE schedule_id = 'test-schedule'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(overrides, 0);
}

#[test]
fn series_changes_persist_after_reopening_and_apply_to_later_operations() {
    let path = temporary_database_path();
    {
        let mut db = Connection::open(&path.0).unwrap();
        initialize_database(&db).unwrap();
        save_schedule_in_db(&mut db, schedule("2027-01-15", "Mensuelle"), None).unwrap();
        record_schedule_in_db(&mut db, "test-schedule", "before-edit").unwrap();
        let mut edited = schedule("2027-02-28", "Trimestrielle");
        edited.account_id = "sylvie".into();
        edited.label = "Updated".into();
        edited.category = "Income".into();
        edited.amount = 9995;
        edited.kind = "credit".into();
        save_schedule_in_db(&mut db, edited, Some("series")).unwrap();
    }

    let mut db = Connection::open(&path.0).unwrap();
    initialize_database(&db).unwrap();
    let saved: (String, String, String, String, String, i64, String) = db.query_row(
        "SELECT account_id, label, category, next_due, frequency, amount_cents, kind FROM schedules WHERE id = 'test-schedule'", [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
    ).unwrap();
    assert_eq!(
        saved,
        (
            "sylvie".into(),
            "Updated".into(),
            "Income".into(),
            "2027-02-28".into(),
            "Trimestrielle".into(),
            9995,
            "credit".into()
        )
    );
    for (id, date, next) in [
        ("after-one", "2027-02-28", "2027-05-28"),
        ("after-two", "2027-05-28", "2027-08-28"),
        ("after-three", "2027-08-28", "2027-11-28"),
    ] {
        record_schedule_in_db(&mut db, "test-schedule", id).unwrap();
        let operation: (String, String, String, String, i64, i64) = db.query_row(
            "SELECT account_id, operation_date, label, category, amount_cents, reconciled FROM transactions WHERE id = ?1", [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        ).unwrap();
        assert_eq!(
            operation,
            (
                "sylvie".into(),
                date.into(),
                "Updated".into(),
                "Income".into(),
                9995,
                0
            )
        );
        assert_eq!(next_date(&db), next);
    }
    let earlier: (String, String, i64) = db
        .query_row(
            "SELECT account_id, label, amount_cents FROM transactions WHERE id = 'before-edit'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(earlier, ("ccp".into(), "Example".into(), -4275));
}

#[test]
fn invalid_series_update_preserves_existing_series_and_override() {
    let mut db = database();
    save_schedule_in_db(&mut db, schedule("2027-01-31", "Mensuelle"), None).unwrap();
    save_schedule_in_db(
        &mut db,
        schedule("2027-02-02", "Mensuelle"),
        Some("occurrence"),
    )
    .unwrap();
    let mut edited = schedule("2027-03-31", "Trimestrielle");
    edited.account_id = "missing".into();
    assert!(save_schedule_in_db(&mut db, edited, Some("series")).is_err());
    assert_eq!(next_date(&db), "2027-01-31");
    let due: String = db
        .query_row(
            "SELECT due_date FROM schedule_overrides WHERE schedule_id = 'test-schedule'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(due, "2027-02-02");
    record_schedule_in_db(&mut db, "test-schedule", "after-failure").unwrap();
    assert_eq!(next_date(&db), "2027-02-28");
}

#[test]
fn failed_recording_keeps_schedule_and_override_unchanged() {
    let mut db = database();
    save_schedule_in_db(&mut db, schedule("2027-01-31", "Mensuelle"), None).unwrap();
    save_schedule_in_db(
        &mut db,
        schedule("2027-02-02", "Mensuelle"),
        Some("occurrence"),
    )
    .unwrap();
    assert!(record_schedule_in_db(&mut db, "test-schedule", "t1").is_err());
    assert_eq!(next_date(&db), "2027-01-31");
    let due: String = db
        .query_row(
            "SELECT due_date FROM schedule_overrides WHERE schedule_id = 'test-schedule'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(due, "2027-02-02");
}

#[test]
fn failure_advancing_schedule_rolls_back_inserted_operation() {
    let mut db = database();
    save_schedule_in_db(&mut db, schedule("2027-01-31", "Mensuelle"), None).unwrap();
    db.execute_batch("CREATE TRIGGER fail_advance BEFORE UPDATE ON schedules BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;").unwrap();
    assert!(record_schedule_in_db(&mut db, "test-schedule", "rolled-back").is_err());
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM transactions WHERE id = 'rolled-back'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(next_date(&db), "2027-01-31");
}

#[test]
fn invalid_date_or_missing_account_does_not_create_schedule() {
    let mut db = database();
    assert!(save_schedule_in_db(&mut db, schedule("2027-02-29", "Annuelle"), None).is_err());
    let mut invalid_account = schedule("2028-02-29", "Annuelle");
    invalid_account.account_id = "missing".into();
    assert!(save_schedule_in_db(&mut db, invalid_account, None).is_err());
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM schedules WHERE id = 'test-schedule'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn counted_series_consumes_overrides_and_keeps_recorded_operations() {
    let mut db = database();
    let mut item = schedule("2028-01-31", "Mensuelle");
    item.remaining_count = Some(2);
    save_schedule_in_db(&mut db, item, None).unwrap();
    save_schedule_in_db(
        &mut db,
        schedule("2028-02-02", "Mensuelle"),
        Some("occurrence"),
    )
    .unwrap();
    record_schedule_in_db(&mut db, "test-schedule", "limited-1").unwrap();
    let loaded = list_schedules_in_db(&db)
        .unwrap()
        .into_iter()
        .find(|s| s.id == "test-schedule")
        .unwrap();
    assert_eq!(
        (loaded.next_due.as_str(), loaded.remaining_count),
        ("2028-02-29", Some(1))
    );
    record_schedule_in_db(&mut db, "test-schedule", "limited-2").unwrap();
    assert!(
        list_schedules_in_db(&db)
            .unwrap()
            .iter()
            .all(|s| s.id != "test-schedule")
    );
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM transactions WHERE id IN ('limited-1','limited-2')",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
}

#[test]
fn end_date_is_inclusive_and_invalid_update_is_rejected() {
    let mut db = database();
    let mut item = schedule("2028-01-31", "Mensuelle");
    item.end_date = Some("2028-02-29".into());
    save_schedule_in_db(&mut db, item, None).unwrap();
    record_schedule_in_db(&mut db, "test-schedule", "date-1").unwrap();
    assert_eq!(next_date(&db), "2028-02-29");
    let mut invalid = schedule("2028-02-29", "Mensuelle");
    invalid.end_date = Some("2028-02-28".into());
    assert!(save_schedule_in_db(&mut db, invalid, Some("series")).is_err());
    record_schedule_in_db(&mut db, "test-schedule", "date-2").unwrap();
    assert!(
        list_schedules_in_db(&db)
            .unwrap()
            .iter()
            .all(|s| s.id != "test-schedule")
    );
}

#[test]
fn future_exception_survives_until_recorded_and_preserves_series() {
    let mut db = database();
    save_schedule_in_db(&mut db, schedule("2028-01-31", "Mensuelle"), None).unwrap();
    let mut changed = schedule("2028-03-02", "Mensuelle");
    changed.label = "Exception".into();
    changed.amount = -1234;
    assert!(
        update_future_in_db(&mut db, schedule("2028-03-02", "Mensuelle"), "2028-02-28").is_err()
    );
    update_future_in_db(&mut db, changed, "2028-02-29").unwrap();
    let item = list_schedules_in_db(&db)
        .unwrap()
        .into_iter()
        .find(|s| s.id == "test-schedule")
        .unwrap();
    assert_eq!(item.future_overrides[0].original_due, "2028-02-29");
    record_schedule_in_db(&mut db, "test-schedule", "january").unwrap();
    let item = list_schedules_in_db(&db)
        .unwrap()
        .into_iter()
        .find(|s| s.id == "test-schedule")
        .unwrap();
    assert_eq!(
        (item.next_due.as_str(), item.label.as_str()),
        ("2028-03-02", "Exception")
    );
    assert!(item.future_overrides.is_empty());
    record_schedule_in_db(&mut db, "test-schedule", "february").unwrap();
    let actual: (String, String, i64) = db
        .query_row(
            "SELECT operation_date,label,amount_cents FROM transactions WHERE id='february'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(actual, ("2028-03-02".into(), "Exception".into(), -1234));
    assert_eq!(next_date(&db), "2028-03-31");
}

#[test]
fn future_transfer_override_obeys_limits_and_records_both_sides() {
    let mut db = database();
    let mut series = recurring_transfer();
    series.remaining_count = Some(2);
    save_schedule_in_db(&mut db, series, None).unwrap();
    let mut changed = recurring_transfer();
    changed.destination_account_id = Some("livret-michel".into());
    changed.next_due = "2028-03-01".into();
    assert!(update_future_in_db(&mut db, recurring_transfer(), "2028-03-31").is_err());
    update_future_in_db(&mut db, changed, "2028-02-29").unwrap();
    record_schedule_in_db(&mut db, "test-schedule", "first").unwrap();
    record_schedule_in_db(&mut db, "test-schedule", "second").unwrap();
    let credit: (String, String, i64) = db.query_row("SELECT account_id,operation_date,amount_cents FROM transactions WHERE id='second-credit'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(credit, ("livret-michel".into(), "2028-03-01".into(), 4275));
    assert!(
        list_schedules_in_db(&db)
            .unwrap()
            .iter()
            .all(|s| s.id != "test-schedule")
    );
}

#[test]
fn cheque_number_is_recorded_once_while_the_payment_method_stays_on_the_series() {
    let mut db = database();
    let mut item = schedule("2028-01-31", "Mensuelle");
    item.payment_method = Some("cheque".into());
    item.cheque = Some(" 00123 ".into());
    save_schedule_in_db(&mut db, item, None).unwrap();
    record_schedule_in_db(&mut db, "test-schedule", "one").unwrap();
    let item = list_schedules_in_db(&db)
        .unwrap()
        .into_iter()
        .find(|s| s.id == "test-schedule")
        .unwrap();
    assert_eq!(item.payment_method.as_deref(), Some("cheque"));
    assert_eq!(item.cheque, None);
    record_schedule_in_db(&mut db, "test-schedule", "two").unwrap();
    let first: Option<String> = db
        .query_row("SELECT cheque FROM transactions WHERE id='one'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let second: Option<String> = db
        .query_row("SELECT cheque FROM transactions WHERE id='two'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(first.as_deref(), Some("00123"));
    assert_eq!(second, None);
}

#[test]
fn future_cheque_override_is_promoted_without_changing_series_payment() {
    let mut db = database();
    let mut series = schedule("2028-01-31", "Mensuelle");
    series.payment_method = Some("direct_debit".into());
    save_schedule_in_db(&mut db, series, None).unwrap();
    let mut future = schedule("2028-02-29", "Mensuelle");
    future.payment_method = Some("cheque".into());
    future.cheque = Some("0042".into());
    update_future_in_db(&mut db, future, "2028-02-29").unwrap();
    record_schedule_in_db(&mut db, "test-schedule", "first").unwrap();
    let item = list_schedules_in_db(&db)
        .unwrap()
        .into_iter()
        .find(|s| s.id == "test-schedule")
        .unwrap();
    assert_eq!(
        (item.payment_method.as_deref(), item.cheque.as_deref()),
        (Some("cheque"), Some("0042"))
    );
    assert_eq!(
        item.series.unwrap().payment_method.as_deref(),
        Some("direct_debit")
    );
    record_schedule_in_db(&mut db, "test-schedule", "second").unwrap();
    let cheque: Option<String> = db
        .query_row(
            "SELECT cheque FROM transactions WHERE id='second'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(cheque.as_deref(), Some("0042"));
    let item = list_schedules_in_db(&db)
        .unwrap()
        .into_iter()
        .find(|s| s.id == "test-schedule")
        .unwrap();
    assert_eq!(item.payment_method.as_deref(), Some("direct_debit"));
    assert!(item.cheque.is_none());
}

#[test]
fn invalid_payment_fields_are_rejected() {
    let mut db = database();
    let mut item = schedule("2028-01-31", "Mensuelle");
    item.payment_method = Some("direct_debit".into());
    item.cheque = Some("123".into());
    assert!(save_schedule_in_db(&mut db, item, None).is_err());
    let mut item = recurring_transfer();
    item.payment_method = Some("cheque".into());
    assert!(save_schedule_in_db(&mut db, item, None).is_err());
}
