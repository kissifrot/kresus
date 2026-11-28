use tauri::{
    Emitter, Manager,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
};

const TOGGLE_TRANSACTION_COMMENTS: &str = "toggle-transaction-comments";

// Native menus dispatch actions to the same frontend workflows as the rest of the UI.
pub fn install(app: &tauri::App, show_transaction_comments: bool) -> tauri::Result<()> {
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
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::separator(app)?,
            #[cfg(not(target_os = "macos"))]
            &quit,
        ],
    )?;
    let comments = CheckMenuItem::with_id(
        app,
        TOGGLE_TRANSACTION_COMMENTS,
        "Afficher les commentaires",
        true,
        show_transaction_comments,
        None::<&str>,
    )?;
    let preferences = Submenu::with_items(app, "&Préférences", true, &[&comments])?;
    let about = MenuItem::with_id(app, "about", "À propos", true, None::<&str>)?;
    let help = Submenu::with_items(app, "&Aide", true, &[&about])?;
    #[cfg(target_os = "macos")]
    {
        let application = Submenu::with_items(app, "Kresus", true, &[&quit])?;
        // The native edit actions route keyboard shortcuts to the focused WebView field.
        let edit = tauri::menu::SubmenuBuilder::new(app, "Édition")
            .undo_with_text("Annuler")
            .redo_with_text("Rétablir")
            .separator()
            .cut_with_text("Couper")
            .copy_with_text("Copier")
            .paste_with_text("Coller")
            .select_all_with_text("Tout sélectionner")
            .build()?;
        app.set_menu(Menu::with_items(
            app,
            &[&application, &file, &edit, &preferences, &help],
        )?)?;
    }
    #[cfg(not(target_os = "macos"))]
    app.set_menu(Menu::with_items(app, &[&file, &preferences, &help])?)?;
    app.manage(comments);
    app.on_menu_event(|app, event| {
        if matches!(
            event.id().as_ref(),
            "open"
                | "default"
                | "import"
                | "backup"
                | "restore"
                | "about"
                | TOGGLE_TRANSACTION_COMMENTS
        ) {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("kresus-menu", event.id().as_ref());
            }
        }
    });
    Ok(())
}
