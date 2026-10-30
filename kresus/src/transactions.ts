import { invoke } from "@tauri-apps/api/core";
import { transactions, accounts, selectedAccount, setTransactions, setAccounts } from "./state";
import type { Account, Transaction } from "./types";
import { escapeHtml, parseCents, parsePositiveCents, centsInput, localDate } from "./format";
import { render } from "./accounts";
import { categoryOptions } from "./categories";
import { openTransferEditor } from "./transfers";
import { loadPayeeSuggestions } from "./payees";

type TransactionFilter =
  "all" | "unreconciled" | "reconciled" | "debit" | "credit" | "month-debit" | "month-credit";
export let transactionSearch = "";
export let transactionFilter: TransactionFilter = "all";
export const transactionFilters: Record<TransactionFilter, string> = {
  all: "Toutes les opérations",
  unreconciled: "À pointer",
  reconciled: "Pointées",
  debit: "Débits",
  credit: "Crédits",
  "month-credit": "Entrées ce mois",
  "month-debit": "Sorties ce mois",
};
const pageSize = 100;
let transactionPage = 1;
let pageAccountId: string | undefined;

type RegisterPage = {
  rows: (Transaction & { runningBalance: number })[];
  totalCount: number;
  filteredCount: number;
  unreconciledCount: number;
  income: number;
  expenses: number;
  creditCount: number;
  debitCount: number;
  page: number;
  pageCount: number;
};
let registerPage: RegisterPage | undefined;
let requestVersion = 0;

// Discard pending responses and navigation state when changing databases.
export function resetRegister() {
  requestVersion++;
  transactionPage = 1;
  pageAccountId = undefined;
  registerPage = undefined;
  transactionFilter = "all";
  transactionSearch = "";
  setTransactions([]);
}

export function registerSummary() {
  const result = pageAccountId === selectedAccount.id ? registerPage : undefined;
  return {
    rows: result?.rows ?? [],
    totalCount: result?.totalCount ?? 0,
    unreconciledCount: result?.unreconciledCount ?? 0,
    balance:
      accounts.find((account) => account.id === selectedAccount.id)?.currentBalance ??
      selectedAccount.openingBalance,
    filteredCount: result?.filteredCount ?? 0,
    pageCount: result?.pageCount ?? 1,
    page: result?.page ?? 1,
    start: ((result?.page ?? 1) - 1) * pageSize,
    income: result?.income ?? 0,
    expenses: result?.expenses ?? 0,
    creditCount: result?.creditCount ?? 0,
    debitCount: result?.debitCount ?? 0,
  };
}

export function bindTransactionFilter() {
  // Summary shortcuts apply the same filters as the list and restart at page one.
  for (const [id, filter] of [
    ["filter-unreconciled", "unreconciled"],
    ["filter-month-credit", "month-credit"],
    ["filter-month-debit", "month-debit"],
  ] as const) {
    document.querySelector<HTMLButtonElement>(`#${id}`)?.addEventListener("click", () => {
      transactionFilter = filter;
      transactionPage = 1;
      void refreshTransactions();
    });
  }
  document
    .querySelector<HTMLFormElement>("#transaction-search-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      transactionSearch = document
        .querySelector<HTMLInputElement>("#transaction-search")!
        .value.trim();
      transactionPage = 1;
      void refreshTransactions();
    });
  document
    .querySelector<HTMLSelectElement>("#transaction-filter")
    ?.addEventListener("change", (event) => {
      transactionFilter = (event.currentTarget as HTMLSelectElement).value as TransactionFilter;
      transactionPage = 1;
      void refreshTransactions();
    });
  document.querySelector<HTMLButtonElement>("#previous-page")?.addEventListener("click", () => {
    transactionPage--;
    void refreshTransactions();
  });
  document.querySelector<HTMLButtonElement>("#next-page")?.addEventListener("click", () => {
    transactionPage++;
    void refreshTransactions();
  });
  document.querySelector<HTMLFormElement>("#page-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector<HTMLInputElement>("#page-input")!;
    const page = Number(input.value);
    if (Number.isInteger(page) && page >= 1 && page <= Number(input.max)) {
      transactionPage = page;
      void refreshTransactions();
    } else input.reportValidity();
  });
}

