use chrono::NaiveDate;
use quick_xml::Reader;
use quick_xml::events::Event;
use serde::Serialize;
use std::collections::HashMap;

pub(crate) const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ROWS: usize = 5_000;
const INVALID: &str = "Le fichier OFX est incomplet ou mal formé.";

pub(crate) struct Statement {
    pub bank_id: String,
    pub account_number: String,
    pub rows: Vec<StatementRow>,
    pub repeated: Vec<bool>,
    pub closing: ClosingBalance,
}

#[derive(Clone, Default, Serialize)]
pub(crate) struct ClosingBalance {
    pub date: Option<String>,
    pub amount: Option<i64>,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StatementRow {
    #[serde(skip_serializing)]
    pub fit_id: String,
    pub date: String,
    pub amount: i64,
    pub label: String,
    pub note: Option<String>,
    pub reference: Option<String>,
}

#[derive(Default)]
struct Element {
    name: String,
    text: String,
    children: Vec<Element>,
}

impl Element {
    fn optional_child(&self, tag: &str) -> Result<Option<&Element>, String> {
        let mut children = self.children.iter().filter(|child| child.name == tag);
        let child = children.next();
        if children.next().is_some() {
            return Err(format!("Le fichier OFX contient plusieurs éléments {tag}."));
        }
        Ok(child)
    }

    fn child(&self, tag: &str) -> Result<&Element, String> {
        self.optional_child(tag)?
            .ok_or_else(|| format!("Champ OFX manquant : {tag}."))
    }

    fn optional_value(&self, tag: &str) -> Result<Option<&str>, String> {
        let Some(child) = self.optional_child(tag)? else {
            return Ok(None);
        };
        if !child.children.is_empty() {
            return Err(INVALID.into());
        }
        let value = child.text.trim();
        Ok((!value.is_empty()).then_some(value))
    }

