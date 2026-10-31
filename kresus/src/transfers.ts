import { invoke } from "@tauri-apps/api/core";
import { accounts } from "./state";
import { escapeHtml, parsePositiveCents, centsInput } from "./format";
import { categoryOptions } from "./categories";

type Transfer = {
  id: string;
  sourceId: string;
  destinationId: string;
  date: string;
  amount: number;
  category: string;
  note: string;
};

// Load both sides before filling the same fixed editor used by ordinary operations.
export async function openTransferEditor(
  panel: HTMLElement,
  id: string,
  keyboard: boolean,
  cancel: () => void,
  saved: () => Promise<void>,
) {
  panel.innerHTML =
    '<h2>Modifier le virement</h2><p>Chargement…</p><button type="button" class="secondary-button cancel-editor">Annuler</button>';
  panel.querySelector(".cancel-editor")!.addEventListener("click", cancel);
  try {
    const transfer = await invoke<Transfer>("get_transfer", { id });
    // A later selection or account change can remove this panel while the request runs.
    if (!panel.isConnected) return;
    const options = (selected: string) =>
      accounts
        .map(
          (account) =>
            `<option value="${escapeHtml(account.id)}" ${account.id === selected ? "selected" : ""}>${escapeHtml(account.name)}</option>`,
        )
        .join("");
    panel.innerHTML = `<h2>Modifier le virement</h2>
      <form class="transaction-editor transfer-editor">
        <label>Date<input name="date" type="date" required value="${escapeHtml(transfer.date)}"></label>
        <label>Compte débité<select name="sourceId" required>${options(transfer.sourceId)}</select></label>
        <label>Compte crédité<select name="destinationId" required>${options(transfer.destinationId)}</select></label>
        <label>Catégorie<select name="category" required>${categoryOptions(transfer.category)}</select></label>
        <label>Montant (€)<input name="amount" type="text" inputmode="decimal" required value="${centsInput(transfer.amount)}"></label>
        <label class="editor-note">Commentaire<textarea name="note" rows="2" placeholder="Ajouter un commentaire (facultatif)">${escapeHtml(transfer.note)}</textarea></label>
        <div class="editor-actions"><button type="submit" class="primary-button">Enregistrer</button><button type="button" class="secondary-button cancel-editor">Annuler</button></div>
        <p class="editor-error" role="alert"></p>
      </form>`;
    const form = panel.querySelector<HTMLFormElement>(".transfer-editor")!;
    if (keyboard) form.querySelector<HTMLSelectElement>('[name="sourceId"]')!.focus();
    form.querySelector(".cancel-editor")!.addEventListener("click", cancel);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = new FormData(form);
      const sourceId = String(values.get("sourceId"));
      const destinationId = String(values.get("destinationId"));
      const error = form.querySelector<HTMLElement>(".editor-error")!;
      if (!sourceId || !destinationId || sourceId === destinationId) {
        error.textContent = "Choisissez deux comptes différents.";
        return;
      }
      const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      button.disabled = true;
      try {
        await invoke("update_transfer", {
          transfer: {
            id,
            sourceId,
            destinationId,
            date: String(values.get("date")),
            amount: parsePositiveCents(String(values.get("amount"))),
            category: String(values.get("category")),
            note: String(values.get("note") ?? "").trim(),
          },
        });
        await saved();
      } catch (reason) {
        error.textContent = `Enregistrement impossible : ${String(reason)}`;
      } finally {
        button.disabled = false;
      }
    });
  } catch (reason) {
    if (!panel.isConnected) return;
    panel.innerHTML = `<h2>Modifier le virement</h2><p class="editor-error" role="alert">Chargement impossible : ${escapeHtml(String(reason))}</p><button type="button" class="secondary-button cancel-editor">Annuler</button>`;
    panel.querySelector(".cancel-editor")!.addEventListener("click", cancel);
    if (keyboard) panel.querySelector<HTMLButtonElement>(".cancel-editor")!.focus();
  }
}