export function bindTransactionActions() {
  // Opening the editor hides the summary until the edit is saved or cancelled.
  document.querySelectorAll<HTMLTableRowElement>("tr[data-transaction]").forEach((row) =>
    row.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("button, input")) return;
      const item = transactions.find((transaction) => transaction.id === row.dataset.transaction);
      if (!item) return;
      if (item.transferId) {
        void openTransferEditor(item.transferId);
        return;
      }
      document.querySelector(".transaction-editor-panel")?.remove();
      document
        .querySelectorAll("tr[data-transaction]")
        .forEach((transactionRow) => transactionRow.classList.remove("editing"));
      row.classList.add("editing");
      const summary = document.querySelector<HTMLElement>(".summary-grid")!;
      summary.hidden = true;
      const editor = document.createElement("section");
      editor.className = "transaction-editor-panel";
      editor.innerHTML = `
        <h2>Modifier l’opération</h2>
        <form class="transaction-editor">
          <label>Date<input name="date" type="date" required value="${escapeHtml(item.date)}"></label>
          <label>Destinataire<input name="label" list="edit-payee-suggestions" required maxlength="80" value="${escapeHtml(item.label)}"><datalist id="edit-payee-suggestions"></datalist></label>
          <label>Catégorie<select name="category" required>${categoryOptions(item.category)}</select></label>
          <label>N° chèque<input name="cheque" pattern="[0-9]{7}" maxlength="7" value="${escapeHtml(item.cheque ?? "")}"></label>
          <label>Type<select name="type">
            <option value="debit" ${item.amount < 0 ? "selected" : ""}>Débit</option>
            <option value="credit" ${item.amount > 0 ? "selected" : ""}>Crédit</option>
          </select></label>
          <label>Montant (€)<input name="amount" type="text" inputmode="decimal" required value="${centsInput(Math.abs(item.amount))}"></label>
          <label class="editor-note">Commentaire<textarea name="note" rows="2" placeholder="Ajouter un commentaire (facultatif)">${escapeHtml(item.note ?? "")}</textarea></label>
          <div class="editor-actions">
            <button type="submit" class="primary-button">Enregistrer</button>
            <button type="button" class="secondary-button cancel-editor">Annuler</button>
          </div>
          <p class="editor-error" role="alert"></p>
        </form>`;
      document.querySelector(".transactions-panel")!.after(editor);
      void loadPayeeSuggestions(
        editor.querySelector<HTMLDataListElement>("#edit-payee-suggestions")!,
      );
      editor.querySelector(".cancel-editor")?.addEventListener("click", () => {
        editor.remove();
        row.classList.remove("editing");
        summary.hidden = false;
      });
      editor.querySelector("form")?.addEventListener("submit", async (submitEvent) => {
        submitEvent.preventDefault();
        const form = submitEvent.currentTarget as HTMLFormElement;
        const values = new FormData(form);
        try {
          const amount = parsePositiveCents(String(values.get("amount")));
          await invoke("update_transaction", {
            transaction: {
              id: item.id,
              accountId: item.accountId,
              date: String(values.get("date")),
              label: String(values.get("label")).trim(),
              category: String(values.get("category")).trim(),
              cheque: String(values.get("cheque")).trim() || null,
              note: String(values.get("note") ?? "").trim(),
              amount: values.get("type") === "credit" ? amount : -amount,
            },
          });
          await refreshTransactions();
        } catch (error) {
          editor.querySelector<HTMLElement>(".editor-error")!.textContent =
            `Enregistrement impossible : ${String(error)}`;
        }
      });
    }),
  );
  document.querySelector("#new-transaction")?.addEventListener("click", () => {
    const dialog = document.querySelector<HTMLDialogElement>("#transaction-dialog")!;
    const suggestions = dialog.querySelector<HTMLDataListElement>("#payee-suggestions")!;
    dialog.querySelector<HTMLInputElement>('input[name="date"]')!.value = localDate(new Date());
    dialog.showModal();
    void loadPayeeSuggestions(suggestions);
  });
  document
    .querySelector("#transaction-dialog .dialog-close")
    ?.addEventListener("click", closeDialog);
  document.querySelector(".dialog-cancel")?.addEventListener("click", closeDialog);
  document.querySelector("#transaction-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form);
    const cheque = String(values.get("cheque") ?? "").trim();
    if (cheque && !/^\d{7}$/.test(cheque)) {
      (form.elements.namedItem("cheque") as HTMLInputElement).setCustomValidity(
        "Le numéro de chèque doit comporter 7 chiffres.",
      );
      (form.elements.namedItem("cheque") as HTMLInputElement).reportValidity();
      return;
    }
    try {
      const amount = parsePositiveCents(String(values.get("amount")));
      await invoke("create_transaction", {
        transaction: {
          id: crypto.randomUUID(),
          accountId: selectedAccount.id,
          date: String(values.get("date")),
          label: String(values.get("label")).trim(),
          category: String(values.get("category")),
          cheque: cheque || null,
          note: String(values.get("note") ?? "").trim(),
          amount: values.get("type") === "credit" ? amount : -amount,
        },
      });
      closeDialog();
      await refreshTransactions();
    } catch (error) {
      form.querySelector<HTMLElement>(".transaction-error")!.textContent =
        `Enregistrement impossible : ${String(error)}`;
    }
  });
  document.querySelectorAll<HTMLElement>("[data-reconcile]").forEach((button) =>
    button.addEventListener("click", async () => {
      await invoke("toggle_transaction_reconciliation", { id: button.dataset.reconcile });
      await refreshTransactions();
    }),
  );
  document.querySelectorAll<HTMLElement>("[data-delete]").forEach((button) =>
    button.addEventListener("click", async () => {
      const item = transactions.find((transaction) => transaction.id === button.dataset.delete);
      if (item?.transferId && !window.confirm("Supprimer ce virement et ses deux opérations ?"))
        return;
      await invoke("delete_transaction", { id: button.dataset.delete });
      await refreshTransactions();
    }),
  );
}

