use super::*;
use crate::test_support::database;

fn entry(id: &str, date: &str, amount: &str, label: &str) -> String {
    format!(
        "<STMTTRN><TRNTYPE>OTHER</TRNTYPE><FITID>{id}</FITID><DTPOSTED>{date}</DTPOSTED><TRNAMT>{amount}</TRNAMT><NAME>{label}</NAME></STMTTRN>"
    )
}

fn xml(currency: &str, entries: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS>
<CURDEF>{currency}</CURDEF><BANKACCTFROM><BANKID>12345</BANKID><ACCTID>00123456</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST>{entries}</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>"#
    )
}

#[test]
fn parses_ofx_xml_and_legacy_sgml_with_signed_amounts_and_bank_ids() {
    let line = entry(
        "id&amp;42",
        "20240229130000.000[+1:CET]",
        "-12.3400",
        "Café &amp; journal",
    );
    let xml = xml("EUR", &(line.clone() + &line));
    let statement = ofx::parse(xml.as_bytes()).unwrap();
    assert_eq!(statement.account_number, "00123456");
    assert_eq!(statement.rows[0].fit_id, "id&42");
    assert_eq!(statement.rows[0].label, "Café & journal");
    assert_eq!(statement.rows[0].date, "2024-02-29");
    assert_eq!(statement.rows[0].amount, -1234);
    assert_eq!(statement.repeated, vec![false, true]);

    let sgml = b"OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nENCODING:USASCII\r\nCHARSET:1252\r\n\r\n\
<OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0\r\n</STATUS><STMTRS>\
<CURDEF>EUR\r\n<BANKACCTFROM><BANKID>12345<ACCTID>00123456<ACCTTYPE>CHECKING</BANKACCTFROM>\
<BANKTRANLIST><DTSTART>20240201\r\n<STMTTRN><DTPOSTED>20240229<TRNAMT>17.5<FITID>100<NAME>Caf\xe9<MEMO>Prix 17,5 \x80<CHECKNUM>0032</STMTTRN>\
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>";
    let legacy = ofx::parse(sgml).unwrap();
    assert_eq!(legacy.rows[0].label, "Café");
    assert_eq!(legacy.rows[0].amount, 1750);
    assert_eq!(legacy.rows[0].note.as_deref(), Some("Prix 17,5 €"));
    assert_eq!(legacy.rows[0].reference.as_deref(), Some("0032"));
}

#[test]
fn rejects_invalid_dates_amounts_currency_and_conflicting_bank_ids() {
    for (date, amount) in [
        ("19691231", "10.00"),
        ("20270229", "10"),
        ("20270228", "-1.001"),
        ("20270228", "0"),
        ("20270228", "1000000000.01"),
    ] {
        assert!(ofx::parse(xml("EUR", &entry("a", date, amount, "Courses")).as_bytes()).is_err());
    }
    let valid = entry("a", "20270110", "-1", "Courses");
    assert!(ofx::parse(xml("USD", &valid).as_bytes()).is_err());
    let conflicting = valid.clone() + &entry("a", "20270110", "-2", "Courses");
    assert!(ofx::parse(xml("EUR", &conflicting).as_bytes()).is_err());
    let corrected = valid.replace(
        "</STMTTRN>",
        "<CORRECTFITID>b</CORRECTFITID><CORRECTACTION>DELETE</CORRECTACTION></STMTTRN>",
    );
    assert!(ofx::parse(xml("EUR", &corrected).as_bytes()).is_err());
    assert!(ofx::parse(xml("EUR", &valid).trim_end_matches("</OFX>").as_bytes()).is_err());
}

#[test]
fn reads_the_ledger_balance_and_date_even_with_no_movements() {
    let no_rows = xml("EUR", "").replace("<BANKTRANLIST></BANKTRANLIST>", "");
    let statement = |balance: &str| {
        let xml = no_rows.replace(
            "</STMTRS>",
            &format!(
                "<AVAILBAL><BALAMT>300.00</BALAMT><DTASOF>20270116</DTASOF></AVAILBAL>
                 <LEDGERBAL><BALAMT>{balance}</BALAMT><DTASOF>20270115013000[+1:CET]</DTASOF></LEDGERBAL></STMTRS>"
            ),
        );
        ofx::parse(xml.as_bytes()).unwrap()
    };
    for (raw, expected) in [("0.00", Some(0)), ("-20.01", Some(-2001)), ("1.005", None)] {
        let parsed = statement(raw);
        assert!(parsed.rows.is_empty());
        assert_eq!(parsed.closing.date.as_deref(), Some("2027-01-15"));
        assert_eq!(parsed.closing.amount, expected);
    }
    assert_eq!(
        ofx::parse(xml("EUR", "").as_bytes())
            .unwrap()
            .closing
            .amount,
        None
    );
}

