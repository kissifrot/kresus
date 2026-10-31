use tauri::{
    Emitter, Manager,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
};

// Native menus dispatch actions to the same frontend workflows as the rest of the UI.
pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Ouvrir une base…", true, Some("CmdOrCtrl+O"))?;
    let default = MenuItem::with_id(
        app,
        "default",
        "Revenir à la base habituelle",
        true,
        None::<&str>,
    )?;
    let import = MenuItem::with_id(app, "import", "Importer Money…", true, None::<&str>)?;
    let backup = MenuItem::with_id(
        app,
        "backup",
        "Sauvegarder…",
        true,
        Some("CmdOrCtrl+Shift+S"),
    )?;
    let restore = MenuItem::with_id(app, "restore", "Restaurer…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, Some("Quitter"))?;
    let file = Submenu::with_items(
        app,
        "&Fichier",
        true,
        &[
            &open,
            &default,
            &import,
            &separator,
            &backup,
            &restore,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let about = MenuItem::with_id(app, "about", "À propos", true, None::<&str>)?;
    let help = Submenu::with_items(app, "&Aide", true, &[&about])?;
    app.set_menu(Menu::with_items(app, &[&file, &help])?)?;
    app.on_menu_event(|app, event| {
        if matches!(
            event.id().as_ref(),
            "open" | "default" | "import" | "backup" | "restore" | "about"
        ) {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("kresus-menu", event.id().as_ref());
            }
        }
    });
    Ok(())
}
