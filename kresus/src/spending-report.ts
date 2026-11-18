import { invoke } from "@tauri-apps/api/core";
import { accounts, selectedAccount, setSelectedAccount } from "./state";
import type { Transaction } from "./types";
import { euro, escapeHtml, MIN_CALENDAR_DATE } from "./format";
import { render } from "./accounts";
import { refreshTransactions } from "./transactions";

type Period = { start: string; end: string };
const colors = [
  "#367d55",
  "#e49d6a",
  "#6d82ba",
  "#d2b157",
  "#a476a0",
  "#66a4a0",
  "#c77d78",
  "#86945a",
];

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function currentMonth(): Period {
  const today = new Date();
  return {
    start: localDate(new Date(today.getFullYear(), today.getMonth(), 1)),
    end: localDate(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
  };
}

// Aggregate in cents and exclude internal transfers from spending.
function spendingByCategory(entries: Transaction[], period: Period) {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    if (
      entry.amount >= 0 ||
      entry.transferId ||
      entry.date < period.start ||
      entry.date > period.end
    )
      continue;
    const parts = entry.splits?.length ? entry.splits : [entry];
    for (const part of parts) {
      const label = part.category.trim() || "Sans catégorie";
      totals.set(label, (totals.get(label) ?? 0) - part.amount);
    }
  }
  return [...totals]
    .filter(([, cents]) => cents !== 0)
    .map(([label, cents]) => ({ label, cents }))
    .sort((a, b) => b.cents - a.cents || a.label.localeCompare(b.label, "fr"));
}

export function renderSpendingReport(period: Period = currentMonth(), entries?: Transaction[]) {
  const accountId = selectedAccount?.id;
  if (accountId === undefined) return;
  render();
  document.querySelector(".nav-item.selected")?.classList.remove("selected");
  document.querySelector("#spending-nav")?.classList.add("selected");
  // Reports use the full history independently of the paginated register.
  if (!entries) {
    void invoke<Transaction[]>("list_transactions", { accountId })
      .then((loaded) => {
        if (selectedAccount?.id === accountId && document.querySelector("#spending-nav.selected"))
          renderSpendingReport(period, loaded);
      })
      .catch((error) => {
        const target = document.querySelector<HTMLElement>(".spending-error");
        if (target) target.textContent = `Impossible de charger les opérations : ${String(error)}`;
      });
  }
  const items = spendingByCategory(entries ?? [], period);
  const total = items.reduce((sum, item) => sum + item.cents, 0);
  const expenses = items.filter((item) => item.cents > 0);
  const chartTotal = expenses.reduce((sum, item) => sum + item.cents, 0);
  let offset = 0;
  const circles = expenses
    .map((item, index) => {
      const share = (item.cents / chartTotal) * 100;
      const circle = `<circle cx="90" cy="90" r="70" pathLength="100" fill="none" stroke="${colors[index % colors.length]}" stroke-width="28" stroke-dasharray="${share} ${100 - share}" stroke-dashoffset="${-offset}"></circle>`;
      offset += share;
      return circle;
    })
    .join("");
  document.querySelector<HTMLDivElement>(".page-content")!.innerHTML = `
    <div class="page-heading"><div><div class="eyebrow">ANALYSE</div><h1>Répartition des dépenses</h1><p>Visualisez les dépenses par catégorie pour un compte et une période.</p></div></div>
    <form id="spending-filter" class="spending-filter"><label>Compte<select name="account" required>${accounts.map((account) => `<option value="${escapeHtml(account.id)}" ${account.id === accountId ? "selected" : ""}>${escapeHtml(account.name)}</option>`).join("")}</select></label><label>Du<input type="date" min="${MIN_CALENDAR_DATE}" name="start" value="${period.start}" required></label><label>Au<input type="date" min="${MIN_CALENDAR_DATE}" name="end" value="${period.end}" required></label><button class="primary-button" type="submit" ${entries ? "" : "disabled"}>Afficher</button><p class="spending-error" role="alert"></p></form>
    <section class="spending-panel"><div class="spending-heading"><h2>Dépenses par catégorie</h2><p>Les virements entre vos comptes sont exclus.${chartTotal !== total ? " Le graphique montre les catégories dont les dépenses nettes sont positives." : ""}</p></div>${!entries ? '<p class="spending-empty">Chargement des opérations…</p>' : total === 0 ? '<p class="spending-empty">Aucune dépense pour cette période.</p>' : `<div class="spending-content"><div class="spending-chart"><svg viewBox="0 0 180 180" role="img" aria-label="Répartition des dépenses par catégorie ; détail dans la liste"><g transform="rotate(-90 90 90)">${circles}</g></svg><div class="spending-total"><span>Total</span><strong>${euro(total)}</strong></div></div><div class="spending-list" aria-label="Détail des dépenses par catégorie">${items.map((item, index) => `<div class="spending-row"><span class="spending-swatch" style="background:${colors[index % colors.length]}"></span><span class="spending-name">${escapeHtml(item.label)}</span><strong>${euro(item.cents)}</strong><span class="spending-percent">${item.cents > 0 ? `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format((item.cents / chartTotal) * 100)} %` : "—"}</span></div>`).join("")}</div></div>`}</section>`;

  const form = document.querySelector<HTMLFormElement>("#spending-filter")!;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const start = String(values.get("start"));
    const end = String(values.get("end"));
    const error = form.querySelector<HTMLElement>(".spending-error")!;
    if (!start || !end || start > end) {
      error.textContent =
        "Choisissez une période valide : la date de début doit précéder la date de fin.";
      return;
    }
    const account = accounts.find((item) => item.id === values.get("account"));
    if (!account) {
      error.textContent = "Compte introuvable.";
      return;
    }
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    button.disabled = true;
    try {
      const entries = await invoke<Transaction[]>("list_transactions", { accountId: account.id });
      if (!form.isConnected) return;
      setSelectedAccount(account);
      await refreshTransactions();
      if (form.isConnected) renderSpendingReport({ start, end }, entries);
    } catch (reason) {
      error.textContent = `Impossible de charger les opérations : ${String(reason)}`;
      button.disabled = false;
    }
  });
}
