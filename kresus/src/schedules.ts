import { invoke } from "@tauri-apps/api/core";
import type { Account, Schedule, CalendarOccurrence } from "./types";
import { accounts, schedules, selectedAccount, setAccounts, setSchedules } from "./state";
import { euro, escapeHtml, parseCents, centsInput } from "./format";
import { render } from "./accounts";
import { categoryOptions } from "./categories";
import { loadPayeeSuggestions } from "./payees";

// Store the first day of the displayed month to simplify month navigation.
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let annualView = false;

// Clamp to the last day of short months while retaining the intended day.
function occurrencesForMonth(schedule: Schedule, monthKey: string): CalendarOccurrence[] {
  const result: CalendarOccurrence[] = [];
  if (schedule.nextDue.startsWith(monthKey)) result.push({ ...schedule, projected: false });
  const months: Record<string, number> = {
    Mensuelle: 1,
    Bimestrielle: 2,
    Trimestrielle: 3,
    Semestrielle: 6,
    Annuelle: 12,
  };
  const step = months[schedule.frequency];
  if (!step) return result;
  const current = new Date(`${schedule.series.nextDue}T00:00:00Z`);
  const targetEnd = `${monthKey}-31`;
  let occurrenceIndex = 1;
  while (current.toISOString().slice(0, 10) <= targetEnd) {
    current.setUTCDate(1);
    current.setUTCMonth(current.getUTCMonth() + step);
    const lastDay = new Date(
      Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0),
    ).getUTCDate();
    current.setUTCDate(Math.min(schedule.series.anchorDay, lastDay));
    const date = current.toISOString().slice(0, 10);
    occurrenceIndex++;
    // Limits refer to the original series dates, even if the pending occurrence was moved.
    if (
      (schedule.remainingCount != null && occurrenceIndex > schedule.remainingCount) ||
      (schedule.endDate && date > schedule.endDate)
    )
      break;
    if (
      date.startsWith(monthKey) &&
      !schedule.futureOverrides?.some((item) => item.originalDue === date)
    )
      result.push({
        ...schedule.series,
        id: schedule.id,
        frequency: schedule.frequency,
        nextDue: date,
        projected: true,
        originalDue: date,
      });
  }
  // An exception can move across months, so display it by its edited date.
  for (const override of schedule.futureOverrides ?? []) {
    if (override.nextDue.startsWith(monthKey))
      result.push({ ...override, id: schedule.id, frequency: schedule.frequency, projected: true });
  }
  return result;
}

export function renderSchedules() {
  renderScheduleView(false);
}

// Reuse the same actionable overdue list from other views.
export function renderOverdueSchedules() {
  annualView = false;
  renderScheduleView(true);
}

