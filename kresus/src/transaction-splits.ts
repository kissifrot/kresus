import { categoryOptions } from "./categories";
import { centsInput, escapeHtml, euro, parseCents } from "./format";
import type { TransactionSplit } from "./types";

export const splitControls = `<div class="split-controls">
  <button type="button" class="secondary-button toggle-splits" aria-expanded="false">Ventiler</button>
  <div class="split-fields" hidden>
    <div class="split-rows"></div>
    <div class="split-actions">
      <button type="button" class="secondary-button add-split">Ajouter une ligne</button>
      <output class="split-balance"></output>
    </div>
    <small>Un montant négatif compense une partie du total.</small>
  </div>
</div>`;

export function bindSplitEditor(
  form: HTMLFormElement,
  initial: TransactionSplit[] = [],
  direction = 1,
) {
  const type = form.elements.namedItem("type") as HTMLSelectElement;
  const amount = form.elements.namedItem("amount") as HTMLInputElement;
  const category = form.elements.namedItem("category") as HTMLSelectElement;
  const picker = category.closest<HTMLElement>(".category-picker")!;
  const controls = form.querySelector<HTMLElement>(".split-controls")!;
  const toggle = controls.querySelector<HTMLButtonElement>(".toggle-splits")!;
  const fields = controls.querySelector<HTMLElement>(".split-fields")!;
  const rows = controls.querySelector<HTMLElement>(".split-rows")!;
  const balance = controls.querySelector<HTMLOutputElement>(".split-balance")!;
  let enabled = initial.length > 0;

  const choices = (current = "") => categoryOptions(current, type.value, true);

  function appendRow(part?: TransactionSplit) {
    const row = document.createElement("div");
    row.className = "split-row";
    row.innerHTML = `
      <label>Catégorie<select class="split-category">${choices(part?.category)}</select></label>
      <label>Montant (€)<input class="split-amount" inputmode="decimal" value="${part ? centsInput(part.amount * direction) : ""}"></label>
      <label>Commentaire (facultatif)<textarea class="split-note" rows="1">${escapeHtml(part?.note ?? "")}</textarea></label>
      <button type="button" class="secondary-button remove-split" aria-label="Supprimer cette ligne" title="Supprimer cette ligne">×</button>`;
    rows.append(row);
    return row.querySelector<HTMLSelectElement>("select")!;
  }

  const rowParts = () =>
    Array.from(rows.querySelectorAll<HTMLElement>(".split-row")).map((row) => ({
      category: row.querySelector<HTMLSelectElement>(".split-category")!.value,
      amount: row.querySelector<HTMLInputElement>(".split-amount")!.value,
      note: row.querySelector<HTMLTextAreaElement>(".split-note")!.value.trim() || null,
    }));
  const active = () => enabled && type.value !== "transfer";

  function showBalance() {
    balance.value = "";
    if (!active()) return;
    try {
      const total = BigInt(parseCents(amount.value));
      const allocated = rowParts().reduce(
        (sum, part) => sum + BigInt(part.amount.trim() ? parseCents(part.amount) : 0),
        0n,
      );
      const rest = total - allocated;
      balance.value =
        rest === 0n ? "Montant entièrement ventilé" : `Reste à ventiler · ${euro(Number(rest))}`;
    } catch {
      // The form reports invalid amounts on submission.
    }
  }

  function sync() {
    controls.hidden = type.value === "transfer";
    fields.hidden = !active();
    picker.hidden = active();
    category.disabled = active();
    toggle.textContent = active() ? "Utiliser une seule catégorie" : "Ventiler";
    toggle.setAttribute("aria-expanded", String(active()));
    rows.querySelectorAll<HTMLButtonElement>(".remove-split").forEach((button) => {
      button.disabled = rows.childElementCount <= 1;
    });
    showBalance();
  }

  initial.forEach(appendRow);
  toggle.addEventListener("click", () => {
    enabled = !enabled;
    if (enabled && !rows.childElementCount) {
      appendRow({ category: category.value, amount: 0 });
      rows.querySelector<HTMLInputElement>(".split-amount")!.value = "";
      appendRow();
    }
    sync();
    if (enabled) rows.querySelector<HTMLInputElement>(".split-amount")?.focus();
  });
  controls.querySelector(".add-split")!.addEventListener("click", () => {
    const select = appendRow();
    sync();
    select.focus();
  });
  rows.addEventListener("click", (event) => {
    if (!(event.target instanceof HTMLButtonElement) || !event.target.matches(".remove-split"))
      return;
    event.target.closest(".split-row")!.remove();
    sync();
    controls.querySelector<HTMLButtonElement>(".add-split")?.focus();
  });
  amount.addEventListener("input", showBalance);
  rows.addEventListener("input", showBalance);
  type.addEventListener("change", () => {
    rows.querySelectorAll<HTMLSelectElement>(".split-category").forEach((select) => {
      select.innerHTML = choices(select.value);
    });
    sync();
  });
  sync();

  return {
    reset() {
      enabled = false;
      rows.replaceChildren();
      sync();
    },
    read(total: number): TransactionSplit[] {
      if (!active()) return [];
      const sign = Math.sign(total);
      const result = rowParts().map((part) => ({
        ...part,
        amount: parseCents(part.amount) * sign,
      }));
      if (result.some((part) => !part.category))
        throw new Error("Choisissez une catégorie pour chaque ligne.");
      const allocated = result.reduce((sum, part) => sum + BigInt(part.amount), 0n);
      if (allocated !== BigInt(total))
        throw new Error(
          "La somme des lignes ventilées doit correspondre au montant de l’opération.",
        );
      return result;
    },
  };
}
