import { REFERENCE_LIMIT, TEXT_NAME_LIMIT } from "./text-limits";
import { invoke } from "@tauri-apps/api/core";
import type { Account, AccountKind, Schedule, Category, Transaction } from "./types";
import {
  accounts,
  schedules,
  selectedAccount,
  setAccounts,
  setSelectedAccount,
  setSchedules,
  setCategories,
} from "./state";
import {
  euro,
  amountWithoutCurrency,
  dateLabel,
  displayReference,
  escapeHtml,
  parseCents,
  localDate,
  MIN_CALENDAR_DATE,
} from "./format";
import {
  transactionFilter,
  transactionFilters,
  transactionSearch,
  amountFilterLabel,
  renderAmountFilterDialog,
  periodFilterLabel,
  renderPeriodFilterDialog,
  registerSummary,
  bindTransactionActions,
  bindTransactionFilter,
  refreshTransactions,
  resetRegister,
} from "./transactions";
import { renderSchedules } from "./schedules";
import { categoryOptions, renderCategories } from "./categories";
import { renderSpendingReport } from "./spending-report";
import { renderHousehold } from "./household";
import { openMoneyImport } from "./money-import";
import { openBankImport } from "./bank-import";
import { bindReconciliation, resetReconciliation } from "./reconciliation";
import { bindBalanceHistory } from "./balance-history";
import { bindBalanceForecast } from "./balance-forecast";
import { confirmAction } from "./confirmation";
import { showAbout } from "./about";

const brandIcon = new URL("../assets/kresus-icon.svg", import.meta.url).href;
let activeDatabase: string | null = null;

function referenceCell(reference?: string | null, cheque?: string | null): string {
  const formatted = reference ? displayReference(reference) : "";
  const number = cheque?.trim() ?? "";
  if (formatted && number && formatted !== number)
    return `<span>Réf. ${escapeHtml(formatted)}</span><span>Chèque ${escapeHtml(number)}</span>`;
  return escapeHtml(formatted || number || "—");
}

function registerFilterControl(id: string, label: string, value: string, clearLabel: string) {
  return `<div class="register-filter-actions" ${value ? "data-active" : ""}>
    <button type="button" class="secondary-button" id="${id}" aria-haspopup="dialog">${label}${value ? ` · ${escapeHtml(value)}` : ""}</button>
    ${value ? `<button type="button" class="secondary-button register-filter-clear" id="${id}-quick-clear" aria-label="${clearLabel}" title="${clearLabel}">×</button>` : ""}
  </div>`;
}

function renderSearchResults(rows: Transaction[]) {
  const accountNames = new Map(accounts.map((account) => [account.id, account.name]));
  return `<div class="table-wrap"><table class="search-results"><thead><tr><th>DATE</th><th>COMPTE</th><th>RÉF. / N° CHÈQUE</th><th>TIERS / OPÉRATION</th><th>CATÉGORIE</th><th class="right">MONTANT (€)</th><th></th></tr></thead><tbody>${
    rows
      .map((transaction) => {
        const accountName = escapeHtml(accountNames.get(transaction.accountId) ?? "Compte");
        const label = escapeHtml(transaction.label);
        return `<tr><td class="date-cell">${dateLabel(transaction.date)}</td><td>${accountName}</td><td class="cheque-cell">${referenceCell(transaction.reference, transaction.cheque)}</td><td><strong class="transaction-label">${label}</strong>${transaction.note ? `<small class="transaction-note">${escapeHtml(transaction.note)}</small>` : ""}</td><td><span class="category-pill">${escapeHtml(transaction.category)}</span></td><td class="amount ${transaction.amount < 0 ? "debit" : "credit"}">${amountWithoutCurrency(transaction.amount)}</td><td><button type="button" class="secondary-button" data-search-result="${escapeHtml(transaction.id)}" aria-label="Ouvrir ${label} dans ${accountName}">Ouvrir</button></td></tr>`;
      })
      .join("") ||
    '<tr><td colspan="7" class="empty-row">Aucune opération ne correspond à cette recherche.</td></tr>'
  }</tbody></table></div>`;
}

