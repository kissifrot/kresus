import { invoke } from "@tauri-apps/api/core";
import { dateLabel, escapeHtml, euro } from "./format";
import { selectedAccount, setCategories } from "./state";
import { refreshTransactions } from "./transactions";
import { openReconciliation, type ClosingBalance } from "./reconciliation";
import type { Account, Category } from "./types";

type Candidate = { id: string; date: string; label: string; category: string; reconciled: boolean };
type StatementRow = {
  date: string;
  label: string;
  amount: number;
  note: string | null;
  reference: string | null;
  duplicate: "alreadyImported" | "repeated" | null;
  candidates: Candidate[];
  moreCandidates: boolean;
};
type StatementPreview = {
  previewId: string;
  fileName: string;
  bankId: string;
  bankAccount: string;
  matchDays: number;
  closing: ClosingBalance;
  rows: StatementRow[];
};
type BulkAction = "add" | "skip";
type Choice = { action: BulkAction } | { action: "match"; transactionId: string };
type ImportResult = { added: number; matched: number; skipped: number };

const summaryLabels = {
  add: ["à ajouter", "à ajouter"],
  match: ["à rapprocher", "à rapprocher"],
  duplicate: ["doublon", "doublons"],
  skip: ["ignorée", "ignorées"],
  pending: ["à vérifier", "à vérifier"],
} as const;
type SummaryFilter = keyof typeof summaryLabels;
const pageSize = 25;
const matchPrefix = "match:";
const plural = (count: number, singular: string, plural: string) =>
  `${count} ${count === 1 ? singular : plural}`;

function discard(previewId: string) {
  void invoke("discard_bank_statement", { previewId }).catch(console.error);
}

export async function openBankImport(account: Account, button: HTMLButtonElement) {
  const view = button.closest(".page-content")!;
  const status = view.querySelector<HTMLElement>(".bank-import-status")!;
  button.disabled = true;
  status.textContent = "";
  try {
    const preview = await invoke<StatementPreview | null>("preview_bank_statement", {
      accountId: account.id,
    });
    if (!preview) return;
    if (!view.isConnected || selectedAccount?.id !== account.id) {
      discard(preview.previewId);
      return;
    }
    showPreview(view, account, preview);
  } catch (error) {
    status.textContent = `Lecture du relevé impossible. ${String(error)}`;
  } finally {
    button.disabled = false;
  }
}

function optionValue(choice: Choice | null): string {
  if (!choice) return "";
  return choice.action === "match" ? matchPrefix + choice.transactionId : choice.action;
}

function uniquePendingMatches(
  preview: StatementPreview,
  choices: (Choice | null)[],
  claimed: Set<string>,
) {
  const contenders = new Map<string, number>();
  const truncatedDates = new Map<number, number[]>();
  const singleMatches: { index: number; candidate: Candidate; amount: number }[] = [];
  preview.rows.forEach((row, index) => {
    if (choices[index] !== null) return;
    const available = row.candidates.filter(({ id }) => !claimed.has(matchPrefix + id));
    for (const { id } of available) contenders.set(id, (contenders.get(id) ?? 0) + 1);
    if (row.moreCandidates) {
      const dates = truncatedDates.get(row.amount) ?? [];
      dates.push(Date.parse(row.date));
      truncatedDates.set(row.amount, dates);
    } else if (available.length === 1) {
      singleMatches.push({ index, candidate: available[0]!, amount: row.amount });
    }
  });
  const matchWindow = preview.matchDays * 86_400_000;
  return singleMatches.filter(({ candidate, amount }) => {
    if (contenders.get(candidate.id) !== 1) return false;
    const date = Date.parse(candidate.date);
    // A truncated list can hide this candidate within the same amount and date window.
    return !truncatedDates.get(amount)?.some((other) => Math.abs(date - other) <= matchWindow);
  });
}

