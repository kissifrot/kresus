import { invoke } from "@tauri-apps/api/core";
import type { Account, Schedule, CalendarOccurrence } from "./types";
import { accounts, schedules, selectedAccount, setAccounts, setSchedules } from "./state";
import { euro, escapeHtml, parseCents, centsInput } from "./format";
import { render } from "./accounts";
import { categoryOptions } from "./categories";
import { loadPayeeSuggestions } from "./payees";

// Store the first day of the displayed month to simplify month navigation.
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

// Clamp to the last day of short months while retaining the intended day.
function occurrencesForMonth(schedule: Schedule, monthKey: string): CalendarOccurrence[] {
  const result: CalendarOccurrence[] = [];
  if (schedule.nextDue.startsWith(monthKey)) result.push({ ...schedule, projected: false });
  const months: Record<string, number> = { Mensuelle: 1, Trimestrielle: 3, Semestrielle: 6, Annuelle: 12 };
  const step = months[schedule.frequency];
  if (!step) return result;
  const current = new Date(`${schedule.series.nextDue}T00:00:00Z`);
  const targetEnd = `${monthKey}-31`;
  while (current.toISOString().slice(0, 10) <= targetEnd) {
    current.setUTCDate(1);
    current.setUTCMonth(current.getUTCMonth() + step);
    const lastDay = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0)).getUTCDate();
    current.setUTCDate(Math.min(schedule.series.anchorDay, lastDay));
    const date = current.toISOString().slice(0, 10);
    if (date.startsWith(monthKey)) result.push({ ...schedule.series, id: schedule.id, frequency: schedule.frequency, nextDue: date, projected: true });
  }
  return result;
}

export function renderSchedules() {
  renderScheduleView(false);
}

