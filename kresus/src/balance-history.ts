import { invoke } from "@tauri-apps/api/core";
import { euro, escapeHtml, localDate } from "./format";
import { selectedAccount } from "./state";

type BalancePoint = { date: string; balance: number };

// Aggregate operations by day to keep the graph independent of register pagination.
export function bindBalanceHistory() {
  const button = document.querySelector<HTMLButtonElement>("#balance-history-toggle")!;
  const panel = document.querySelector<HTMLElement>("#balance-history")!;
  button.addEventListener("click", async () => {
    const open = panel.hidden;
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? "Masquer l’historique" : "Historique du solde";
    if (!open || panel.dataset.loaded === "true") return;
    const accountId = selectedAccount.id;
    panel.innerHTML = '<p class="balance-history-message">Chargement…</p>';
    try {
      const points = await invoke<BalancePoint[]>("balance_history", {
        accountId,
        today: localDate(new Date()),
      });
      if (!panel.isConnected || selectedAccount.id !== accountId) return;
      if (points.length < 2) throw new Error("Historique incomplet.");
      const values = points.map((point) => point.balance);
      const low = Math.min(...values),
        high = Math.max(...values);
      const span = high - low || 1;
      const last = points[points.length - 1]!;
      const firstTime = Date.parse(`${points[0]!.date}T00:00:00Z`);
      const duration = Date.parse(`${last.date}T00:00:00Z`) - firstTime;
      const x = (index: number) =>
        16 + ((Date.parse(`${points[index]!.date}T00:00:00Z`) - firstTime) / duration) * 568;
      const y = (balance: number) => (high === low ? 70 : 116 - ((balance - low) / span) * 92);
      const path = points
        .map((point, index) =>
          index === 0
            ? `M ${x(index).toFixed(1)} ${y(point.balance).toFixed(1)}`
            : `H ${x(index).toFixed(1)} V ${y(point.balance).toFixed(1)}`,
        )
        .join(" ");
      const date = (value: string) =>
        new Intl.DateTimeFormat("fr-FR", {
          day: "numeric",
          month: "short",
          year: "numeric",
        }).format(new Date(`${value}T12:00:00`));
      panel.innerHTML = `<div class="balance-history-heading"><div><h2>Évolution du solde</h2><p>Opérations jusqu’au ${escapeHtml(new Intl.DateTimeFormat("fr-FR").format(new Date(`${last.date}T12:00:00`)))}</p></div><strong>${euro(last.balance)}</strong></div>
        <div class="balance-history-chart"><div class="balance-history-axis"><span>${euro(high)}</span><span>${euro(low)}</span></div><div class="balance-history-plot"><svg viewBox="0 0 600 132" preserveAspectRatio="none" role="img" aria-label="Évolution quotidienne du solde du compte"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2.5" vector-effect="non-scaling-stroke"/>${points.map((point, index) => `<circle cx="${x(index).toFixed(1)}" cy="${y(point.balance).toFixed(1)}" r="4" fill="${index === points.length - 1 ? "currentColor" : "transparent"}"><title>${escapeHtml(date(point.date))} : ${escapeHtml(euro(point.balance))}</title></circle>`).join("")}</svg><div class="balance-history-dates"><span>${escapeHtml(date(points[0]!.date))}</span><span>${escapeHtml(date(last.date))}</span></div></div></div>`;
      panel.dataset.loaded = "true";
    } catch (error) {
      if (panel.isConnected)
        panel.innerHTML = `<p class="balance-history-message" role="alert">Impossible de charger l’historique : ${escapeHtml(String(error))}</p>`;
    }
  });
}