function renderRow(row: StatementRow, index: number, choice: Choice | null, selected: boolean) {
  const label = escapeHtml(row.label);
  const value = optionValue(choice);
  const action = row.duplicate
    ? row.duplicate === "alreadyImported"
      ? "Déjà importée"
      : "Doublon dans le fichier"
    : `<select class="filter-button" data-bank-line="${index}" aria-label="Action pour la ligne ${index + 1}, ${label}">
        ${row.candidates.length ? '<option value="">À décider</option>' : ""}
        <option value="add" ${value === "add" ? "selected" : ""}>Ajouter l’opération</option>
        <option value="skip" ${value === "skip" ? "selected" : ""}>Ignorer la ligne</option>
        ${row.candidates
          .map((item) => {
            const option = matchPrefix + item.id;
            return `<option value="${escapeHtml(option)}" ${value === option ? "selected" : ""}>Rapprocher · ${dateLabel(item.date)} · ${escapeHtml(item.label)} · ${escapeHtml(item.category)}${item.reconciled ? " · pointée" : ""}</option>`;
          })
          .join("")}
      </select>${row.moreCandidates ? "<small>20 opérations les plus proches affichées.</small>" : ""}`;
  const checkbox = row.duplicate
    ? ""
    : `<input type="checkbox" data-bank-select="${index}" aria-label="Sélectionner la ligne ${index + 1}, ${label}" ${selected ? "checked" : ""}>`;
  return `<tr><td class="bank-import-select">${checkbox}</td><td class="date-cell">${dateLabel(row.date)}</td>
    <td class="bank-import-label"><strong>${label}</strong>${row.reference ? `<small>Réf. ${escapeHtml(row.reference)}</small>` : ""}${row.note ? `<small>${escapeHtml(row.note)}</small>` : ""}</td>
    <td class="amount ${row.amount < 0 ? "debit" : "credit"}">${euro(row.amount)}</td>
    <td class="bank-import-decision">${action}</td></tr>`;
}