function closeDialog() {
  document.querySelector<HTMLDialogElement>("#transaction-dialog")?.close();
}
// Reload after a mutation so the register reflects the database state.
export async function refreshTransactions(strict = false) {
  const accountId = selectedAccount.id;
  if (pageAccountId !== accountId) {
    pageAccountId = accountId;
    transactionPage = 1;
    registerPage = undefined;
    transactionSearch = "";
  }
  const version = ++requestVersion;
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  try {
    const [updatedAccounts, result] = await Promise.all([
      invoke<Account[]>("list_accounts"),
      invoke<RegisterPage>("list_register", {
        accountId,
        filter: transactionFilter,
        page: transactionPage,
        month,
        search: transactionSearch,
      }),
    ]);
    // A slower earlier request must not replace a newer page or account.
    if (version !== requestVersion || selectedAccount.id !== accountId) return;
    setAccounts(updatedAccounts);
    registerPage = result;
    transactionPage = result.page;
    setTransactions(result.rows);
    render();
  } catch (error) {
    if (version !== requestVersion) return;
    if (strict) throw error;
    const target = document.querySelector<HTMLElement>(".register-error");
    if (target) target.textContent = `Chargement des opérations impossible : ${String(error)}`;
    else throw error;
  }
}
// Import user-created entries from the prototype's browser storage once.
export async function migrateBrowserTransactions() {
  const legacyData = localStorage.getItem("kresus.transactions.v1");
  if (!legacyData) return;
  try {
    const legacyTransactions = JSON.parse(legacyData) as Transaction[];
    const imported = legacyTransactions.filter((transaction) => !/^t\d+$/.test(transaction.id));
    for (const transaction of imported) {
      await invoke("create_transaction", {
        transaction: { ...transaction, amount: parseCents(String(transaction.amount)) },
      });
    }
    localStorage.removeItem("kresus.transactions.v1");
  } catch (error) {
    console.error("La migration des anciennes opérations a échoué.", error);
  }
}
