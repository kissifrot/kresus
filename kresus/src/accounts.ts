import { invoke } from "@tauri-apps/api/core";
import type { Account, AccountKind, Schedule, Category } from "./types";
import { accounts, schedules, selectedAccount, setAccounts, setSelectedAccount, setSchedules, setCategories } from "./state";
import { euro, dateLabel, escapeHtml, parseCents } from "./format";
import { transactionFilter, transactionFilters, registerSummary, bindTransactionActions, bindTransactionFilter, refreshTransactions, resetRegister } from "./transactions";
import { renderSchedules } from "./schedules";
import { categoryOptions, renderCategories } from "./categories";
import { transferDialog, bindTransferActions } from "./transfers";
import { renderSpendingReport } from "./spending-report";
import { renderHousehold } from "./household";

let activeDatabase: string | null = null;

export function render() {
  // Keep the account list position when the interface is refreshed.
  const accountScroll = document.querySelector<HTMLElement>(".sidebar-accounts")?.scrollTop ?? 0;
  const { totalCount, unreconciledCount, balance, rows, filteredCount, pageCount, page, start, income, expenses, creditCount, debitCount } = registerSummary();
  const accountList = (kind: AccountKind) => accounts.filter((account) => account.kind === kind).map((account) => `
    <button class="account-item ${account.id === selectedAccount.id ? "active" : ""}" data-account="${account.id}">
      <span class="account-icon ${kind === "Compte courant" ? "checking" : kind === "Épargne" ? "savings" : "insurance"}">${kind === "Compte courant" ? "↗" : kind === "Épargne" ? "◈" : "✳"}</span>
      <span class="account-copy"><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.bank)}</small></span>
      <span class="account-balance">${euro(account.currentBalance)}</span>
    </button>`).join("");
  document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">k</div><div><strong>kresus</strong><span>FINANCES FAMILIALES</span></div></div>
      <button class="nav-item" id="household-nav"><span>▦</span> Vue d’ensemble</button>
      <button class="nav-item" id="schedules-nav"><span>◷</span> Échéances <i>${schedules.length}</i></button>
      <button class="nav-item" id="categories-nav"><span>▤</span> Catégories</button>
      <button class="nav-item" id="spending-nav"><span>◔</span> Répartition des dépenses</button>
      <div class="sidebar-divider"></div>
      <div class="section-heading">MES COMPTES <button class="add-account" title="Ajouter un compte">+</button></div>
      <div class="sidebar-accounts" aria-label="Liste des comptes">
      <div class="account-group"><div class="group-label">COURANTS <span>${accounts.filter((account) => account.kind === "Compte courant").length}</span></div>${accountList("Compte courant")}</div>
      <div class="account-group"><div class="group-label">ÉPARGNE <span>${accounts.filter((account) => account.kind === "Épargne").length}</span></div>${accountList("Épargne")}</div>
      <div class="account-group"><div class="group-label">ASSURANCE VIE <span>${accounts.filter((account) => account.kind === "Assurance vie").length}</span></div>${accountList("Assurance vie")}</div>
      </div>
      <div class="database-controls"><small title="${escapeHtml(activeDatabase ?? "Base habituelle")}">${activeDatabase ? escapeHtml(activeDatabase.split(/[\\/]/).pop() ?? activeDatabase) : "Base habituelle"}</small><button type="button" id="choose-database">Ouvrir une base…</button>${activeDatabase ? '<button type="button" id="default-database">Revenir à la base habituelle</button>' : ""}<p class="database-error" role="alert"></p></div><div class="sidebar-bottom"><span class="avatar">M</span><span><strong>Michel &amp; Sylvie</strong><small>Foyer familial</small></span><button class="more">···</button></div>
    </aside>
    <main class="main-area">
      <header class="topbar"><div class="breadcrumb"><button type="button" id="household-breadcrumb">Mon foyer</button> <span>/</span> <button type="button" id="accounts-breadcrumb">Comptes</button> <span>/</span> <strong>${escapeHtml(selectedAccount.name)}</strong></div><div class="top-actions"><span class="updated"><i></i> Mis à jour à l’instant</span><button class="icon-button" aria-label="Notifications">♧</button><button class="avatar small">M</button></div></header>
      <div class="page-content">
        <div class="page-heading"><div><div class="eyebrow">${escapeHtml(selectedAccount.kind)} <span>·</span> ${escapeHtml(selectedAccount.bank)}</div><h1>${escapeHtml(selectedAccount.name)}</h1><p>Suivez les mouvements et rapprochez vos opérations bancaires.</p></div><div class="page-actions"><button class="secondary-button" id="new-transfer" ${accounts.length < 2 ? "disabled title=\"Deux comptes sont nécessaires\"" : ""}>Virement</button><button class="primary-button" id="new-transaction"><span>+</span> Nouvelle opération</button></div></div>
        <section class="summary-grid">
          <article class="summary-card balance-card"><div class="card-label">Solde du compte <span class="help">i</span></div><strong>${euro(balance)}</strong><small>Solde initial · ${euro(selectedAccount.openingBalance)}</small><div class="balance-decoration">€</div></article>
          <article class="summary-card"><div class="card-label">Entrées ce mois <span class="metric-icon positive">↙</span></div><strong>${euro(income)}</strong><small class="positive-text">${creditCount} opération${creditCount === 1 ? "" : "s"} créditrice${creditCount === 1 ? "" : "s"}</small></article>
          <article class="summary-card"><div class="card-label">Sorties ce mois <span class="metric-icon negative">↗</span></div><strong>${euro(Math.abs(expenses))}</strong><small>${debitCount} opération${debitCount === 1 ? "" : "s"} débitrice${debitCount === 1 ? "" : "s"}</small></article>
          <article class="summary-card reconciliation-card"><div class="card-label">À pointer</div><strong>${unreconciledCount} <em>opérations</em></strong><small><span class="status-dot"></span> Rapprochez vos relevés</small></article>
        </section>
        <p class="register-error" role="alert"></p><section class="transactions-panel">
          <div class="panel-heading"><div><h2>Historique des opérations</h2><p>${totalCount} opérations · Solde calculé à partir des mouvements</p></div><div class="panel-actions"><label class="filter-label"><span class="visually-hidden">Filtrer les opérations</span><select class="filter-button" id="transaction-filter">${Object.entries(transactionFilters).map(([value, label]) => `<option value="${value}" ${transactionFilter === value ? "selected" : ""}>${label}</option>`).join("")}</select></label></div></div>
          <div class="table-wrap"><table><thead><tr><th class="check-col"><input type="checkbox" aria-label="Tout sélectionner"></th><th>DATE</th><th>N° CHÈQUE</th><th>DESTINATAIRE / OPÉRATION</th><th>CATÉGORIE</th><th class="center">POINTÉ</th><th class="right">DÉBIT (€)</th><th class="right">CRÉDIT (€)</th><th class="right">SOLDE (€)</th><th></th></tr></thead><tbody>${rows.map((transaction) => `
            <tr data-transaction="${transaction.id}"><td class="check-col"><input type="checkbox" aria-label="Sélectionner ${escapeHtml(transaction.label)}"></td><td class="date-cell">${dateLabel(transaction.date)}</td><td class="cheque-cell">${transaction.cheque ?? "—"}</td><td><strong class="transaction-label">${escapeHtml(transaction.label)}</strong>${transaction.note ? `<small class="transaction-note">${escapeHtml(transaction.note)}</small>` : ""}</td><td><span class="category-pill">${escapeHtml(transaction.category)}</span></td><td class="center"><button class="reconcile ${transaction.reconciled ? "done" : "pending"}" data-reconcile="${transaction.id}" title="${transaction.reconciled ? "Marquer comme non pointée" : "Pointer l’opération"}">${transaction.reconciled ? "P" : "·"}</button></td><td class="amount debit">${transaction.amount < 0 ? euro(Math.abs(transaction.amount)) : "—"}</td><td class="amount credit">${transaction.amount > 0 ? euro(transaction.amount) : "—"}</td><td class="amount running-balance">${euro(transaction.runningBalance)}</td><td><button class="row-menu" data-delete="${transaction.id}" title="Supprimer">···</button></td></tr>`).join("") || `<tr><td colspan="10" class="empty-row">Aucune opération ne correspond à ce filtre.</td></tr>`}</tbody></table></div>
          <div class="table-footer"><span>${filteredCount ? `Opérations <strong>${start + 1}–${start + rows.length}</strong> sur ${filteredCount}` : "Aucune opération"}${filteredCount !== totalCount ? ` · ${totalCount} au total` : ""} · Solde initial : <strong>${euro(selectedAccount.openingBalance)}</strong></span><div class="pagination"><button id="previous-page" type="button" aria-label="Page précédente" ${page === 1 ? "disabled" : ""}>‹</button><form id="page-form"><label for="page-input">Page</label><input id="page-input" type="number" min="1" max="${pageCount}" value="${page}" required aria-label="Numéro de page"><span> / ${pageCount}</span><button type="submit" aria-label="Aller à la page">OK</button></form><button id="next-page" type="button" aria-label="Page suivante" ${page === pageCount ? "disabled" : ""}>›</button></div></div>
        </section>
      </div>
    </main>
    <dialog id="account-dialog"><form id="account-form"><div class="dialog-heading"><h2>Nouveau compte</h2><button type="button" class="dialog-close account-close" aria-label="Fermer">×</button></div><label>Nom du compte<input name="name" required maxlength="80" placeholder="Ex. Compte courant"></label><label>Type de compte<select name="kind"><option>Compte courant</option><option>Épargne</option><option>Assurance vie</option></select></label><label>Établissement <span class="optional">(facultatif)</span><input name="bank" maxlength="80" placeholder="Nom de la banque"></label><label>Solde initial (€)<input name="balance" type="number" step="0.01" min="-1000000000" max="1000000000" value="0" required></label><p class="editor-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-button account-close">Annuler</button><button type="submit" class="primary-button">Créer le compte</button></div></form></dialog>
    <dialog id="transaction-dialog"><form id="transaction-form"><div class="dialog-heading"><div><div class="eyebrow">${escapeHtml(selectedAccount.name)}</div><h2>Nouvelle opération</h2></div><button type="button" class="dialog-close" aria-label="Fermer">×</button></div><label>Type d’opération<select name="type"><option value="debit">Débit</option><option value="credit">Crédit</option></select></label><label>Destinataire / libellé<input name="label" list="payee-suggestions" required maxlength="80" placeholder="Ex. Marché du dimanche"><datalist id="payee-suggestions"></datalist></label><div class="form-row"><label>Date<input name="date" type="date" required value="${new Date().toISOString().slice(0, 10)}"></label><label>Montant (€)<input name="amount" type="number" min="0.01" step="0.01" required placeholder="0,00"></label></div><label>Catégorie<select name="category" required>${categoryOptions()}</select></label><label>Numéro de chèque <span class="optional">(facultatif)</span><input name="cheque" inputmode="numeric" pattern="[0-9]{7}" maxlength="7" placeholder="7 chiffres"></label><p class="editor-error transaction-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-button dialog-cancel">Annuler</button><button type="submit" class="primary-button">Ajouter l’opération</button></div></form></dialog>${transferDialog()}`;

  document.querySelector<HTMLElement>(".sidebar-accounts")!.scrollTop = accountScroll;
  document.querySelectorAll<HTMLElement>("[data-account]").forEach((button) => button.addEventListener("click", async () => {
    setSelectedAccount(accounts.find((account) => account.id === button.dataset.account)!);
    await refreshTransactions();
  }));
  document.querySelector("#schedules-nav")?.addEventListener("click", renderSchedules);
  document.querySelector("#categories-nav")?.addEventListener("click", renderCategories);
  document.querySelector("#spending-nav")?.addEventListener("click", () => renderSpendingReport());
  document.querySelector("#household-breadcrumb")?.addEventListener("click", renderHousehold);
  document.querySelector("#household-nav")?.addEventListener("click", renderHousehold);
  document.querySelector("#accounts-breadcrumb")?.addEventListener("click", renderAccountsList);
  document.querySelector("#choose-database")?.addEventListener("click", () => void changeDatabase(false));
  document.querySelector("#default-database")?.addEventListener("click", () => void changeDatabase(true));
  bindTransactionFilter();
  const accountDialog = document.querySelector<HTMLDialogElement>("#account-dialog")!;
  document.querySelector(".add-account")?.addEventListener("click", () => accountDialog.showModal());
  document.querySelectorAll(".account-close").forEach((button) => button.addEventListener("click", () => accountDialog.close()));
  document.querySelector<HTMLFormElement>("#account-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form);
    const id = crypto.randomUUID();
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submit.disabled = true;
    try {
      await invoke("create_account", { account: { id, name: String(values.get("name")).trim(), kind: String(values.get("kind")), bank: String(values.get("bank")).trim(), openingBalance: parseCents(String(values.get("balance"))) } });
      setAccounts(await invoke<Account[]>("list_accounts"));
      setSelectedAccount(accounts.find((account) => account.id === id)!);
      await refreshTransactions();
    } catch (error) {
      form.querySelector<HTMLElement>(".editor-error")!.textContent = `Création impossible : ${String(error)}`;
      submit.disabled = false;
    }
  });
  bindTransactionActions();
  bindTransferActions();
}

// The breadcrumb leads to an overview; selecting a row opens its register.
export function renderAccountsList() {
  render();
  document.querySelector<HTMLElement>(".breadcrumb")!.innerHTML = '<button type="button" id="household-breadcrumb">Mon foyer</button> <span>/</span> <strong>Comptes</strong>';
  document.querySelector("#household-breadcrumb")?.addEventListener("click", renderHousehold);
  const groups: { kind: AccountKind; label: string }[] = [
    { kind: "Compte courant", label: "Comptes courants" },
    { kind: "Épargne", label: "Comptes d’épargne" },
    { kind: "Assurance vie", label: "Assurances vie" },
  ];
  document.querySelector<HTMLElement>(".page-content")!.innerHTML = `<div class="page-heading"><div><div class="eyebrow">MON FOYER</div><h1>Mes comptes</h1><p>Consultez les soldes et ouvrez le registre d’un compte.</p></div><button type="button" class="primary-button" id="list-add-account"><span>+</span> Nouveau compte</button></div><section class="accounts-overview">${groups.map(({ kind, label }) => {
    const items = accounts.filter((account) => account.kind === kind);
    if (!items.length) return "";
    return `<div class="accounts-overview-group"><h2>${label} <span>${items.length}</span></h2>${items.map((account) => `<button type="button" class="accounts-overview-row" data-open-account="${escapeHtml(account.id)}"><span class="account-icon ${kind === "Compte courant" ? "checking" : kind === "Épargne" ? "savings" : "insurance"}">${kind === "Compte courant" ? "↗" : kind === "Épargne" ? "◈" : "✳"}</span><span class="accounts-overview-name"><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.bank)}</small></span><strong class="accounts-overview-balance">${euro(account.currentBalance)}</strong><span class="accounts-overview-arrow" aria-hidden="true">›</span></button>`).join("")}</div>`;
  }).join("") || '<p class="accounts-overview-empty">Aucun compte disponible.</p>'}</section>`;
  document.querySelector("#list-add-account")?.addEventListener("click", () => document.querySelector<HTMLButtonElement>(".add-account")?.click());
  document.querySelectorAll<HTMLElement>("[data-open-account]").forEach((button) => button.addEventListener("click", async () => {
    const account = accounts.find((item) => item.id === button.dataset.openAccount);
    if (!account) return;
    setSelectedAccount(account);
    await refreshTransactions();
  }));
}

// Reload all domains after a successful switch; cancelled selections do nothing.
async function changeDatabase(useDefault: boolean) {
  const buttons = document.querySelectorAll<HTMLButtonElement>("#choose-database, #default-database");
  buttons.forEach((button) => button.disabled = true);
  document.body.classList.add("database-switching");
  let switched = false;
  try {
    const path = useDefault ? (await invoke("use_default_database"), null) : await invoke<string | null>("choose_database");
    if (!useDefault && path === null) return;
    switched = true;
    activeDatabase = path;
    resetRegister();
    const [newAccounts, newSchedules, newCategories] = await Promise.all([invoke<Account[]>("list_accounts"), invoke<Schedule[]>("list_schedules"), invoke<Category[]>("list_categories")]);
    if (!newAccounts.length) throw new Error("La base ne contient aucun compte.");
    setAccounts(newAccounts); setSelectedAccount(newAccounts[0]); setSchedules(newSchedules); setCategories(newCategories);
    await refreshTransactions(true);
  } catch (error) {
    // Never leave stale account controls attached to a different database.
    if (switched) {
      const app = document.querySelector<HTMLElement>("#app")!;
      app.innerHTML = '<main class="database-fatal"><p role="alert"></p><button type="button" class="primary-button" id="restart-database">Redémarrer l’application</button></main>';
      app.querySelector("[role=alert]")!.textContent = `Base ouverte, mais chargement impossible : ${String(error)}.`;
      app.querySelector("#restart-database")!.addEventListener("click", () => window.location.reload());
      return;
    }
    const target = document.querySelector<HTMLElement>(".database-error");
    if (target) target.textContent = `Ouverture impossible : ${String(error)}`;
  } finally { document.body.classList.remove("database-switching"); buttons.forEach((button) => button.disabled = false); }
}
