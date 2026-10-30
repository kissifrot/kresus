use crate::accounts::Account;
use crate::database::initialize_database;
use rusqlite::Connection;
use std::fs;

// Remove the test database when the guard goes out of scope, even on failure.
pub(crate) struct TestDatabasePath(pub(crate) std::path::PathBuf);
impl Drop for TestDatabasePath {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        if let Some(directory) = self.0.parent() {
            let _ = fs::remove_dir(directory);
        }
    }
}

pub(crate) fn temporary_database_path() -> TestDatabasePath {
    static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    loop {
        let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let directory =
            std::env::temp_dir().join(format!("kresus-test-{}-{id}", std::process::id()));
        match fs::create_dir(&directory) {
            Ok(()) => return TestDatabasePath(directory.join("test.sqlite3")),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("Cannot create test directory: {error}"),
        }
    }
}

pub(crate) fn database() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    initialize_database(&connection).unwrap();
    connection
}

pub(crate) fn account(id: &str, kind: &str, balance: f64) -> Account {
    Account {
        id: id.into(),
        name: "  Household  ".into(),
        kind: kind.into(),
        opening_balance: (balance * 100.0).round() as i64,
        bank: "  Bank  ".into(),
        current_balance: 0,
    }
}