function bindAccountSettings(account: Account) {
  const dialog = document.querySelector<HTMLDialogElement>("#account-settings-dialog")!;
  const form = dialog.querySelector("form")!;
  const name = form.querySelector<HTMLInputElement>('[name="name"]')!;
  const error = form.querySelector<HTMLElement>(".editor-error")!;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  document.querySelector("#edit-account")!.addEventListener("click", () => {
    form.reset();
    error.textContent = "";
    dialog.showModal();
    name.focus();
  });
  dialog.querySelector(".dialog-close")!.addEventListener("click", () => dialog.close());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const values = new FormData(form);
    submit.disabled = true;
    error.textContent = "";
    try {
      await invoke("update_account", {
        id: account.id,
        settings: {
          name: name.value.trim(),
          bank: String(values.get("bank")).trim(),
          accountNumber: String(values.get("accountNumber")).trim() || null,
          archived: values.has("archived"),
        },
      });
      await refreshTransactions({ strict: true });
      document.querySelector<HTMLButtonElement>("#edit-account")?.focus();
    } catch (issue) {
      error.textContent = `Enregistrement impossible : ${String(issue)}`;
    } finally {
      submit.disabled = false;
    }
  });
}

export function render(allAccounts = false) {
  const selected =
    accounts.find((account) => account.id === selectedAccount?.id) ?? selectedAccount;
  // Keep the account list position when the interface is refreshed.
  const accountScroll = document.querySelector<HTMLElement>(".sidebar-accounts")?.scrollTop ?? 0;
  const {
    totalCount,
    unreconciledCount,
    balance,
    balanceWithFuture,
    rows,
    searchRows,
    filteredCount,
    pageCount,
    page,
    start,
    income,
    expenses,
    creditCount,
    debitCount,
  } = registerSummary(allAccounts);
  const visibleCount = allAccounts ? searchRows.length : rows.length;
  const activeAccounts = accounts.filter((account) => !account.archived);
  const accountList = (kind: AccountKind) =>
    activeAccounts
      .filter((account) => account.kind === kind)
      .map(
        (account) => `
    <button class="account-item ${!allAccounts && account.id === selected?.id ? "active" : ""}" data-account="${escapeHtml(account.id)}">
      <span class="account-icon ${kind === "Compte courant" ? "checking" : kind === "Épargne" ? "savings" : "insurance"}">${kind === "Compte courant" ? "↗" : kind === "Épargne" ? "◈" : "✳"}</span>
      <span class="account-copy"><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.bank)}</small></span>
      <span class="account-balance">${euro(account.currentBalance)}</span>
    </button>`,
      )
      .join("");
  document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
    <aside class="sidebar">
      <div class="brand"><img class="brand-mark" src="${brandIcon}" alt=""><div><strong>kresus</strong><span>FINANCES FAMILIALES</span></div></div>
      <button class="nav-item" id="household-nav"><span>▦</span> Vue d’ensemble</button>
      <button class="nav-item" id="schedules-nav"><span>◷</span> Échéances <i>${schedules.length}</i></button>
      <button class="nav-item" id="categories-nav"><span>▤</span> Catégories</button>
      <button class="nav-item" id="spending-nav" ${selected ? "" : "disabled"}><span>◔</span> Répartition des dépenses</button>
      <div class="sidebar-divider"></div>
      <div class="section-heading"><button type="button" id="accounts-nav">Mes comptes</button> <button class="add-account" title="Ajouter un compte">+</button></div>
      <div class="sidebar-accounts" aria-label="Liste des comptes">
      <div class="account-group"><div class="group-label">COURANTS <span>${activeAccounts.filter((account) => account.kind === "Compte courant").length}</span></div>${accountList("Compte courant")}</div>
      <div class="account-group"><div class="group-label">ÉPARGNE <span>${activeAccounts.filter((account) => account.kind === "Épargne").length}</span></div>${accountList("Épargne")}</div>
      <div class="account-group"><div class="group-label">ASSURANCE VIE <span>${activeAccounts.filter((account) => account.kind === "Assurance vie").length}</span></div>${accountList("Assurance vie")}</div>
      </div>
      <div class="database-controls"><small title="${escapeHtml(activeDatabase ?? "Base habituelle")}">${activeDatabase ? escapeHtml(activeDatabase.split(/[\\/]/).pop() ?? activeDatabase) : "Base habituelle"}</small><p class="database-error" role="status"></p></div>
    </aside>
    <main class="main-area">
      <header class="topbar"><div class="breadcrumb"><button type="button" id="household-breadcrumb">Mon foyer</button> <span>/</span> ${allAccounts ? "<strong>Recherche des opérations</strong>" : selected ? `<button type="button" id="accounts-breadcrumb">Comptes</button> <span>/</span> <strong>${escapeHtml(selected.name)}</strong>` : "<strong>Comptes</strong>"}</div></header>
      <div class="page-content">
        ${
          selected
            ? `${
                allAccounts
                  ? ""
                  : `
        <div class="page-heading account-heading"><div><div class="eyebrow">${escapeHtml(selected.kind)}${selected.bank ? ` <span>·</span> ${escapeHtml(selected.bank)}` : ""}${selected.archived ? " <span>·</span> Archivé" : ""}</div><h1>${escapeHtml(selected.name)}</h1><p>Suivez les mouvements et rapprochez vos opérations bancaires.</p>
          <div class="account-settings-control">
            <button type="button" class="secondary-button" id="edit-account" aria-haspopup="dialog">Modifier le compte</button>
            ${selected.accountNumber ? `<small id="account-number">Numéro de compte · ${escapeHtml(selected.accountNumber)}</small>` : ""}
          </div></div><div class="page-actions"><button type="button" class="secondary-button" id="balance-history-toggle" aria-expanded="false" aria-controls="balance-history">Historique du solde</button><button type="button" class="secondary-button" id="balance-forecast-toggle" aria-expanded="false" aria-controls="balance-forecast">Prévision du solde</button><button type="button" class="secondary-button" id="bank-import" aria-haspopup="dialog">Importer un relevé…</button><button type="button" class="secondary-button" id="start-reconciliation">Rapprocher un relevé</button><button class="primary-button" id="new-transaction"><span>+</span> Nouvelle opération</button></div></div>
        <p class="bank-import-status" role="status"></p>
        <section class="summary-grid">
          <article class="summary-card balance-card${balance < 0 ? " negative-balance" : ""}"><div class="card-label">Solde à ce jour <span class="help">i</span></div><strong>${euro(balance)}</strong><small>Solde initial · ${euro(selected.openingBalance)}</small>${balanceWithFuture !== undefined && balanceWithFuture !== balance ? `<small>Avec opérations futures · ${euro(balanceWithFuture)}</small>` : ""}<div class="balance-decoration">€</div></article>
          <article class="summary-card"><div class="card-label">Entrées ce mois <span class="metric-icon positive">↙</span></div><strong><button type="button" id="filter-month-credit" aria-label="Afficher les entrées de ce mois">${euro(income)}</button></strong><small class="positive-text">${creditCount} opération${creditCount === 1 ? "" : "s"} créditrice${creditCount === 1 ? "" : "s"}</small></article>
          <article class="summary-card"><div class="card-label">Sorties ce mois <span class="metric-icon negative">↗</span></div><strong><button type="button" id="filter-month-debit" aria-label="Afficher les sorties de ce mois">${euro(Math.abs(expenses))}</button></strong><small>${debitCount} opération${debitCount === 1 ? "" : "s"} débitrice${debitCount === 1 ? "" : "s"}</small></article>
          <article class="summary-card reconciliation-card"><div class="card-label">À pointer</div><strong><button type="button" id="filter-unreconciled" aria-label="Afficher les ${unreconciledCount} opérations à pointer">${unreconciledCount} <em>opérations</em></button></strong><small><span class="status-dot"></span> Rapprochez vos relevés</small></article>
        </section>
        <section id="balance-history" class="balance-history" hidden></section>
        <section id="balance-forecast" class="balance-history" hidden></section>
        <section id="statement-reconciliation" class="statement-reconciliation" hidden></section>`
              }
        <p class="register-error" role="alert"></p><section class="transactions-panel">
          <div class="panel-heading"><div><h2>${allAccounts ? "Recherche des opérations" : "Historique des opérations"}</h2>${allAccounts ? "" : `<p>${totalCount} opérations · Solde calculé à partir des mouvements</p>`}</div><div class="panel-actions"><form id="transaction-search-form" role="search"><label class="visually-hidden" for="transaction-search">Rechercher une opération</label><input class="filter-button" type="search" id="transaction-search" placeholder="Libellé, catégorie…" title="Rechercher dans le libellé, la catégorie, la référence, le numéro de chèque ou le commentaire" value="${escapeHtml(transactionSearch)}"><label class="visually-hidden" for="transaction-search-scope">Périmètre de recherche</label><select class="filter-button" id="transaction-search-scope" data-rendered-scope="${allAccounts ? "all" : "current"}"><option value="current" ${allAccounts ? "" : "selected"}>Ce compte</option><option value="all" ${allAccounts ? "selected" : ""}>Tous les comptes</option></select><button type="submit" class="secondary-button">Rechercher</button></form>
            ${registerFilterControl("amount-filter", "Montant", amountFilterLabel(), "Effacer le filtre de montant")}
            ${registerFilterControl("period-filter", "Période", periodFilterLabel(), "Effacer le filtre de période")}
            ${
              allAccounts
                ? ""
                : `<label class="filter-label"><span class="visually-hidden">Filtrer les opérations</span><select class="filter-button" id="transaction-filter">${Object.entries(
                    transactionFilters,
                  )
                    .map(
                      ([value, label]) =>
                        `<option value="${value}" ${transactionFilter === value ? "selected" : ""}>${label}</option>`,
                    )
                    .join("")}</select></label>`
            }</div></div>
          ${
            allAccounts
              ? renderSearchResults(searchRows)
              : `<div class="table-wrap"><table><thead><tr><th>DATE</th><th>RÉF. / N° CHÈQUE</th><th>TIERS / OPÉRATION</th><th>CATÉGORIE</th><th class="center">POINTÉ</th><th class="right">DÉBIT (€)</th><th class="right">CRÉDIT (€)</th><th class="right">SOLDE (€)</th><th></th></tr></thead><tbody>${
                  rows
                    .map(
                      (transaction) => `
            <tr data-transaction="${escapeHtml(transaction.id)}" tabindex="0" title="Appuyez sur Entrée pour modifier l’opération"><td class="date-cell">${dateLabel(transaction.date)}${transaction.bankDate && transaction.bankDate !== transaction.date ? `<small class="transaction-note">Banque · ${dateLabel(transaction.bankDate)}</small>` : ""}</td><td class="cheque-cell">${referenceCell(transaction.reference, transaction.cheque)}</td><td><strong class="transaction-label">${escapeHtml(transaction.label)}</strong>${transaction.note ? `<small class="transaction-note">${escapeHtml(transaction.note)}</small>` : ""}</td><td><span class="category-pill">${escapeHtml(transaction.category)}</span></td><td class="center"><button class="reconcile ${transaction.reconciled ? "done" : "pending"}" data-reconcile="${transaction.id}" aria-pressed="${transaction.reconciled}" aria-label="${transaction.reconciled ? "Dépointer l’opération" : "Pointer l’opération"}" title="${transaction.reconciled ? "Marquer comme non pointée" : "Pointer l’opération"}">${transaction.reconciled ? "P" : "·"}</button></td><td class="amount debit">${transaction.amount < 0 ? amountWithoutCurrency(Math.abs(transaction.amount)) : "—"}</td><td class="amount credit">${transaction.amount > 0 ? amountWithoutCurrency(transaction.amount) : "—"}</td><td class="amount running-balance">${amountWithoutCurrency(transaction.runningBalance)}</td><td><button type="button" class="row-delete" data-delete="${escapeHtml(transaction.id)}" title="Supprimer l’opération" aria-label="Supprimer ${escapeHtml(transaction.label)}">Supprimer</button></td></tr>`,
                    )
                    .join("") ||
                  `<tr><td colspan="9" class="empty-row">Aucune opération ne correspond à ce filtre.</td></tr>`
                }</tbody></table></div>`
          }
          <div class="table-footer"><span>${filteredCount ? `Opérations <strong>${start + 1}–${start + visibleCount}</strong> sur ${filteredCount}` : "Aucune opération"}${allAccounts ? "" : `${filteredCount !== totalCount ? ` · ${totalCount} au total` : ""} · Solde initial : <strong>${euro(selected.openingBalance)}</strong>`}</span><div class="pagination"><button id="previous-page" type="button" aria-label="Page précédente" ${page === 1 ? "disabled" : ""}>‹</button><form id="page-form"><label for="page-input">Page</label><input id="page-input" type="number" min="1" max="${pageCount}" value="${page}" required aria-label="Numéro de page"><span> / ${pageCount}</span><button type="submit" aria-label="Aller à la page">OK</button></form><button id="next-page" type="button" aria-label="Page suivante" ${page === pageCount ? "disabled" : ""}>›</button></div></div>
        </section>`
            : `
        <div class="page-heading"><div><h1>Mes comptes</h1><p>Ajoutez votre premier compte pour commencer à enregistrer vos opérations.</p></div>
          <div class="page-actions">
            <button type="button" class="primary-button" id="empty-add-account">Ajouter un compte</button>
            <button type="button" class="secondary-button" id="empty-import">Importer un fichier Money</button>
          </div>
        </div>`
        }
      </div>
    </main>
    ${renderAmountFilterDialog(allAccounts)}
    ${renderPeriodFilterDialog()}
    <dialog id="account-dialog"><form id="account-form"><div class="dialog-heading"><h2>Nouveau compte</h2><button type="button" class="dialog-close account-close" aria-label="Fermer">×</button></div><label>Nom du compte<input name="name" required maxlength="${TEXT_NAME_LIMIT}" placeholder="Ex. Compte courant"></label><label>Type de compte<select name="kind"><option>Compte courant</option><option>Épargne</option><option>Assurance vie</option></select></label><label>Établissement <span class="optional">(facultatif)</span><input name="bank" maxlength="${TEXT_NAME_LIMIT}" placeholder="Nom de la banque"></label><label>Numéro de compte <span class="optional">(facultatif)</span><input name="accountNumber" maxlength="${TEXT_NAME_LIMIT}"></label><label>Solde initial (€)<input name="balance" type="text" inputmode="decimal" value="0" required></label><p class="editor-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-button account-close">Annuler</button><button type="submit" class="primary-button">Créer le compte</button></div></form></dialog>
    ${
      selected
        ? `<dialog id="account-settings-dialog" aria-labelledby="account-settings-title">
      <form id="account-settings-form">
        <div class="dialog-heading"><h2 id="account-settings-title">Modifier le compte</h2><button type="button" class="dialog-close" aria-label="Fermer">×</button></div>
        <label>Nom du compte<input name="name" required maxlength="${TEXT_NAME_LIMIT}" value="${escapeHtml(selected.name)}"></label>
        <label>Établissement <span class="optional">(facultatif)</span><input name="bank" maxlength="${TEXT_NAME_LIMIT}" value="${escapeHtml(selected.bank)}"></label>
        <label>Numéro de compte <span class="optional">(facultatif)</span><input name="accountNumber" maxlength="${TEXT_NAME_LIMIT}" value="${escapeHtml(selected.accountNumber ?? "")}"></label>
        <label class="archive-account-control"><input name="archived" type="checkbox" aria-describedby="archive-account-help" ${selected.archived ? "checked" : ""}> Archiver le compte</label>
        <p id="archive-account-help">Le compte sera accessible depuis « Mes comptes », dans les comptes archivés.</p>
        <p class="editor-error" role="alert"></p>
        <div class="dialog-actions"><button type="submit" class="primary-button">Enregistrer</button></div>
      </form>
    </dialog>
    <dialog id="transaction-dialog"><form id="transaction-form"><div class="dialog-heading"><div><div class="eyebrow">${escapeHtml(selected.name)}</div><h2>Nouvelle opération</h2></div><button type="button" class="dialog-close" aria-label="Fermer">×</button></div><label>Type d’opération<select name="type"><option value="debit">Débit</option><option value="credit">Crédit</option><option value="transfer" ${accounts.length < 2 ? "disabled" : ""}>Virement entre mes comptes</option></select></label><div class="transaction-transfer-accounts" hidden><label>Compte débité<select name="sourceId" disabled>${accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`).join("")}</select></label><label>Compte crédité<select name="destinationId" disabled>${accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`).join("")}</select></label><label>Réf. / N° chèque du débit <span class="optional">(facultatif)</span><input name="debitReference" maxlength="${REFERENCE_LIMIT}" disabled></label><label>Réf. / N° chèque du crédit <span class="optional">(facultatif)</span><input name="creditReference" maxlength="${REFERENCE_LIMIT}" disabled></label></div><label class="transaction-payee">Tiers<input name="label" list="payee-suggestions" required maxlength="${TEXT_NAME_LIMIT}" placeholder="Ex. Marché du dimanche"><datalist id="payee-suggestions"></datalist></label><div class="form-row"><label>Date<input name="date" type="date" min="${MIN_CALENDAR_DATE}" required value="${localDate(new Date())}"></label><label>Montant (€)<input name="amount" type="text" inputmode="decimal" required placeholder="0,00"></label></div><div class="category-picker"><label>Catégorie<select name="category" required>${categoryOptions()}</select></label><button type="button" class="secondary-button add-category">+ Catégorie</button></div><label class="transaction-reference-field">Réf. / N° chèque <span class="optional">(facultatif)</span><input name="reference" maxlength="${REFERENCE_LIMIT}"></label><label>Commentaire <span class="optional">(facultatif)</span><textarea name="note" rows="2"></textarea></label><p class="editor-error transaction-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-button dialog-cancel">Annuler</button><button type="submit" class="primary-button">Ajouter l’opération</button></div></form></dialog>
    <dialog id="delete-transaction-dialog" aria-labelledby="delete-transaction-title"><div class="delete-confirmation"><h2 id="delete-transaction-title">Confirmer la suppression</h2><p class="delete-confirmation-message"></p><p class="editor-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-button delete-cancel" autofocus>Annuler</button><button type="button" class="primary-button delete-confirm">Supprimer</button></div></div></dialog>`
        : ""
    }`;

  document.querySelector<HTMLElement>(".sidebar-accounts")!.scrollTop = accountScroll;
  document.querySelectorAll<HTMLElement>("[data-account]").forEach((button) =>
    button.addEventListener("click", async () => {
      setSelectedAccount(accounts.find((account) => account.id === button.dataset.account)!);
      await refreshTransactions({ showRegister: true });
    }),
  );
  document.querySelector("#schedules-nav")?.addEventListener("click", renderSchedules);
  document.querySelector("#categories-nav")?.addEventListener("click", renderCategories);
  document.querySelector("#spending-nav")?.addEventListener("click", () => renderSpendingReport());
  document.querySelector("#household-breadcrumb")?.addEventListener("click", renderHousehold);
  document.querySelector("#household-nav")?.addEventListener("click", renderHousehold);
  document.querySelector("#accounts-breadcrumb")?.addEventListener("click", renderAccountsList);
  document.querySelector("#accounts-nav")?.addEventListener("click", renderAccountsList);
  if (selected) bindTransactionFilter();
  if (selected && !allAccounts) {
    const bankImport = document.querySelector<HTMLButtonElement>("#bank-import")!;
    bankImport.addEventListener("click", () => void openBankImport(selected, bankImport));
    bindReconciliation(selected.id);
    bindAccountSettings(selected);
    bindBalanceHistory();
    bindBalanceForecast();
    bindTransactionActions();
  }
  const accountDialog = document.querySelector<HTMLDialogElement>("#account-dialog")!;
  document
    .querySelectorAll(".add-account, #empty-add-account")
    .forEach((button) => button.addEventListener("click", () => accountDialog.showModal()));
  document
    .querySelector("#empty-import")
    ?.addEventListener("click", () => void runMenuAction("import"));
  document
    .querySelectorAll(".account-close")
    .forEach((button) => button.addEventListener("click", () => accountDialog.close()));
  document
    .querySelector<HTMLFormElement>("#account-form")
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const values = new FormData(form);
      const id = crypto.randomUUID();
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      submit.disabled = true;
      try {
        await invoke("create_account", {
          account: {
            id,
            name: String(values.get("name")).trim(),
            kind: String(values.get("kind")),
            bank: String(values.get("bank")).trim(),
            accountNumber: String(values.get("accountNumber")).trim() || null,
            openingBalance: parseCents(String(values.get("balance"))),
          },
        });
        setAccounts(await invoke<Account[]>("list_accounts", { today: localDate(new Date()) }));
        setSelectedAccount(accounts.find((account) => account.id === id)!);
        await refreshTransactions({ showRegister: true });
      } catch (error) {
        form.querySelector<HTMLElement>(".editor-error")!.textContent =
          `Création impossible : ${String(error)}`;
        submit.disabled = false;
      }
    });
}

// The breadcrumb leads to an overview; selecting a row opens its register.
export function renderAccountsList() {
  render();
  document.querySelector<HTMLElement>(".breadcrumb")!.innerHTML =
    '<button type="button" id="household-breadcrumb">Mon foyer</button> <span>/</span> <strong>Comptes</strong>';
  document.querySelector("#household-breadcrumb")?.addEventListener("click", renderHousehold);
  const groups: { kind: AccountKind; label: string }[] = [
    { kind: "Compte courant", label: "Comptes courants" },
    { kind: "Épargne", label: "Comptes d’épargne" },
    { kind: "Assurance vie", label: "Assurances vie" },
  ];
  const archived = accounts.filter((account) => account.archived);
  const active = accounts.filter((account) => !account.archived);
  const overviewRow = (account: Account) => {
    const { kind } = account;
    return `<button type="button" class="accounts-overview-row" data-open-account="${escapeHtml(account.id)}"><span class="account-icon ${kind === "Compte courant" ? "checking" : kind === "Épargne" ? "savings" : "insurance"}">${kind === "Compte courant" ? "↗" : kind === "Épargne" ? "◈" : "✳"}</span><span class="accounts-overview-name"><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.bank)}</small></span><strong class="accounts-overview-balance">${euro(account.currentBalance)}</strong><span class="accounts-overview-arrow" aria-hidden="true">›</span></button>`;
  };
  document.querySelector(".account-item.active")?.classList.remove("active");
  document.querySelector<HTMLElement>(".page-content")!.innerHTML =
    `<div class="page-heading"><div><div class="eyebrow">MON FOYER</div><h1>Mes comptes</h1><p>Consultez les soldes et ouvrez le registre d’un compte.</p></div><button type="button" class="primary-button" id="list-add-account"><span>+</span> Nouveau compte</button></div><section class="accounts-overview">${
      groups
        .map(({ kind, label }) => {
          const items = active.filter((account) => account.kind === kind);
          if (!items.length) return "";
          return `<div class="accounts-overview-group"><h2>${label} <span>${items.length}</span></h2>${items.map(overviewRow).join("")}</div>`;
        })
        .join("") || '<p class="accounts-overview-empty">Aucun compte actif.</p>'
    }</section>${archived.length ? `<details class="accounts-overview archived-accounts"><summary>Comptes archivés (${archived.length})</summary>${archived.map(overviewRow).join("")}</details>` : ""}`;
  document
    .querySelector("#list-add-account")
    ?.addEventListener("click", () =>
      document.querySelector<HTMLButtonElement>(".add-account")?.click(),
    );
  document.querySelectorAll<HTMLElement>("[data-open-account]").forEach((button) =>
    button.addEventListener("click", async () => {
      const account = accounts.find((item) => item.id === button.dataset.openAccount);
      if (!account) return;
      setSelectedAccount(account);
      await refreshTransactions({ showRegister: true });
    }),
  );
}

// Reload all domains after a successful switch; cancelled selections do nothing.
async function changeDatabase(useDefault: boolean, requestedPath?: string) {
  document.body.classList.add("database-switching");
  let switched = false;
  try {
    const path = useDefault
      ? (await invoke("use_default_database"), null)
      : requestedPath !== undefined
        ? (await invoke("open_database_path", { path: requestedPath }), requestedPath)
        : await invoke<string | null>("choose_database");
    if (!useDefault && path === null) return;
    switched = true;
    await reloadDatabase(path);
  } catch (error) {
    // Never leave stale account controls attached to a different database.
    if (switched) {
      const app = document.querySelector<HTMLElement>("#app")!;
      app.innerHTML =
        '<main class="database-fatal"><p role="alert"></p><button type="button" class="primary-button" id="restart-database">Redémarrer l’application</button></main>';
      app.querySelector("[role=alert]")!.textContent =
        `Base ouverte, mais chargement impossible : ${String(error)}.`;
      app
        .querySelector("#restart-database")!
        .addEventListener("click", () => window.location.reload());
      return;
    }
    const target = document.querySelector<HTMLElement>(".database-error");
    if (target) target.textContent = `Ouverture impossible : ${String(error)}`;
  } finally {
    document.body.classList.remove("database-switching");
  }
}

// External file requests share the same validation and error handling as the chooser.
export async function openRequestedDatabase(path: string) {
  await changeDatabase(false, path);
}

// Refresh all domains after importing into a newly created database.
export async function reloadDatabase(path: string | null) {
  activeDatabase = path;
  resetReconciliation();
  resetRegister();
  const [newAccounts, newSchedules, newCategories] = await Promise.all([
    invoke<Account[]>("list_accounts", { today: localDate(new Date()) }),
    invoke<Schedule[]>("list_schedules"),
    invoke<Category[]>("list_categories"),
  ]);
  setAccounts(newAccounts);
  setSchedules(newSchedules);
  setCategories(newCategories);
  await openInitialAccount();
}

export async function openInitialAccount() {
  const first = accounts.find((account) => !account.archived);
  setSelectedAccount(first);
  if (!first && accounts.length) {
    renderAccountsList();
  } else {
    await refreshTransactions({ strict: true, showRegister: true });
  }
}

async function backupDatabase() {
  const message = document.querySelector<HTMLElement>(".database-error")!;
  message.textContent = "";
  try {
    const path = await invoke<string | null>("backup_database");
    if (path) message.textContent = `Sauvegarde créée : ${path}`;
  } catch (error) {
    message.textContent = `Sauvegarde impossible : ${String(error)}`;
  }
}

async function restoreDatabase() {
  const message = document.querySelector<HTMLElement>(".database-error")!;
  message.textContent = "";
  let restored = false;
  try {
    const path = await invoke<string | null>("choose_restore_file");
    if (
      !path ||
      !(await confirmAction(
        "Confirmer la restauration",
        `Restaurer la sauvegarde « ${path} » dans ${activeDatabase ? `la base « ${activeDatabase} »` : "la base habituelle"} ? Les données actuelles de cette base seront remplacées.`,
        "Restaurer",
      ))
    )
      return;
    document.body.classList.add("database-switching");
    await invoke("restore_database", { path });
    restored = true;
    await reloadDatabase(activeDatabase);
    document.querySelector<HTMLElement>(".database-error")!.textContent = "Sauvegarde restaurée.";
  } catch (error) {
    if (restored) {
      document.querySelector<HTMLElement>("#app")!.textContent =
        `Base restaurée, mais actualisation impossible : ${String(error)}. Redémarrez l’application.`;
    } else message.textContent = `Restauration impossible : ${String(error)}`;
  } finally {
    document.body.classList.remove("database-switching");
  }
}

// Serialize menu workflows and ignore actions while a modal is already open.
let menuBusy = false;
export async function runMenuAction(action: string) {
  if (menuBusy || document.querySelector("dialog[open]")) return;
  menuBusy = true;
  try {
    switch (action) {
      case "open":
        await changeDatabase(false);
        break;
      case "default":
        if (activeDatabase) await changeDatabase(true);
        break;
      case "backup":
        await backupDatabase();
        break;
      case "restore":
        await restoreDatabase();
        break;
      case "import":
        await openMoneyImport();
        break;
      case "about":
        showAbout();
        break;
    }
  } finally {
    menuBusy = false;
  }
}