#[test]
fn pointed_balance_respects_the_bank_date_and_ignores_unpointed_and_future_entries() {
    let mut db = database();
    existing(&db);
    db.execute_batch(
        "UPDATE accounts SET opening_balance_cents=20000 WHERE id='ccp';
         UPDATE transactions SET reconciled=1 WHERE id IN ('other-account','other-sign');
         UPDATE transactions SET operation_date='2027-01-15' WHERE id='existing';",
    )
    .unwrap();
    let file = xml("EUR", &entry("bank", "20270110", "-12.34", "Relevé"));
    let parsed = ofx::parse(file.as_bytes()).unwrap();
    apply_statement(
        &mut db,
        "ccp",
        &parsed,
        &[StatementChoice::Match {
            transaction_id: "existing".into(),
        }],
    )
    .unwrap();
    assert_eq!(
        reconciliation_balance_in_db(&db, "ccp", "2027-01-09").unwrap(),
        20000
    );
    assert_eq!(
        reconciliation_balance_in_db(&db, "ccp", "2027-01-10").unwrap(),
        20000
    );
    crate::transactions::toggle_transaction_in_db(&db, "existing").unwrap();
    assert_eq!(
        reconciliation_balance_in_db(&db, "ccp", "2027-01-10").unwrap(),
        21234
    );
    db.execute_batch("ALTER TABLE bank_statement_entries DROP COLUMN bank_date;")
        .unwrap();
    initialize_schema(&db).unwrap();
    crate::transactions::toggle_transaction_in_db(&db, "existing").unwrap();
    assert_eq!(
        reconciliation_balance_in_db(&db, "ccp", "2027-01-10").unwrap(),
        21234
    );
    let verification = apply_statement(&mut db, "ccp", &parsed, &[StatementChoice::Skip]).unwrap();
    assert_eq!(
        (
            verification.added,
            verification.matched,
            verification.skipped
        ),
        (0, 0, 1)
    );
    assert_eq!(
        reconciliation_balance_in_db(&db, "ccp", "2027-01-10").unwrap(),
        20000
    );
    assert!(reconciliation_balance_in_db(&db, "ccp", "1969-12-31").is_err());
    assert!(reconciliation_balance_in_db(&db, "ccp", "2027-02-30").is_err());
}

