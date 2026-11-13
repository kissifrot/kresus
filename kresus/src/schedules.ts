import { occurrencesForMonth } from "./schedule-occurrences";
import { FREQUENCY } from "./frequency";
import { TEXT_NAME_LIMIT } from "./text-limits";
import { invoke } from "@tauri-apps/api/core";
import { confirmAction } from "./confirmation";
import type { Account, Schedule, CalendarOccurrence } from "./types";
import { accounts, schedules, selectedAccount, setAccounts, setSchedules } from "./state";
import { euro, amountWithoutCurrency, escapeHtml, parsePositiveCents, centsInput } from "./format";
import { render } from "./accounts";
import { bindCategoryCreation, categoryOptions } from "./categories";
import { loadPayeeSuggestions } from "./payees";

// Store the first day of the displayed month to simplify month navigation.
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let annualView = false;

export function renderSchedules() {
  renderScheduleView(false);
}

// Reuse the same actionable overdue list from other views.
export function renderOverdueSchedules() {
  annualView = false;
  renderScheduleView(true);
}

// Both calendar views open the same occurrence editor.
function occurrenceEditAttributes(item: CalendarOccurrence): string {
  return item.projected
    ? `data-edit-future="${escapeHtml(item.id)}" data-original-due="${escapeHtml(item.originalDue!)}"`
    : `data-edit-schedule="${escapeHtml(item.id)}"`;
}

function renderCalendarCells(
  year: number,
  month: number,
  monthKey: string,
  monthSchedules: CalendarOccurrence[],
): string {
  // JavaScript starts the week on Sunday; the calendar starts on Monday.
  const firstDayOffset = (calendarMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: Math.ceil((firstDayOffset + daysInMonth) / 7) * 7 }, (_, index) => {
    const day = index - firstDayOffset + 1;
    const currentDay = day > 0 && day <= daysInMonth;
    const date = currentDay ? `${monthKey}-${String(day).padStart(2, "0")}` : "";
    const entries = monthSchedules.filter((schedule) => schedule.nextDue === date);
    const events = entries
      .map(
        (entry) => `<button type="button" class="calendar-event ${entry.kind}"
          ${occurrenceEditAttributes(entry)} title="${escapeHtml(entry.label)}">${escapeHtml(entry.label)}</button>`,
      )
      .join("");
    return `<div class="calendar-cell ${currentDay ? "" : "outside"}"><span>${currentDay ? day : ""}</span>${events}</div>`;
  }).join("");
}

function renderAnnualRows(year: number): string {
  // Use the same projection rules for the annual overview and monthly calendar.
  return Array.from({ length: 12 }, (_, index) => {
    const key = `${year}-${String(index + 1).padStart(2, "0")}`;
    const items = schedules
      .flatMap((schedule) => occurrencesForMonth(schedule, key))
      .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
    const label = new Intl.DateTimeFormat("fr-FR", { month: "long" }).format(
      new Date(year, index, 1),
    );
    const debit = items
      .filter((item) => item.kind === "debit")
      .reduce((sum, item) => sum + Math.abs(item.amount), 0);
    const credit = items
      .filter((item) => item.kind === "credit")
      .reduce((sum, item) => sum + item.amount, 0);
    const occurrences = items
      .map(
        (item) => `<button type="button" class="annual-occurrence"
          ${occurrenceEditAttributes(item)} title="${escapeHtml(item.label)}">${escapeHtml(item.nextDue.slice(-2))} · ${escapeHtml(item.label)}${item.projected ? " (prévision)" : ""}</button>`,
      )
      .join("<br>");
    return `<tr>
      <th scope="row"><button type="button" class="annual-month" data-annual-month="${index}">${label}</button></th>
      <td>${items.length}</td><td>${amountWithoutCurrency(debit)}</td>
      <td>${amountWithoutCurrency(credit)}</td><td>${occurrences || "—"}</td>
    </tr>`;
  }).join("");
}

