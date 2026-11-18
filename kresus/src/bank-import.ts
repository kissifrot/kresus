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
type Choice = { action: "add" | "skip" } | { action: "match"; transactionId: string };
type ImportResult = { added: number; matched: number; skipped: number };

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

function renderRow(row: StatementRow, index: number, choice: Choice | null) {
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
  return `<tr><td class="date-cell">${dateLabel(row.date)}</td>
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
  const duplicates = preview.rows.filter((row) => row.duplicate).length;
  const lastPage = Math.max(0, Math.ceil(choices.length / pageSize) - 1);
  let page = 0;
  let saving = false;
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
      <table><thead><tr><th scope="col">DATE</th><th scope="col">LIBELLÉ</th><th scope="col" class="right">MONTANT</th><th scope="col">ACTION</th></tr></thead><tbody></tbody></table>
    </div>
    <div class="table-footer"><span id="bank-import-range"></span><div class="pagination">
      <button type="button" id="bank-import-previous" aria-label="Page précédente">‹</button>
      <button type="button" id="bank-import-next" aria-label="Page suivante">›</button>
    </div></div>
    <p id="bank-import-summary" role="status"></p>
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
  const summary = dialog.querySelector<HTMLElement>("#bank-import-summary")!;
  const error = dialog.querySelector<HTMLElement>(".editor-error")!;
  const submit = dialog.querySelector<HTMLButtonElement>("#bank-import-confirm")!;
  const cancelButtons = dialog.querySelectorAll<HTMLButtonElement>(
    ".dialog-close, #bank-import-cancel",
  );

  const sync = () => {
    const counts = { add: 0, match: 0, skip: 0, pending: 0 };
    const claimed = new Set<string>();
    for (const choice of choices) {
      counts[choice?.action ?? "pending"]++;
      if (choice?.action === "match") claimed.add(optionValue(choice));
    }
    summary.textContent = [
      plural(counts.add, "à ajouter", "à ajouter"),
      plural(counts.match, "à rapprocher", "à rapprocher"),
      plural(duplicates, "doublon", "doublons"),
      plural(counts.skip - duplicates, "ignorée", "ignorées"),
      plural(counts.pending, "à vérifier", "à vérifier"),
    ].join(" · ");
    previous.disabled = saving || page === 0;
    next.disabled = saving || page === lastPage;
    review.disabled = saving;
    review.hidden = counts.pending === 0;
    verify.hidden = counts.pending > 0 || counts.add + counts.match > 0;
    verify.disabled = saving || verify.hidden;
    submit.hidden = !verify.hidden;
    submit.disabled = saving || counts.pending > 0 || submit.hidden;
    cancelButtons.forEach((button) => {
      button.disabled = saving;
    });
    table.querySelectorAll<HTMLSelectElement>("select").forEach((select) => {
      select.disabled = saving;
      for (const option of select.options) {
        option.disabled = option.value !== select.value && claimed.has(option.value);
      }
    });
  };

  const renderPage = () => {
    const start = page * pageSize;
    const end = Math.min(start + pageSize, choices.length);
    table.innerHTML =
      preview.rows
        .slice(start, end)
        .map((row, offset) => renderRow(row, start + offset, choices[start + offset]!))
        .join("") ||
      '<tr><td colspan="4" class="empty-row">Ce relevé ne contient aucune opération.</td></tr>';
    range.textContent = choices.length ? `Lignes ${start + 1} à ${end} sur ${choices.length}` : "";
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
  review.addEventListener("click", () => {
    const index = choices.indexOf(null);
    if (index < 0) return;
    page = Math.floor(index / pageSize);
    renderPage();
    table.querySelector<HTMLSelectElement>(`[data-bank-line="${index}"]`)?.focus();
  });
  table.addEventListener("change", (event) => {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const { value } = event.target;
    const index = Number(event.target.dataset.bankLine);
    choices[index] =
      value === "skip" || value === "add"
        ? { action: value }
        : value.startsWith(matchPrefix)
          ? { action: "match", transactionId: value.slice(matchPrefix.length) }
          : null;
    error.textContent = "";
    sync();
  });
  cancelButtons.forEach((button) => button.addEventListener("click", cancel));
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    cancel();
  });
  dialog.querySelector("form")!.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled && verify.disabled) return;
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
