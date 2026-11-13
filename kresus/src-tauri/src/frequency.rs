use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};
use std::str::FromStr;

// These serialized names are part of the existing SQLite and Tauri data format.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) enum Frequency {
    #[serde(rename = "Une seule fois")]
    Once,
    #[serde(rename = "Mensuelle")]
    Monthly,
    #[serde(rename = "Bimensuelle")]
    TwiceMonthly,
    #[serde(rename = "Bimestrielle")]
    EveryTwoMonths,
    #[serde(rename = "Trimestrielle")]
    Quarterly,
    #[serde(rename = "Semestrielle")]
    Semiannual,
    #[serde(rename = "Annuelle")]
    Annual,
}

impl Frequency {
    fn as_str(self) -> &'static str {
        match self {
            Self::Once => "Une seule fois",
            Self::Monthly => "Mensuelle",
            Self::TwiceMonthly => "Bimensuelle",
            Self::EveryTwoMonths => "Bimestrielle",
            Self::Quarterly => "Trimestrielle",
            Self::Semiannual => "Semestrielle",
            Self::Annual => "Annuelle",
        }
    }
}

impl FromStr for Frequency {
    type Err = String;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "Une seule fois" => Ok(Self::Once),
            "Mensuelle" => Ok(Self::Monthly),
            "Bimensuelle" => Ok(Self::TwiceMonthly),
            "Bimestrielle" => Ok(Self::EveryTwoMonths),
            "Trimestrielle" => Ok(Self::Quarterly),
            "Semestrielle" => Ok(Self::Semiannual),
            "Annuelle" => Ok(Self::Annual),
            _ => Err(format!("Périodicité inconnue : {value}")),
        }
    }
}

impl ToSql for Frequency {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(self.as_str().into())
    }
}

impl FromSql for Frequency {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        value
            .as_str()?
            .parse()
            .map_err(|message: String| FromSqlError::Other(message.into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn json_and_sql_round_trip_existing_values_and_reject_unknown_frequencies() {
        let db = Connection::open_in_memory().unwrap();
        for (frequency, stored) in [
            (Frequency::Once, "Une seule fois"),
            (Frequency::Monthly, "Mensuelle"),
            (Frequency::TwiceMonthly, "Bimensuelle"),
            (Frequency::EveryTwoMonths, "Bimestrielle"),
            (Frequency::Quarterly, "Trimestrielle"),
            (Frequency::Semiannual, "Semestrielle"),
            (Frequency::Annual, "Annuelle"),
        ] {
            assert_eq!(serde_json::to_value(frequency).unwrap(), stored);
            assert_eq!(
                serde_json::from_value::<Frequency>(stored.into()).unwrap(),
                frequency
            );
            let actual: String = db
                .query_row("SELECT ?1", [frequency], |row| row.get(0))
                .unwrap();
            assert_eq!(actual, stored);
            let actual: Frequency = db
                .query_row("SELECT ?1", [stored], |row| row.get(0))
                .unwrap();
            assert_eq!(actual, frequency);
        }
        assert!(serde_json::from_str::<Frequency>("\"Hebdomadaire\"").is_err());
        assert!(
            db.query_row("SELECT 'Hebdomadaire'", [], |row| row
                .get::<_, Frequency>(0))
                .is_err()
        );
    }
}