function renderScheduleRow(schedule: CalendarOccurrence, showOverdue: boolean): string {
  const account = accounts.find((item) => item.id === schedule.accountId);
  const destination = accounts.find((item) => item.id === schedule.destinationAccountId);
  const payment = schedule.paymentMethod
    ? {
        cheque: "Chèque",
        bank_transfer: "Virement automatique",
        direct_debit: "Prélèvement",
        automatic: "Prélèvt/Virement auto.",
        income_payment: "Versement",
      }[schedule.paymentMethod]
    : "";
  const date = new Date(`${schedule.nextDue}T12:00:00`);
  const month = new Intl.DateTimeFormat("fr-FR", {
    month: "short",
    ...(showOverdue ? { year: "numeric" } : {}),
  }).format(date);
  const destinationLabel =
    schedule.kind === "transfer" ? ` → ${escapeHtml(destination?.name ?? "Compte")}` : "";
  const paymentLabel = payment
    ? ` · ${payment}${schedule.cheque ? ` n° ${escapeHtml(schedule.cheque)}` : ""}`
    : "";
  const sign = schedule.kind === "credit" ? "+ " : schedule.kind === "transfer" ? "↔ " : "− ";
  const actions = schedule.projected
    ? `<span class="schedule-projected">Prévision</span><button class="schedule-record" ${occurrenceEditAttributes(schedule)}>Modifier</button>`
    : `<button class="schedule-record" ${occurrenceEditAttributes(schedule)}>Modifier</button><button class="schedule-record" data-record-schedule="${escapeHtml(schedule.id)}">Enregistrer</button>`;
  return `<div class="schedule-row">
    <time><strong>${date.getDate()}</strong><small>${month}</small></time>
    <span class="schedule-row-copy"><strong>${escapeHtml(schedule.label)}</strong><small>${escapeHtml(schedule.category)} · ${escapeHtml(account?.name ?? "Compte")}${destinationLabel}${paymentLabel}</small>${schedule.note ? `<small>${escapeHtml(schedule.note)}</small>` : ""}</span>
    <span class="schedule-amount ${schedule.kind}">${sign}${euro(Math.abs(schedule.amount))}<small>${escapeHtml(schedule.frequency)}${schedule.estimated ? " · Montant estimé" : ""}</small></span>
    <div class="schedule-row-actions">${actions}<button class="secondary-button schedule-delete" data-delete-schedule="${escapeHtml(schedule.id)}">Supprimer</button></div>
  </div>`;
}

