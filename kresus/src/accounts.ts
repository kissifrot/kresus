import { invoke } from "@tauri-apps/api/core";
import type { Account, AccountKind, Schedule, Category } from "./types";
import {
  accounts,
  schedules,
  selectedAccount,
  setAccounts,
  setSelectedAccount,
  setSchedules,
  setCategories,
} from "./state";
import { euro, dateLabel, escapeHtml, parseCents, localDate } from "./format";
import {
  transactionFilter,
  transactionFilters,
  transactionSearch,
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
import { bindBalanceHistory } from "./balance-history";
import { confirmAction } from "./confirmation";
import { showAbout } from "./about";

let activeDatabase: string | null = null;

export function render() {
  // Keep the account list position when the interface is refreshed.
  const accountScroll = document.querySelector<HTMLElement>(".sidebar-accounts")?.scrollTop ?? 0;
  const {
    totalCount,
    unreconciledCount,
    balance,
    rows,
    filteredCount,
    pageCount,
    page,
    start,
    income,
    expenses,
    creditCount,
    debitCount,
  } = registerSummary();
  const accountList = (kind: AccountKind) =>
    accounts
      .filter((account) => account.kind === kind)
      .map(
        (account) => `
    <button class="account-item ${account.id === selectedAccount.id ? "active" : ""}" data-account="${account.id}">
      <span class="account-icon ${kind === "Compte courant" ? "checking" : kind === "Épargne" ? "savings" : "insurance"}">${kind === "Compte courant" ? "↗" : kind === "Épargne" ? "◈" : "✳"}</span>
      <span class="account-copy"><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.bank)}</small></span>
      <span class="account-balance">${euro(account.currentBalance)}</span>
    </button>`,
      )
      .join("");
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
      <div class="database-controls"><small title="${escapeHtml(activeDatabase ?? "Base habituelle")}">${activeDatabase ? escapeHtml(activeDatabase.split(/[\\/]/).pop() ?? activeDatabase) : "Base habituelle"}</small><p class="database-error" role="status"></p></div>
    </aside>
    <main class="main-area">
      <header class="topbar"><div class="breadcrumb"><button type="button" id="household-breadcrumb">Mon foyer</button> <span>/</span> <button type="button" id="accounts-breadcrumb">Comptes</button> <span>/</span> <strong>${escapeHtml(selectedAccount.name)}</strong></div></header>
      <div class="page-content">
        <div class="page-heading account-heading"><div><div class="eyebrow">${escapeHtml(selectedAccount.kind)} <span>·</span> ${escapeHtml(selectedAccount.bank)}</div><h1>${escapeHtml(selectedAccount.name)}</h1><p>Suivez les mouvements et rapprochez vos opérations bancaires.</p></div><div class="page-actions"><button type="button" class="secondary-button" id="balance-history-toggle" aria-expanded="false" aria-controls="balance-history">Historique du solde</button><button class="primary-button" id="new-transaction"><span>+</span> Nouvelle opération</button></div></div>
        <section class="summary-grid">
          <article class="summary-card balance-card${balance < 0 ? " negative-balance" : ""}"><div class="card-label">Solde du compte <span class="help">i</span></div><strong>${euro(balance)}</strong><small>Solde initial · ${euro(selectedAccount.openingBalance)}</small><div class="balance-decoration">€</div></article>
          <article class="summary-card"><div class="card-label">Entrées ce mois <span class="metric-icon positive">↙</span></div><strong><button type="button" id="filter-month-credit" aria-label="Afficher les entrées de ce mois">${euro(income)}</button></strong><small class="positive-text">${creditCount} opération${creditCount === 1 ? "" : "s"} créditrice${creditCount === 1 ? "" : "s"}</small></article>
          <article class="summary-card"><div class="card-label">Sorties ce mois <span class="metric-icon negative">↗</span></div><strong><button type="button" id="filter-month-debit" aria-label="Afficher les sorties de ce mois">${euro(Math.abs(expenses))}</button></strong><small>${debitCount} opération${debitCount === 1 ? "" : "s"} débitrice${debitCount === 1 ? "" : "s"}</small></article>
          <article class="summary-card reconciliation-card"><div class="card-label">À pointer</div><strong><button type="button" id="filter-unreconciled" aria-label="Afficher les ${unreconciledCount} opérations à pointer">${unreconciledCount} <em>opérations</em></button></strong><small><span class="status-dot"></span> Rapprochez vos relevés</small></article>
        </section>
        <section id="balance-history" class="balance-history" hidden></section>
        <p class="register-error" role="alert"></p><section class="transactions-panel">
          <div class="panel-heading"><div><h2>Historique des opérations</h2><p>${totalCount} opérations · Solde calculé à partir des mouvements</p></div><div class="panel-actions"><form id="transaction-search-form" role="search"><label class="visually-hidden" for="transaction-search">Rechercher une opération</label><input class="filter-button" type="search" id="transaction-search" placeholder="Libellé, catégorie…" title="Rechercher dans le libellé, la catégorie, le numéro de chèque ou le commentaire" value="${escapeHtml(transactionSearch)}"><button type="submit" class="secondary-button">Rechercher</button></form><label class="filter-label"><span class="visually-hidden">Filtrer les opérations</span><select class="filter-button" id="transaction-filter">${Object.entries(
            transactionFilters,
          )
            .map(
              ([value, label]) =>
                `<option value="${value}" ${transactionFilter === value ? "selected" : ""}>${label}</option>`,
            )
            .join("")}</select></label></div></div>
          <div class="table-wrap"><table><thead><tr><th>DATE</th><th>N° CHÈQUE</th><th>DESTINATAIRE / OPÉRATION</th><th>CATÉGORIE</th><th class="center">POINTÉ</th><th class="right">DÉBIT (€)</th><th class="right">CRÉDIT (€)</th><th class="right">SOLDE (€)</th><th></th></tr></thead><tbody>${
            rows
              .map(
                (transaction) => `
            <tr data-transaction="${escapeHtml(transaction.id)}" tabindex="0" title="Appuyez sur Entrée pour modifier l’opération"><td class="date-cell">${dateLabel(transaction.date)}</td><td class="cheque-cell">${transaction.cheque ?? "—"}</td><td><strong class="transaction-label">${escapeHtml(transaction.label)}</strong>${transaction.note ? `<small class="transaction-note">${escapeHtml(transaction.note)}</small>` : ""}</td><td><span class="category-pill">${escapeHtml(transaction.category)}</span></td><td class="center"><button class="reconcile ${transaction.reconciled ? "done" : "pending"}" data-reconcile="${transaction.id}" title="${transaction.reconciled ? "Marquer comme non pointée" : "Pointer l’opération"}">${transaction.reconciled ? "P" : "·"}</button></td><td class="amount debit">${transaction.amount < 0 ? euro(Math.abs(transaction.amount)) : "—"}</td><td class="amount credit">${transaction.amount > 0 ? euro(transaction.amount) : "—"}</td><td class="amount running-balance">${euro(transaction.runningBalance)}</td><td><button type="button" class="row-delete" data-delete="${escapeHtml(transaction.id)}" title="Supprimer l’opération" aria-label="Supprimer ${escapeHtml(transaction.label)}">Supprimer</button></td></tr>`,
              )
              .join("") ||
            `<tr><td colspan="9" class="empty-row">Aucune opération ne correspond à ce filtre.</td></tr>`
          }</tbody></table></div>
          <div class="table-footer"><span>${filteredCount ? `Opérations <strong>${start + 1}–${start + rows.length}</strong> sur ${filteredCount}` : "Aucune opération"}${filteredCount !== totalCount ? ` · ${totalCount} au total` : ""} · Solde initial : <strong>${euro(selectedAccount.openingBalance)}</strong></span><div class="pagination"><button id="previous-page" type="button" aria-label="Page précédente" ${page === 1 ? "disabled" : ""}>‹</button><form id="page-form"><label for="page-input">Page</label><input id="page-input" type="number" min="1" max="${pageCount}" value="${page}" required aria-label="Numéro de page"><span> / ${pageCount}</span><button type="submit" aria-label="Aller à la page">OK</button></form><button id="next-page" type="button" aria-label="Page suivante" ${page === pageCount ? "disabled" : ""}>›</button></div></div>
        </section>
      </div>
    </main>
    <dialog id="account-dialog"><form id="account-form"><div class="dialog-heading"><h2>Nouveau compte</h2><button type="button" class="dialog-close account-close" aria-label="Fermer">×</button></div><label>Nom du compte<input name="name" required maxlength="80" placeholder="Ex. Compte courant"></label><label>Type de compte<select name="kind"><option>Compte courant</option><option>Épargne</option><option>Assurance vie</option></select></label><label>Établissement <span class="optional">(facultatif)</span><input name="bank" maxlength="80" placeholder="Nom de la banque"></label><label>Solde initial (€)<input name="balance" type="text" inputmode="decimal" value="0" required></label><p class="editor-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-button account-close">Annuler</button><button type="submit" class="primary-button">Créer le compte</button></div></form></dialog>
    <dialog id="transaction-dialog"><form id="transaction-form"><div class="dialog-heading"><div><div class="eyebrow">${escapeHtml(selectedAccount.name)}</div><h2>Nouvelle opération</h2></div><button type="button" class="dialog-close" aria-label="Fermer">×</button></div><label>Type d’opération<select name="type"><option value="debit">Débit</option><option value="credit">Crédit</option><option value="transfer" ${accounts.length < 2 ? "disabled" : ""}>Virement entre mes comptes</option></select></label><div class="transaction-transfer-accounts" hidden><label>Compte débité<select name="sourceId" disabled>${accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`).join("")}</select></label><label>Compte crédité<select name="destinationId" disabled>${accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`).join("")}</select></label></div><label class="transaction-payee">Destinataire / libellé<input name="label" list="payee-suggestions" required maxlength="80" placeholder="Ex. Marché du dimanche"><datalist id="payee-suggestions"></datalist></label><div class="form-row"><label>Date<input name="date" type="date" required value="${localDate(new Date())}"></label><label>Montant (€)<input name="amount" type="text" inputmode="decimal" required placeholder="0,00"></label></div><label>Catégorie<select name="category" required>${categoryOptions()}</select></label><label class="transaction-cheque">Numéro de chèque <span class="optional">(facultatif)</span><input name="cheque" inputmode="numeric" pattern="[0-9]{7}" maxlength="7" placeholder="7 chiffres"></label><label>Commentaire <span class="optional">(facultatif)</span><textarea name="note" rows="2"></textarea></label><p class="editor-error transaction-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-button dialog-cancel">Annuler</button><button type="submit" class="primary-button">Ajouter l’opération</button></div></form></dialog>
    <dialog id="delete-transaction-dialog" aria-labelledby="delete-transaction-title"><div class="delete-confirmation"><h2 id="delete-transaction-title">Confirmer la suppression</h2><p class="delete-confirmation-message"></p><p class="editor-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-button delete-cancel" autofocus>Annuler</button><button type="button" class="primary-button delete-confirm">Supprimer</button></div></div></dialog>`;

  document.querySelector<HTMLElement>(".sidebar-accounts")!.scrollTop = accountScroll;
  document.querySelectorAll<HTMLElement>("[data-account]").forEach((button) =>
    button.addEventListener("click", async () => {
      setSelectedAccount(accounts.find((account) => account.id === button.dataset.account)!);
      await refreshTransactions();
    }),
  );
  document.querySelector("#schedules-nav")?.addEventListener("click", renderSchedules);
  document.querySelector("#categories-nav")?.addEventListener("click", renderCategories);
  document.querySelector("#spending-nav")?.addEventListener("click", () => renderSpendingReport());
  document.querySelector("#household-breadcrumb")?.addEventListener("click", renderHousehold);
  document.querySelector("#household-nav")?.addEventListener("click", renderHousehold);
  document.querySelector("#accounts-breadcrumb")?.addEventListener("click", renderAccountsList);
  bindTransactionFilter();
  const accountDialog = document.querySelector<HTMLDialogElement>("#account-dialog")!;
  document
    .querySelector(".add-account")
    ?.addEventListener("click", () => accountDialog.showModal());
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
            openingBalance: parseCents(String(values.get("balance"))),
          },
        });
        setAccounts(await invoke<Account[]>("list_accounts"));
        setSelectedAccount(accounts.find((account) => account.id === id)!);
        await refreshTransactions();
      } catch (error) {
        form.querySelector<HTMLElement>(".editor-error")!.textContent =
          `Création impossible : ${String(error)}`;
        submit.disabled = false;
      }
    });
  bindBalanceHistory();
  bindTransactionActions();
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
  document.querySelector<HTMLElement>(".page-content")!.innerHTML =
    `<div class="page-heading"><div><div class="eyebrow">MON FOYER</div><h1>Mes comptes</h1><p>Consultez les soldes et ouvrez le registre d’un compte.</p></div><button type="button" class="primary-button" id="list-add-account"><span>+</span> Nouveau compte</button></div><section class="accounts-overview">${
      groups
        .map(({ kind, label }) => {
          const items = accounts.filter((account) => account.kind === kind);
          if (!items.length) return "";
          return `<div class="accounts-overview-group"><h2>${label} <span>${items.length}</span></h2>${items.map((account) => `<button type="button" class="accounts-overview-row" data-open-account="${escapeHtml(account.id)}"><span class="account-icon ${kind === "Compte courant" ? "checking" : kind === "Épargne" ? "savings" : "insurance"}">${kind === "Compte courant" ? "↗" : kind === "Épargne" ? "◈" : "✳"}</span><span class="accounts-overview-name"><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.bank)}</small></span><strong class="accounts-overview-balance">${euro(account.currentBalance)}</strong><span class="accounts-overview-arrow" aria-hidden="true">›</span></button>`).join("")}</div>`;
        })
        .join("") || '<p class="accounts-overview-empty">Aucun compte disponible.</p>'
    }</section>`;
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
      await refreshTransactions();
    }),
  );
}

// Reload all domains after a successful switch; cancelled selections do nothing.
async function changeDatabase(useDefault: boolean) {
  document.body.classList.add("database-switching");
  let switched = false;
  try {
    const path = useDefault
      ? (await invoke("use_default_database"), null)
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

// Refresh all domains after importing into a newly created database.
export async function reloadDatabase(path: string | null) {
  activeDatabase = path;
  resetRegister();
  const [newAccounts, newSchedules, newCategories] = await Promise.all([
    invoke<Account[]>("list_accounts"),
    invoke<Schedule[]>("list_schedules"),
    invoke<Category[]>("list_categories"),
  ]);
  if (!newAccounts.length) throw new Error("La base ne contient aucun compte.");
  setAccounts(newAccounts);
  setSelectedAccount(newAccounts[0]!);
  setSchedules(newSchedules);
  setCategories(newCategories);
  await refreshTransactions(true);
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