fn existing(db: &Connection) {
    db.execute_batch("INSERT INTO transactions
        (id,account_id,operation_date,label,category,amount_cents,reference,note)
    VALUES
        ('existing','ccp','2027-01-03','Saisie manuelle','Alimentation',-1234,'réf. locale','note locale'),
        ('other-account','sylvie','2027-01-10','Autre compte','Divers',-1234,NULL,NULL),
        ('other-sign','ccp','2027-01-10','Crédit','Divers',1234,NULL,NULL),
        ('too-old','ccp','2027-01-02','Hors fenêtre','Divers',-1234,NULL,NULL);").unwrap();
}

#[test]
fn imports_and_matches_atomically_then_recognizes_the_same_statement() {
    let mut db = database();
    existing(&db);
    let first = entry("a", "20270110", "-12.34", "Relevé");
    let second = entry("b", "20270110", "37.20", "Remboursement");
    let parsed = ofx::parse(xml("EUR", &(first.clone() + &second + &first)).as_bytes()).unwrap();
    let preview = preview_rows(&db, "ccp", &parsed).unwrap();
    assert_eq!(preview[0].candidates.len(), 1);
    assert_eq!(preview[0].candidates[0].id, "existing");
    assert!(preview[1].candidates.is_empty());
    assert!(matches!(preview[2].duplicate, Some(Duplicate::Repeated)));
    let result = apply_statement(
        &mut db,
        "ccp",
        &parsed,
        &[
            StatementChoice::Match {
                transaction_id: "existing".into(),
            },
            StatementChoice::Add,
            StatementChoice::Skip,
        ],
    )
    .unwrap();
    assert_eq!((result.added, result.matched, result.skipped), (1, 1, 1));
    let items = crate::transactions::list_transactions_in_db(&db, "ccp").unwrap();
    let existing = items.iter().find(|item| item.id == "existing").unwrap();
    assert!(existing.reconciled);
    assert_eq!(existing.date, "2027-01-03");
    assert_eq!(existing.label, "Saisie manuelle");
    assert_eq!(existing.category, "Alimentation");
    assert_eq!(existing.reference.as_deref(), Some("réf. locale"));
    assert_eq!(existing.note.as_deref(), Some("note locale"));
    let new = items
        .iter()
        .find(|item| item.label == "Remboursement")
        .unwrap();
    assert!(new.reconciled);
    assert_eq!(new.amount, 3720);
    assert_eq!(new.category, "Divers");
    assert_eq!(Uuid::parse_str(&new.id).unwrap().get_version_num(), 4);
    assert!(
        preview_rows(&db, "ccp", &parsed)
            .unwrap()
            .iter()
            .all(|line| matches!(line.duplicate, Some(Duplicate::AlreadyImported)))
    );
    assert!(
        apply_statement(
            &mut db,
            "ccp",
            &parsed,
            &[
                StatementChoice::Add,
                StatementChoice::Skip,
                StatementChoice::Skip
            ]
        )
        .is_err()
    );
    // An OFX identifier belongs to the bank account, so a different account's ID may match it.
    let another_source = xml("EUR", &second).replace("00123456", "00123457");
    let another_source = ofx::parse(another_source.as_bytes()).unwrap();
    assert!(
        preview_rows(&db, "ccp", &another_source).unwrap()[0]
            .duplicate
            .is_none()
    );

    crate::transactions::delete_transaction_in_db(&db, &new.id).unwrap();
    assert!(
        preview_rows(&db, "ccp", &parsed).unwrap()[1]
            .duplicate
            .is_none()
    );
}

#[test]
fn stale_or_reused_match_rolls_back_new_operations_and_pointing() {
    let mut db = database();
    existing(&db);
    let entries = entry("new", "20270110", "9.43", "Nouveau")
        + &entry("one", "20270110", "-12.34", "Premier")
        + &entry("two", "20270110", "-12.34", "Deuxième");
    let parsed = ofx::parse(xml("EUR", &entries).as_bytes()).unwrap();
    let matching = || StatementChoice::Match {
        transaction_id: "existing".into(),
    };
    assert!(
        apply_statement(
            &mut db,
            "ccp",
            &parsed,
            &[StatementChoice::Add, matching(), matching()]
        )
        .is_err()
    );
    let untouched: bool = db
        .query_row(
            "SELECT (SELECT count(*) FROM transactions)=4
           AND (SELECT count(*) FROM transactions WHERE reconciled=1)=0
           AND (SELECT count(*) FROM bank_statement_entries)=0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(untouched);
    assert!(
        apply_statement(
            &mut db,
            "ccp",
            &parsed,
            &[
                StatementChoice::Add,
                StatementChoice::Match {
                    transaction_id: "other-account".into()
                },
                StatementChoice::Skip,
            ]
        )
        .is_err()
    );
}

#[test]
fn current_format_databases_keep_operations_when_bank_import_storage_is_added() {
    let db = database();
    existing(&db);
    db.execute_batch(
        "DROP TRIGGER bank_statement_detach_moved_transaction; DROP TABLE bank_statement_entries;",
    )
    .unwrap();
    crate::database::initialize_database(&db).unwrap();
    let count: i64 = db
        .query_row("SELECT count(*) FROM transactions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 4);

    let parsed =
        ofx::parse(xml("EUR", &entry("a", "20270110", "-12.34", "Relevé")).as_bytes()).unwrap();
    let mut db = db;
    apply_statement(
        &mut db,
        "ccp",
        &parsed,
        &[StatementChoice::Match {
            transaction_id: "existing".into(),
        }],
    )
    .unwrap();
    db.execute(
        "UPDATE transactions SET account_id='sylvie' WHERE id='existing'",
        [],
    )
    .unwrap();
    assert!(
        preview_rows(&db, "ccp", &parsed).unwrap()[0]
            .duplicate
            .is_none()
    );
}