function renderScheduleDialog(): string {
  return `    <dialog id="schedule-dialog"><form id="schedule-form">
        <div class="dialog-heading"><h2>Nouvelle échéance</h2><button type="button" class="dialog-close schedule-close" aria-label="Fermer">×</button></div>
        <label class="schedule-scope" hidden>Appliquer la modification<select name="scope"><option value="occurrence">Cette occurrence uniquement</option><option value="series">Cette occurrence et les suivantes</option></select></label><p class="schedule-exceptions-warning" hidden>Modifier la série supprimera les modifications individuelles des occurrences futures.</p>
        <label><span class="schedule-account-label">Compte</span><select name="accountId" required>${accounts.map((account) => `<option value="${escapeHtml(account.id)}" ${account.id === selectedAccount.id ? "selected" : ""}>${escapeHtml(account.name)}</option>`).join("")}</select></label>
        <label class="schedule-destination" hidden>Compte crédité<select name="destinationAccountId">${accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`).join("")}</select></label>
        <label>Tiers<input name="label" list="schedule-payee-suggestions" required maxlength="${TEXT_NAME_LIMIT}"><datalist id="schedule-payee-suggestions"></datalist></label>
        <div class="category-picker"><label>Catégorie<select name="category" required>${categoryOptions()}</select></label><button type="button" class="secondary-button add-category">+ Catégorie</button></div>
        <div class="form-row"><label>Type<select name="kind"><option value="debit">Débit</option><option value="credit">Crédit</option><option value="transfer">Virement</option></select></label>
        <label>Montant (€)<input name="amount" type="text" inputmode="decimal" required></label></div>
        <div class="form-row"><label>Méthode de paiement<select name="paymentMethod"><option value="">Non précisée</option><option value="cheque">Chèque</option><option value="bank_transfer">Virement automatique</option><option value="direct_debit">Prélèvement</option><option value="automatic">Prélèvt/Virement auto.</option><option value="income_payment">Versement</option></select></label><label class="schedule-cheque" hidden>N° de chèque (cette occurrence)<input name="cheque" inputmode="numeric" pattern="[0-9]{7}" maxlength="7" placeholder="7 chiffres"></label></div>
        <label><input type="checkbox" name="estimated"> Montant estimé pour la série</label>
        <label>Commentaire <span class="optional">(facultatif)</span><textarea name="note" rows="2"></textarea></label>
        <div class="form-row"><label><span class="schedule-date-label">Première échéance</span><input name="nextDue" type="date" required></label>
        <label>Périodicité<select name="frequency">${Object.values(FREQUENCY)
          .map(
            (frequency) =>
              `<option value="${frequency}">${frequency === FREQUENCY.TWICE_MONTHLY ? `${frequency} (15 et fin de mois)` : frequency}</option>`,
          )
          .join("")}</select></label></div>
        <div class="schedule-limit"><label>Fin de la série<select name="limitType"><option value="none">Sans limite</option><option value="count">Nombre d’occurrences</option><option value="date">Date de fin</option></select></label>
        <label class="schedule-count" hidden>Occurrences restantes (échéance actuelle comprise)<input name="remainingCount" type="number" min="1" max="100000" step="1"></label>
        <label class="schedule-end" hidden>Date de fin incluse<input name="endDate" type="date"></label></div>
        <p class="editor-error" role="alert"></p>
        <div class="dialog-actions"><button type="button" class="secondary-button schedule-close">Annuler</button>
          <button type="submit" class="primary-button">Créer l’échéance</button></div>
      </form>
    </dialog>`;
}

function renderAnnualView(year: number, rows: string): string {
  return `<section class="annual-schedules">
    <div class="annual-toolbar"><button id="previous-year" class="secondary-button" aria-label="Année précédente">‹</button><h2>${year}</h2><button id="next-year" class="secondary-button" aria-label="Année suivante">›</button></div>
    <div class="table-wrap"><table><thead><tr><th>Mois</th><th>Échéances</th><th>Débits (€)</th><th>Crédits (€)</th><th>Détail</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p>Les virements sont comptés dans les échéances et exclus des totaux de débits et crédits. Cliquez sur un mois pour le consulter.</p>
  </section>`;
}

function renderMonthlyView(
  monthLabel: string,
  cells: string,
  items: CalendarOccurrence[],
  showOverdue: boolean,
): string {
  const days = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
  const rows =
    items.map((item) => renderScheduleRow(item, showOverdue)).join("") ||
    `<p class="empty-row">${showOverdue ? "Aucune échéance en retard." : "Aucune échéance pour ce mois."}</p>`;
  return `<section class="schedules-workspace">
    <div class="calendar-panel">
      <div class="calendar-toolbar"><button id="previous-month" aria-label="Mois précédent">‹</button><h2>${monthLabel}</h2><button id="current-month">Aujourd’hui</button><button id="next-month" aria-label="Mois suivant">›</button></div>
      <div class="calendar-weekdays">${days.map((day) => `<span>${day}</span>`).join("")}</div>
      <div class="calendar-grid">${cells}</div>
    </div>
    <div class="schedule-list-panel">
      <div class="schedule-list-heading"><div><h2>${showOverdue ? "Échéances en retard" : "Échéances du mois"}</h2><p>${items.length} échéance${items.length === 1 ? "" : "s"} ${showOverdue ? "en retard" : "planifiées"}</p></div>${showOverdue ? '<button id="back-to-month" class="secondary-button">Retour au mois</button>' : ""}</div>
      <div class="schedule-list">${rows}</div>
    </div>
  </section>`;
}

function renderScheduleView(showOverdue: boolean) {
  render();
  document.querySelector(".nav-item.selected")?.classList.remove("selected");
  document.querySelector("#schedules-nav")?.classList.add("selected");
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthLabel = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(
    calendarMonth,
  );
  const monthSchedules = schedules
    .flatMap((schedule) => occurrencesForMonth(schedule, monthKey))
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  // Only pending occurrences can be recorded; projected dates are excluded.
  const overdueSchedules: CalendarOccurrence[] = schedules
    .filter((schedule) => schedule.nextDue < today)
    .map((schedule) => ({ ...schedule, projected: false }))
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  const overdueCount = overdueSchedules.length;
  const displayedSchedules = showOverdue ? overdueSchedules : monthSchedules;
  // Search upcoming months for both pending occurrences and future projections.
  let nextUpcoming: CalendarOccurrence | undefined;
  for (let offset = 0; offset <= 12 && !nextUpcoming; offset++) {
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const key = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}`;
    nextUpcoming = schedules
      .flatMap((schedule) => occurrencesForMonth(schedule, key))
      .filter((item) => item.nextDue >= today)
      .sort((a, b) => a.nextDue.localeCompare(b.nextDue))[0];
  }
  const cells = renderCalendarCells(year, month, monthKey, monthSchedules);
  const annualRows = annualView ? renderAnnualRows(year) : "";
  const totalDue = monthSchedules
    .filter((schedule) => schedule.kind === "debit")
    .reduce((sum, schedule) => sum + Math.abs(schedule.amount), 0);
  document.querySelector<HTMLDivElement>(".page-content")!.innerHTML = `
    <div class="page-heading schedule-heading"><div><div class="eyebrow">PLANIFICATION</div><h1>Échéances</h1><p>Préparez les opérations récurrentes avant leur intégration au compte.</p></div><button class="primary-button" id="new-schedule"><span>+</span> Nouvelle échéance</button></div>
    <section class="schedule-summary"><div><span>À prévoir en ${monthLabel}</span><strong>${euro(totalDue)}</strong><small>${monthSchedules.length} échéances ce mois</small></div><div class="summary-divider"></div><div><span>Prochaine échéance</span><strong>${nextUpcoming ? new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${nextUpcoming.nextDue}T12:00:00`)) : "—"}</strong><small>${nextUpcoming ? `${nextUpcoming.projected ? "Prévision · " : ""}${escapeHtml(nextUpcoming.label)}` : "Aucune échéance à venir"}</small>${overdueCount ? `<button type="button" id="show-overdue" class="schedule-overdue">${overdueCount} échéance${overdueCount === 1 ? "" : "s"} en retard</button>` : ""}</div><div class="schedule-tip">Une échéance arrivée à son terme peut être enregistrée comme opération et pointée dans le compte.</div></section><p class="schedule-message" role="alert"></p>
    <div class="schedule-view-switch"><button type="button" class="secondary-button" id="schedule-month-view" aria-pressed="${!annualView}">Mois</button><button type="button" class="secondary-button" id="schedule-year-view" aria-pressed="${annualView}">Année</button></div>
    ${annualView ? renderAnnualView(year, annualRows) : renderMonthlyView(monthLabel, cells, displayedSchedules, showOverdue)}
    ${renderScheduleDialog()}`;
  const scheduleDialog = document.querySelector<HTMLDialogElement>("#schedule-dialog")!;
  const scheduleForm = scheduleDialog.querySelector<HTMLFormElement>("#schedule-form")!;
  bindCategoryCreation(scheduleForm);
  let editingSchedule: Schedule | undefined;
  let editingOriginal: string | undefined;
  // A cheque number is specific to the occurrence, never the recurring series.
  function updatePaymentFields() {
    const transfer =
      (scheduleForm.elements.namedItem("kind") as HTMLSelectElement).value === "transfer";
    const method = scheduleForm.elements.namedItem("paymentMethod") as HTMLSelectElement;
    const credit =
      (scheduleForm.elements.namedItem("kind") as HTMLSelectElement).value === "credit";
    // Imported transfers can have an unknown Money payment method.
    for (const option of method.options)
      option.disabled =
        (transfer && ["cheque", "direct_debit"].includes(option.value)) ||
        (option.value === "income_payment" && !credit);
    if (!credit && method.value === "income_payment") method.value = "";
    if (transfer && ["cheque", "direct_debit"].includes(method.value))
      method.value = "bank_transfer";
    const cheque = scheduleForm.elements.namedItem("cheque") as HTMLInputElement;
    const showCheque = !transfer && method.value === "cheque";
    scheduleForm.querySelector<HTMLElement>(".schedule-cheque")!.hidden = !showCheque;
    cheque.disabled = !showCheque;
  }
  function updateTransferFields() {
    const transfer =
      (scheduleForm.elements.namedItem("kind") as HTMLSelectElement).value === "transfer";
    const destination = scheduleForm.elements.namedItem(
      "destinationAccountId",
    ) as HTMLSelectElement;
    scheduleForm.querySelector<HTMLElement>(".schedule-destination")!.hidden = !transfer;
    scheduleForm.querySelector(".schedule-account-label")!.textContent = transfer
      ? "Compte débité"
      : "Compte";
    destination.disabled = !transfer;
    destination.required = transfer;
    updatePaymentFields();
    const source = (scheduleForm.elements.namedItem("accountId") as HTMLSelectElement).value;
    if (transfer && (!destination.value || destination.value === source))
      destination.value = accounts.find((account) => account.id !== source)?.id ?? "";
  }
  function updateLimitFields() {
    const occurrenceOnly =
      !!editingSchedule &&
      (!!editingOriginal ||
        (scheduleForm.elements.namedItem("scope") as HTMLSelectElement).value === "occurrence");
    scheduleForm.querySelector<HTMLElement>(".schedule-exceptions-warning")!.hidden =
      occurrenceOnly || !editingSchedule?.futureOverrides?.length;
    (scheduleForm.elements.namedItem("estimated") as HTMLInputElement).disabled = occurrenceOnly;
    const once =
      (scheduleForm.elements.namedItem("frequency") as HTMLSelectElement).value === FREQUENCY.ONCE;
    const type = (scheduleForm.elements.namedItem("limitType") as HTMLSelectElement).value;
    scheduleForm.querySelector<HTMLElement>(".schedule-limit")!.hidden = occurrenceOnly || once;
    for (const [name, selector, active] of [
      ["remainingCount", ".schedule-count", type === "count"],
      ["endDate", ".schedule-end", type === "date"],
    ] as const) {
      scheduleForm.querySelector<HTMLElement>(selector)!.hidden = !active;
      const input = scheduleForm.elements.namedItem(name) as HTMLInputElement;
      input.disabled = occurrenceOnly || once || !active;
      input.required = !occurrenceOnly && !once && active;
    }
  }
  (scheduleForm.elements.namedItem("limitType") as HTMLSelectElement).addEventListener(
    "change",
    updateLimitFields,
  );
  (scheduleForm.elements.namedItem("frequency") as HTMLSelectElement).addEventListener(
    "change",
    updateLimitFields,
  );
  // Reuse the same form for a new series and for an existing occurrence.
  function openScheduleForm(schedule?: Schedule, originalDue?: string) {
    editingSchedule = schedule;
    editingOriginal = originalDue;
    scheduleForm.reset();
    scheduleForm.querySelector<HTMLElement>(".editor-error")!.textContent = "";
    scheduleForm.querySelector("h2")!.textContent = schedule
      ? "Modifier l’échéance"
      : "Nouvelle échéance";
    scheduleForm.querySelector(".schedule-date-label")!.textContent = schedule
      ? originalDue
        ? "Date de cette occurrence"
        : "Prochaine échéance"
      : "Première échéance";
    scheduleForm.querySelector<HTMLElement>(".schedule-scope")!.hidden = !schedule || !!originalDue;
    const frequencyInput = scheduleForm.elements.namedItem("frequency") as HTMLSelectElement;
    frequencyInput.disabled = !!schedule;
    scheduleForm.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent = schedule
      ? "Enregistrer"
      : "Créer l’échéance";
    const setValue = (name: string, value: string) => {
      (scheduleForm.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value = value;
    };
    const today = new Date();
    setValue(
      "nextDue",
      schedule?.nextDue ??
        `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`,
    );
    (scheduleForm.elements.namedItem("estimated") as HTMLInputElement).checked =
      !!schedule?.estimated;
    if (schedule) {
      setValue("accountId", schedule.accountId);
      setValue("label", schedule.label);
      setValue("category", schedule.category);
      setValue("kind", schedule.kind);
      setValue("paymentMethod", schedule.paymentMethod ?? "");
      setValue("cheque", schedule.cheque ?? "");
      (scheduleForm.elements.namedItem("note") as HTMLTextAreaElement).value = schedule.note ?? "";
      setValue("amount", centsInput(Math.abs(schedule.amount)));
      setValue("frequency", schedule.frequency);
      setValue(
        "limitType",
        schedule.remainingCount != null ? "count" : schedule.endDate ? "date" : "none",
      );
      if (schedule.remainingCount != null)
        setValue("remainingCount", String(schedule.remainingCount));
      if (schedule.endDate) setValue("endDate", schedule.endDate);
      if (schedule.destinationAccountId)
        setValue("destinationAccountId", schedule.destinationAccountId);
    }
    updateTransferFields();
    updateLimitFields();
    scheduleDialog.showModal();
    void loadPayeeSuggestions(
      scheduleForm.querySelector<HTMLDataListElement>("#schedule-payee-suggestions")!,
    );
  }
  (scheduleForm.elements.namedItem("paymentMethod") as HTMLSelectElement).addEventListener(
    "change",
    updatePaymentFields,
  );
  (scheduleForm.elements.namedItem("kind") as HTMLSelectElement).addEventListener(
    "change",
    updateTransferFields,
  );
  (scheduleForm.elements.namedItem("accountId") as HTMLSelectElement).addEventListener(
    "change",
    updateTransferFields,
  );
  // Frequency belongs to the series and cannot be changed for one occurrence.
  scheduleForm
    .querySelector<HTMLSelectElement>('select[name="scope"]')!
    .addEventListener("change", (event) => {
      (scheduleForm.elements.namedItem("frequency") as HTMLSelectElement).disabled =
        (event.currentTarget as HTMLSelectElement).value === "occurrence";
      updateLimitFields();
    });
  document.querySelector("#new-schedule")?.addEventListener("click", () => openScheduleForm());
  document.querySelectorAll<HTMLElement>("[data-edit-schedule]").forEach((button) =>
    button.addEventListener("click", () => {
      const schedule = schedules.find((item) => item.id === button.dataset.editSchedule);
      if (schedule) openScheduleForm(schedule);
    }),
  );
  document.querySelectorAll<HTMLElement>("[data-edit-future]").forEach((button) =>
    button.addEventListener("click", () => {
      const series = schedules.find((item) => item.id === button.dataset.editFuture);
      const originalDue = button.dataset.originalDue;
      if (!series || !originalDue) return;
      const override = series.futureOverrides?.find((item) => item.originalDue === originalDue);
      // Projected values come from the series, never from the pending exception.
      openScheduleForm(
        {
          ...series,
          ...series.series,
          ...override,
          nextDue: override?.nextDue ?? originalDue,
          cheque: override?.cheque ?? null,
        },
        originalDue,
      );
    }),
  );
  scheduleDialog
    .querySelectorAll(".schedule-close")
    .forEach((button) => button.addEventListener("click", () => scheduleDialog.close()));
  scheduleForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form);
    const cheque = String(values.get("cheque") ?? "").trim();
    if (cheque && !/^[0-9]{7}$/.test(cheque)) {
      form.querySelector<HTMLElement>(".editor-error")!.textContent =
        "Le numéro de chèque doit comporter 7 chiffres.";
      return;
    }
    const kind = String(values.get("kind"));
    const nextDue = String(values.get("nextDue"));
    const accountId = String(values.get("accountId"));
    const destinationAccountId =
      kind === "transfer" ? String(values.get("destinationAccountId") ?? "") : null;
    if (kind === "transfer" && (!destinationAccountId || destinationAccountId === accountId)) {
      form.querySelector<HTMLElement>(".editor-error")!.textContent =
        "Choisissez deux comptes différents pour le virement.";
      return;
    }
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    button.disabled = true;
    try {
      const amount = parsePositiveCents(String(values.get("amount")));
      await invoke(
        editingOriginal
          ? "update_future_occurrence"
          : editingSchedule
            ? "update_schedule"
            : "create_schedule",
        {
          ...(editingOriginal ? { originalDue: editingOriginal } : {}),
          scope: editingSchedule ? String(values.get("scope")) : undefined,
          schedule: {
            id: editingSchedule?.id ?? crypto.randomUUID(),
            accountId,
            destinationAccountId,
            label: String(values.get("label")).trim(),
            category: String(values.get("category")).trim(),
            nextDue,
            frequency: String(values.get("frequency") ?? editingSchedule?.frequency),
            amount: kind === "credit" ? amount : -amount,
            kind,
            estimated: values.has("estimated"),
            paymentMethod: String(values.get("paymentMethod") ?? "") || null,
            cheque: cheque || null,
            note: String(values.get("note") ?? "").trim() || null,
            remainingCount: values.get("remainingCount")
              ? Number(values.get("remainingCount"))
              : null,
            endDate: values.get("endDate") ? String(values.get("endDate")) : null,
          },
        },
      );
      setSchedules(await invoke<Schedule[]>("list_schedules"));
      const [dueYear, dueMonth] = nextDue.split("-").map(Number);
      calendarMonth = new Date(dueYear!, dueMonth! - 1, 1);
      scheduleDialog.close();
      renderScheduleView(showOverdue);
    } catch (error) {
      form.querySelector<HTMLElement>(".editor-error")!.textContent =
        `Enregistrement impossible : ${String(error)}`;
      button.disabled = false;
    }
  });
  document.querySelector("#schedule-month-view")?.addEventListener("click", () => {
    annualView = false;
    renderSchedules();
  });
  document.querySelector("#schedule-year-view")?.addEventListener("click", () => {
    annualView = true;
    renderSchedules();
  });
  document.querySelector("#previous-year")?.addEventListener("click", () => {
    calendarMonth = new Date(year - 1, month, 1);
    renderSchedules();
  });
  document.querySelector("#next-year")?.addEventListener("click", () => {
    calendarMonth = new Date(year + 1, month, 1);
    renderSchedules();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-annual-month]").forEach((button) =>
    button.addEventListener("click", () => {
      calendarMonth = new Date(year, Number(button.dataset.annualMonth), 1);
      annualView = false;
      renderSchedules();
    }),
  );
  document.querySelector("#previous-month")?.addEventListener("click", () => {
    calendarMonth = new Date(year, month - 1, 1);
    renderSchedules();
  });
  document.querySelector("#next-month")?.addEventListener("click", () => {
    calendarMonth = new Date(year, month + 1, 1);
    renderSchedules();
  });
  document.querySelector("#current-month")?.addEventListener("click", () => {
    const today = new Date();
    calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    renderSchedules();
  });
  document
    .querySelector("#show-overdue")
    ?.addEventListener("click", () => renderOverdueSchedules());
  document
    .querySelector("#back-to-month")
    ?.addEventListener("click", () => renderScheduleView(false));
  document.querySelectorAll<HTMLButtonElement>("[data-delete-schedule]").forEach((button) =>
    button.addEventListener("click", async () => {
      const schedule = schedules.find((item) => item.id === button.dataset.deleteSchedule);
      if (
        !schedule ||
        !(await confirmAction(
          "Confirmer la suppression",
          `Supprimer la série « ${schedule.label} » et toutes ses échéances à venir ? Les opérations déjà enregistrées seront conservées.`,
          "Supprimer",
        ))
      )
        return;
      button.disabled = true;
      let deleted = false;
      try {
        await invoke("delete_schedule", { id: schedule.id });
        deleted = true;
        setSchedules(await invoke<Schedule[]>("list_schedules"));
        renderScheduleView(showOverdue);
      } catch (error) {
        document.querySelector<HTMLElement>(".schedule-message")!.textContent = deleted
          ? `Échéance supprimée, mais actualisation impossible : ${String(error)}. Rouvrez l’échéancier.`
          : `Suppression impossible : ${String(error)}`;
        if (!deleted) button.disabled = false;
      }
    }),
  );
  document.querySelectorAll<HTMLElement>("[data-record-schedule]").forEach((button) =>
    button.addEventListener("click", async () => {
      (button as HTMLButtonElement).disabled = true;
      let recorded = false;
      try {
        await invoke("record_schedule", { id: button.dataset.recordSchedule });
        recorded = true;
        setAccounts(await invoke<Account[]>("list_accounts"));
        setSchedules(await invoke<Schedule[]>("list_schedules"));
        renderScheduleView(showOverdue);
      } catch (error) {
        document.querySelector<HTMLElement>(".schedule-message")!.textContent = recorded
          ? `Échéance enregistrée, mais actualisation impossible : ${String(error)}. Rouvrez l’échéancier.`
          : `Enregistrement impossible : ${String(error)}`;
        if (!recorded) (button as HTMLButtonElement).disabled = false;
      }
    }),
  );
}
