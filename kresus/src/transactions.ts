import { REFERENCE_LIMIT, TEXT_NAME_LIMIT } from "./text-limits";
import { invoke } from "@tauri-apps/api/core";
import {
  transactions,
  accounts,
  selectedAccount,
  setTransactions,
  setAccounts,
  setSelectedAccount,
} from "./state";
import type { Account, Transaction } from "./types";
import {
  escapeHtml,
  displayReference,
  parseCents,
  parsePositiveCents,
  centsInput,
  amountWithoutCurrency,
  euro,
  localDate,
  MIN_CALENDAR_DATE,
} from "./format";
import { render } from "./accounts";
import { bindCategoryCreation, categoryOptions } from "./categories";
import { openTransferEditor } from "./transfers";
import { loadPayeeSuggestions } from "./payees";
import { bindSplitEditor, splitControls } from "./transaction-splits";

type TransactionFilter =
  "all" | "unreconciled" | "reconciled" | "debit" | "credit" | "month-debit" | "month-credit";
export let transactionSearch = "";
type AmountRange = { min: number | null; max: number | null };
let amountRange: AmountRange | null = null;
type DateRange = { start: string | null; end: string | null };
let dateRange: DateRange | null = null;

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

type OperationSearchPage = {
  rows: Transaction[];
  filteredCount: number;
  page: number;
  pageCount: number;
};

type RegisterPage = Omit<OperationSearchPage, "rows"> & {
  rows: (Transaction & { runningBalance: number; bankDate?: string | null })[];
  totalCount: number;
  unreconciledCount: number;
  income: number;
  expenses: number;
  creditCount: number;
  debitCount: number;
};
let searchPage: OperationSearchPage | undefined;
let registerPage: RegisterPage | undefined;
let requestVersion = 0;

// Discard pending responses and navigation state when changing databases.
export function resetRegister() {
  requestVersion++;
  transactionPage = 1;
  pageAccountId = undefined;
  registerPage = undefined;
  searchPage = undefined;
  transactionFilter = "all";
  transactionSearch = "";
  amountRange = null;
  dateRange = null;
  setTransactions([]);
}

export function registerSummary(allAccounts = false) {
  const accountId = selectedAccount?.id;
  const result = pageAccountId === accountId ? registerPage : undefined;
  const account = accounts.find((item) => item.id === accountId);
  const pagination = allAccounts ? searchPage : result;
  return {
    rows: result?.rows ?? [],
    searchRows: searchPage?.rows ?? [],
    totalCount: result?.totalCount ?? 0,
    unreconciledCount: result?.unreconciledCount ?? 0,
    balance: account?.currentBalance ?? selectedAccount?.openingBalance ?? 0,
    balanceWithFuture: account?.balanceWithFuture,
    filteredCount: pagination?.filteredCount ?? 0,
    pageCount: pagination?.pageCount ?? 1,
    page: pagination?.page ?? 1,
    start: ((pagination?.page ?? 1) - 1) * pageSize,
    income: result?.income ?? 0,
    expenses: result?.expenses ?? 0,
    creditCount: result?.creditCount ?? 0,
    debitCount: result?.debitCount ?? 0,
  };
}

export function amountFilterLabel() {
  if (!amountRange) return "";
  const { min, max } = amountRange;
  if (min === null) return max === null ? "" : `Au plus ${euro(max)}`;
  if (max === null) return `Au moins ${euro(min)}`;
  return min === max ? euro(min) : `${amountWithoutCurrency(min)} à ${euro(max)}`;
}

function renderRegisterFilterDialog(id: string, title: string, fields: string) {
  return `<dialog id="${id}-dialog" aria-labelledby="${id}-title">
    <form class="register-filter-form" id="${id}-form">
      <div class="dialog-heading">
        <h2 id="${id}-title">${title}</h2>
        <button type="button" class="dialog-close" aria-label="Fermer">×</button>
      </div>
      ${fields}
      <p class="editor-error" role="alert"></p>
      <div class="dialog-actions">
        <button type="button" class="secondary-button" id="${id}-clear">Effacer le filtre</button>
        <button type="submit" class="primary-button">Appliquer</button>
      </div>
    </form>
  </dialog>`;
}

