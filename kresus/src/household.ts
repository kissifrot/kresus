import { accounts, schedules, setSelectedAccount } from "./state";
import type { Account, AccountKind } from "./types";
import { euro, escapeHtml } from "./format";
import { render, renderAccountsList } from "./accounts";
import { refreshTransactions } from "./transactions";
import { renderSchedules, renderOverdueSchedules } from "./schedules";

// Sum cents so the combined balances do not accumulate floating-point rounding.
function totalBalance(items: Account[]): number {
  return items.reduce((sum, account) => sum + account.currentBalance, 0);
}

export function renderHousehold() {
  render();
  document.querySelector("#household-nav")?.classList.add("selected");
  document.querySelector<HTMLElement>(".breadcrumb")!.innerHTML = "<strong>Mon foyer</strong>";
  document.querySelector(".account-item.active")?.classList.remove("active");
  const groups: { kind: AccountKind; label: string }[] = [
    { kind: "Compte courant", label: "Comptes courants" },
    { kind: "Épargne", label: "Épargne" },
    { kind: "Assurance vie", label: "Assurances vie" },
  ];
  // Display each series' next outstanding occurrence, including overdue ones.
  const upcoming = [...schedules]
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue) || a.label.localeCompare(b.label, "fr"))
    .slice(0, 5);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const overdueCount = schedules.filter((schedule) => schedule.nextDue < today).length;
  document.querySelector<HTMLElement>(".page-content")!.innerHTML =
    `<div class="page-heading"><div><div class="eyebrow">MON FOYER</div><h1>Vue d’ensemble</h1><p>Retrouvez les soldes actuels de tous vos comptes.</p></div><button type="button" class="secondary-button" id="household-accounts">Voir tous les comptes</button></div>
    <section class="summary-grid household-summary"><article class="summary-card balance-card"><div class="card-label">Total du foyer</div><strong>${euro(totalBalance(accounts))}</strong><small>${accounts.length} compte${accounts.length === 1 ? "" : "s"}</small><div class="balance-decoration">€</div></article>${groups
      .map(({ kind, label }) => {
        const items = accounts.filter((account) => account.kind === kind);
        return `<article class="summary-card"><div class="card-label">${label}</div><strong>${euro(totalBalance(items))}</strong><small>${items.length} compte${items.length === 1 ? "" : "s"}</small></article>`;
      })
      .join("")}</section>
    <section class="accounts-overview"><div class="household-list-heading"><h2>Soldes des comptes</h2></div>${accounts.map((account) => `<button type="button" class="accounts-overview-row" data-household-account="${escapeHtml(account.id)}"><span class="account-icon ${account.kind === "Compte courant" ? "checking" : account.kind === "Épargne" ? "savings" : "insurance"}">${account.kind === "Compte courant" ? "↗" : account.kind === "Épargne" ? "◈" : "✳"}</span><span class="accounts-overview-name"><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.kind)}${account.bank ? ` · ${escapeHtml(account.bank)}` : ""}</small></span><strong class="accounts-overview-balance">${euro(account.currentBalance)}</strong><span class="accounts-overview-arrow" aria-hidden="true">›</span></button>`).join("") || '<p class="accounts-overview-empty">Aucun compte disponible.</p>'}</section>
    <section class="accounts-overview household-schedules"><div class="household-schedules-heading"><div><h2>Prochaines échéances</h2><p>Les cinq prochaines échéances à enregistrer.</p>${overdueCount ? `<button type="button" id="household-overdue" class="household-overdue-link">${overdueCount} échéance${overdueCount === 1 ? "" : "s"} en retard</button>` : ""}</div><button type="button" class="secondary-button" id="household-schedules">Voir l’échéancier</button></div>${
      upcoming
        .map((schedule) => {
          const source = accounts.find((account) => account.id === schedule.accountId);
          const destination = accounts.find(
            (account) => account.id === schedule.destinationAccountId,
          );
          const date = new Intl.DateTimeFormat("fr-FR", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          }).format(new Date(`${schedule.nextDue}T12:00:00`));
          return `<div class="household-schedule-row"><time datetime="${escapeHtml(schedule.nextDue)}">${escapeHtml(date)}</time><span class="household-schedule-name"><strong>${escapeHtml(schedule.label)}</strong><small>${escapeHtml(source?.name ?? "Compte")}${schedule.kind === "transfer" ? ` → ${escapeHtml(destination?.name ?? "Compte")}` : ""}${schedule.nextDue < today ? ' · <span class="household-overdue">En retard</span>' : ""}</small></span><strong class="household-schedule-amount ${schedule.kind}">${schedule.kind === "credit" ? "+ " : schedule.kind === "transfer" ? "↔ " : "− "}${euro(Math.abs(schedule.amount))}</strong></div>`;
        })
        .join("") || '<p class="accounts-overview-empty">Aucune échéance à venir.</p>'
    }</section>`;
  document.querySelector("#household-accounts")?.addEventListener("click", renderAccountsList);
  document.querySelector("#household-schedules")?.addEventListener("click", renderSchedules);
  document.querySelector("#household-overdue")?.addEventListener("click", renderOverdueSchedules);
  document.querySelectorAll<HTMLElement>("[data-household-account]").forEach((button) =>
    button.addEventListener("click", async () => {
      const account = accounts.find((item) => item.id === button.dataset.householdAccount);
      if (!account) return;
      setSelectedAccount(account);
      await refreshTransactions();
    }),
  );
}