function renderScheduleView(showOverdue: boolean) {
  render();
  document.querySelector(".nav-item.selected")?.classList.remove("selected");
  document.querySelector("#schedules-nav")?.classList.add("selected");
  const days = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
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
  // JavaScript starts the week on Sunday; the calendar starts on Monday.
  const firstDayOffset = (calendarMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Array.from(
    { length: Math.ceil((firstDayOffset + daysInMonth) / 7) * 7 },
    (_, index) => {
      const day = index - firstDayOffset + 1;
      const currentDay = day > 0 && day <= daysInMonth;
      const date = currentDay ? `${monthKey}-${String(day).padStart(2, "0")}` : "";
      const entries = monthSchedules.filter((schedule) => schedule.nextDue === date);
      return `<div class="calendar-cell ${currentDay ? "" : "outside"}"><span>${currentDay ? day : ""}</span>${entries.map((entry) => `<button type="button" class="calendar-event ${entry.kind}" ${entry.projected ? `data-edit-future="${escapeHtml(entry.id)}" data-original-due="${escapeHtml(entry.originalDue!)}"` : `data-edit-schedule="${escapeHtml(entry.id)}"`} title="${escapeHtml(entry.label)}">${escapeHtml(entry.label)}</button>`).join("")}</div>`;
    },
  ).join("");
  // Use the same projection rules for the annual overview and monthly calendar.
  const annualRows = annualView
    ? Array.from({ length: 12 }, (_, index) => {
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
        return `<tr><th scope="row"><button type="button" class="annual-month" data-annual-month="${index}">${label}</button></th><td>${items.length}</td><td>${euro(debit)}</td><td>${euro(credit)}</td><td>${items.map((item) => `<button type="button" class="annual-occurrence" ${item.projected ? `data-edit-future="${escapeHtml(item.id)}" data-original-due="${escapeHtml(item.originalDue!)}"` : `data-edit-schedule="${escapeHtml(item.id)}"`} title="${escapeHtml(item.label)}">${escapeHtml(item.nextDue.slice(-2))} · ${escapeHtml(item.label)}${item.projected ? " (prévision)" : ""}</button>`).join("<br>") || "—"}</td></tr>`;
      }).join("")
    : "";
  const totalDue = monthSchedules
    .filter((schedule) => schedule.kind === "debit")
    .reduce((sum, schedule) => sum + Math.abs(schedule.amount), 0);
  document.querySelector<HTMLDivElement>(".page-content")!.innerHTML = `
    <div class="page-heading schedule-heading"><div><div class="eyebrow">PLANIFICATION</div><h1>Échéances</h1><p>Préparez les opérations récurrentes avant leur intégration au compte.</p></div><button class="primary-button" id="new-schedule"><span>+</span> Nouvelle échéance</button></div>
    <section class="schedule-summary"><div><span>À prévoir en ${monthLabel}</span><strong>${euro(totalDue)}</strong><small>${monthSchedules.length} échéances ce mois</small></div><div class="summary-divider"></div><div><span>Prochaine échéance</span><strong>${nextUpcoming ? new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${nextUpcoming.nextDue}T12:00:00`)) : "—"}</strong><small>${nextUpcoming ? `${nextUpcoming.projected ? "Prévision · " : ""}${escapeHtml(nextUpcoming.label)}` : "Aucune échéance à venir"}</small>${overdueCount ? `<button type="button" id="show-overdue" class="schedule-overdue">${overdueCount} échéance${overdueCount === 1 ? "" : "s"} en retard</button>` : ""}</div><div class="schedule-tip">Une échéance arrivée à son terme peut être enregistrée comme opération et pointée dans le compte.</div></section><p class="schedule-message" role="alert"></p>
    <div class="schedule-view-switch"><button type="button" class="secondary-button" id="schedule-month-view" aria-pressed="${!annualView}">Mois</button><button type="button" class="secondary-button" id="schedule-year-view" aria-pressed="${annualView}">Année</button></div>
    ${
      annualView
        ? `<section class="annual-schedules"><div class="annual-toolbar"><button id="previous-year" class="secondary-button" aria-label="Année précédente">‹</button><h2>${year}</h2><button id="next-year" class="secondary-button" aria-label="Année suivante">›</button></div><div class="table-wrap"><table><thead><tr><th>Mois</th><th>Échéances</th><th>Débits</th><th>Crédits</th><th>Détail</th></tr></thead><tbody>${annualRows}</tbody></table></div><p>Les virements sont comptés dans les échéances et exclus des totaux de débits et crédits. Cliquez sur un mois pour le consulter.</p></section>`
        : `<section class="schedules-workspace"><div class="calendar-panel"><div class="calendar-toolbar"><button id="previous-month" aria-label="Mois précédent">‹</button><h2>${monthLabel}</h2><button id="current-month">Aujourd’hui</button><button id="next-month" aria-label="Mois suivant">›</button></div><div class="calendar-weekdays">${days.map((day) => `<span>${day}</span>`).join("")}</div><div class="calendar-grid">${cells}</div></div><div class="schedule-list-panel"><div class="schedule-list-heading"><div><h2>${showOverdue ? "Échéances en retard" : "Échéances du mois"}</h2><p>${displayedSchedules.length} échéance${displayedSchedules.length === 1 ? "" : "s"} ${showOverdue ? "en retard" : "planifiées"}</p></div>${showOverdue ? '<button id="back-to-month" class="secondary-button">Retour au mois</button>' : ""}</div><div class="schedule-list">${
            displayedSchedules
              .map((schedule) => {
                const account = accounts.find((item) => item.id === schedule.accountId);
                const destination = accounts.find(
                  (item) => item.id === schedule.destinationAccountId,
                );
                const payment = schedule.paymentMethod
                  ? {
                      cheque: "Chèque",
                      bank_transfer: "Virement automatique",
                      direct_debit: "Prélèvement",
                    }[schedule.paymentMethod]
                  : "";
                return `<div class="schedule-row"><time><strong>${new Date(`${schedule.nextDue}T12:00:00`).getDate()}</strong><small>${new Intl.DateTimeFormat("fr-FR", { month: "short", ...(showOverdue ? { year: "numeric" } : {}) }).format(new Date(`${schedule.nextDue}T12:00:00`))}</small></time><span class="schedule-row-copy"><strong>${escapeHtml(schedule.label)}</strong><small>${escapeHtml(schedule.category)} · ${escapeHtml(account?.name ?? "Compte")}${schedule.kind === "transfer" ? ` → ${escapeHtml(destination?.name ?? "Compte")}` : ""}${payment ? ` · ${payment}${schedule.cheque ? ` n° ${escapeHtml(schedule.cheque)}` : ""}` : ""}</small></span><span class="schedule-amount ${schedule.kind}">${schedule.kind === "credit" ? "+ " : schedule.kind === "transfer" ? "↔ " : "− "}${euro(Math.abs(schedule.amount))}<small>${escapeHtml(schedule.frequency)}</small></span><div class="schedule-row-actions">${schedule.projected ? `<span class="schedule-projected">Prévision</span><button class="schedule-record" data-edit-future="${escapeHtml(schedule.id)}" data-original-due="${escapeHtml(schedule.originalDue!)}">Modifier</button>` : `<button class="schedule-record" data-edit-schedule="${escapeHtml(schedule.id)}">Modifier</button><button class="schedule-record" data-record-schedule="${escapeHtml(schedule.id)}">Enregistrer</button>`}<button class="secondary-button schedule-delete" data-delete-schedule="${escapeHtml(schedule.id)}">Supprimer</button></div></div>`;
              })
              .join("") ||
            `<p class="empty-row">${showOverdue ? "Aucune échéance en retard." : "Aucune échéance pour ce mois."}</p>`
          }</div></div></section>`
    }
    <dialog id="schedule-dialog"><form id="schedule-form">
        <div class="dialog-heading"><h2>Nouvelle échéance</h2><button type="button" class="dialog-close schedule-close" aria-label="Fermer">×</button></div>
        <label class="schedule-scope" hidden>Appliquer la modification<select name="scope"><option value="occurrence">Cette occurrence uniquement</option><option value="series">Cette occurrence et les suivantes</option></select></label><p class="schedule-exceptions-warning" hidden>Modifier la série supprimera les modifications individuelles des occurrences futures.</p>
        <label><span class="schedule-account-label">Compte</span><select name="accountId" required>${accounts.map((account) => `<option value="${escapeHtml(account.id)}" ${account.id === selectedAccount.id ? "selected" : ""}>${escapeHtml(account.name)}</option>`).join("")}</select></label>
        <label class="schedule-destination" hidden>Compte crédité<select name="destinationAccountId">${accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`).join("")}</select></label>
        <label>Destinataire / libellé<input name="label" list="schedule-payee-suggestions" required maxlength="80"><datalist id="schedule-payee-suggestions"></datalist></label>
        <label>Catégorie<select name="category" required>${categoryOptions()}</select></label>
        <div class="form-row"><label>Type<select name="kind"><option value="debit">Débit</option><option value="credit">Crédit</option><option value="transfer">Virement</option></select></label>
        <label>Montant (€)<input name="amount" type="number" min="0.01" max="1000000000" step="0.01" required></label></div>
        <div class="form-row"><label>Méthode de paiement<select name="paymentMethod"><option value="">Non précisée</option><option value="cheque">Chèque</option><option value="bank_transfer">Virement automatique</option><option value="direct_debit">Prélèvement</option></select></label><label class="schedule-cheque" hidden>N° de chèque (cette occurrence)<input name="cheque" maxlength="40"></label></div>
        <div class="form-row"><label><span class="schedule-date-label">Première échéance</span><input name="nextDue" type="date" required></label>
        <label>Périodicité<select name="frequency"><option>Mensuelle</option><option>Bimestrielle</option><option>Trimestrielle</option><option>Semestrielle</option><option>Annuelle</option></select></label></div>
        <div class="schedule-limit"><label>Fin de la série<select name="limitType"><option value="none">Sans limite</option><option value="count">Nombre d’occurrences</option><option value="date">Date de fin</option></select></label>
        <label class="schedule-count" hidden>Occurrences restantes (échéance actuelle comprise)<input name="remainingCount" type="number" min="1" max="100000" step="1"></label>
        <label class="schedule-end" hidden>Date de fin incluse<input name="endDate" type="date"></label></div>
        <p class="editor-error" role="alert"></p>
        <div class="dialog-actions"><button type="button" class="secondary-button schedule-close">Annuler</button>
          <button type="submit" class="primary-button">Créer l’échéance</button></div>
      </form>
    </dialog>`;
  const scheduleDialog = document.querySelector<HTMLDialogElement>("#schedule-dialog")!;
  const scheduleForm = scheduleDialog.querySelector<HTMLFormElement>("#schedule-form")!;
  let editingSchedule: Schedule | undefined;
  let editingOriginal: string | undefined;
  // A cheque number is specific to the occurrence, never the recurring series.
  function updatePaymentFields() {
    const transfer =
      (scheduleForm.elements.namedItem("kind") as HTMLSelectElement).value === "transfer";
    const method = scheduleForm.elements.namedItem("paymentMethod") as HTMLSelectElement;
    // Imported transfers can have an unknown Money payment method.
    for (const option of method.options)
      option.disabled = transfer && ["cheque", "direct_debit"].includes(option.value);
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
    const type = (scheduleForm.elements.namedItem("limitType") as HTMLSelectElement).value;
    scheduleForm.querySelector<HTMLElement>(".schedule-limit")!.hidden = occurrenceOnly;
    for (const [name, selector, active] of [
      ["remainingCount", ".schedule-count", type === "count"],
      ["endDate", ".schedule-end", type === "date"],
    ] as const) {
      scheduleForm.querySelector<HTMLElement>(selector)!.hidden = !active;
      const input = scheduleForm.elements.namedItem(name) as HTMLInputElement;
      input.disabled = occurrenceOnly || !active;
      input.required = !occurrenceOnly && active;
    }
  }
  (scheduleForm.elements.namedItem("limitType") as HTMLSelectElement).addEventListener(
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
    if (schedule) {
      setValue("accountId", schedule.accountId);
      setValue("label", schedule.label);
      setValue("category", schedule.category);
      setValue("kind", schedule.kind);
      setValue("paymentMethod", schedule.paymentMethod ?? "");
      setValue("cheque", schedule.cheque ?? "");
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
      const amount = parseCents(String(values.get("amount")));
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
            paymentMethod: String(values.get("paymentMethod") ?? "") || null,
            cheque: String(values.get("cheque") ?? "").trim() || null,
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
        !window.confirm(
          `Supprimer la série « ${schedule.label} » et toutes ses échéances à venir ? Les opérations déjà enregistrées seront conservées.`,
        )
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