export function renderAmountFilterDialog(allAccounts = false) {
  return renderRegisterFilterDialog(
    "amount-filter",
    "Filtrer par montant",
    `<label>Critère<select name="mode"><option value="exact">Montant exact</option><option value="range">Intervalle</option></select></label>
      <label id="amount-filter-exact">Montant (€)<input name="exact" type="text" inputmode="decimal" placeholder="0,00"></label>
      <div class="form-row" id="amount-filter-range" hidden>
        <label>Minimum (€)<input name="min" type="text" inputmode="decimal" placeholder="Sans minimum"></label>
        <label>Maximum (€)<input name="max" type="text" inputmode="decimal" placeholder="Sans maximum"></label>
      </div>
      <p class="register-filter-help">Saisissez le montant sans signe.${allAccounts ? "" : " Pour choisir le sens, utilisez le filtre Débits ou Crédits."}</p>`,
  );
}

export function periodFilterLabel() {
  if (!dateRange) return "";
  const { start, end } = dateRange;
  const format = (date: string) => date.split("-").reverse().join("/");
  if (!start) return end ? `Jusqu’au ${format(end)}` : "";
  if (!end) return `À partir du ${format(start)}`;
  return start === end ? format(start) : `${format(start)} au ${format(end)}`;
}

const periodShortcuts = [
  { id: "this-month", label: "Ce mois-ci", months: (month: number) => [month, month + 1] as const },
  {
    id: "last-month",
    label: "Le mois dernier",
    months: (month: number) => [month - 1, month] as const,
  },
  { id: "this-year", label: "Cette année", months: () => [0, 12] as const },
];

export function renderPeriodFilterDialog() {
  return renderRegisterFilterDialog(
    "period-filter",
    "Filtrer par période",
    `<div class="form-row">
      <label>Date de début<input name="start" type="date" min="${MIN_CALENDAR_DATE}" max="9999-12-31"></label>
      <label>Date de fin<input name="end" type="date" min="${MIN_CALENDAR_DATE}" max="9999-12-31"></label>
    </div>
    <div class="period-shortcuts" role="group" aria-label="Raccourcis de période">
      ${periodShortcuts
        .map(
          ({ id, label }) =>
            `<button type="button" class="secondary-button" data-period-shortcut="${id}">${label}</button>`,
        )
        .join("")}
    </div>
    <p class="register-filter-help">Les deux dates sont facultatives et incluses dans la période.</p>`,
  );
}

function bindRegisterFilterDialog(id: string, dialog: HTMLDialogElement, clearFilter: () => void) {
  const apply = async () => {
    transactionPage = 1;
    if (dialog.open) dialog.close();
    await refreshTransactions();
    if (document.activeElement === document.body) document.getElementById(id)?.focus();
  };
  const clear = () => {
    clearFilter();
    void apply();
  };
  dialog.querySelector(".dialog-close")!.addEventListener("click", () => dialog.close());
  document.getElementById(`${id}-clear`)?.addEventListener("click", clear);
  document.getElementById(`${id}-quick-clear`)?.addEventListener("click", clear);
  return apply;
}