function showPreview(view: Element, account: Account, preview: StatementPreview) {
  const lastOperationDate = preview.rows.reduce(
    (latest, row) => (row.date > latest ? row.date : latest),
    "",
  );
  const closing = {
    amount: preview.closing.amount,
    date:
      preview.closing.date ?? (preview.closing.amount === null ? lastOperationDate || null : null),
  };
  const choices: (Choice | null)[] = preview.rows.map((row) =>
    row.duplicate ? { action: "skip" } : row.candidates.length ? null : { action: "add" },
  );
  const rows = preview.rows.map((row, index) => ({ row, index }));
  const selection = new Set<number>();
  const statusOf = (index: number): SummaryFilter =>
    preview.rows[index]!.duplicate ? "duplicate" : (choices[index]?.action ?? "pending");
  let page = 0;
  let lastPage = 0;
  let filter: SummaryFilter | null = null;
  let selectableIndices: number[] = [];
  let saving = false;
  let showPendingError = false;
  let uniqueMatches: ReturnType<typeof uniquePendingMatches> = [];
  const dialog = document.createElement("dialog");
  dialog.className = "bank-import-dialog";
  dialog.setAttribute("aria-labelledby", "bank-import-title");
  dialog.innerHTML = `<form>
    <div class="dialog-heading"><h2 id="bank-import-title">Importer un relevé bancaire</h2><button type="button" class="dialog-close" aria-label="Fermer">×</button></div>
    <div class="bank-import-source">
      <p><strong>Compte de destination</strong> · ${escapeHtml(account.name)}</p>
      <p><strong>Relevé OFX</strong> · ${escapeHtml(preview.fileName)} · Compte ${escapeHtml(preview.bankAccount)} · Banque ${escapeHtml(preview.bankId)}</p>
      ${preview.closing.amount !== null ? `<p><strong>Solde de clôture</strong> · ${euro(preview.closing.amount)}${preview.closing.date ? ` au ${dateLabel(preview.closing.date)}` : ""}</p>` : ""}
      ${
        account.accountNumber &&
        account.accountNumber.replace(/\s/g, "") !== preview.bankAccount.replace(/\s/g, "")
          ? '<p class="money-warning">Le numéro du relevé diffère du numéro enregistré dans Kresus. Vérifiez le compte de destination.</p>'
          : ""
      }
      <p>Kresus propose les opérations de même montant et de même sens, à ${preview.matchDays} jours près. Rapprocher une ligne pointe l’opération existante.</p>
    </div>
    <div class="table-wrap bank-import-table">
      <table><thead><tr><th scope="col" class="bank-import-select"><input type="checkbox" id="bank-import-select-all" aria-label="Tout sélectionner" title="Tout sélectionner (toutes les pages du filtre)"></th><th scope="col">DATE</th><th scope="col">LIBELLÉ</th><th scope="col" class="right">MONTANT</th><th scope="col">ACTION</th></tr></thead><tbody id="bank-import-lines"></tbody></table>
    </div>
    <div class="table-footer"><span id="bank-import-range" role="status"></span><div class="pagination">
      <button type="button" id="bank-import-previous" aria-label="Page précédente">‹</button>
      <button type="button" id="bank-import-next" aria-label="Page suivante">›</button>
    </div></div>
    <div id="bank-import-summary" role="group" aria-label="Filtrer les lignes du relevé">
      ${Object.keys(summaryLabels)
        .map(
          (key) =>
            `<button type="button" class="secondary-button" data-bank-filter="${key}" aria-pressed="false" aria-controls="bank-import-lines"></button>`,
        )
        .join("")}
    </div>
    <p id="bank-import-totals" class="visually-hidden" role="status"></p>
    <div id="bank-import-bulk-actions" role="group" aria-label="Choisir une action pour toutes les lignes à vérifier" hidden>
      <button type="button" class="secondary-button" id="bank-import-match-pending" hidden>Rapprocher les correspondances uniques</button>
      <button type="button" class="secondary-button" id="bank-import-add-pending">Ajouter les lignes à vérifier</button>
      <button type="button" class="secondary-button" id="bank-import-skip-pending">Ignorer les lignes à vérifier</button>
    </div>
    <div id="bank-import-selection-actions" role="group" aria-label="Actions sur la sélection" hidden>
      <span id="bank-import-selection-count" role="status"></span>
      <button type="button" class="secondary-button" id="bank-import-match-selection" hidden>Rapprocher les correspondances uniques de la sélection</button>
      <button type="button" class="secondary-button" id="bank-import-add-selection">Ajouter la sélection</button>
      <button type="button" class="secondary-button" id="bank-import-skip-selection">Ignorer la sélection</button>
      <button type="button" class="secondary-button" id="bank-import-clear-selection">Désélectionner tout</button>
    </div>
    <p class="editor-error" role="alert"></p>
    <div class="dialog-actions">
      <button type="button" class="secondary-button" id="bank-import-review">Voir la prochaine ligne à vérifier</button>
      <button type="button" class="secondary-button" id="bank-import-cancel">Annuler</button>
      <button type="submit" class="primary-button" id="bank-import-balance" hidden>Vérifier le solde</button>
      <button type="submit" class="primary-button" id="bank-import-confirm">Confirmer l’import</button>
    </div>
  </form>`;
  view.append(dialog);
  const table = dialog.querySelector("tbody")!;
  const previous = dialog.querySelector<HTMLButtonElement>("#bank-import-previous")!;
  const next = dialog.querySelector<HTMLButtonElement>("#bank-import-next")!;
  const review = dialog.querySelector<HTMLButtonElement>("#bank-import-review")!;
  const verify = dialog.querySelector<HTMLButtonElement>("#bank-import-balance")!;
  const range = dialog.querySelector<HTMLElement>("#bank-import-range")!;
  const filterButtons = dialog.querySelectorAll<HTMLButtonElement>("[data-bank-filter]");
  const totals = dialog.querySelector<HTMLElement>("#bank-import-totals")!;
  const bulk = dialog.querySelector<HTMLElement>("#bank-import-bulk-actions")!;
  const matchPending = dialog.querySelector<HTMLButtonElement>("#bank-import-match-pending")!;
  const addPending = dialog.querySelector<HTMLButtonElement>("#bank-import-add-pending")!;
  const skipPending = dialog.querySelector<HTMLButtonElement>("#bank-import-skip-pending")!;
  const selectionActions = dialog.querySelector<HTMLElement>("#bank-import-selection-actions")!;
  const matchSelection = dialog.querySelector<HTMLButtonElement>("#bank-import-match-selection")!;
  const selectAll = dialog.querySelector<HTMLInputElement>("#bank-import-select-all")!;
  const selectionCount = dialog.querySelector<HTMLElement>("#bank-import-selection-count")!;
  const selectionButtons = selectionActions.querySelectorAll<HTMLButtonElement>("button");
  const error = dialog.querySelector<HTMLElement>(".editor-error")!;
  const submit = dialog.querySelector<HTMLButtonElement>("#bank-import-confirm")!;
  const cancelButtons = dialog.querySelectorAll<HTMLButtonElement>(
    ".dialog-close, #bank-import-cancel",
  );

  const syncSelection = () => {
    const checked = selectableIndices.filter((index) => selection.has(index)).length;
    selectAll.disabled = saving || selectableIndices.length === 0;
    selectAll.checked = checked > 0 && checked === selectableIndices.length;
    selectAll.indeterminate = checked > 0 && checked < selectableIndices.length;
    selectionActions.hidden = selection.size === 0;
    selectionCount.textContent = plural(selection.size, "ligne cochée", "lignes cochées");
    const matches = uniqueMatches.filter(({ index }) => selection.has(index)).length;
    matchSelection.hidden = matches === 0;
    matchSelection.textContent = `Rapprocher les correspondances uniques de la sélection (${matches})`;
    bulk.hidden = selection.size > 0 || !choices.includes(null);
  };

  const sync = () => {
    const counts = { add: 0, match: 0, duplicate: 0, skip: 0, pending: 0 };
    const claimed = new Set<string>();
    choices.forEach((choice, index) => {
      counts[statusOf(index)]++;
      if (choice?.action === "match") claimed.add(optionValue(choice));
    });
    const summary = Array.from(filterButtons, (button) => {
      const key = button.dataset.bankFilter as SummaryFilter;
      const [singular, pluralLabel] = summaryLabels[key];
      const label = plural(counts[key], singular, pluralLabel);
      button.textContent = label;
      button.setAttribute("aria-pressed", String(filter === key));
      button.title =
        filter === key ? "Afficher toutes les lignes" : "Afficher uniquement ces lignes";
      button.disabled = saving || (counts[key] === 0 && filter !== key);
      return label;
    }).join(" · ");
    if (totals.textContent !== summary) totals.textContent = summary;
    uniqueMatches = uniquePendingMatches(preview, choices, claimed);
    syncSelection();
    matchPending.hidden = uniqueMatches.length === 0;
    matchPending.disabled = saving;
    matchPending.textContent = `Rapprocher les correspondances uniques (${uniqueMatches.length})`;
    addPending.disabled = saving;
    skipPending.disabled = saving;
    selectionButtons.forEach((button) => {
      button.disabled = saving;
    });
    if (showPendingError) {
      if (counts.pending === 0) {
        showPendingError = false;
        error.textContent = "";
      } else {
        error.textContent =
          counts.pending === 1
            ? "Il reste une ligne à vérifier. Choisissez une action avant de confirmer l’import."
            : `Il reste ${counts.pending} lignes à vérifier. Choisissez une action pour chacune avant de confirmer l’import.`;
      }
    }
    previous.disabled = saving || page === 0;
    next.disabled = saving || page === lastPage;
    review.disabled = saving;
    review.hidden = counts.pending === 0;
    verify.hidden = counts.pending > 0 || counts.add + counts.match > 0;
    verify.disabled = saving || verify.hidden;
    submit.hidden = !verify.hidden;
    submit.disabled = saving || submit.hidden;
    cancelButtons.forEach((button) => {
      button.disabled = saving;
    });
    table.querySelectorAll<HTMLInputElement>("[data-bank-select]").forEach((checkbox) => {
      checkbox.disabled = saving;
    });
    table.querySelectorAll<HTMLSelectElement>("select").forEach((select) => {
      select.disabled = saving;
      for (const option of select.options) {
        option.disabled = option.value !== select.value && claimed.has(option.value);
      }
    });
  };

  const renderPage = () => {
    const visible = filter ? rows.filter(({ index }) => statusOf(index) === filter) : rows;
    selectableIndices = visible.filter(({ row }) => !row.duplicate).map(({ index }) => index);
    lastPage = Math.max(0, Math.ceil(visible.length / pageSize) - 1);
    page = Math.min(page, lastPage);
    const start = page * pageSize;
    const end = Math.min(start + pageSize, visible.length);
    const emptyMessage = filter
      ? "Aucune ligne ne correspond à ce filtre."
      : "Ce relevé ne contient aucune opération.";
    table.innerHTML =
      visible
        .slice(start, end)
        .map(({ row, index }) => renderRow(row, index, choices[index]!, selection.has(index)))
        .join("") || `<tr><td colspan="5" class="empty-row">${emptyMessage}</td></tr>`;
    range.textContent = visible.length
      ? `Lignes ${start + 1} à ${end} sur ${visible.length}${filter ? ` · ${rows.length} au total` : ""}`
      : "";
    sync();
  };
  const close = () => {
    dialog.close();
    dialog.remove();
    view.querySelector<HTMLButtonElement>("#bank-import")?.focus();
  };
  const cancel = () => {
    if (saving) return;
    discard(preview.previewId);
    close();
  };

  previous.addEventListener("click", () => {
    page--;
    renderPage();
  });
  next.addEventListener("click", () => {
    page++;
    renderPage();
  });
  selectAll.addEventListener("change", () => {
    for (const index of selectableIndices) {
      if (selectAll.checked) selection.add(index);
      else selection.delete(index);
    }
    renderPage();
  });
  filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.bankFilter as SummaryFilter;
      filter = filter === key ? null : key;
      page = 0;
      renderPage();
    });
  });
  const applyToPending = (action: BulkAction) => {
    choices.forEach((choice, index) => {
      if (choice === null) choices[index] = { action };
    });
    renderPage();
    dialog.querySelector<HTMLButtonElement>(`[data-bank-filter="${action}"]`)?.focus();
  };
  addPending.addEventListener("click", () => applyToPending("add"));
  skipPending.addEventListener("click", () => applyToPending("skip"));
  const applyUniqueMatches = (selectionOnly: boolean) => {
    for (const { index, candidate } of uniqueMatches) {
      if (selectionOnly && !selection.has(index)) continue;
      choices[index] = { action: "match", transactionId: candidate.id };
      selection.delete(index);
    }
    if (!showPendingError) error.textContent = "";
    renderPage();
    dialog.querySelector<HTMLButtonElement>('[data-bank-filter="match"]')?.focus();
  };
  matchPending.addEventListener("click", () => applyUniqueMatches(false));
  matchSelection.addEventListener("click", () => applyUniqueMatches(true));
  const applyToSelection = (action: BulkAction) => {
    for (const index of selection) choices[index] = { action };
    selection.clear();
    if (!showPendingError) error.textContent = "";
    renderPage();
    dialog.querySelector<HTMLButtonElement>(`[data-bank-filter="${action}"]`)?.focus();
  };
  dialog
    .querySelector("#bank-import-add-selection")!
    .addEventListener("click", () => applyToSelection("add"));
  dialog
    .querySelector("#bank-import-skip-selection")!
    .addEventListener("click", () => applyToSelection("skip"));
  dialog.querySelector("#bank-import-clear-selection")!.addEventListener("click", () => {
    selection.clear();
    renderPage();
    (
      table.querySelector<HTMLInputElement>("[data-bank-select]") ??
      dialog.querySelector<HTMLButtonElement>("[data-bank-filter][aria-pressed='true']") ??
      (submit.hidden ? verify : submit)
    ).focus();
  });
  const focusPending = (index: number) => {
    if (index < 0) return;
    filter = null;
    page = Math.floor(index / pageSize);
    renderPage();
    table.querySelector<HTMLSelectElement>(`[data-bank-line="${index}"]`)?.focus();
  };
  review.addEventListener("click", () => focusPending(choices.indexOf(null)));
  table.addEventListener("change", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.dataset.bankSelect !== undefined) {
      const index = Number(event.target.dataset.bankSelect);
      if (event.target.checked) selection.add(index);
      else selection.delete(index);
      syncSelection();
      return;
    }
    if (!(event.target instanceof HTMLSelectElement)) return;
    const { value } = event.target;
    const index = Number(event.target.dataset.bankLine);
    choices[index] =
      value === "skip" || value === "add"
        ? { action: value }
        : value.startsWith(matchPrefix)
          ? { action: "match", transactionId: value.slice(matchPrefix.length) }
          : null;
    if (!showPendingError) error.textContent = "";
    if (filter && statusOf(index) !== filter) {
      renderPage();
      dialog.querySelector<HTMLButtonElement>("[data-bank-filter][aria-pressed='true']")?.focus();
    } else sync();
  });
  cancelButtons.forEach((button) => button.addEventListener("click", cancel));
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    cancel();
  });
  dialog.querySelector("form")!.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    const pending = choices.indexOf(null);
    if (pending >= 0) {
      showPendingError = true;
      focusPending(pending);
      return;
    }
    const checkingOnly = submit.hidden;
    saving = true;
    error.textContent = "";
    sync();
    let result: ImportResult;
    try {
      result = await invoke<ImportResult>("import_bank_statement", {
        previewId: preview.previewId,
        choices,
      });
    } catch (issue) {
      saving = false;
      error.textContent = `Import impossible. ${String(issue)}`;
      sync();
      return;
    }
    close();
    if (!view.isConnected) return;
    const message = checkingOnly
      ? ""
      : [
          plural(result.added, "opération ajoutée", "opérations ajoutées"),
          plural(result.matched, "rapprochée", "rapprochées"),
          plural(result.skipped, "ligne ignorée", "lignes ignorées"),
        ].join(" · ");
    let status = message;
    try {
      if (result.added) {
        const categories = await invoke<Category[]>("list_categories");
        if (!view.isConnected) return;
        setCategories(categories);
      }
      await refreshTransactions({ strict: true });
    } catch (issue) {
      status = `${message ? `${message}. ` : ""}Actualisation impossible. ${String(issue)}`;
    }
    const feedback = document.querySelector<HTMLElement>(".bank-import-status");
    if (feedback && selectedAccount?.id === account.id) {
      feedback.textContent = status;
      openReconciliation(account.id, closing);
    }
  });
  renderPage();
  dialog.showModal();
}
