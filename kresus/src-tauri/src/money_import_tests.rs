use super::*;

#[test]
fn imports_schedule_comment_and_copies_it_to_recorded_operation() {
    let mut preview = fixture();
    preview.schedules.push(MoneySchedule {
        id: 80,
        account_id: 1,
        destination_account_id: None,
        label: "Mutuelle".into(),
        category: "Divers".into(),
        next_due: "2026-12-10".into(),
        frequency: Frequency::Monthly,
        amount: -9020,
        kind: "debit".into(),
        estimated: false,
        note: Some("  garantie santé  ".into()),
        payment_method: None,
        anchor_day: None,
        remaining_count: None,
        end_date: None,
    });
    let selected = [MoneySelection {
        id: 1,
        kind: "Compte courant".into(),
    }];
    let mut db = Connection::open_in_memory().unwrap();
    import_into_database(&mut db, &preview, &selected).unwrap();
    let comment: String = db
        .query_row(
            "SELECT note FROM schedules WHERE id='money-schedule-80'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(comment, "garantie santé");
    crate::schedules::record_schedule_in_db(&mut db, "money-schedule-80", "schedule-note-test")
        .unwrap();
    let recorded: String = db
        .query_row(
            "SELECT note FROM transactions WHERE id='schedule-note-test'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(recorded, "garantie santé");
}

#[test]
fn imports_income_payment_for_credit_and_rejects_it_on_debit() {
    let mut preview = fixture();
    preview.schedules.push(MoneySchedule {
        id: 70,
        account_id: 1,
        destination_account_id: None,
        label: "Salaire".into(),
        category: "Divers".into(),
        next_due: "2026-12-01".into(),
        frequency: Frequency::Monthly,
        amount: 200000,
        kind: "credit".into(),
        estimated: false,
        note: None,
        payment_method: Some("income_payment".into()),
        anchor_day: None,
        remaining_count: None,
        end_date: None,
    });
    let selected = [MoneySelection {
        id: 1,
        kind: "Compte courant".into(),
    }];
    let mut db = Connection::open_in_memory().unwrap();
    import_into_database(&mut db, &preview, &selected).unwrap();
    let value: String = db
        .query_row(
            "SELECT payment_method FROM schedules WHERE id='money-schedule-70'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(value, "income_payment");
    preview.schedules[0].kind = "debit".into();
    preview.schedules[0].amount = -200000;
    let mut invalid = Connection::open_in_memory().unwrap();
    assert!(import_into_database(&mut invalid, &preview, &selected).is_err());
}

#[test]
fn imported_overdue_annual_schedule_keeps_due_date_and_advances_one_year() {
    let mut preview = fixture();
    preview.schedules.push(MoneySchedule {
        id: 91,
        account_id: 1,
        destination_account_id: None,
        label: "BWT".into(),
        category: "Divers".into(),
        next_due: "2026-10-09".into(),
        frequency: Frequency::Annual,
        amount: -19690,
        kind: "debit".into(),
        estimated: false,
        note: None,
        payment_method: Some("cheque".into()),
        anchor_day: Some(9),
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
    crate::schedules::record_schedule_in_db(&mut db, "money-schedule-91", "annual-overdue")
        .unwrap();
    let result: (String, String, i64) = db.query_row("SELECT next_due, (SELECT operation_date FROM transactions WHERE id='annual-overdue'), (SELECT amount_cents FROM transactions WHERE id='annual-overdue') FROM schedules WHERE id='money-schedule-91'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(result, ("2027-10-09".into(), "2026-10-09".into(), -19690));
}

#[test]
fn imported_one_time_schedule_records_once() {
    let mut preview = fixture();
    preview.schedules.push(MoneySchedule {
        id: 99,
        account_id: 1,
        destination_account_id: None,
        label: "Trésor".into(),
        category: "Divers".into(),
        next_due: "2026-12-28".into(),
        frequency: Frequency::Once,
        amount: -53000,
        kind: "debit".into(),
        estimated: false,
        note: None,
        payment_method: None,
        anchor_day: Some(28),
        remaining_count: None,
        end_date: Some("2026-12-28".into()),
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
    crate::schedules::record_schedule_in_db(&mut db, "money-schedule-99", "once").unwrap();
    let result: (i64, i64) = db.query_row("SELECT (SELECT amount_cents FROM transactions WHERE id='once'), (SELECT count(*) FROM schedules WHERE id='money-schedule-99')", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(result, (-53000, 0));
}

#[test]
fn money_file_size_limit_accepts_large_files_and_rejects_above_64_mib() {
    let path = crate::test_support::temporary_database_path();
    let file = fs::File::create(&path.0).unwrap();
    // Sparse files exercise the actual file reader without shipping large fixtures.
    for size in [20 * 1024 * 1024 + 1, MAX_MONEY_FILE_BYTES] {
        file.set_len(size).unwrap();
        assert_eq!(read_money_file(&path.0).unwrap().len() as u64, size);
    }
    file.set_len(MAX_MONEY_FILE_BYTES + 1).unwrap();
    assert!(read_money_file(&path.0).unwrap_err().contains("64 Mio"));
}

fn fixture() -> MoneyPreview {
    serde_json::from_str(r#"{"accounts":[{"id":1,"name":"Compte","openingBalance":100000,"balance":87500,"count":2}],"categories":[{"id":3,"name":"Maison","parentId":null},{"id":4,"name":"Charges","parentId":3}],"operations":[{"id":1,"accountId":1,"date":"2026-01-01","label":"Loyer","category":"Maison · Charges","amount":-10000,"reconciled":false,"note":""},{"id":2,"accountId":1,"date":"2026-01-02","label":"Achat","category":"Divers","amount":-2500,"reconciled":true,"note":"Référence Money : 1Carte"}],"warnings":[]}"#).unwrap()
}

#[test]
fn import_keeps_names_and_payees_longer_than_the_manual_entry_limit() {
    let mut preview = fixture();
    let long = "é".repeat(201);
    preview.accounts[0].name = long.clone();
    preview.categories[0].name = long.clone();
    preview.operations[0].label = long.clone();
    let mut db = Connection::open_in_memory().unwrap();
    import_into_database(
        &mut db,
        &preview,
        &[MoneySelection {
            id: 1,
            kind: "Épargne".into(),
        }],
    )
    .unwrap();
    for (table, id) in [
        ("accounts", "money-account-1"),
        ("categories", "money-cat-3"),
        ("transactions", "money-transaction-1"),
    ] {
        let column = if table == "transactions" {
            "label"
        } else {
            "name"
        };
        let stored: String = db
            .query_row(
                &format!("SELECT {column} FROM {table} WHERE id=?1"),
                [id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, long);
    }
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
        frequency: Frequency::Monthly,
        amount: -1200,
        kind: "debit".into(),
        estimated: true,
        note: None,
        payment_method: Some("cheque".into()),
        anchor_day: None,
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
    let estimated: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schedule_estimates WHERE schedule_id='money-schedule-9')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(estimated);
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
fn import_trims_text_without_changing_internal_spacing() {
    let mut preview = fixture();
    preview.accounts[0].name = "  Compte  ".into();
    preview.categories[0].name = "  Maison  ".into();
    preview.categories[1].name = "  Charges  ".into();
    preview.operations[0].label = "  Mon  loyer  ".into();
    preview.operations[0].category = "  Maison · Charges  ".into();
    preview.operations[0].note = "  Une ligne\n  Une autre  ".into();
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
    let row: (String, String, String) = db
        .query_row(
            "SELECT label,category,note FROM transactions WHERE id='money-transaction-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        row,
        (
            "Mon  loyer".into(),
            "Maison · Charges".into(),
            "Une ligne\n  Une autre".into()
        )
    );
    assert_eq!(
        db.query_row(
            "SELECT name FROM accounts WHERE id='money-account-1'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "Compte"
    );
    assert_eq!(
        db.query_row(
            "SELECT name FROM categories WHERE id='money-cat-3'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "Maison"
    );
}

fn posted_transfer_fixture() -> MoneyPreview {
    let mut preview = fixture();
    preview.accounts.push(MoneyAccount {
        id: 2,
        name: "Épargne".into(),
        opening_balance: 200000,
        balance: 202500,
        count: 2,
    });
    preview.operations.extend([
        MoneyOperation {
            reference: None,
            id: 10,
            account_id: 1,
            date: "2026-02-01".into(),
            label: "Vers épargne".into(),
            category: "Divers".into(),
            amount: -10000,
            reconciled: true,
            note: "Débit".into(),
        },
        MoneyOperation {
            reference: None,
            id: 11,
            account_id: 2,
            date: "2026-02-01".into(),
            label: "Depuis compte".into(),
            category: "Divers".into(),
            amount: 10000,
            reconciled: false,
            note: "Crédit".into(),
        },
        MoneyOperation {
            reference: None,
            id: 12,
            account_id: 2,
            date: "2026-03-01".into(),
            label: "Retour".into(),
            category: "Divers".into(),
            amount: -7500,
            reconciled: false,
            note: "".into(),
        },
        MoneyOperation {
            reference: None,
            id: 13,
            account_id: 1,
            date: "2026-03-01".into(),
            label: "Retour".into(),
            category: "Divers".into(),
            amount: 7500,
            reconciled: true,
            note: "".into(),
        },
    ]);
    preview.transfers = vec![
        MoneyTransfer {
            debit_id: 10,
            credit_id: 11,
        },
        MoneyTransfer {
            debit_id: 12,
            credit_id: 13,
        },
    ];
    preview
}

fn both_accounts() -> Vec<MoneySelection> {
    vec![
        MoneySelection {
            id: 1,
            kind: "Compte courant".into(),
        },
        MoneySelection {
            id: 2,
            kind: "Épargne".into(),
        },
    ]
}

#[test]
fn imports_references_independently_of_notes_cheques_and_transfer_sides() {
    let mut preview = posted_transfer_fixture();
    preview.operations[0].reference = Some("0000123".into());
    preview.operations[0].note = "Une note".into();
    preview
        .operations
        .iter_mut()
        .find(|op| op.id == 10)
        .unwrap()
        .reference = Some("000000001".into());
    let mut db = Connection::open_in_memory().unwrap();
    import_into_database(&mut db, &preview, &both_accounts()).unwrap();
    let values: (Option<String>, Option<String>, Option<String>) = db
        .query_row(
            "SELECT reference,note,cheque FROM transactions WHERE id='money-transaction-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        values,
        (Some("0000123".into()), Some("Une note".into()), None)
    );
    let pair: (Option<String>, Option<String>) = db.query_row("SELECT d.reference,c.reference FROM transfers t JOIN transactions d ON d.id=t.debit_id JOIN transactions c ON c.id=t.credit_id WHERE t.id='money-transfer-10-11'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(pair, (Some("000000001".into()), None));
}

#[test]
fn synthetic_posted_transfers_preserve_both_operations_and_balances() {
    let mut db = Connection::open_in_memory().unwrap();
    import_into_database(&mut db, &posted_transfer_fixture(), &both_accounts()).unwrap();
    let rows: (i64, i64, i64, i64, String, String) = db.query_row("SELECT d.amount_cents,c.amount_cents,d.reconciled,c.reconciled,d.note,c.note FROM transfers t JOIN transactions d ON d.id=t.debit_id JOIN transactions c ON c.id=t.credit_id WHERE t.id='money-transfer-10-11'", [], |r| Ok((r.get(0)?, r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).unwrap();
    assert_eq!(rows, (-10000, 10000, 1, 0, "Débit".into(), "Crédit".into()));
    let accounts = crate::accounts::list_accounts_in_db(&db).unwrap();
    assert_eq!(
        accounts
            .iter()
            .find(|a| a.id == "money-account-1")
            .unwrap()
            .current_balance,
        85000
    );
    assert_eq!(
        accounts
            .iter()
            .find(|a| a.id == "money-account-2")
            .unwrap()
            .current_balance,
        202500
    );
    crate::transactions::update_transfer_in_db(
        &mut db,
        crate::transactions::NewTransfer {
            debit_reference: None,
            credit_reference: None,
            id: "money-transfer-10-11".into(),
            source_id: "money-account-1".into(),
            destination_id: "money-account-2".into(),
            date: "2026-02-02".into(),
            amount: 20000,
            category: "Divers".into(),
            note: "Modifié".into(),
        },
    )
    .unwrap();
    let updated: (i64, i64, i64, i64) = db.query_row("SELECT d.amount_cents,c.amount_cents,d.reconciled,c.reconciled FROM transfers t JOIN transactions d ON d.id=t.debit_id JOIN transactions c ON c.id=t.credit_id WHERE t.id='money-transfer-10-11'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    assert_eq!(updated, (-20000, 20000, 1, 0));
    crate::transactions::delete_transaction_in_db(&db, "money-transaction-11").unwrap();
    let count: i64 = db.query_row("SELECT count(*) FROM transactions WHERE id IN ('money-transaction-10','money-transaction-11')", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 0);
}

#[test]
fn synthetic_posted_transfers_reject_partial_and_inconsistent_pairs_atomically() {
    let preview = posted_transfer_fixture();
    let mut db = Connection::open_in_memory().unwrap();
    assert!(import_into_database(&mut db, &preview, &both_accounts()[..1]).is_err());
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='accounts'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    for mode in 0..4 {
        let mut invalid = posted_transfer_fixture();
        match mode {
            0 => {
                invalid
                    .operations
                    .iter_mut()
                    .find(|op| op.id == 11)
                    .unwrap()
                    .amount = 9999
            }
            1 => invalid.transfers[0].credit_id = 999,
            2 => invalid.transfers[1].credit_id = 11,
            _ => {
                invalid
                    .operations
                    .iter_mut()
                    .find(|op| op.id == 11)
                    .unwrap()
                    .account_id = 1
            }
        }
        let mut db = Connection::open_in_memory().unwrap();
        assert!(
            import_into_database(&mut db, &invalid, &both_accounts()).is_err(),
            "case {mode}"
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='accounts'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
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
        frequency: Frequency::EveryTwoMonths,
        amount: -10000,
        kind: "transfer".into(),
        estimated: false,
        note: None,
        payment_method: Some("automatic".into()),
        anchor_day: None,
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
    let method: String = db
        .query_row(
            "SELECT payment_method FROM schedules WHERE id='money-schedule-8'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(method, "automatic");
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
fn imported_twice_monthly_transfer_creates_linked_entries_and_advances() {
    let mut preview = fixture();
    preview.accounts.push(MoneyAccount {
        id: 2,
        name: "Livret".into(),
        opening_balance: 0,
        balance: 0,
        count: 0,
    });
    preview.schedules.push(MoneySchedule {
        id: 9,
        account_id: 1,
        destination_account_id: Some(2),
        label: "Orange bimensuel".into(),
        category: "Divers".into(),
        next_due: "2026-10-15".into(),
        frequency: Frequency::TwiceMonthly,
        amount: -10000,
        kind: "transfer".into(),
        estimated: false,
        note: None,
        payment_method: None,
        anchor_day: Some(15),
        remaining_count: None,
        end_date: None,
    });
    let mut db = Connection::open_in_memory().unwrap();
    import_into_database(&mut db, &preview, &both_accounts()).unwrap();
    crate::schedules::record_schedule_in_db(&mut db, "money-schedule-9", "semi-transfer").unwrap();
    let result: (String, i64, i64, i64) = db.query_row("SELECT next_due, (SELECT amount_cents FROM transactions WHERE id='semi-transfer-debit'), (SELECT amount_cents FROM transactions WHERE id='semi-transfer-credit'), (SELECT count(*) FROM transfers WHERE id='semi-transfer') FROM schedules WHERE id='money-schedule-9'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    assert_eq!(result, ("2026-10-31".into(), -10000, 10000, 1));
    crate::schedules::record_schedule_in_db(&mut db, "money-schedule-9", "semi-next").unwrap();
    assert_eq!(
        db.query_row(
            "SELECT next_due FROM schedules WHERE id='money-schedule-9'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "2026-11-15"
    );
    preview.schedules[0].next_due = "2026-10-16".into();
    let mut invalid = Connection::open_in_memory().unwrap();
    assert!(import_into_database(&mut invalid, &preview, &both_accounts()).is_err());
}

#[test]
fn imported_semiannual_debit_persists_and_advances_every_six_months() {
    let mut preview = fixture();
    preview.schedules.push(MoneySchedule {
        id: 12,
        account_id: 1,
        destination_account_id: None,
        label: "EDF semestriel".into(),
        category: "Divers".into(),
        next_due: "2026-11-13".into(),
        frequency: Frequency::Semiannual,
        amount: -10000,
        kind: "debit".into(),
        estimated: false,
        note: None,
        payment_method: None,
        anchor_day: Some(13),
        remaining_count: None,
        end_date: None,
    });
    let path = crate::test_support::temporary_database_path();
    let mut db = Connection::open(&path.0).unwrap();
    import_into_database(
        &mut db,
        &preview,
        &[MoneySelection {
            id: 1,
            kind: "Compte courant".into(),
        }],
    )
    .unwrap();
    drop(db);
    let mut db = Connection::open(&path.0).unwrap();
    for (id, expected) in [
        ("semiannual-first", "2027-05-13"),
        ("semiannual-second", "2027-11-13"),
    ] {
        crate::schedules::record_schedule_in_db(&mut db, "money-schedule-12", id).unwrap();
        let value: (String, String, i64) = db.query_row(
            "SELECT frequency, next_due, (SELECT amount_cents FROM transactions WHERE id=?1) FROM schedules WHERE id='money-schedule-12'",
            [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(value, ("Semestrielle".into(), expected.into(), -10000));
    }
}

#[test]
fn imported_quarterly_debit_advances_by_three_months() {
    let mut preview = fixture();
    preview.schedules.push(MoneySchedule {
        id: 9,
        account_id: 1,
        destination_account_id: None,
        label: "Trimestrielle".into(),
        category: "Divers".into(),
        next_due: "2026-11-06".into(),
        frequency: Frequency::Quarterly,
        amount: -10000,
        kind: "debit".into(),
        estimated: false,
        note: None,
        payment_method: Some("cheque".into()),
        anchor_day: Some(6),
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
    crate::schedules::record_schedule_in_db(&mut db, "money-schedule-9", "quarterly-first")
        .unwrap();
    let result: (String, String, i64) = db.query_row(
        "SELECT frequency, next_due, (SELECT amount_cents FROM transactions WHERE id='quarterly-first') FROM schedules WHERE id='money-schedule-9'",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    assert_eq!(
        result,
        ("Trimestrielle".into(), "2027-02-06".into(), -10000)
    );
}

#[test]
fn imported_schedule_limits_are_atomic_and_enforced() {
    for (remaining_count, end_date) in [(Some(2), None), (None, Some("2028-02-29".to_string()))] {
        let mut preview = fixture();
        preview.schedules.push(MoneySchedule {
            id: 9,
            account_id: 1,
            destination_account_id: None,
            label: "Limitée".into(),
            category: "Divers".into(),
            next_due: "2028-01-31".into(),
            frequency: Frequency::Monthly,
            amount: -1200,
            kind: "debit".into(),
            estimated: false,
            note: None,
            payment_method: None,
            anchor_day: None,
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
        crate::schedules::record_schedule_in_db(&mut db, "money-schedule-9", "limit-last").unwrap();
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
fn imported_started_series_preserves_month_end_anchor() {
    let mut preview = fixture();
    preview.schedules.push(MoneySchedule {
        id: 9,
        account_id: 1,
        destination_account_id: None,
        label: "Limitée".into(),
        category: "Divers".into(),
        next_due: "2028-02-29".into(),
        frequency: Frequency::Monthly,
        amount: -1200,
        kind: "debit".into(),
        estimated: false,
        note: None,
        payment_method: None,
        anchor_day: Some(31),
        remaining_count: None,
        end_date: Some("2028-03-31".into()),
    });
    let mut invalid = preview.clone();
    invalid.schedules[0].anchor_day = Some(28);
    let mut rejected = Connection::open_in_memory().unwrap();
    assert!(
        import_into_database(
            &mut rejected,
            &invalid,
            &[MoneySelection {
                id: 1,
                kind: "Compte courant".into()
            }]
        )
        .is_err()
    );
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
    crate::schedules::record_schedule_in_db(&mut db, "money-schedule-9", "first").unwrap();
    assert_eq!(
        db.query_row(
            "SELECT next_due FROM schedules WHERE id='money-schedule-9'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "2028-03-31"
    );
    crate::schedules::record_schedule_in_db(&mut db, "money-schedule-9", "last").unwrap();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM schedules WHERE id='money-schedule-9'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
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
            frequency: Frequency::Monthly,
            amount: -1200,
            kind: "debit".into(),
            estimated: false,
            note: None,
            payment_method: None,
            anchor_day: None,
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