function bindAmountFilter() {
  const button = document.querySelector<HTMLButtonElement>("#amount-filter");
  const dialog = document.querySelector<HTMLDialogElement>("#amount-filter-dialog");
  if (!button || !dialog) return;
  const apply = bindRegisterFilterDialog("amount-filter", dialog, () => {
    amountRange = null;
  });
  const form = dialog.querySelector<HTMLFormElement>("form")!;
  const mode = form.querySelector<HTMLSelectElement>('[name="mode"]')!;
  const exact = form.querySelector<HTMLInputElement>('[name="exact"]')!;
  const min = form.querySelector<HTMLInputElement>('[name="min"]')!;
  const max = form.querySelector<HTMLInputElement>('[name="max"]')!;
  const clear = form.querySelector<HTMLButtonElement>("#amount-filter-clear")!;
  const error = form.querySelector<HTMLElement>(".editor-error")!;
  const updateMode = () => {
    const isExact = mode.value === "exact";
    form.querySelector<HTMLElement>("#amount-filter-exact")!.hidden = !isExact;
    form.querySelector<HTMLElement>("#amount-filter-range")!.hidden = isExact;
    error.textContent = "";
  };
  button.addEventListener("click", () => {
    const activeMin = amountRange?.min ?? null;
    const activeMax = amountRange?.max ?? null;
    mode.value = activeMin === activeMax ? "exact" : "range";
    exact.value = activeMin !== null && activeMin === activeMax ? centsInput(activeMin) : "";
    min.value = activeMin === null ? "" : centsInput(activeMin);
    max.value = activeMax === null ? "" : centsInput(activeMax);
    clear.hidden = amountRange === null;
    updateMode();
    dialog.showModal();
    (mode.value === "exact" ? exact : min).focus();
  });
  mode.addEventListener("change", updateMode);
  form.addEventListener("input", () => {
    error.textContent = "";
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const lower = parseAmountBound(mode.value === "exact" ? exact.value : min.value);
      const upper = mode.value === "exact" ? lower : parseAmountBound(max.value);
      if (lower === null && upper === null)
        throw new Error(
          mode.value === "exact" ? "Saisissez un montant." : "Saisissez au moins une borne.",
        );
      if (lower !== null && upper !== null && lower > upper)
        throw new Error("Le minimum doit être inférieur ou égal au maximum.");
      amountRange = { min: lower, max: upper };
      void apply();
    } catch (issue) {
      error.textContent = (issue as Error).message;
    }
  });
}

function parseAmountBound(value: string) {
  if (!value.trim()) return null;
  const cents = parseCents(value);
  if (value.trim().startsWith("-")) throw new Error("Saisissez le montant sans signe.");
  return cents;
}

function bindPeriodFilter() {
  const button = document.querySelector<HTMLButtonElement>("#period-filter");
  const dialog = document.querySelector<HTMLDialogElement>("#period-filter-dialog");
  if (!button || !dialog) return;
  const apply = bindRegisterFilterDialog("period-filter", dialog, () => {
    dateRange = null;
  });
  const form = dialog.querySelector<HTMLFormElement>("form")!;
  const startInput = form.querySelector<HTMLInputElement>('[name="start"]')!;
  const endInput = form.querySelector<HTMLInputElement>('[name="end"]')!;
  const error = form.querySelector<HTMLElement>(".editor-error")!;
  const clear = form.querySelector<HTMLButtonElement>("#period-filter-clear")!;
  button.addEventListener("click", () => {
    startInput.value = dateRange?.start ?? "";
    endInput.value = dateRange?.end ?? "";
    error.textContent = "";
    clear.hidden = dateRange === null;
    dialog.showModal();
    startInput.focus();
  });
  for (const { id, months } of periodShortcuts) {
    form.querySelector(`[data-period-shortcut="${id}"]`)!.addEventListener("click", () => {
      const today = new Date();
      const year = today.getFullYear();
      const [firstMonth, nextMonth] = months(today.getMonth());
      startInput.value = localDate(new Date(year, firstMonth, 1));
      endInput.value = localDate(new Date(year, nextMonth, 0));
      error.textContent = "";
    });
  }
  form.addEventListener("input", (event) => {
    const input = event.target;
    // WebKit can keep a stale form validation result after an optional date is cleared.
    if (input instanceof HTMLInputElement && input.value === "" && input.validity.valid)
      input.value = "";
    error.textContent = "";
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const start = startInput.value || null;
    const end = endInput.value || null;
    if (start && end && start > end) {
      error.textContent = "La date de début doit précéder la date de fin ou lui être égale.";
      return;
    }
    dateRange = start || end ? { start, end } : null;
    void apply();
  });
}