// Reuse the same actionable overdue list from other views.
export function renderOverdueSchedules() {
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
  const monthLabel = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(calendarMonth);
  const monthSchedules = schedules.flatMap((schedule) => occurrencesForMonth(schedule, monthKey)).sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  // Only pending occurrences can be recorded; projected dates are excluded.
  const overdueSchedules: CalendarOccurrence[] = schedules.filter((schedule) => schedule.nextDue < today).map((schedule) => ({ ...schedule, projected: false })).sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  const overdueCount = overdueSchedules.length;
  const displayedSchedules = showOverdue ? overdueSchedules : monthSchedules;
  // Search upcoming months for both pending occurrences and future projections.
  let nextUpcoming: CalendarOccurrence | undefined;
  for (let offset = 0; offset <= 12 && !nextUpcoming; offset++) {
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const key = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}`;
    nextUpcoming = schedules.flatMap((schedule) => occurrencesForMonth(schedule, key)).filter((item) => item.nextDue >= today).sort((a, b) => a.nextDue.localeCompare(b.nextDue))[0];
  }
  // JavaScript starts the week on Sunday; the calendar starts on Monday.
  const firstDayOffset = (calendarMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: Math.ceil((firstDayOffset + daysInMonth) / 7) * 7 }, (_, index) => {
    const day = index - firstDayOffset + 1;
    const currentDay = day > 0 && day <= daysInMonth;
    const date = currentDay ? `${monthKey}-${String(day).padStart(2, "0")}` : "";
    const entries = monthSchedules.filter((schedule) => schedule.nextDue === date);
    return `<div class="calendar-cell ${currentDay ? "" : "outside"}"><span>${currentDay ? day : ""}</span>${entries.map((entry) => `<small class="calendar-event ${entry.kind}" title="${escapeHtml(entry.label)}">${escapeHtml(entry.label)}</small>`).join("")}</div>`;
  }).join("");
  const totalDue = monthSchedules.filter((schedule) => schedule.kind === "debit").reduce((sum, schedule) => sum + Math.abs(schedule.amount), 0);
  document.querySelector<HTMLDivElement>(".page-content")!.innerHTML = `
    <div class="page-heading schedule-heading"><div><div class="eyebrow">PLANIFICATION</div><h1>Échéances</h1><p>Préparez les opérations récurrentes avant leur intégration au compte.</p></div><button class="primary-button" id="new-schedule"><span>+</span> Nouvelle échéance</button></div>
    <section class="schedule-summary"><div><span>À prévoir en ${monthLabel}</span><strong>${euro(totalDue)}</strong><small>${monthSchedules.length} échéances ce mois</small></div><div class="summary-divider"></div><div><span>Prochaine échéance</span><strong>${nextUpcoming ? new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${nextUpcoming.nextDue}T12:00:00`)) : "—"}</strong><small>${nextUpcoming ? `${nextUpcoming.projected ? "Prévision · " : ""}${escapeHtml(nextUpcoming.label)}` : "Aucune échéance à venir"}</small>${overdueCount ? `<button type="button" id="show-overdue" class="schedule-overdue">${overdueCount} échéance${overdueCount === 1 ? "" : "s"} en retard</button>` : ""}</div><div class="schedule-tip">Une échéance arrivée à son terme peut être enregistrée comme opération et pointée dans le compte.</div></section><p class="schedule-message" role="alert"></p>
    <section class="schedules-workspace"><div class="calendar-panel"><div class="calendar-toolbar"><button id="previous-month" aria-label="Mois précédent">‹</button><h2>${monthLabel}</h2><button id="current-month">Aujourd’hui</button><button id="next-month" aria-label="Mois suivant">›</button></div><div class="calendar-weekdays">${days.map((day) => `<span>${day}</span>`).join("")}</div><div class="calendar-grid">${cells}</div></div><div class="schedule-list-panel"><div class="schedule-list-heading"><div><h2>${showOverdue ? "Échéances en retard" : "Échéances du mois"}</h2><p>${displayedSchedules.length} échéance${displayedSchedules.length === 1 ? "" : "s"} ${showOverdue ? "en retard" : "planifiées"}</p></div>${showOverdue ? '<button id="back-to-month" class="secondary-button">Retour au mois</button>' : ""}</div><div class="schedule-list">${displayedSchedules.map((schedule) => { const account = accounts.find((item) => item.id === schedule.accountId); const destination = accounts.find((item) => item.id === schedule.destinationAccountId); return `<div class="schedule-row"><time><strong>${new Date(`${schedule.nextDue}T12:00:00`).getDate()}</strong><small>${new Intl.DateTimeFormat("fr-FR", { month: "short", ...(showOverdue ? { year: "numeric" } : {}) }).format(new Date(`${schedule.nextDue}T12:00:00`))}</small></time><span class="schedule-row-copy"><strong>${escapeHtml(schedule.label)}</strong><small>${escapeHtml(schedule.category)} · ${escapeHtml(account?.name ?? "Compte")}${schedule.kind === "transfer" ? ` → ${escapeHtml(destination?.name ?? "Compte")}` : ""}</small></span><span class="schedule-amount ${schedule.kind}">${schedule.kind === "credit" ? "+ " : schedule.kind === "transfer" ? "↔ " : "− "}${euro(Math.abs(schedule.amount))}<small>${escapeHtml(schedule.frequency)}</small></span><div class="schedule-row-actions">${schedule.projected ? '<span class="schedule-projected">Prévision</span>' : `<button class="schedule-record" data-edit-schedule="${escapeHtml(schedule.id)}">Modifier</button><button class="schedule-record" data-record-schedule="${escapeHtml(schedule.id)}">Enregistrer</button>`}<button class="secondary-button schedule-delete" data-delete-schedule="${escapeHtml(schedule.id)}">Supprimer</button></div></div>`; }).join("") || `<p class="empty-row">${showOverdue ? "Aucune échéance en retard." : "Aucune échéance pour ce mois."}</p>`}</div></div></section>
    <dialog id="schedule-dialog"><form id="schedule-form"><div class="dialog-heading"><h2>Nouvelle échéance</h2><button type="button" class="dialog-close schedule-close" aria-label="Fermer">×</button></div><label class="schedule-scope" hidden>Appliquer la modification<select name="scope"><option value="occurrence">Cette occurrence uniquement</option><option value="series">Cette occurrence et les suivantes</option></select></label><label><span class="schedule-account-label">Compte</span><select name="accountId" required>${accounts.map((account) => `<option value="${escapeHtml(account.id)}" ${account.id === selectedAccount.id ? "selected" : ""}>${escapeHtml(account.name)}</option>`).join("")}</select></label><label class="schedule-destination" hidden>Compte crédité<select name="destinationAccountId">${accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`).join("")}</select></label><label>Destinataire / libellé<input name="label" list="schedule-payee-suggestions" required maxlength="80"><datalist id="schedule-payee-suggestions"></datalist></label><label>Catégorie<select name="category" required>${categoryOptions()}</select></label><div class="form-row"><label>Type<select name="kind"><option value="debit">Débit</option><option value="credit">Crédit</option><option value="transfer">Virement</option></select></label><label>Montant (€)<input name="amount" type="number" min="0.01" max="1000000000" step="0.01" required></label></div><div class="form-row"><label><span class="schedule-date-label">Première échéance</span><input name="nextDue" type="date" required></label><label>Périodicité<select name="frequency"><option>Mensuelle</option><option>Trimestrielle</option><option>Semestrielle</option><option>Annuelle</option></select></label></div><p class="editor-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-button schedule-close">Annuler</button><button type="submit" class="primary-button">Créer l’échéance</button></div></form></dialog>`;
  const scheduleDialog = document.querySelector<HTMLDialogElement>("#schedule-dialog")!;
  const scheduleForm = scheduleDialog.querySelector<HTMLFormElement>("#schedule-form")!;
  let editingSchedule: Schedule | undefined;
  function updateTransferFields() {
    const transfer = (scheduleForm.elements.namedItem("kind") as HTMLSelectElement).value === "transfer";
    const destination = scheduleForm.elements.namedItem("destinationAccountId") as HTMLSelectElement;
    scheduleForm.querySelector<HTMLElement>(".schedule-destination")!.hidden = !transfer;
    scheduleForm.querySelector(".schedule-account-label")!.textContent = transfer ? "Compte débité" : "Compte";
    destination.disabled = !transfer;
    destination.required = transfer;
    const source = (scheduleForm.elements.namedItem("accountId") as HTMLSelectElement).value;
    if (transfer && (!destination.value || destination.value === source)) destination.value = accounts.find((account) => account.id !== source)?.id ?? "";
  }
  // Reuse the same form for a new series and for an existing occurrence.
  function openScheduleForm(schedule?: Schedule) {
    editingSchedule = schedule;
    scheduleForm.reset();
    scheduleForm.querySelector<HTMLElement>(".editor-error")!.textContent = "";
    scheduleForm.querySelector("h2")!.textContent = schedule ? "Modifier l’échéance" : "Nouvelle échéance";
    scheduleForm.querySelector(".schedule-date-label")!.textContent = schedule ? "Prochaine échéance" : "Première échéance";
    scheduleForm.querySelector<HTMLElement>(".schedule-scope")!.hidden = !schedule;
    const frequencyInput = scheduleForm.elements.namedItem("frequency") as HTMLSelectElement;
    frequencyInput.disabled = !!schedule;
    scheduleForm.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent = schedule ? "Enregistrer" : "Créer l’échéance";
    const setValue = (name: string, value: string) => { (scheduleForm.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value = value; };
    const today = new Date();
    setValue("nextDue", schedule?.nextDue ?? `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`);
    if (schedule) {
      setValue("accountId", schedule.accountId); setValue("label", schedule.label); setValue("category", schedule.category);
      setValue("kind", schedule.kind); setValue("amount", centsInput(Math.abs(schedule.amount))); setValue("frequency", schedule.frequency);
      if (schedule.destinationAccountId) setValue("destinationAccountId", schedule.destinationAccountId);
    }
    updateTransferFields();
    scheduleDialog.showModal();
    void loadPayeeSuggestions(scheduleForm.querySelector<HTMLDataListElement>("#schedule-payee-suggestions")!);
  }
  (scheduleForm.elements.namedItem("kind") as HTMLSelectElement).addEventListener("change", updateTransferFields);
  (scheduleForm.elements.namedItem("accountId") as HTMLSelectElement).addEventListener("change", updateTransferFields);
  // Frequency belongs to the series and cannot be changed for one occurrence.
  scheduleForm.querySelector<HTMLSelectElement>('select[name="scope"]')!.addEventListener("change", (event) => {
    (scheduleForm.elements.namedItem("frequency") as HTMLSelectElement).disabled = (event.currentTarget as HTMLSelectElement).value === "occurrence";
  });
  document.querySelector("#new-schedule")?.addEventListener("click", () => openScheduleForm());
  document.querySelectorAll<HTMLElement>("[data-edit-schedule]").forEach((button) => button.addEventListener("click", () => {
    const schedule = schedules.find((item) => item.id === button.dataset.editSchedule);
    if (schedule) openScheduleForm(schedule);
  }));
  scheduleDialog.querySelectorAll(".schedule-close").forEach((button) => button.addEventListener("click", () => scheduleDialog.close()));
  scheduleForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form);
    const kind = String(values.get("kind"));
    const nextDue = String(values.get("nextDue"));
    const accountId = String(values.get("accountId"));
    const destinationAccountId = kind === "transfer" ? String(values.get("destinationAccountId") ?? "") : null;
    if (kind === "transfer" && (!destinationAccountId || destinationAccountId === accountId)) { form.querySelector<HTMLElement>(".editor-error")!.textContent = "Choisissez deux comptes différents pour le virement."; return; }
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    button.disabled = true;
    try {
      const amount = parseCents(String(values.get("amount")));
      await invoke(editingSchedule ? "update_schedule" : "create_schedule", { scope: editingSchedule ? String(values.get("scope")) : undefined, schedule: { id: editingSchedule?.id ?? crypto.randomUUID(), accountId, destinationAccountId, label: String(values.get("label")).trim(), category: String(values.get("category")).trim(), nextDue, frequency: String(values.get("frequency") ?? editingSchedule?.frequency), amount: kind === "credit" ? amount : -amount, kind } });
      setSchedules(await invoke<Schedule[]>("list_schedules"));
      const [dueYear, dueMonth] = nextDue.split("-").map(Number);
      calendarMonth = new Date(dueYear, dueMonth - 1, 1);
      scheduleDialog.close();
      renderScheduleView(showOverdue);
    } catch (error) { form.querySelector<HTMLElement>(".editor-error")!.textContent = `Enregistrement impossible : ${String(error)}`; button.disabled = false; }
  });
  document.querySelector("#previous-month")?.addEventListener("click", () => { calendarMonth = new Date(year, month - 1, 1); renderSchedules(); });
  document.querySelector("#next-month")?.addEventListener("click", () => { calendarMonth = new Date(year, month + 1, 1); renderSchedules(); });
  document.querySelector("#current-month")?.addEventListener("click", () => { const today = new Date(); calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1); renderSchedules(); });
  document.querySelector("#show-overdue")?.addEventListener("click", () => renderScheduleView(true));
  document.querySelector("#back-to-month")?.addEventListener("click", () => renderScheduleView(false));
  document.querySelectorAll<HTMLButtonElement>("[data-delete-schedule]").forEach((button) => button.addEventListener("click", async () => {
    const schedule = schedules.find((item) => item.id === button.dataset.deleteSchedule);
    if (!schedule || !window.confirm(`Supprimer la série « ${schedule.label} » et toutes ses échéances à venir ? Les opérations déjà enregistrées seront conservées.`)) return;
    button.disabled = true;
    let deleted = false;
    try {
      await invoke("delete_schedule", { id: schedule.id });
      deleted = true;
      setSchedules(await invoke<Schedule[]>("list_schedules"));
      renderScheduleView(showOverdue);
    } catch (error) {
      document.querySelector<HTMLElement>(".schedule-message")!.textContent = deleted ? `Échéance supprimée, mais actualisation impossible : ${String(error)}. Rouvrez l’échéancier.` : `Suppression impossible : ${String(error)}`;
      if (!deleted) button.disabled = false;
    }
  }));
  document.querySelectorAll<HTMLElement>("[data-record-schedule]").forEach((button) => button.addEventListener("click", async () => {
    (button as HTMLButtonElement).disabled = true;
    let recorded = false;
    try {
      await invoke("record_schedule", { id: button.dataset.recordSchedule });
      recorded = true;
      setAccounts(await invoke<Account[]>("list_accounts"));
      setSchedules(await invoke<Schedule[]>("list_schedules"));
      renderScheduleView(showOverdue);
    } catch (error) {
      document.querySelector<HTMLElement>(".schedule-message")!.textContent = recorded ? `Échéance enregistrée, mais actualisation impossible : ${String(error)}. Rouvrez l’échéancier.` : `Enregistrement impossible : ${String(error)}`;
      if (!recorded) (button as HTMLButtonElement).disabled = false;
    }
  }));
}
