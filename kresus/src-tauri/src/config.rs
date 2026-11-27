use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, ErrorKind, Write},
    path::{Path, PathBuf},
};

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Config {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) startup_database: Option<PathBuf>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

impl Config {
    pub(crate) fn load(path: &Path) -> io::Result<Self> {
        match fs::read(path) {
            Ok(content) => return Ok(serde_json::from_slice(&content)?),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }

        let legacy = path.with_file_name("base-demarrage.json");
        match fs::read(&legacy) {
            Ok(content) => {
                let config = Self {
                    startup_database: Some(serde_json::from_slice(&content)?),
                    ..Self::default()
                };
                // A failed migration still lets Kresus open the remembered database.
                if config.save(path).is_ok() {
                    let _ = fs::remove_file(&legacy);
                }
                Ok(config)
            }
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error),
        }
    }

    pub(crate) fn save(&self, path: &Path) -> io::Result<()> {
        let content = serde_json::to_vec_pretty(self)?;
        let temporary = path.with_extension(uuid::Uuid::new_v4().to_string());
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let written = file.write_all(&content).and_then(|()| file.sync_all());
        drop(file);
        let saved = written.and_then(|()| fs::rename(&temporary, path));
        if saved.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        saved
    }
}