    fn value(&self, tag: &str) -> Result<&str, String> {
        self.optional_value(tag)?
            .ok_or_else(|| format!("Champ OFX manquant : {tag}."))
    }
}

pub(crate) fn parse(bytes: &[u8]) -> Result<Statement, String> {
    let (text, sgml) = decode(bytes)?;
    let ofx = parse_elements(&text, sgml)?;
    let statements = ofx.child("BANKMSGSRSV1")?;
    if ofx.children.iter().any(|child| {
        matches!(
            child.name.as_str(),
            "CREDITCARDMSGSRSV1" | "INVSTMTMSGSRSV1"
        )
    }) {
        return Err("Choisissez un relevé OFX contenant un seul compte bancaire.".into());
    }
    let response = statements.child("STMTTRNRS")?;
    if response.child("STATUS")?.value("CODE")? != "0" {
        return Err("Le fichier OFX contient une erreur signalée par la banque.".into());
    }
    let statement = response.child("STMTRS")?;
    if statement.value("CURDEF")? != "EUR" {
        return Err("Seuls les relevés bancaires en euros sont pris en charge.".into());
    }
    let source = statement.child("BANKACCTFROM")?;
    let bank_id = identifier(source.value("BANKID")?)?;
    let account_number = identifier(source.value("ACCTID")?)?;
    let closing = statement
        .optional_child("LEDGERBAL")?
        .map(|balance| ClosingBalance {
            date: balance
                .optional_value("DTASOF")
                .ok()
                .flatten()
                .and_then(|value| posted_date(value).ok()),
            amount: balance
                .optional_value("BALAMT")
                .ok()
                .flatten()
                .and_then(|value| amount_in_cents(value).ok())
                .filter(|amount| amount.unsigned_abs() <= 100_000_000_000),
        })
        .unwrap_or_default();
    let list = statement.optional_child("BANKTRANLIST")?;
    let mut rows = Vec::new();
    let mut repeated = Vec::new();
    let mut seen = HashMap::new();
    for (index, entry) in list
        .into_iter()
        .flat_map(|list| list.children.iter())
        .filter(|entry| entry.name == "STMTTRN")
        .enumerate()
    {
        if index == MAX_ROWS {
            return Err(format!(
                "Un relevé peut contenir au maximum {MAX_ROWS} opérations."
            ));
        }
        let row =
            parse_row(entry).map_err(|error| format!("Ligne {} du relevé : {error}", index + 1))?;
        let duplicate = match seen.get(&row.fit_id) {
            Some(&previous) if rows[previous] != row => {
                return Err(format!(
                    "Les lignes {} et {} partagent un identifiant bancaire avec des données différentes.",
                    previous + 1,
                    index + 1
                ));
            }
            Some(_) => true,
            None => {
                seen.insert(row.fit_id.clone(), index);
                false
            }
        };
        rows.push(row);
        repeated.push(duplicate);
    }
    Ok(Statement {
        bank_id,
        account_number,
        rows,
        repeated,
        closing,
    })
}

fn parse_row(entry: &Element) -> Result<StatementRow, String> {
    if entry
        .children
        .iter()
        .any(|child| matches!(child.name.as_str(), "CORRECTFITID" | "CORRECTACTION"))
    {
        return Err(
            "Les corrections d’écritures par la banque ne sont pas prises en charge.".into(),
        );
    }
    // A foreign currency may describe the original purchase in ORIGCURRENCY;
    // CURRENCY overrides the statement currency for the amount itself.
    if let Some(currency) = entry.children.iter().find(|child| child.name == "CURRENCY")
        && currency.value("CURSYM")? != "EUR"
    {
        return Err("Le montant de cette écriture doit être en euros.".into());
    }
    let fit_id = identifier(entry.value("FITID")?)?;
    let date = posted_date(entry.value("DTPOSTED")?)?;
    let amount = amount_in_cents(entry.value("TRNAMT")?)?;
    crate::transactions::validate_transaction_amount(amount)?;
    let note = entry.optional_value("MEMO")?;
    let name = entry.optional_value("NAME")?;
    let label = name.or(note).unwrap_or("Opération bancaire");
    let reference = entry
        .optional_value("REFNUM")?
        .or(entry.optional_value("CHECKNUM")?);
    Ok(StatementRow {
        fit_id,
        date,
        amount,
        label: label.into(),
        note: note.filter(|note| *note != label).map(str::to_owned),
        reference: reference.map(str::to_owned),
    })
}

fn posted_date(posted: &str) -> Result<String, String> {
    let raw_date = posted
        .get(..8)
        .filter(|value| value.bytes().all(|byte| byte.is_ascii_digit()))
        .ok_or("Date bancaire invalide.")?;
    let date =
        NaiveDate::parse_from_str(raw_date, "%Y%m%d").map_err(|_| "Date bancaire invalide.")?;
    if raw_date < "19700101" {
        return Err("La date est antérieure au 1er janvier 1970.".into());
    }
    Ok(date.to_string())
}

fn identifier(value: &str) -> Result<String, String> {
    if value.chars().count() > 255 || value.chars().any(char::is_control) {
        return Err("Identifiant bancaire OFX invalide.".into());
    }
    Ok(value.into())
}

fn amount_in_cents(value: &str) -> Result<i64, String> {
    let invalid = "Montant OFX invalide.";
    let negative = value.starts_with('-');
    let unsigned = value.strip_prefix(['-', '+']).unwrap_or(value);
    let (units, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    let significant = fraction.trim_end_matches('0');
    if (units.is_empty() && fraction.is_empty())
        || significant.len() > 2
        || !units
            .bytes()
            .chain(fraction.bytes())
            .all(|b| b.is_ascii_digit())
    {
        return Err(invalid.into());
    }
    let units = if units.is_empty() {
        0
    } else {
        units.parse::<i64>().map_err(|_| invalid)?
    };
    let cents = significant
        .bytes()
        .fold(0i64, |sum, byte| sum * 10 + i64::from(byte - b'0'))
        * if significant.len() == 1 { 10 } else { 1 };
    let amount = units
        .checked_mul(100)
        .and_then(|units| units.checked_add(cents))
        .ok_or(invalid)?;
    Ok(if negative { -amount } else { amount })
}

fn decode(bytes: &[u8]) -> Result<(String, bool), String> {
    let bytes = bytes
        .strip_prefix(b"\xef\xbb\xbf")
        .unwrap_or(bytes)
        .trim_ascii_start();
    let sgml = bytes.starts_with(b"OFXHEADER:");
    let root_at = bytes
        .windows(4)
        .position(|window| window == b"<OFX")
        .ok_or(INVALID)?;
    let header = String::from_utf8_lossy(&bytes[..root_at]).to_ascii_uppercase();
    let body = if sgml { &bytes[root_at..] } else { bytes };
    if sgml && !header.lines().any(|line| line.trim() == "DATA:OFXSGML") {
        return Err("L’en-tête OFX 1.x est invalide.".into());
    }
    if let Ok(text) = std::str::from_utf8(body)
        && (!sgml || !header.contains("CHARSET:1252") || text.is_ascii())
    {
        return Ok((text.into(), sgml));
    }
    // OFX 1.x exports commonly use USASCII with the Windows-1252 character set.
    let cp1252 = header.contains("CHARSET:1252")
        || header.contains("WINDOWS-1252")
        || header.contains("CP1252");
    let latin1 = header.contains("ISO-8859-1") || header.contains("CHARSET:8859-1");
    if !cp1252 && !latin1 {
        return Err(
            "Encodage OFX non pris en charge. Utilisez un fichier UTF-8 ou Windows-1252.".into(),
        );
    }
    const WINDOWS_1252: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž',
        '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}',
        'ž', 'Ÿ',
    ];
    let text = body
        .iter()
        .map(|&byte| {
            if cp1252 && (0x80..0xa0).contains(&byte) {
                WINDOWS_1252[usize::from(byte - 0x80)]
            } else {
                char::from(byte)
            }
        })
        .collect();
    Ok((text, sgml))
}

fn parse_elements(input: &str, sgml: bool) -> Result<Element, String> {
    let mut reader = Reader::from_str(input);
    reader.config_mut().check_end_names = !sgml;
    reader.config_mut().expand_empty_elements = true;
    let mut stack = vec![Element::default()];
    loop {
        match reader.read_event().map_err(|_| INVALID)? {
            Event::Start(tag) => {
                // OFX SGML allows a leaf with character data to omit its closing tag.
                if sgml && stack.len() > 1 && !stack.last().unwrap().text.trim().is_empty() {
                    finish_element(&mut stack)?;
                }
                let name = tag.name().into_inner();
                if stack.len() > 32 || !stack.last().unwrap().text.trim().is_empty() {
                    return Err(INVALID.into());
                }
                stack.push(Element {
                    name: name.into(),
                    ..Element::default()
                });
            }
            Event::End(tag) => {
                let name = tag.name();
                if sgml
                    && stack.last().unwrap().name != name.as_ref()
                    && !stack.last().unwrap().text.trim().is_empty()
                {
                    finish_element(&mut stack)?;
                }
                if stack.last().unwrap().name != name.as_ref() {
                    return Err(INVALID.into());
                }
                finish_element(&mut stack)?;
            }
            Event::Text(text) => stack
                .last_mut()
                .unwrap()
                .text
                .push_str(&text.xml10_content()),
            Event::CData(text) => stack
                .last_mut()
                .unwrap()
                .text
                .push_str(&text.xml10_content()),
            Event::GeneralRef(entity) => {
                let out = &mut stack.last_mut().unwrap().text;
                if let Some(character) = entity.resolve_char_ref().map_err(|_| INVALID)? {
                    out.push(character);
                } else {
                    out.push_str(
                        quick_xml::escape::resolve_xml_entity(&entity.xml10_content())
                            .ok_or(INVALID)?,
                    );
                }
            }
            Event::Decl(_) | Event::PI(_) | Event::Comment(_) => {}
            Event::Eof => break,
            _ => return Err(INVALID.into()),
        }
    }
    let document = stack.pop().ok_or(INVALID)?;
    if !stack.is_empty() || !document.text.trim().is_empty() || document.children.len() != 1 {
        return Err(INVALID.into());
    }
    let root = document.children.into_iter().next().ok_or(INVALID)?;
    if root.name != "OFX" {
        return Err(INVALID.into());
    }
    Ok(root)
}

fn finish_element(stack: &mut Vec<Element>) -> Result<(), String> {
    if stack.len() < 2 {
        return Err(INVALID.into());
    }
    let child = stack.pop().unwrap();
    if !child.children.is_empty() && !child.text.trim().is_empty() {
        return Err(INVALID.into());
    }
    stack.last_mut().unwrap().children.push(child);
    Ok(())
}
