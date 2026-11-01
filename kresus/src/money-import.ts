import { invoke } from "@tauri-apps/api/core";
import { euro, escapeHtml } from "./format";
import { reloadDatabase } from "./accounts";
import { Buffer } from "buffer";
import browserProcess from "process";

type MoneyAccount = {
  id: number;
  name: string;
  openingBalance: number;
  balance: number;
  count: number;
};
type MoneyCategory = { id: number; name: string; parentId: number | null };
type MoneyOperation = {
  accountId: number;
  date: string;
  label: string;
  category: string;
  amount: number;
};
type MoneySchedule = {
  accountId: number;
  destinationAccountId: number | null;
  label: string;
  nextDue: string;
  frequency: string;
  amount: number;
  paymentMethod: "cheque" | null;
  endDate: string | null;
};
type MoneyPreview = {
  schedules: MoneySchedule[];
  transfers: { debitId: number; creditId: number }[];
  skippedSchedules: string[];
  accounts: MoneyAccount[];
  categories: MoneyCategory[];
  operations: MoneyOperation[];
  warnings: string[];
};

// The backend holds the analyzed data; the UI submits only reviewed account choices.
export async function openMoneyImport() {
  try {
    const bytes = await invoke<number[] | null>("choose_money_file");
    if (!bytes) return;
    // Initialize the browser shims before loading the database reader.
    Object.assign(globalThis, { Buffer, process: browserProcess });
    const { inspect } = await import("./money-reader");
    const preview: MoneyPreview = inspect(Buffer.from(bytes));
    await invoke("set_money_preview", { preview });
    const dialog = document.createElement("dialog");
    dialog.className = "money-import-dialog";
    dialog.innerHTML = `<form><div class="dialog-heading"><h2>Importer un fichier Money</h2><button type="button" class="dialog-close" aria-label="Fermer">×</button></div><p>Choisissez les comptes bancaires à importer dans une nouvelle base.</p><p>${preview.categories.length} catégories et sous-catégories · ${preview.transfers.length} virement${preview.transfers.length === 1 ? "" : "s"} enregistré${preview.transfers.length === 1 ? "" : "s"} · ${preview.schedules.length} échéances détectées.</p>${preview.skippedSchedules.length ? `<div class="money-warning"><strong>${preview.skippedSchedules.length} échéance${preview.skippedSchedules.length === 1 ? "" : "s"} ne ${preview.skippedSchedules.length === 1 ? "sera" : "seront"} pas importée${preview.skippedSchedules.length === 1 ? "" : "s"}.</strong><details><summary>Voir le détail des échéances non importées</summary><p>Sélectionnez et copiez ce texte pour conserver les détails.</p><textarea class="money-skipped-details" readonly aria-label="Détail des échéances non importées" rows="6">${escapeHtml(preview.skippedSchedules.join("\n"))}</textarea></details></div>` : ""}${preview.warnings.length ? `<details class="money-warning"><summary>Autres avertissements (${preview.warnings.length})</summary><ul>${preview.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></details>` : ""}<div class="money-accounts">${preview.accounts.map((account) => `<div class="money-account"><label><input type="checkbox" name="account" value="${account.id}" checked> <strong>${escapeHtml(account.name)}</strong></label><span>${account.count} opérations · Solde initial ${euro(account.openingBalance)} · Solde calculé ${euro(account.balance)}</span><label>Type <select data-kind="${account.id}"><option>Compte courant</option><option>Épargne</option></select></label></div>`).join("") || "<p>Aucun compte bancaire importable.</p>"}</div><details><summary>Voir les catégories (${preview.categories.length})</summary><ul>${preview.categories.map((category) => `<li>${escapeHtml(category.parentId === null ? category.name : `${preview.categories.find((parent) => parent.id === category.parentId)?.name ?? "?"} · ${category.name}`)}</li>`).join("")}</ul></details><details><summary>Voir les opérations (${preview.operations.length})</summary><ul>${preview.operations
      .slice(0, 100)
      .map(
        (operation) =>
          `<li>${escapeHtml(operation.date)} · ${escapeHtml(preview.accounts.find((account) => account.id === operation.accountId)?.name ?? "Compte")} · ${escapeHtml(operation.label)} · ${escapeHtml(operation.category)} · ${euro(operation.amount)}</li>`,
      )
      .join(
        "",
      )}</ul>${preview.operations.length > 100 ? "<p>Les 100 premières opérations sont affichées.</p>" : ""}</details><details><summary>Voir les échéances (${preview.schedules.length})</summary><ul>${preview.schedules.map((item) => `<li>${escapeHtml(item.nextDue)} · ${escapeHtml(item.label)} · ${euro(item.amount)} · ${escapeHtml(item.frequency)}${item.endDate ? ` · Jusqu’au ${escapeHtml(item.endDate.split("-").reverse().join("/"))}` : ""}${item.destinationAccountId != null ? " · Virement" : ""} · ${item.paymentMethod === "cheque" ? "Par chèque" : "Méthode à vérifier"}</li>`).join("")}</ul></details><p>Pour importer un virement, enregistré ou récurrent, sélectionnez ses deux comptes. Les références Money sont conservées dans les commentaires. Les placements et ventilations ne sont pas importés.</p><p class="editor-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-button cancel-money">Annuler</button><button type="submit" class="primary-button" ${preview.accounts.length ? "" : "disabled"}>Créer la base et importer</button></div></form>`;
    document.body.append(dialog);
    const close = () => {
      dialog.close();
      dialog.remove();
    };
    dialog
      .querySelectorAll(".dialog-close,.cancel-money")
      .forEach((item) => item.addEventListener("click", close));
    dialog.addEventListener("cancel", () => dialog.remove());
    dialog.querySelector("form")!.addEventListener("submit", async (event) => {
      event.preventDefault();
      const selected = [
        ...dialog.querySelectorAll<HTMLInputElement>('input[name="account"]:checked'),
      ].map((input) => ({
        id: Number(input.value),
        kind: dialog.querySelector<HTMLSelectElement>(`[data-kind="${input.value}"]`)!.value,
      }));
      if (!selected.length) {
        dialog.querySelector<HTMLElement>(".editor-error")!.textContent =
          "Sélectionnez au moins un compte.";
        return;
      }
      const submit = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      submit.disabled = true;
      let path: string | null = null;
      try {
        path = await invoke<string | null>("import_money", { selection: selected });
        if (path) {
          close();
          await reloadDatabase(path);
        } else submit.disabled = false;
      } catch (error) {
        if (path) {
          document.querySelector<HTMLElement>("#app")!.textContent =
            `Base créée, mais actualisation impossible : ${String(error)}. Redémarrez l’application.`;
        } else {
          dialog.querySelector<HTMLElement>(".editor-error")!.textContent =
            `Import impossible : ${String(error)}`;
          submit.disabled = false;
        }
      }
    });
    dialog.showModal();
  } catch (error) {
    document.querySelector<HTMLElement>(".database-error")!.textContent =
      `Lecture impossible : ${String(error)}`;
  }
}
