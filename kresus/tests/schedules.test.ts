// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

type Series = {
  accountId: string;
  label: string;
  category: string;
  nextDue: string;
  amount: number;
  kind: string;
  anchorDay: number;
  destinationAccountId?: string | null;
};
type Schedule = Omit<Series, "anchorDay"> & {
  id: string;
  frequency: string;
  remainingCount?: number | null;
  endDate?: string | null;
  series: Series;
  futureOverrides?: (Omit<Series, "anchorDay"> & { originalDue: string })[];
};

const baseSeries = (date: string, day: number): Series => ({
  accountId: "account",
  label: "Yolo",
  category: "Divers",
  nextDue: date,
  amount: -100,
  kind: "debit",
  anchorDay: day,
});
const recurring = (date: string, day: number, frequency = "Annuelle"): Schedule => {
  const series = baseSeries(date, day);
  return { ...series, id: "schedule", frequency, series };
};

async function openCalendar(
  schedules: Schedule[],
  twoAccounts = false,
  onRecord?: (id: string) => void,
) {
  // Convert fixture euros to the integer-cent API representation.
  schedules.forEach((item) => {
    item.amount = Math.round(item.amount * 100);
    item.series = { ...item.series, amount: Math.round(item.series.amount * 100) };
  });
  // Use the real calendar renderer with an isolated fake Tauri backend.
  const invoke = vi.fn(
    async (
      command: string,
      args?: { schedule?: Schedule; scope?: string; id?: string; originalDue?: string },
    ) => {
      if (command === "list_accounts")
        return [
          {
            id: "account",
            name: "Compte",
            kind: "Compte courant",
            openingBalance: 0,
            currentBalance: 0,
            bank: "",
          },
          ...(twoAccounts
            ? [
                {
                  id: "saving",
                  name: "Épargne",
                  kind: "Épargne",
                  openingBalance: 0,
                  currentBalance: 0,
                  bank: "",
                },
              ]
            : []),
        ];
      if (command === "list_schedules") return schedules;
      if (command === "list_categories")
        return ["Divers", "Alimentation"].map((name) => ({ id: name, name, parentId: null }));
      if (command === "list_transactions") return [];
      if (command === "list_register")
        return {
          rows: [],
          totalCount: 0,
          filteredCount: 0,
          unreconciledCount: 0,
          income: 0,
          expenses: 0,
          creditCount: 0,
          debitCount: 0,
          page: 1,
          pageCount: 1,
        };
      if (command === "list_payees") return ["Marché <bio>", "EDF"];
      if (command === "create_schedule" && args?.schedule) {
        const item = args.schedule;
        schedules.push({
          ...item,
          series: {
            accountId: item.accountId,
            label: item.label,
            category: item.category,
            nextDue: item.nextDue,
            amount: item.amount,
            kind: item.kind,
            destinationAccountId: item.destinationAccountId,
            anchorDay: Number(item.nextDue.slice(-2)),
          },
        });
        return;
      }
      if (command === "record_schedule") {
        onRecord?.(args!.id!);
        return;
      }
      if (command === "delete_schedule") {
        const index = schedules.findIndex((schedule) => schedule.id === args?.id);
        if (index < 0) throw new Error("Échéance introuvable");
        schedules.splice(index, 1);
        return;
      }
      if (command === "update_future_occurrence" && args?.schedule && args.originalDue) {
        const series = schedules.find((item) => item.id === args.schedule!.id)!;
        series.futureOverrides = (series.futureOverrides ?? []).filter(
          (item) => item.originalDue !== args.originalDue,
        );
        series.futureOverrides.push({ ...args.schedule, originalDue: args.originalDue });
        return;
      }
      if (command === "update_schedule" && args?.schedule && args.scope === "occurrence") {
        schedules[0] = { ...args.schedule, series: schedules[0].series };
        return;
      }
      if (command === "update_schedule" && args?.schedule && args.scope === "series") {
        const updated = args.schedule;
        const original = schedules[0].series;
        const anchorDay =
          updated.nextDue === original.nextDue
            ? original.anchorDay
            : Number(updated.nextDue.slice(-2));
        schedules[0] = {
          ...updated,
          series: {
            accountId: updated.accountId,
            label: updated.label,
            category: updated.category,
            nextDue: updated.nextDue,
            amount: updated.amount,
            kind: updated.kind,
            destinationAccountId: updated.destinationAccountId,
            anchorDay,
          },
        };
        return;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  );
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  await import("../src/main");
  await vi.waitFor(() => expect(document.querySelector("#schedules-nav")).not.toBeNull());
  (document.querySelector("#schedules-nav") as HTMLButtonElement).click();
  return invoke;
}

function calendarEvents() {
  return [...document.querySelectorAll<HTMLElement>(".calendar-cell")].filter((cell) =>
    cell.querySelector(".calendar-event"),
  );
}

describe("schedule calendar", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    document.body.innerHTML = '<div id="app"></div>';
    localStorage.clear();
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("@tauri-apps/api/core");
  });

  it("shows a yearly overview with leap-day projections, limits and month navigation", async () => {
    vi.setSystemTime(new Date(2028, 0, 1, 12));
    const item = recurring("2028-01-31", 31, "Mensuelle");
    item.remainingCount = 2;
    await openCalendar([item]);
    (document.querySelector("#schedule-year-view") as HTMLButtonElement).click();
    const rows = document.querySelectorAll(".annual-schedules tbody tr");
    expect(rows).toHaveLength(12);
    expect(rows[0]?.textContent).toContain("31 · Yolo");
    expect(rows[1]?.textContent).toContain("29 · Yolo (prévision)");
    expect(rows[2]?.textContent).not.toContain("Yolo");
    (document.querySelector('[data-annual-month="1"]') as HTMLButtonElement).click();
    expect(document.querySelector(".calendar-toolbar h2")?.textContent).toBe("février 2028");
    expect(calendarEvents()[0]?.textContent).toContain("29Yolo");
    (document.querySelector("#schedule-year-view") as HTMLButtonElement).click();
    (document.querySelector("#next-year") as HTMLButtonElement).click();
    expect(document.querySelector(".annual-toolbar h2")?.textContent).toBe("2029");
    expect(document.querySelector(".annual-schedules tbody")?.textContent).not.toContain("Yolo");
  });

  it("opens overdue occurrences from the annual view", async () => {
    vi.setSystemTime(new Date(2028, 0, 15, 12));
    await openCalendar([recurring("2028-01-10", 10, "Mensuelle")]);
    (document.querySelector("#schedule-year-view") as HTMLButtonElement).click();
    (document.querySelector("#show-overdue") as HTMLButtonElement).click();
    expect(document.querySelector(".annual-schedules")).toBeNull();
    expect(document.querySelector(".schedule-list-heading")?.textContent).toContain("en retard");
    expect(document.querySelector("[data-record-schedule]")).not.toBeNull();
  });

  it.each([
    { year: 2027, februaryDay: 28 },
    { year: 2028, februaryDay: 29 },
  ])("projects every two months through February $year", async ({ year, februaryDay }) => {
    vi.setSystemTime(new Date(year, 1, 1, 12));
    await openCalendar([recurring(`${year - 1}-12-31`, 31, "Bimestrielle")]);
    expect(calendarEvents()).toHaveLength(1);
    expect(calendarEvents()[0]?.textContent).toContain(String(februaryDay));
    (document.querySelector("#next-month") as HTMLButtonElement).click();
    expect(calendarEvents()).toHaveLength(0);
    (document.querySelector("#next-month") as HTMLButtonElement).click();
    expect(calendarEvents()[0]?.textContent).toContain("30");
  });

  it.each([
    { frequency: "Mensuelle", months: 1, expectedDay: 28 },
    { frequency: "Bimestrielle", months: 2, expectedDay: 31 },
    { frequency: "Trimestrielle", months: 3, expectedDay: 30 },
    { frequency: "Semestrielle", months: 6, expectedDay: 31 },
    { frequency: "Annuelle", months: 12, expectedDay: 31 },
  ])("projects $frequency after $months month(s)", async ({ frequency, months, expectedDay }) => {
    vi.setSystemTime(new Date(2027, 0, 1, 12));
    await openCalendar([recurring("2027-01-31", 31, frequency)]);
    for (let i = 0; i < months; i++) {
      (document.querySelector("#next-month") as HTMLButtonElement).click();
      if (i < months - 1) expect(calendarEvents()).toHaveLength(0);
    }
    expect(calendarEvents().map((cell) => cell.textContent)).toEqual([`${expectedDay}Yolo`]);
  });

  it("stops projections at the count and inclusive leap-day end date", async () => {
    vi.setSystemTime(new Date(2028, 0, 1, 12));
    const counted = recurring("2028-01-31", 31, "Mensuelle");
    counted.remainingCount = 2;
    const dated = recurring("2028-01-31", 31, "Mensuelle");
    dated.id = "dated";
    dated.endDate = "2028-02-29";
    await openCalendar([counted, dated]);
    (document.querySelector("#next-month") as HTMLButtonElement).click();
    expect(document.querySelectorAll(".calendar-event")).toHaveLength(2);
    (document.querySelector("#next-month") as HTMLButtonElement).click();
    expect(document.querySelectorAll(".calendar-event")).toHaveLength(0);
  });

  it("submits a count limit for a new series", async () => {
    vi.setSystemTime(new Date(2028, 0, 1, 12));
    const invoke = await openCalendar([]);
    (document.querySelector("#new-schedule") as HTMLButtonElement).click();
    const form = document.querySelector<HTMLFormElement>("#schedule-form")!;
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    field("label").value = "Mensualité";
    field("amount").value = "10,00";
    field("limitType").value = "count";
    field("limitType").dispatchEvent(new Event("change"));
    field("remainingCount").value = "3";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "create_schedule",
        expect.objectContaining({
          schedule: expect.objectContaining({ remainingCount: 3, endDate: null }),
        }),
      ),
    );
  });

  it("exposes the full calendar label in a native tooltip", async () => {
    vi.setSystemTime(new Date(2027, 0, 1, 12));
    const entry = recurring("2027-01-15", 15, "Mensuelle");
    entry.label = 'Abonnement <internet> "maison"';
    await openCalendar([entry]);
    const event = document.querySelector<HTMLElement>(".calendar-event")!;
    expect(event.title).toBe('Abonnement <internet> "maison"');
    expect(event.textContent).toBe(entry.label);
    expect(event.querySelector("internet")).toBeNull();
  });

  it("distinguishes an overdue occurrence from the next future projection", async () => {
    vi.setSystemTime(new Date(2026, 9, 29, 12));
    await openCalendar([recurring("2026-09-29", 29, "Annuelle")]);
    const summary = document.querySelector(".schedule-summary")!;
    expect(summary.textContent).toContain("29 sept. 2027");
    expect(summary.textContent).toContain("Prévision · Yolo");
    expect(summary.textContent).toContain("1 échéance en retard");
    (document.querySelector("#previous-month") as HTMLButtonElement).click();
    expect(document.querySelector(".schedule-list")?.textContent).toContain("Yolo");
    expect(document.querySelector("[data-record-schedule]")).not.toBeNull();
  });

  it("treats an occurrence due today as upcoming", async () => {
    vi.setSystemTime(new Date(2026, 9, 29, 12));
    await openCalendar([recurring("2026-10-29", 29, "Mensuelle")]);
    expect(document.querySelector(".schedule-summary")?.textContent).toContain("29 oct. 2026");
    expect(document.querySelector(".schedule-summary")?.textContent).not.toContain("en retard");
    expect(document.querySelector(".schedule-summary")?.textContent).not.toContain("Prévision ·");
  });

  it("sums schedule amounts in cents and submits exact cents", async () => {
    vi.setSystemTime(new Date(2026, 9, 1, 12));
    const first = recurring("2026-10-15", 15, "Mensuelle");
    first.amount = -0.1;
    first.series.amount = -0.1;
    const second = recurring("2026-10-16", 16, "Mensuelle");
    second.id = "second";
    second.amount = -0.2;
    second.series.amount = -0.2;
    const invoke = await openCalendar([first, second]);
    expect(document.querySelector(".schedule-summary")?.textContent).toContain("0,30");
    (document.querySelector('[data-edit-schedule="schedule"]') as HTMLButtonElement).click();
    const form = document.querySelector<HTMLFormElement>("#schedule-form")!;
    expect((form.elements.namedItem("amount") as HTMLInputElement).value).toBe("0,10");
    (form.elements.namedItem("amount") as HTMLInputElement).value = "0.29";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "update_schedule",
        expect.objectContaining({ schedule: expect.objectContaining({ amount: -29 }) }),
      ),
    );
  });

  it("confirms deletion of an overdue series and retains the overdue view", async () => {
    vi.setSystemTime(new Date(2026, 9, 29, 12));
    const invoke = await openCalendar([recurring("2026-09-29", 29, "Mensuelle")]);
    (document.querySelector("#show-overdue") as HTMLButtonElement).click();
    (document.querySelector("[data-delete-schedule]") as HTMLButtonElement).click();
    expect(document.querySelector(".confirmation-message")?.textContent).toContain(
      "Les opérations déjà enregistrées seront conservées",
    );
    document
      .querySelector<HTMLDialogElement>(".confirmation-dialog")!
      .dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(invoke).not.toHaveBeenCalledWith("delete_schedule", expect.anything());
    (document.querySelector("[data-delete-schedule]") as HTMLButtonElement).click();
    (document.querySelector(".confirmation-accept") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(document.querySelector(".schedule-list")?.textContent).toContain(
        "Aucune échéance en retard",
      ),
    );
    expect(invoke).toHaveBeenCalledWith("delete_schedule", { id: "schedule" });
    expect(document.querySelector("#show-overdue")).toBeNull();
  });

  it("can delete a series from one of its projected occurrences", async () => {
    vi.setSystemTime(new Date(2026, 9, 1, 12));
    const invoke = await openCalendar([recurring("2026-10-15", 15, "Mensuelle")]);
    (document.querySelector("#next-month") as HTMLButtonElement).click();
    expect(document.querySelector(".schedule-projected")).not.toBeNull();
    (document.querySelector("[data-delete-schedule]") as HTMLButtonElement).click();
    (document.querySelector(".confirmation-accept") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(document.querySelector(".schedule-list")?.textContent).toContain(
        "Aucune échéance pour ce mois",
      ),
    );
    expect(invoke).toHaveBeenCalledWith("delete_schedule", { id: "schedule" });
  });

  it("reports a failed deletion and leaves the series available", async () => {
    vi.setSystemTime(new Date(2026, 9, 1, 12));
    const invoke = await openCalendar([recurring("2026-10-15", 15, "Mensuelle")]);
    invoke.mockRejectedValueOnce(new Error("base indisponible"));
    const button = document.querySelector<HTMLButtonElement>("[data-delete-schedule]")!;
    button.click();
    (document.querySelector(".confirmation-accept") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(document.querySelector(".schedule-message")?.textContent).toContain(
        "Suppression impossible",
      ),
    );
    expect(button.disabled).toBe(false);
    expect(document.querySelector(".schedule-row")?.textContent).toContain("Yolo");
  });

  it("opens overdue occurrences from the summary and keeps the list updated after recording", async () => {
    vi.setSystemTime(new Date(2026, 9, 29, 12));
    const older = { ...recurring("2025-09-29", 29, "Annuelle"), id: "older", label: "Ancienne" };
    const recent = { ...recurring("2026-09-29", 29, "Mensuelle"), id: "recent", label: "Récente" };
    const today = { ...recurring("2026-10-29", 29), id: "today", label: "Aujourd’hui" };
    const items = [recent, today, older];
    const invoke = await openCalendar(items, false, (id) => {
      const item = items.find((schedule) => schedule.id === id)!;
      // One recording can leave another occurrence of the same series overdue.
      item.nextDue = item.nextDue === "2025-09-29" ? "2026-09-29" : "2026-11-29";
    });
    (document.querySelector("#show-overdue") as HTMLButtonElement).click();
    let rows = [...document.querySelectorAll<HTMLElement>(".schedule-row")];
    expect(rows.map((row) => row.querySelector(".schedule-row-copy strong")?.textContent)).toEqual([
      "Ancienne",
      "Récente",
    ]);
    expect(rows[0].textContent).toContain("2025");
    (rows[0].querySelector("[data-edit-schedule]") as HTMLButtonElement).click();
    expect(
      (
        document
          .querySelector<HTMLFormElement>("#schedule-form")!
          .elements.namedItem("label") as HTMLInputElement
      ).value,
    ).toBe("Ancienne");
    (document.querySelector(".schedule-close.secondary-button") as HTMLButtonElement).click();
    (rows[0].querySelector("[data-record-schedule]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("record_schedule", { id: "older" }));
    await vi.waitFor(() =>
      expect(document.querySelector(".schedule-list")?.textContent).not.toContain("2025"),
    );
    expect(document.querySelectorAll(".schedule-row")).toHaveLength(2);
    (document.querySelector('[data-record-schedule="older"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelectorAll(".schedule-row")).toHaveLength(1));
    (document.querySelector('[data-record-schedule="recent"]') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(document.querySelector(".schedule-list")?.textContent).toContain(
        "Aucune échéance en retard",
      ),
    );
    (document.querySelector("#back-to-month") as HTMLButtonElement).click();
    expect(document.querySelector(".schedule-list-heading h2")?.textContent).toBe(
      "Échéances du mois",
    );
  });

  it("suggests existing payees for new and edited schedules without replacing typed text", async () => {
    vi.setSystemTime(new Date(2027, 0, 1, 12));
    const invoke = await openCalendar([recurring("2027-01-15", 15, "Mensuelle")]);
    (document.querySelector("#new-schedule") as HTMLButtonElement).click();
    let form = document.querySelector<HTMLFormElement>("#schedule-form")!;
    let input = form.elements.namedItem("label") as HTMLInputElement;
    expect(input.getAttribute("list")).toBe("schedule-payee-suggestions");
    input.value = "Nouvelle saisie";
    await vi.waitFor(() =>
      expect(
        [...form.querySelectorAll<HTMLOptionElement>("#schedule-payee-suggestions option")].map(
          (option) => option.value,
        ),
      ).toEqual(["Marché <bio>", "EDF"]),
    );
    expect(input.value).toBe("Nouvelle saisie");
    (form.querySelector(".schedule-close.secondary-button") as HTMLButtonElement).click();
    (document.querySelector("[data-edit-schedule]") as HTMLButtonElement).click();
    form = document.querySelector<HTMLFormElement>("#schedule-form")!;
    input = form.elements.namedItem("label") as HTMLInputElement;
    expect(input.value).toBe("Yolo");
    await vi.waitFor(() =>
      expect(form.querySelectorAll("#schedule-payee-suggestions option")).toHaveLength(2),
    );
    input.value = "Nouveau destinataire";
    (form.elements.namedItem("amount") as HTMLInputElement).value = "25";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(document.querySelector(".schedule-list")?.textContent).toContain(
        "Nouveau destinataire",
      ),
    );
    expect(invoke).toHaveBeenCalledWith(
      "update_schedule",
      expect.objectContaining({
        schedule: expect.objectContaining({ label: "Nouveau destinataire" }),
      }),
    );
    expect(invoke.mock.calls.filter(([command]) => command === "list_payees")).toHaveLength(2);
  });

  it("shows an annual 29 February schedule on 28 February in a common year and on 29 February in a leap year", async () => {
    vi.setSystemTime(new Date(2025, 1, 10, 12));
    await openCalendar([recurring("2024-02-29", 29)]);
    expect(calendarEvents().map((cell) => cell.textContent)).toEqual(["28Yolo"]);
    for (let i = 0; i < 36; i++)
      (document.querySelector("#next-month") as HTMLButtonElement).click();
    expect(document.querySelector(".calendar-toolbar h2")?.textContent).toBe("février 2028");
    expect(calendarEvents().map((cell) => cell.textContent)).toEqual(["29Yolo"]);
    expect(document.querySelector(".schedule-projected")?.textContent).toBe("Prévision");
    expect(document.querySelector("[data-record-schedule]")).toBeNull();
  });

  it("places a quarterly schedule in the correct months across a year boundary", async () => {
    vi.setSystemTime(new Date(2027, 0, 10, 12));
    await openCalendar([recurring("2026-11-30", 30, "Trimestrielle")]);
    expect(calendarEvents()).toHaveLength(0);
    (document.querySelector("#next-month") as HTMLButtonElement).click();
    expect(calendarEvents().map((cell) => cell.textContent)).toEqual(["28Yolo"]);
    for (let i = 0; i < 3; i++)
      (document.querySelector("#next-month") as HTMLButtonElement).click();
    expect(calendarEvents().map((cell) => cell.textContent)).toEqual(["30Yolo"]);
  });

  it("shows a one-time exception on its changed date while future projections use the series values", async () => {
    vi.setSystemTime(new Date(2027, 1, 1, 12));
    const series = baseSeries("2027-01-31", 31);
    const changed: Schedule = {
      id: "schedule",
      frequency: "Mensuelle",
      series,
      accountId: "account",
      label: "Exception",
      category: "Divers",
      nextDue: "2027-02-02",
      amount: -25,
      kind: "debit",
    };
    await openCalendar([changed]);
    expect(calendarEvents().map((cell) => cell.textContent)).toEqual(["2Exception", "28Yolo"]);
    expect(document.querySelector(".schedule-list")?.textContent).toContain("25,00");
    expect(document.querySelectorAll("[data-record-schedule]")).toHaveLength(1);
    (document.querySelector("#next-month") as HTMLButtonElement).click();
    expect(calendarEvents().map((cell) => cell.textContent)).toEqual(["31Yolo"]);
    expect(document.querySelector(".schedule-list")?.textContent).toContain("100,00");
    expect(document.querySelector(".schedule-list")?.textContent).not.toContain("Exception");
  });

  it.each(["calendar", "annual"])(
    "edits a future occurrence from the %s view and moves it across months",
    async (view) => {
      vi.setSystemTime(new Date(2028, 0, 1, 12));
      const invoke = await openCalendar([recurring("2028-01-31", 31, "Mensuelle")]);
      if (view === "annual") {
        (document.querySelector("#schedule-year-view") as HTMLButtonElement).click();
      } else {
        (document.querySelector("#next-month") as HTMLButtonElement).click();
      }
      (
        document.querySelector(
          '[data-edit-future][data-original-due="2028-02-29"]',
        ) as HTMLButtonElement
      ).click();
      const form = document.querySelector<HTMLFormElement>("#schedule-form")!;
      expect(form.querySelector<HTMLElement>(".schedule-scope")!.hidden).toBe(true);
      (form.elements.namedItem("nextDue") as HTMLInputElement).value = "2028-03-02";
      (form.elements.namedItem("label") as HTMLInputElement).value = "Exception";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(
          "update_future_occurrence",
          expect.objectContaining({
            originalDue: "2028-02-29",
            schedule: expect.objectContaining({ nextDue: "2028-03-02", label: "Exception" }),
          }),
        ),
      );
      await vi.waitFor(() =>
        expect(document.querySelector("#schedule-dialog")!.hasAttribute("open")).toBe(false),
      );
      if (view === "annual") {
        const rows = document.querySelectorAll(".annual-schedules tbody tr");
        expect(rows[1]!.textContent).not.toContain("Yolo");
        expect(rows[2]!.textContent).toContain("02 · Exception");
        expect(rows[2]!.textContent).toContain("31 · Yolo");
      } else {
        expect(calendarEvents().map((cell) => cell.textContent)).toEqual(["2Exception", "31Yolo"]);
        (document.querySelector("#previous-month") as HTMLButtonElement).click();
        expect(calendarEvents()).toHaveLength(0);
      }
    },
  );

  it("allows a cheque number only when cheque is selected, including for a future occurrence", async () => {
    vi.setSystemTime(new Date(2028, 0, 1, 12));
    const invoke = await openCalendar([recurring("2028-01-31", 31, "Mensuelle")]);
    (document.querySelector("#next-month") as HTMLButtonElement).click();
    (document.querySelector("[data-edit-future]") as HTMLButtonElement).click();
    const form = document.querySelector<HTMLFormElement>("#schedule-form")!;
    const method = form.elements.namedItem("paymentMethod") as HTMLSelectElement;
    const cheque = form.elements.namedItem("cheque") as HTMLInputElement;
    expect(cheque.disabled).toBe(true);
    method.value = "cheque";
    method.dispatchEvent(new Event("change"));
    expect(cheque.disabled).toBe(false);
    cheque.value = "123";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(invoke).not.toHaveBeenCalledWith("update_future_occurrence", expect.anything());
    expect(form.querySelector(".editor-error")?.textContent).toContain("7 chiffres");
    cheque.value = "0012345";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "update_future_occurrence",
        expect.objectContaining({
          schedule: expect.objectContaining({ paymentMethod: "cheque", cheque: "0012345" }),
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(document.querySelector("#schedule-dialog")!.hasAttribute("open")).toBe(false),
    );
    (document.querySelector("[data-edit-future]") as HTMLButtonElement).click();
    expect(document.querySelector<HTMLInputElement>('[name="cheque"]')!.value).toBe("0012345");
  });

  it("saves an occurrence edit and displays its updated date and amount", async () => {
    vi.setSystemTime(new Date(2027, 0, 1, 12));
    const invoke = await openCalendar([recurring("2027-01-15", 15, "Mensuelle")]);
    (document.querySelector("[data-edit-schedule]") as HTMLButtonElement).click();
    const form = document.querySelector<HTMLFormElement>("#schedule-form")!;
    (form.elements.namedItem("nextDue") as HTMLInputElement).value = "2027-01-20";
    (form.elements.namedItem("amount") as HTMLInputElement).value = "25";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(document.querySelector(".schedule-list")?.textContent).toContain("25,00"),
    );
    expect(invoke).toHaveBeenCalledWith(
      "update_schedule",
      expect.objectContaining({
        scope: "occurrence",
        schedule: expect.objectContaining({ nextDue: "2027-01-20", amount: -2500 }),
      }),
    );
    expect(calendarEvents().map((cell) => cell.textContent)).toEqual(["20Yolo"]);
    (document.querySelector("#next-month") as HTMLButtonElement).click();
    expect(calendarEvents().map((cell) => cell.textContent)).toEqual(["15Yolo"]);
    expect(document.querySelector(".schedule-list")?.textContent).toContain("100,00");
  });

  it("updates the current occurrence and following projections when the series scope is selected", async () => {
    vi.setSystemTime(new Date(2027, 0, 1, 12));
    const invoke = await openCalendar([recurring("2027-01-15", 15, "Mensuelle")]);
    (document.querySelector("[data-edit-schedule]") as HTMLButtonElement).click();
    const form = document.querySelector<HTMLFormElement>("#schedule-form")!;
    const scope = form.elements.namedItem("scope") as HTMLSelectElement;
    const frequency = form.elements.namedItem("frequency") as HTMLSelectElement;
    expect(scope.value).toBe("occurrence");
    expect(frequency.disabled).toBe(true);
    scope.value = "series";
    scope.dispatchEvent(new Event("change", { bubbles: true }));
    expect(frequency.disabled).toBe(false);
    frequency.value = "Trimestrielle";
    (form.elements.namedItem("nextDue") as HTMLInputElement).value = "2027-01-20";
    (form.elements.namedItem("label") as HTMLInputElement).value = "Nouveau loyer";
    (form.elements.namedItem("amount") as HTMLInputElement).value = "125";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(document.querySelector(".schedule-list")?.textContent).toContain("125,00"),
    );
    expect(invoke).toHaveBeenCalledWith(
      "update_schedule",
      expect.objectContaining({
        scope: "series",
        schedule: expect.objectContaining({
          nextDue: "2027-01-20",
          frequency: "Trimestrielle",
          label: "Nouveau loyer",
          amount: -12500,
        }),
      }),
    );
    expect(calendarEvents().map((cell) => cell.textContent)).toEqual(["20Nouveau loyer"]);
    (document.querySelector("#next-month") as HTMLButtonElement).click();
    expect(calendarEvents()).toHaveLength(0);
    for (let i = 0; i < 2; i++)
      (document.querySelector("#next-month") as HTMLButtonElement).click();
    expect(calendarEvents().map((cell) => cell.textContent)).toEqual(["20Nouveau loyer"]);
    expect(document.querySelector(".schedule-list")?.textContent).toContain("125,00");
    expect(document.querySelector(".schedule-projected")?.textContent).toBe("Prévision");
  });

  it("cancels a series edit without saving changes", async () => {
    vi.setSystemTime(new Date(2027, 0, 1, 12));
    const invoke = await openCalendar([recurring("2027-01-15", 15, "Mensuelle")]);
    (document.querySelector("[data-edit-schedule]") as HTMLButtonElement).click();
    const form = document.querySelector<HTMLFormElement>("#schedule-form")!;
    const scope = form.elements.namedItem("scope") as HTMLSelectElement;
    scope.value = "series";
    scope.dispatchEvent(new Event("change", { bubbles: true }));
    (form.elements.namedItem("amount") as HTMLInputElement).value = "250";
    (form.querySelector(".schedule-close.secondary-button") as HTMLButtonElement).click();
    expect(invoke).not.toHaveBeenCalledWith("update_schedule", expect.anything());
    expect(calendarEvents().map((cell) => cell.textContent)).toEqual(["15Yolo"]);
    expect(document.querySelector(".schedule-list")?.textContent).toContain("100,00");
  });

  it("creates and records a recurring transfer with distinct accounts", async () => {
    vi.setSystemTime(new Date(2028, 0, 15, 12));
    const invoke = await openCalendar([], true);
    (document.querySelector("#new-schedule") as HTMLButtonElement).click();
    const form = document.querySelector<HTMLFormElement>("#schedule-form")!;
    const kind = form.elements.namedItem("kind") as HTMLSelectElement;
    kind.value = "transfer";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    const destination = form.elements.namedItem("destinationAccountId") as HTMLSelectElement;
    expect(destination.disabled).toBe(false);
    expect(destination.value).toBe("saving");
    (form.elements.namedItem("label") as HTMLInputElement).value = "Épargne mensuelle";
    (form.elements.namedItem("amount") as HTMLInputElement).value = "50";
    (form.elements.namedItem("nextDue") as HTMLInputElement).value = "2028-01-31";
    destination.value = "account";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(form.querySelector("[role=alert]")?.textContent).toContain("deux comptes différents");
    destination.value = "saving";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(document.querySelector(".schedule-list")?.textContent).toContain("Épargne mensuelle"),
    );
    expect(invoke).toHaveBeenCalledWith(
      "create_schedule",
      expect.objectContaining({
        schedule: expect.objectContaining({
          kind: "transfer",
          accountId: "account",
          destinationAccountId: "saving",
          amount: -5000,
        }),
      }),
    );
    expect(document.querySelector(".schedule-list")?.textContent).toContain("Compte → Épargne");
    (document.querySelector("[data-record-schedule]") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "record_schedule",
        expect.objectContaining({ id: expect.any(String) }),
      ),
    );
  });

  it("edits one transfer occurrence while retaining the destination of the series", async () => {
    vi.setSystemTime(new Date(2028, 0, 15, 12));
    const series = {
      ...baseSeries("2028-01-31", 31),
      kind: "transfer",
      destinationAccountId: "saving",
    };
    const item: Schedule = { ...series, id: "scheduled-transfer", frequency: "Mensuelle", series };
    const invoke = await openCalendar([item], true);
    (document.querySelector("[data-edit-schedule]") as HTMLButtonElement).click();
    const form = document.querySelector<HTMLFormElement>("#schedule-form")!;
    expect((form.elements.namedItem("kind") as HTMLSelectElement).value).toBe("transfer");
    expect((form.elements.namedItem("destinationAccountId") as HTMLSelectElement).value).toBe(
      "saving",
    );
    (form.elements.namedItem("amount") as HTMLInputElement).value = "20";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(document.querySelector(".schedule-list")?.textContent).toContain("20,00"),
    );
    expect(invoke).toHaveBeenCalledWith(
      "update_schedule",
      expect.objectContaining({
        scope: "occurrence",
        schedule: expect.objectContaining({
          kind: "transfer",
          destinationAccountId: "saving",
          amount: -2000,
        }),
      }),
    );
    (document.querySelector("#next-month") as HTMLButtonElement).click();
    expect(document.querySelector(".schedule-list")?.textContent).toContain("100,00");
    expect(document.querySelector(".schedule-list")?.textContent).toContain("Compte → Épargne");
  });
});