export function bindTransactionFilter() {
  bindAmountFilter();
  bindPeriodFilter();
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
  const searchInput = document.querySelector<HTMLInputElement>("#transaction-search");
  const scope = document.querySelector<HTMLSelectElement>("#transaction-search-scope");
  const submitSearch = async () => {
    transactionSearch = searchInput!.value.trim();
    transactionPage = 1;
    await refreshTransactions();
  };
  searchInput?.form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitSearch();
  });
  scope?.addEventListener("change", async () => {
    await submitSearch();
    if (document.activeElement === document.body)
      document.getElementById("transaction-search-scope")?.focus();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-search-result]").forEach((button) => {
    button.addEventListener("click", () => {
      const result = searchPage?.rows.find((row) => row.id === button.dataset.searchResult);
      const account = accounts.find((account) => account.id === result?.accountId);
      if (result && account) void refreshTransactions({ target: { account, id: result.id } });
    });
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
  const account = selectedAccount;
  if (!account) return;
  // Opening the editor hides the summary until the edit is saved or cancelled.
  document.querySelectorAll<HTMLTableRowElement>("tr[data-transaction]").forEach((row) => {
    // Share the editor between pointer and keyboard activation.
    const openEditor = (keyboard: boolean) => {
      const item = transactions.find((transaction) => transaction.id === row.dataset.transaction);
      if (!item) return;
      document.querySelector(".transaction-editor-panel")?.remove();
      document
        .querySelectorAll("tr[data-transaction]")
        .forEach((transactionRow) => transactionRow.classList.remove("editing"));
      row.classList.add("editing");
      const summary = document.querySelector<HTMLElement>(".summary-grid")!;
      summary.hidden = true;
      const editor = document.createElement("section");
      editor.className = "transaction-editor-panel";
      const cancel = () => {
        editor.remove();
        row.classList.remove("editing");
        summary.hidden = false;
        if (keyboard) row.focus();
      };
      // Refresh both account balances after a transfer is updated.
      const saved = async () => {
        await refreshTransactions();
        if (keyboard)
          document
            .querySelectorAll<HTMLTableRowElement>("tr[data-transaction]")
            .forEach((candidate) => {
              if (candidate.dataset.transaction === item.id) candidate.focus();
            });
      };
      if (item.transferId) {
        document.querySelector(".transactions-panel")!.after(editor);
        void openTransferEditor(editor, item.transferId, keyboard, cancel, saved);
        return;
      }

      const initialReference = item.reference
        ? displayReference(item.reference)
        : (item.cheque ?? "");
      editor.innerHTML = `
        <h2>Modifier l’opération</h2>
        <form class="transaction-editor">
          <label>Date<input name="date" type="date" min="${MIN_CALENDAR_DATE}" required value="${escapeHtml(item.date)}"></label>
          <label>Tiers<input name="label" list="edit-payee-suggestions" required maxlength="${TEXT_NAME_LIMIT}" value="${escapeHtml(item.label)}"><datalist id="edit-payee-suggestions"></datalist></label>
          <div class="category-picker"><label>Catégorie<select name="category" required>${categoryOptions(item.splits?.[0]?.category ?? item.category, item.amount > 0 ? "credit" : "debit")}</select></label><button type="button" class="secondary-button add-category" aria-label="Ajouter une catégorie" title="Ajouter une catégorie">+</button></div>
          <label>Réf. / N° chèque<input name="reference" maxlength="${REFERENCE_LIMIT}" value="${escapeHtml(initialReference)}"></label>
          <label>Type<select name="type">
            <option value="debit" ${item.amount < 0 ? "selected" : ""}>Débit</option>
            <option value="credit" ${item.amount > 0 ? "selected" : ""}>Crédit</option>
          </select></label>
          <label>Montant (€)<input name="amount" type="text" inputmode="decimal" required value="${centsInput(Math.abs(item.amount))}"></label>
          ${splitControls}
          <label class="editor-note">Commentaire<textarea name="note" rows="2" placeholder="Ajouter un commentaire (facultatif)">${escapeHtml(item.note ?? "")}</textarea></label>
          <div class="editor-actions">
            <button type="submit" class="primary-button">Enregistrer</button>
            <button type="button" class="secondary-button cancel-editor">Annuler</button>
          </div>
          <p class="editor-error" role="alert"></p>
        </form>`;
      document.querySelector(".transactions-panel")!.after(editor);
      const form = editor.querySelector<HTMLFormElement>(".transaction-editor")!;
      bindCategoryCreation(form);
      const splits = bindSplitEditor(form, item.splits, Math.sign(item.amount));
      if (keyboard) editor.querySelector<HTMLInputElement>('input[name="label"]')?.focus();
      void loadPayeeSuggestions(
        editor.querySelector<HTMLDataListElement>("#edit-payee-suggestions")!,
      );
      editor.querySelector(".cancel-editor")?.addEventListener("click", () => {
        cancel();
      });
      editor.querySelector("form")?.addEventListener("submit", async (submitEvent) => {
        submitEvent.preventDefault();
        const form = submitEvent.currentTarget as HTMLFormElement;
        const values = new FormData(form);
        try {
          const amount =
            parsePositiveCents(String(values.get("amount"))) *
            (values.get("type") === "credit" ? 1 : -1);
          const reference = String(values.get("reference") ?? "").trim();
          await invoke("update_transaction", {
            transaction: {
              id: item.id,
              accountId: item.accountId,
              date: String(values.get("date")),
              label: String(values.get("label")).trim(),
              category: String(values.get("category") ?? "").trim(),
              cheque: null,
              note: String(values.get("note") ?? "").trim(),
              reference,
              amount,
              splits: splits.read(amount),
            },
          });
          await saved();
        } catch (error) {
          editor.querySelector<HTMLElement>(".editor-error")!.textContent =
            `Enregistrement impossible : ${String(error)}`;
        }
      });
    };
    row.addEventListener("click", (event) => {
      if (!(event.target as HTMLElement).closest("button, input")) openEditor(false);
    });
    row.addEventListener("keydown", (event) => {
      // Nested controls retain their own keyboard behavior.
      if (event.target === row && event.key === "Enter") {
        event.preventDefault();
        openEditor(true);
      }
    });
  });
  const creationForm = document.querySelector<HTMLFormElement>("#transaction-form")!;
  const resetCreationCategories = bindCategoryCreation(creationForm);
  const creationSplits = bindSplitEditor(creationForm);
  // A transfer has two accounts; ordinary debits and credits have a payee and reference.
  function updateCreationType() {
    const transfer =
      (creationForm.elements.namedItem("type") as HTMLSelectElement).value === "transfer";
    creationForm.querySelector<HTMLElement>(".transaction-transfer-accounts")!.hidden = !transfer;
    creationForm.querySelector<HTMLElement>(".transaction-payee")!.hidden = transfer;
    creationForm.querySelector<HTMLElement>(".transaction-reference-field")!.hidden = transfer;
    for (const name of ["sourceId", "destinationId"]) {
      const input = creationForm.elements.namedItem(name) as HTMLSelectElement;
      input.disabled = !transfer;
      input.required = transfer;
    }
    for (const name of ["debitReference", "creditReference"])
      (creationForm.elements.namedItem(name) as HTMLInputElement).disabled = !transfer;
    const label = creationForm.elements.namedItem("label") as HTMLInputElement;
    label.disabled = transfer;
    label.required = !transfer;
    (creationForm.elements.namedItem("reference") as HTMLInputElement).disabled = transfer;
    creationForm.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent = transfer
      ? "Créer le virement"
      : "Ajouter l’opération";
  }
  (creationForm.elements.namedItem("type") as HTMLSelectElement).addEventListener(
    "change",
    updateCreationType,
  );
  document.querySelector("#new-transaction")?.addEventListener("click", () => {
    const dialog = document.querySelector<HTMLDialogElement>("#transaction-dialog")!;
    const suggestions = dialog.querySelector<HTMLDataListElement>("#payee-suggestions")!;
    creationForm.reset();
    resetCreationCategories();
    creationSplits.reset();
    (creationForm.elements.namedItem("sourceId") as HTMLSelectElement).value = account.id;
    (creationForm.elements.namedItem("destinationId") as HTMLSelectElement).value =
      accounts.find((candidate) => candidate.id !== account.id)?.id ?? "";
    creationForm.querySelector<HTMLElement>(".transaction-error")!.textContent = "";
    updateCreationType();
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
    const isTransfer = values.get("type") === "transfer";
    if (
      isTransfer &&
      (values.get("sourceId") === values.get("destinationId") ||
        !values.get("sourceId") ||
        !values.get("destinationId"))
    ) {
      form.querySelector<HTMLElement>(".transaction-error")!.textContent =
        "Choisissez deux comptes différents.";
      return;
    }
    try {
      const amount = parsePositiveCents(String(values.get("amount")));
      if (isTransfer) {
        await invoke("create_transfer", {
          transfer: {
            id: crypto.randomUUID(),
            sourceId: String(values.get("sourceId")),
            destinationId: String(values.get("destinationId")),
            date: String(values.get("date")),
            amount,
            category: String(values.get("category")),
            debitReference: String(values.get("debitReference") ?? "").trim() || null,
            creditReference: String(values.get("creditReference") ?? "").trim() || null,
            note: String(values.get("note") ?? "").trim(),
          },
        });
      } else {
        const signedAmount = values.get("type") === "credit" ? amount : -amount;
        await invoke("create_transaction", {
          transaction: {
            id: crypto.randomUUID(),
            accountId: account.id,
            date: String(values.get("date")),
            label: String(values.get("label")).trim(),
            category: String(values.get("category") ?? ""),
            reference: String(values.get("reference") ?? "").trim() || null,
            note: String(values.get("note") ?? "").trim(),
            amount: signedAmount,
            splits: creationSplits.read(signedAmount),
          },
        });
      }
      closeDialog();
      await refreshTransactions();
    } catch (error) {
      form.querySelector<HTMLElement>(".transaction-error")!.textContent =
        `Enregistrement impossible : ${String(error)}`;
    }
  });
  document.querySelectorAll<HTMLButtonElement>("[data-reconcile]").forEach((button) =>
    button.addEventListener("click", async () => {
      const id = button.dataset.reconcile;
      const hadFocus = document.activeElement === button;
      button.disabled = true;
      try {
        await invoke("toggle_transaction_reconciliation", { id });
        await refreshTransactions({ strict: true });
        if (hadFocus && document.activeElement === document.body) {
          Array.from(document.querySelectorAll<HTMLButtonElement>("[data-reconcile]"))
            .find((next) => next.dataset.reconcile === id)
            ?.focus({ preventScroll: true });
        }
      } catch (error) {
        const feedback = button
          .closest(".page-content")
          ?.querySelector<HTMLElement>(".register-error");
        if (feedback)
          feedback.textContent = `Actualisation du pointage impossible. ${String(error)}`;
      } finally {
        button.disabled = false;
      }
    }),
  );
  const deleteDialog = document.querySelector<HTMLDialogElement>("#delete-transaction-dialog")!;
  const confirmButton = deleteDialog.querySelector<HTMLButtonElement>(".delete-confirm")!;
  let pendingDelete: string | null = null;
  // An application dialog is visible in the Tauri WebView and works for both operation types.
  document.querySelectorAll<HTMLElement>("[data-delete]").forEach((button) =>
    button.addEventListener("click", () => {
      const item = transactions.find((transaction) => transaction.id === button.dataset.delete);
      if (!item) return;
      pendingDelete = item.id;
      deleteDialog.querySelector<HTMLElement>(".delete-confirmation-message")!.textContent =
        item.transferId
          ? "Supprimer ce virement et ses deux opérations ?"
          : `Supprimer l’opération « ${item.label} » ?`;
      deleteDialog.querySelector<HTMLElement>(".editor-error")!.textContent = "";
      deleteDialog.showModal();
    }),
  );
  deleteDialog
    .querySelector(".delete-cancel")!
    .addEventListener("click", () => deleteDialog.close());
  deleteDialog.addEventListener("close", () => {
    pendingDelete = null;
  });
  confirmButton.addEventListener("click", async () => {
    const id = pendingDelete;
    if (!id || confirmButton.disabled) return;
    confirmButton.disabled = true;
    try {
      await invoke("delete_transaction", { id });
      deleteDialog.close();
      await refreshTransactions();
    } catch (error) {
      deleteDialog.querySelector<HTMLElement>(".editor-error")!.textContent =
        `Suppression impossible : ${String(error)}`;
    } finally {
      confirmButton.disabled = false;
    }
  });
}

