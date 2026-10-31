import config from "../src-tauri/tauri.conf.json";

// The version and icon come from the same sources used to package the application.
export function showAbout() {
  const dialog = document.createElement("dialog");
  dialog.className = "about-dialog";
  dialog.innerHTML = `<div class="about-content"><img alt="" width="80" height="80"><div><h2>À propos de Kresus</h2><p>Finances familiales</p><p class="about-version"></p><p>Application de gestion financière personnelle.</p></div></div><div class="dialog-actions"><button type="button" class="primary-button">Fermer</button></div>`;
  dialog.querySelector("img")!.src = new URL(
    "../src-tauri/icons/128x128.png",
    import.meta.url,
  ).href;
  dialog.querySelector(".about-version")!.textContent = `Version ${config.version}`;
  document.body.append(dialog);
  dialog.querySelector("button")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
}
