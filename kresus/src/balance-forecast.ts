import { invoke } from "@tauri-apps/api/core";
import { euro, escapeHtml, localDate } from "./format";
import { occurrencesForMonth } from "./schedule-occurrences";
import { schedules, selectedAccount } from "./state";
import type { Schedule } from "./types";

type Movement = { date: string; label: string; amount: number; overdue?: boolean; source?: string };
type Point = { date: string; balance: number; movements: Movement[] };

// Clamp the same day three months later, including end-of-month and leap years.
export function forecastEnd(today: string): string {
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(year, month - 1 + 3, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, last));
  return first.toISOString().slice(0, 10);
}

// Keep overdue occurrences on the opening day without losing their original dates.
export function calculateForecast(
  accountId: string,
  today: string,
  balance: number,
  operations: Movement[],
  items: Schedule[],
): Point[] {
  const end = forecastEnd(today);
  const movements: Movement[] = operations
    .filter((item) => item.date > today && item.date <= end)
    .map((item) => ({ ...item, source: "Opération prévue" }));
  for (const schedule of items) {
    const firstDate = [
      schedule.nextDue,
      schedule.series.nextDue,
      ...(schedule.futureOverrides ?? []).map((item) => item.nextDue),
    ].sort()[0]!;
    const cursor = new Date(`${firstDate.slice(0, 7)}-01T00:00:00Z`);
    while (cursor.toISOString().slice(0, 7) <= end.slice(0, 7)) {
      const month = cursor.toISOString().slice(0, 7);
      for (const occurrence of occurrencesForMonth(schedule, month)) {
        if (occurrence.nextDue > end) continue;
        const amount =
          occurrence.accountId === accountId
            ? occurrence.amount
            : occurrence.kind === "transfer" && occurrence.destinationAccountId === accountId
              ? -occurrence.amount
              : 0;
        if (amount !== 0)
          movements.push({
            date: occurrence.nextDue,
            label: occurrence.label,
            amount,
            overdue: occurrence.nextDue < today,
            source: "Échéance",
          });
      }
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  movements.sort((a, b) => a.date.localeCompare(b.date));
  const grouped = new Map<string, Movement[]>();
  for (const item of movements) {
    const date = item.date < today ? today : item.date;
    grouped.set(date, [...(grouped.get(date) ?? []), item]);
  }
  const points: Point[] = [{ date: today, balance, movements: [] }];
  for (const [date, entries] of grouped) {
    balance += entries.reduce((sum, entry) => sum + entry.amount, 0);
    points.push({ date, balance, movements: entries });
  }
  if (points[points.length - 1]!.date < end) points.push({ date: end, balance, movements: [] });
  return points;
}

const displayDate = (date: string) =>
  new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" }).format(
    new Date(`${date}T12:00:00`),
  );

export function bindBalanceForecast() {
  const button = document.querySelector<HTMLButtonElement>("#balance-forecast-toggle")!;
  const panel = document.querySelector<HTMLElement>("#balance-forecast")!;
  button.addEventListener("click", async () => {
    const open = panel.hidden;
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? "Masquer la prévision" : "Prévision du solde";
    if (!open || panel.dataset.loaded === "true") return;
    const accountId = selectedAccount.id;
    const today = localDate(new Date());
    panel.innerHTML = '<p class="balance-history-message">Chargement…</p>';
    try {
      const data = await invoke<{ balance: number; transactions: Movement[] }>(
        "forecast_transactions",
        { accountId, today, end: forecastEnd(today) },
      );
      if (!panel.isConnected || selectedAccount.id !== accountId) return;
      const points = calculateForecast(
        accountId,
        today,
        data.balance,
        data.transactions,
        schedules,
      );
      const values = points.map((p) => p.balance),
        low = Math.min(...values),
        high = Math.max(...values),
        span = high - low || 1;
      const start = Date.parse(`${today}T00:00:00Z`),
        duration = Date.parse(`${forecastEnd(today)}T00:00:00Z`) - start;
      const x = (p: Point) => 16 + ((Date.parse(`${p.date}T00:00:00Z`) - start) / duration) * 568;
      const y = (p: Point) => (high === low ? 70 : 116 - ((p.balance - low) / span) * 92);
      const path = points
        .map((p, i) =>
          i
            ? `H ${x(p).toFixed(1)} V ${y(p).toFixed(1)}`
            : `M ${x(p).toFixed(1)} ${y(p).toFixed(1)}`,
        )
        .join(" ");
      const negative = points.filter(
        (p) => p.balance < 0 && (p.movements.length || p === points[0]),
      );
      panel.innerHTML = `<div class="balance-history-heading"><div><h2>Prévision du solde</h2><p>Sur trois mois · opérations et échéances connues · retards inclus dès aujourd’hui</p></div><strong>${euro(points[points.length - 1]!.balance)}</strong></div><div class="balance-history-chart"><div class="balance-history-axis"><span>${euro(high)}</span><span>${euro(low)}</span></div><div class="balance-history-plot"><svg viewBox="0 0 600 132" preserveAspectRatio="none" role="group" aria-label="Prévision du solde"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2.5" vector-effect="non-scaling-stroke"/>${points.map((p, i) => `<circle cx="${x(p).toFixed(1)}" cy="${y(p).toFixed(1)}" r="${p.movements.length ? 5 : 3}" fill="currentColor" ${p.movements.length ? `class="forecast-point" data-point="${i}" tabindex="0" role="button" aria-label="${escapeHtml(displayDate(p.date))} : ${escapeHtml(euro(p.balance))}"` : ""}/>`).join("")}</svg><div class="balance-history-dates"><span>${escapeHtml(displayDate(today))}</span><span>${escapeHtml(displayDate(forecastEnd(today)))}</span></div></div></div><p class="forecast-negative">${negative.length ? `Solde négatif : ${negative.map((p) => escapeHtml(displayDate(p.date))).join(", ")}` : "Aucun solde négatif prévu."}</p><div class="forecast-days">${
        points
          .map((p, i) => ({ p, i }))
          .filter(({ p }) => p.movements.length)
          .map(
            ({ p, i }) =>
              `<details data-detail="${i}"><summary>${escapeHtml(displayDate(p.date))} · ${escapeHtml(euro(p.balance))}</summary><ul>${p.movements.map((m) => `<li>${escapeHtml(m.source!)}${m.overdue ? ` en retard du ${escapeHtml(displayDate(m.date))}` : ""} : ${escapeHtml(m.label)} · ${escapeHtml(euro(m.amount))}</li>`).join("")}</ul></details>`,
          )
          .join("") || "<p>Aucune opération ou échéance prévue.</p>"
      }</div>`;
      panel.querySelectorAll<SVGElement>(".forecast-point").forEach((point) => {
        const openDetail = () => {
          const detail = panel.querySelector<HTMLDetailsElement>(
            `details[data-detail="${point.dataset.point}"]`,
          );
          if (detail) {
            detail.open = true;
            detail.scrollIntoView({ block: "nearest" });
          }
        };
        point.addEventListener("click", openDetail);
        point.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openDetail();
          }
        });
      });
      panel.dataset.loaded = "true";
    } catch (error) {
      if (panel.isConnected)
        panel.innerHTML = `<p class="balance-history-message" role="alert">Impossible de charger la prévision : ${escapeHtml(String(error))}</p>`;
    }
  });
}
