import { invoke } from "@tauri-apps/api/core";
import { centsInput, euro, localDate, MIN_CALENDAR_DATE, parseCents } from "./format";

export type ClosingBalance = { date: string | null; amount: number | null };
type Draft = { accountId: string; date: string; amount: string };
let active: Draft | undefined;

export function resetReconciliation() {
  active = undefined;
}

export function openReconciliation(
  accountId: string,
  closing: ClosingBalance = { date: localDate(new Date()), amount: null },
) {
  active = {
    accountId,
    date: closing.date ?? "",
    amount: closing.amount === null ? "" : centsInput(closing.amount),
  };
  showReconciliation(active)?.focus();
}

export function bindReconciliation(accountId: string) {
  document.querySelector("#start-reconciliation")?.addEventListener("click", () => {
    openReconciliation(accountId);
  });
  if (active?.accountId === accountId) showReconciliation(active);
}

function showReconciliation(draft: Draft) {
  const panel = document.querySelector<HTMLElement>("#statement-reconciliation");
  const open = document.querySelector<HTMLButtonElement>("#start-reconciliation");
  if (!panel || !open) return;
  panel.hidden = false;
  open.hidden = true;
  panel.innerHTML = `<div class="statement-reconciliation-heading">
      <h2>Rapprochement du relevé</h2>
      <button type="button" class="secondary-button" id="end-reconciliation">Fermer</button>
    </div>
    <div class="statement-reconciliation-fields">
      <label>Date de clôture<input class="filter-button" id="reconciliation-date" type="date" min="${MIN_CALENDAR_DATE}" max="9999-12-31" required></label>
      <label>Solde de clôture (€)<input class="filter-button" id="reconciliation-amount" type="text" inputmode="decimal" placeholder="0,00"></label>
      <dl class="statement-reconciliation-totals" aria-live="polite" aria-atomic="true">
        <div><dt>Solde pointé</dt><dd id="reconciliation-balance">—</dd></div>
        <div><dt>Écart restant</dt><dd id="reconciliation-gap">—</dd></div>
      </dl>
    </div>
    <p class="editor-error" role="alert"></p>`;

  const date = panel.querySelector<HTMLInputElement>("#reconciliation-date")!;
  const amount = panel.querySelector<HTMLInputElement>("#reconciliation-amount")!;
  const balance = panel.querySelector<HTMLElement>("#reconciliation-balance")!;
  const gap = panel.querySelector<HTMLElement>("#reconciliation-gap")!;
  const error = panel.querySelector<HTMLElement>(".editor-error")!;
  date.value = draft.date;
  amount.value = draft.amount;
  let pointed: number | undefined;
  let version = 0;
  let loadError = "";

  const showDifference = () => {
    balance.textContent = pointed === undefined ? "—" : euro(pointed);
    gap.textContent = "—";
    delete gap.dataset.balanced;
    error.textContent = loadError;
    if (!amount.value.trim()) return;
    try {
      const target = parseCents(amount.value);
      if (pointed === undefined) return;
      const difference = target - pointed;
      if (!Number.isSafeInteger(difference))
        throw new Error("L’écart dépasse la précision disponible.");
      gap.textContent = difference === 0 ? `${euro(0)} · Équilibré` : euro(difference);
      if (difference === 0) gap.dataset.balanced = "";
    } catch (issue) {
      error.textContent = (issue as Error).message;
    }
  };

  const load = async () => {
    const request = ++version;
    pointed = undefined;
    loadError = "";
    showDifference();
    if (!date.value) return;
    if (!date.validity.valid) {
      loadError = "Saisissez une date de clôture valide à partir du 1er janvier 1970.";
      showDifference();
      return;
    }
    const current = () => request === version && active === draft && panel.isConnected;
    try {
      const value = await invoke<number>("reconciliation_balance", {
        accountId: draft.accountId,
        date: date.value,
      });
      if (!current()) return;
      if (!Number.isSafeInteger(value))
        throw new Error("Le solde pointé dépasse la précision disponible.");
      pointed = value;
    } catch (issue) {
      if (current()) loadError = `Calcul du solde pointé impossible. ${String(issue)}`;
    }
    if (current()) showDifference();
  };

  date.addEventListener("input", () => {
    draft.date = date.value;
    void load();
  });
  amount.addEventListener("input", () => {
    draft.amount = amount.value;
    showDifference();
  });
  panel.querySelector("#end-reconciliation")!.addEventListener("click", () => {
    resetReconciliation();
    panel.hidden = true;
    panel.replaceChildren();
    open.hidden = false;
    open.focus();
  });
  void load();
  return draft.date ? amount : date;
}