function closeDialog() {
  document.querySelector<HTMLDialogElement>("#transaction-dialog")?.close();
}
// Reload after a mutation so the register reflects the database state.
export async function refreshTransactions({
  strict = false,
  showRegister = false,
  target,
}: { strict?: boolean; showRegister?: boolean; target?: { account: Account; id: string } } = {}) {
  // Keep the cache fresh without replacing a view opened while the request was pending.
  const view = document.querySelector(".page-content");
  const sameView = () => document.querySelector(".page-content") === view;
  const canRender = () =>
    sameView() && (showRegister || view?.querySelector(".transactions-panel"));
  const scope = view?.querySelector<HTMLSelectElement>("#transaction-search-scope");
  const allAccounts = !target && !showRegister && scope?.value === "all";
  const accountId = target?.account.id ?? selectedAccount?.id;
  if (accountId === undefined) {
    resetRegister();
    if (canRender()) render();
    return;
  }
  if (
    !target &&
    !allAccounts &&
    (pageAccountId !== accountId || (showRegister && scope?.value === "all"))
  ) {
    pageAccountId = accountId;
    transactionPage = 1;
    registerPage = undefined;
    transactionSearch = "";
    amountRange = null;
    dateRange = null;
  }
  const version = ++requestVersion;
  const criteria = { search: transactionSearch, amountRange, dateRange };
  try {
    if (allAccounts) {
      const result = await invoke<OperationSearchPage>("search_operations", {
        ...criteria,
        page: transactionPage,
      });
      if (version !== requestVersion || !canRender()) return;
      searchPage = result;
      transactionPage = result.page;
      render(true);
      return;
    }
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const [updatedAccounts, result] = await Promise.all([
      invoke<Account[]>("list_accounts", { today: localDate(now) }),
      invoke<RegisterPage>("list_register", {
        accountId,
        month,
        ...(target
          ? { filter: "all", page: 1, transactionId: target.id }
          : { ...criteria, filter: transactionFilter, page: transactionPage }),
      }),
    ]);
    // A slower earlier request must not replace a newer page or account.
    if (version !== requestVersion || (target ? !canRender() : selectedAccount?.id !== accountId))
      return;
    if (target) {
      resetRegister();
      setSelectedAccount(
        updatedAccounts.find((account) => account.id === accountId) ?? target.account,
      );
      pageAccountId = accountId;
    }
    setAccounts(updatedAccounts);
    registerPage = result;
    transactionPage = result.page;
    setTransactions(result.rows);
    if (canRender()) {
      render();
      if (target) {
        const row = Array.from(
          document.querySelectorAll<HTMLTableRowElement>("tr[data-transaction]"),
        ).find((item) => item.dataset.transaction === target.id);
        row?.classList.add("located");
        row?.focus();
      }
    }
  } catch (error) {
    if (version !== requestVersion) return;
    if (strict) throw error;
    if (!sameView()) return;
    if (scope) scope.value = scope.dataset.renderedScope!;
    const message = view?.querySelector<HTMLElement>(".register-error");
    if (message)
      message.textContent = target
        ? `Ouverture de l’opération impossible : ${String(error)}`
        : `Chargement des opérations impossible : ${String(error)}`;
    else if (canRender()) throw error;
  }
}
