import { invoke } from "@tauri-apps/api/core";
import { euro, escapeHtml, displayReference } from "./format";
import { reloadDatabase } from "./accounts";
import { Buffer } from "buffer";
import browserProcess from "process";
import type { Frequency } from "./frequency";
import type { CategoryKind, TransactionSplit } from "./types";

type MoneyAccount = {
  id: number;
  name: string;
  accountNumber: string | null;
  openingBalance: number;
  balance: number;
  count: number;
};
type MoneyCategory = {
  id: number;
  name: string;
  parentId: number | null;
  kind: CategoryKind | null;
};
type MoneyOperation = {
  accountId: number;
  date: string;
  label: string;
  category: string;
  amount: number;
  reference?: string | null;
  splits?: TransactionSplit[];
};
type MoneySchedule = {
  estimated?: boolean;
  note?: string | null;
  anchorDay?: number;
  accountId: number;
  destinationAccountId: number | null;
  label: string;
  nextDue: string;
  frequency: Frequency;
  amount: number;
  paymentMethod: "cheque" | "automatic" | "income_payment" | null;
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

// The backend holds the analyzed data while the user reviews the import.
export async function openMoneyImport() {
  try {
    const bytes = await invoke<number[] | null>("choose_money_file");
    if (!bytes) return;
    // Initialize the browser shims before loading the database reader.
    Object.assign(globalThis, { Buffer, process: browserProcess });
    const { inspect } = await import("./money-reader");
    const preview: MoneyPreview = inspect(Buffer.from(bytes));
    const defaultAvailable = await invoke<boolean>("set_money_preview", { preview });
    const importDisabled = preview.accounts.length ? "" : "disabled";
    const importLabel = defaultAvailable
      ? "Importer dans la base habituelle"
      : "Choisir un emplacement";
    const otherLocationButton = defaultAvailable
      ? `<button type="button" class="secondary-button" id="money-import-other-location" ${importDisabled}>Choisir un autre emplacement</button>`
      : "";
    const dialog = document.createElement("dialog");
    dialog.className = "money-import-dialog";
    dialog.innerHTML = `<form><div class="dialog-heading"><h2>Importer un fichier Money</h2><button type="button" class="dialog-close" aria-label="Fermer">×</button></div><p>Choisissez les comptes bancaires à importer.</p><p>${preview.categories.length} catégories et sous-catégories · ${preview.transfers.length} virement${preview.transfers.length === 1 ? "" : "s"} enregistré${preview.transfers.length === 1 ? "" : "s"} · ${preview.schedules.length} échéances détectées.</p>${preview.skippedSchedules.length ? `<div class="money-warning"><strong>${preview.skippedSchedules.length} échéance${preview.skippedSchedules.length === 1 ? "" : "s"} ne ${preview.skippedSchedules.length === 1 ? "sera" : "seront"} pas importée${preview.skippedSchedules.length === 1 ? "" : "s"}.</strong><details><summary>Voir le détail des échéances non importées</summary><p>Sélectionnez et copiez ce texte pour conserver les détails.</p><textarea class="money-skipped-details" readonly aria-label="Détail des échéances non importées" rows="6">${escapeHtml(preview.skippedSchedules.join("\n"))}</textarea></details></div>` : ""}${preview.warnings.length ? `<details class="money-warning"><summary>Autres avertissements (${preview.warnings.length})</summary><ul>${preview.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></details>` : ""}<div class="money-accounts">${preview.accounts.map((account) => `<div class="money-account"><label><input type="checkbox" name="account" value="${account.id}" checked> <strong>${escapeHtml(account.name)}</strong></label>${account.accountNumber ? `<span>Numéro de compte · ${escapeHtml(account.accountNumber)}</span>` : ""}<span>${account.count} opérations · Solde initial ${euro(account.openingBalance)} · Solde calculé ${euro(account.balance)}</span><label>Type <select data-kind="${account.id}"><option>Compte courant</option><option>Épargne</option></select></label></div>`).join("") || "<p>Aucun compte bancaire importable.</p>"}</div><details><summary>Voir les catégories (${preview.categories.length})</summary><ul>${preview.categories.map((category) => `<li>${escapeHtml(category.parentId === null ? category.name : `${preview.categories.find((parent) => parent.id === category.parentId)?.name ?? "?"} · ${category.name}`)}</li>`).join("")}</ul></details><details><summary>Voir les opérations (${preview.operations.length})</summary><ul>${preview.operations
      .slice(0, 100)
      .map(
        (operation) =>
          `<li>${escapeHtml(operation.date)} · ${escapeHtml(preview.accounts.find((account) => account.id === operation.accountId)?.name ?? "Compte")} · ${escapeHtml(operation.label)} · ${escapeHtml(operation.splits?.length ? "Ventilée" : operation.category)} · ${euro(operation.amount)}${operation.reference ? ` · Réf. ${escapeHtml(displayReference(operation.reference))}` : ""}${operation.splits?.length ? `<ul>${operation.splits.map((part) => `<li>${escapeHtml(part.category)} · ${euro(part.amount)}${part.note ? ` · ${escapeHtml(part.note)}` : ""}</li>`).join("")}</ul>` : ""}</li>`,
      )
      .join(
        "",
      )}</ul>${preview.operations.length > 100 ? "<p>Les 100 premières opérations sont affichées.</p>" : ""}</details><details><summary>Voir les échéances (${preview.schedules.length})</summary><ul>${preview.schedules.map((item) => `<li>${escapeHtml(item.nextDue)} · ${escapeHtml(item.label)} · ${euro(item.amount)} · ${escapeHtml(item.frequency)}${item.anchorDay ? ` · Jour de référence : ${item.anchorDay}` : ""}${item.estimated ? " · Montant estimé" : ""}${item.note ? ` · Commentaire : ${escapeHtml(item.note)}` : ""}${item.endDate ? ` · Jusqu’au ${escapeHtml(item.endDate.split("-").reverse().join("/"))}` : ""}${item.destinationAccountId != null ? " · Virement" : ""} · ${item.paymentMethod === "cheque" ? "Par chèque" : item.paymentMethod === "automatic" ? "Prélèvt/Virement auto." : item.paymentMethod === "income_payment" ? "Versement" : "Méthode à vérifier"}</li>`).join("")}</ul></details><p>Pour importer un virement, enregistré ou récurrent, sélectionnez ses deux comptes. Les références Money sont conservées séparément des commentaires et des numéros de chèque. Les placements ne sont pas importés.</p><p class="editor-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-button cancel-money">Annuler</button>${otherLocationButton}<button type="submit" class="primary-button" ${importDisabled}>${importLabel}</button></div></form>`;
    document.body.append(dialog);
    const close = () => {
      dialog.close();
      dialog.remove();
    };
    dialog
      .querySelectorAll(".dialog-close,.cancel-money")
      .forEach((item) => item.addEventListener("click", close));
    dialog.addEventListener("cancel", () => dialog.remove());
    const form = dialog.querySelector("form")!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const otherLocation = dialog.querySelector<HTMLButtonElement>("#money-import-other-location");
    const errorMessage = form.querySelector<HTMLElement>(".editor-error")!;
    async function submitImport(chooseAnotherLocation: boolean) {
      if (submit.disabled) return;
      const selected = [
        ...dialog.querySelectorAll<HTMLInputElement>('input[name="account"]:checked'),
      ].map((input) => ({
        id: Number(input.value),
        kind: dialog.querySelector<HTMLSelectElement>(`[data-kind="${input.value}"]`)!.value,
      }));
      if (!selected.length) {
        errorMessage.textContent = "Sélectionnez au moins un compte.";
        return;
      }
      errorMessage.textContent = "";
      submit.disabled = true;
      if (otherLocation) otherLocation.disabled = true;
      let result: { path: string | null } | null = null;
      try {
        result = await invoke<{ path: string | null } | null>("import_money", {
          selection: selected,
          chooseAnotherLocation,
        });
        if (result) {
          close();
          await reloadDatabase(result.path);
        }
      } catch (error) {
        if (result) {
          document.querySelector<HTMLElement>("#app")!.textContent =
            `Import terminé, mais actualisation impossible : ${String(error)}. Redémarrez l’application.`;
        } else {
          errorMessage.textContent = `Import impossible : ${String(error)}`;
        }
      } finally {
        if (!result) {
          submit.disabled = false;
          if (otherLocation) otherLocation.disabled = false;
          if (dialog.open) (chooseAnotherLocation ? (otherLocation ?? submit) : submit).focus();
        }
      }
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitImport(!defaultAvailable);
    });
    otherLocation?.addEventListener("click", () => void submitImport(true));
    dialog.showModal();
  } catch (error) {
    document.querySelector<HTMLElement>(".database-error")!.textContent =
      `Lecture impossible : ${String(error)}`;
  }
}
