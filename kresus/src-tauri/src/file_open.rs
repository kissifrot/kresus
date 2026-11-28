use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

// Requests survive until the webview has registered its event listener.
pub(crate) struct OpenRequests(pub(crate) Mutex<Vec<PathBuf>>);

fn file_argument(args: &[String], cwd: &Path) -> Option<PathBuf> {
    let path = Path::new(args.get(1)?);
    if !path.extension()?.eq_ignore_ascii_case("kresus") || args.len() != 2 {
        return None;
    }
    Some(if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    })
}

pub(crate) fn collect(args: Vec<String>, cwd: &Path) -> Vec<PathBuf> {
    file_argument(&args, cwd).into_iter().collect()
}

pub(crate) fn receive(app: &tauri::AppHandle, args: Vec<String>, cwd: String) {
    if let Some(path) = file_argument(&args, Path::new(&cwd)) {
        enqueue(app, path);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// Finder delivers file associations as URLs rather than as command-line arguments.
#[cfg(target_os = "macos")]
pub(crate) fn receive_opened_urls(app: &tauri::AppHandle, urls: Vec<tauri::Url>) {
    for path in urls.into_iter().filter_map(|url| url.to_file_path().ok()) {
        if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("kresus"))
        {
            enqueue(app, path);
        }
    }
}

fn enqueue(app: &tauri::AppHandle, path: PathBuf) {
    if let Some(requests) = app.try_state::<OpenRequests>() {
        if let Ok(mut pending) = requests.0.lock() {
            pending.push(path);
            drop(pending);
            let _ = app.emit("kresus-file-request", ());
        }
    }
}

#[tauri::command]
pub(crate) fn take_file_requests(
    state: tauri::State<'_, OpenRequests>,
) -> Result<Vec<String>, String> {
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "Demande d’ouverture indisponible.".to_string())?;
    Ok(pending
        .drain(..)
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_one_kresus_file_and_resolves_relative_paths() {
        let cwd = Path::new("/tmp");
        assert_eq!(
            file_argument(&["kresus".into(), "Mon foyer.KRESUS".into()], cwd),
            Some(cwd.join("Mon foyer.KRESUS"))
        );
        assert_eq!(
            file_argument(&["kresus".into(), "foo.sqlite3".into()], cwd),
            None
        );
        assert_eq!(
            file_argument(&["kresus".into(), "--help".into()], cwd),
            None
        );
        assert_eq!(
            file_argument(
                &["kresus".into(), "a.kresus".into(), "b.kresus".into()],
                cwd
            ),
            None
        );
    }
}
