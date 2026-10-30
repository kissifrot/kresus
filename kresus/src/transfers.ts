import { invoke } from "@tauri-apps/api/core";
import { accounts, selectedAccount } from "./state";
import { escapeHtml, parseCents, centsInput } from "./format";
import { categoryOptions } from "./categories";
import { refreshTransactions } from "./transactions";

type Transfer = {
  id: string;
  sourceId: string;
  destinationId: string;
  date: string;
  amount: number;
  category: string;
  note: string;
};
let editingTransferId: string | null = null;

// Load the linked pair so editing works from either account.
export async function openTransferEditor(id: string) {
  const dialog = document.querySelector<HTMLDialogElement>("#transfer-dialog")!;
  const form = document.querySelector<HTMLFormElement>("#transfer-form")!;
  try {
    const transfer = await invoke<Transfer>("get_transfer", { id });
    form.reset();
    editingTransferId = id;
    form.querySelector("h2")!.textContent = "Modifier le virement";
    form.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent = "Enregistrer";
    form.querySelector<HTMLElement>(".editor-error")!.textContent = "";
    const category = form.elements.namedItem("category") as HTMLSelectElement;
    category.innerHTML = categoryOptions(transfer.category);
    for (const name of [
      "sourceId",
      "destinationId",
      "date",
      "amount",
      "category",
      "note",
    ] as const) {
      (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value =
        name === "amount" ? centsInput(transfer.amount) : String(transfer[name]);
    }
    dialog.showModal();
  } catch (reason) {
    const panel = document.createElement("section");
    panel.className = "transaction-editor-panel";
    panel.setAttribute("role", "alert");
    panel.textContent = `Chargement du virement impossible : ${String(reason)}`;
    document.querySelector(".transaction-editor-panel")?.remove();
    document.querySelector(".transactions-panel")?.after(panel);
  }
}

export function transferDialog(): string {
  const options = accounts
    .map(
      (account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`,
    )
    .join("");
  return `
    <dialog id="transfer-dialog">
      <form id="transfer-form">
        <div class="dialog-heading">
          <h2>Nouveau virement</h2>
          <button type="button" class="dialog-close transfer-close" aria-label="Fermer">×</button>
        </div>
        <label>Compte débité<select name="sourceId" required>${options}</select></label>
        <label>Compte crédité<select name="destinationId" required>${options}</select></label>
        <div class="form-row">
          <label>Date<input name="date" type="date" required></label>
          <label>Montant (€)<input name="amount" type="number" min="0.01" max="1000000000" step="0.01" required></label>
        </div>
        <label>Catégorie<select name="category" required>${categoryOptions()}</select></label>
        <label>Commentaire <span class="optional">(facultatif)</span><input name="note" maxlength="200"></label>
        <p class="editor-error" role="alert"></p>
        <div class="dialog-actions">
          <button type="button" class="secondary-button transfer-close">Annuler</button>
          <button type="submit" class="primary-button">Créer le virement</button>
        </div>
      </form>
    </dialog>`;
}

export function bindTransferActions() {
  const dialog = document.querySelector<HTMLDialogElement>("#transfer-dialog")!;
  const form = document.querySelector<HTMLFormElement>("#transfer-form")!;
  document.querySelector("#new-transfer")?.addEventListener("click", () => {
    form.reset();
    editingTransferId = null;
    form.querySelector("h2")!.textContent = "Nouveau virement";
    form.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent =
      "Créer le virement";
    (form.elements.namedItem("category") as HTMLSelectElement).innerHTML = categoryOptions();
    form.querySelector<HTMLElement>(".editor-error")!.textContent = "";
    (form.elements.namedItem("sourceId") as HTMLSelectElement).value = selectedAccount.id;
    (form.elements.namedItem("destinationId") as HTMLSelectElement).value =
      accounts.find((account) => account.id !== selectedAccount.id)?.id ?? "";
    const today = new Date();
    (form.elements.namedItem("date") as HTMLInputElement).value =
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    dialog.showModal();
  });
  dialog
    .querySelectorAll(".transfer-close")
    .forEach((button) => button.addEventListener("click", () => dialog.close()));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const sourceId = String(values.get("sourceId"));
    const destinationId = String(values.get("destinationId"));
    const error = form.querySelector<HTMLElement>(".editor-error")!;
    if (sourceId === destinationId) {
      error.textContent = "Choisissez deux comptes différents.";
      return;
    }
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    button.disabled = true;
    try {
      await invoke(editingTransferId ? "update_transfer" : "create_transfer", {
        transfer: {
          id: editingTransferId ?? crypto.randomUUID(),
          sourceId,
          destinationId,
          date: String(values.get("date")),
          amount: parseCents(String(values.get("amount"))),
          category: String(values.get("category")),
          note: String(values.get("note")).trim(),
        },
      });
      dialog.close();
      await refreshTransactions();
    } catch (reason) {
      error.textContent = `Enregistrement impossible : ${String(reason)}`;
    } finally {
      button.disabled = false;
    }
  });
}
