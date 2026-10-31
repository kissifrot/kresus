// Use a WebView dialog: native window.confirm is not reliable in all Tauri environments.
export function confirmAction(title: string, message: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "confirmation-dialog";
    dialog.setAttribute("aria-labelledby", "confirmation-title");
    dialog.innerHTML = `<div class="delete-confirmation"><h2 id="confirmation-title"></h2><p class="confirmation-message delete-confirmation-message"></p><div class="dialog-actions"><button type="button" class="secondary-button confirmation-cancel" autofocus>Annuler</button><button type="button" class="primary-button confirmation-accept"></button></div></div>`;
    dialog.querySelector("h2")!.textContent = title;
    dialog.querySelector(".confirmation-message")!.textContent = message;
    dialog.querySelector(".confirmation-accept")!.textContent = action;
    document.body.append(dialog);
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(confirmed);
    };
    dialog.querySelector(".confirmation-cancel")!.addEventListener("click", () => finish(false));
    dialog.querySelector(".confirmation-accept")!.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener("close", () => finish(false));
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>(".confirmation-cancel")!.focus();
  });
}
