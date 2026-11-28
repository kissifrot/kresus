// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRegister, field, submit, click } from "./register-fixtures";

describe("accounts", () => {
  beforeEach(() => {
    vi.resetModules();
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

  it("stages unique OFX matches across pages while leaving competing or incomplete choices pending", async () => {
    const invoke = await openRegister();
    const candidates = new Map([
      [0, ["unique"]],
      [1, ["shared"]],
      [2, ["shared"]],
      [3, ["overlap"]],
      [4, ["overlap", "other"]],
      [5, ["reserved"]],
      [6, ["reserved", "available"]],
      [7, ["possibly-hidden"]],
      [8, ["truncated"]],
      [25, ["next-page"]],
    ]);
    invoke.mockResolvedValueOnce({
      previewId: "preview",
      fileName: "releve.ofx",
      bankId: "00001",
      bankAccount: "0012",
      matchDays: 7,
      closing: { amount: 0, date: "2027-01-01" },
      rows: Array.from({ length: 27 }, (_, index) => ({
        date: "2027-01-01",
        label: `Opération ${index + 1}`,
        amount: index === 7 || index === 8 ? -5000 : -1000,
        duplicate: index === 26 ? "alreadyImported" : null,
        candidates: (candidates.get(index) ?? []).map((id) => ({
          id,
          date: "2027-01-01",
          label: id,
          category: "Alimentation",
          reconciled: false,
        })),
        moreCandidates: index === 8,
      })),
    });
    click("#bank-import");
    const button = "#bank-import-match-pending";
    await vi.waitFor(() => expect(document.querySelector(button)?.textContent).toContain("(2)"));
    const reserve = document.querySelector<HTMLSelectElement>('[data-bank-line="5"]')!;
    reserve.value = "match:reserved";
    reserve.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.querySelector(button)?.textContent).toContain("(3)");

    click('[data-bank-select="0"]');
    click('[data-bank-select="1"]');
    click('[data-bank-select="7"]');
    click("#bank-import-next");
    click('[data-bank-select="25"]');
    click('[data-bank-filter="pending"]');
    const visibleChoices = () =>
      Array.from(document.querySelectorAll<HTMLSelectElement>("[data-bank-line]"));
    const selectionButton = document.querySelector<HTMLButtonElement>(
      "#bank-import-match-selection",
    )!;
    expect(selectionButton.hidden).toBe(false);
    expect(selectionButton.textContent).toContain("(2)");
    selectionButton.click();
    expect(visibleChoices().map((select) => Number(select.dataset.bankLine))).toEqual([
      1, 2, 3, 4, 6, 7, 8,
    ]);
    expect(selectionButton.hidden).toBe(true);
    expect(document.querySelector("#bank-import-selection-count")?.textContent).toBe(
      "2 lignes cochées",
    );

    click("#bank-import-clear-selection");
    expect(document.querySelector(button)?.textContent).toContain("(1)");
    click(button);
    expect(visibleChoices().map((select) => Number(select.dataset.bankLine))).toEqual([
      1, 2, 3, 4, 7, 8,
    ]);
    expect(visibleChoices().every((select) => select.value === "")).toBe(true);
    expect(document.querySelector<HTMLButtonElement>(button)?.hidden).toBe(true);

    click('[data-bank-filter="match"]');
    expect(visibleChoices().map((select) => select.value)).toEqual([
      "match:unique",
      "match:reserved",
      "match:available",
      "match:next-page",
    ]);
    expect(invoke).not.toHaveBeenCalledWith("import_bank_statement", expect.anything());
  });

  it("selects and clears all eligible OFX rows in the active filter across pages", async () => {
    const invoke = await openRegister();
    invoke.mockResolvedValueOnce({
      previewId: "preview",
      fileName: "releve.ofx",
      bankId: "00001",
      bankAccount: "0012",
      matchDays: 3,
      closing: { amount: 0, date: "2027-01-01" },
      rows: Array.from({ length: 54 }, (_, index) => ({
        date: "2027-01-01",
        label: `Opération ${index + 1}`,
        amount: -2000,
        duplicate: index === 52 ? "alreadyImported" : null,
        candidates:
          index === 53
            ? [{ id: "debit", date: "2027-01-01", label: "Courses", category: "Alimentation" }]
            : [],
      })),
    });
    click("#bank-import");
    await vi.waitFor(() =>
      expect(document.querySelector("#bank-import-select-all")).not.toBeNull(),
    );
    const selectAll = document.querySelector<HTMLInputElement>("#bank-import-select-all")!;
    const pagination = document.querySelector<HTMLElement>(".bank-import-dialog .pagination")!;
    const tableWrap = document.querySelector<HTMLElement>(".bank-import-table")!;
    const count = () => document.querySelector("#bank-import-selection-count")?.textContent;
    const rowCheckbox = (index: number) =>
      document.querySelector<HTMLInputElement>(`[data-bank-select="${index}"]`)!;
    expect(pagination.hidden).toBe(false);
    expect(pagination.querySelector("#bank-import-page-number")?.textContent).toBe("1 / 3");
    click('[data-bank-filter="pending"]');
    expect(pagination.hidden).toBe(true);
    rowCheckbox(53).click();
    expect(selectAll.checked).toBe(true);

    click('[data-bank-filter="add"]');
    expect(pagination.hidden).toBe(false);
    expect(selectAll.checked).toBe(false);
    selectAll.click();
    expect(count()).toBe("53 lignes cochées");
    tableWrap.scrollTop = 200;
    click("#bank-import-next");
    expect(tableWrap.scrollTop).toBe(0);
    expect(pagination.querySelector("#bank-import-page-number")?.textContent).toBe("2 / 3");
    expect(rowCheckbox(25).checked).toBe(true);
    rowCheckbox(25).click();
    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(true);
    expect(count()).toBe("52 lignes cochées");
    selectAll.click();
    expect(selectAll.checked).toBe(true);
    expect(selectAll.indeterminate).toBe(false);
    selectAll.click();
    expect(count()).toBe("1 ligne cochée");
    expect(rowCheckbox(25).checked).toBe(false);

    tableWrap.scrollTop = 200;
    click("#bank-import-previous");
    expect(tableWrap.scrollTop).toBe(0);

    click('[data-bank-filter="duplicate"]');
    expect(selectAll.disabled).toBe(true);
    expect(selectAll.checked).toBe(false);
    click('[data-bank-filter="pending"]');
    expect(rowCheckbox(53).checked).toBe(true);
    click('[data-bank-filter="pending"]');
    expect(selectAll.indeterminate).toBe(true);
    selectAll.click();
    expect(count()).toBe("53 lignes cochées");
  });

  it.each(["add", "skip"] as const)(
    "filters OFX lines across pages and can %s all remaining choices",
    async (action) => {
      const invoke = await openRegister();
      const original = invoke.getMockImplementation()!;
      const candidate = {
        id: "debit",
        date: "2027-01-01",
        label: "Courses",
        category: "Alimentation",
        reconciled: false,
      };
      const pendingRows = [25, 26, 50];
      const newRows = [0, 53];
      invoke.mockImplementation(async (command, args) => {
        if (command === "preview_bank_statement") {
          return {
            previewId: "preview",
            fileName: "releve.ofx",
            bankId: "00001",
            bankAccount: "0012",
            matchDays: 3,
            closing: { amount: 0, date: "2027-01-01" },
            rows: Array.from({ length: 54 }, (_, index) => ({
              date: "2027-01-01",
              label: `Opération ${index + 1}`,
              amount: -2000,
              duplicate:
                pendingRows.includes(index) || newRows.includes(index) ? null : "alreadyImported",
              candidates: pendingRows.includes(index) ? [candidate] : [],
            })),
          };
        }
        if (command === "import_bank_statement") return { added: 1, matched: 1, skipped: 52 };
        if (command === "reconciliation_balance") return 0;
        return original(command, args);
      });
      click("#bank-import");
      await vi.waitFor(() => expect(document.querySelector("#bank-import-confirm")).not.toBeNull());
      click("#bank-import-confirm");
      const error = document.querySelector(".bank-import-dialog .editor-error")!;
      expect(error.textContent).toContain("3 lignes à vérifier");
      expect(document.activeElement).toBe(document.querySelector('[data-bank-line="25"]'));
      expect(invoke).not.toHaveBeenCalledWith("import_bank_statement", expect.anything());

      const choose = (index: number, value: string) => {
        const select = document.querySelector<HTMLSelectElement>(`[data-bank-line="${index}"]`)!;
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const visibleChoices = () =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-bank-line]"), (select) =>
          Number(select.dataset.bankLine),
        );
      const filter = (name: string) => click(`[data-bank-filter="${name}"]`);
      choose(25, "match:debit");
      expect(error.textContent).toContain("2 lignes à vérifier");
      filter("add");
      expect(visibleChoices()).toEqual([0, 53]);
      choose(0, "skip");
      expect(visibleChoices()).toEqual([53]);
      filter("skip");
      expect(visibleChoices()).toEqual([0]);
      filter("duplicate");
      expect(document.querySelector("#bank-import-page-number")?.textContent).toBe("1 / 2");
      expect(visibleChoices()).toEqual([]);
      expect(document.querySelector("[data-bank-select]")).toBeNull();
      expect(document.querySelector("#bank-import-lines")?.textContent).toContain("Déjà importée");
      filter("pending");
      expect(visibleChoices()).toEqual([26, 50]);
      filter("pending");
      expect(visibleChoices()).toEqual([0]);
      filter("match");
      expect(visibleChoices()).toEqual([25]);

      click(`#bank-import-${action}-pending`);
      expect(error.textContent).toBe("");
      expect(invoke).not.toHaveBeenCalledWith("import_bank_statement", expect.anything());
      filter(action);
      expect(visibleChoices()).toEqual(action === "add" ? [26, 50, 53] : [0, 26, 50]);
      const selectionActions = document.querySelector<HTMLElement>(
        "#bank-import-selection-actions",
      )!;
      const checkbox = (index: number) => `[data-bank-select="${index}"]`;
      const opposite = action === "add" ? "skip" : "add";
      expect(selectionActions.hidden).toBe(true);
      click(checkbox(50));
      expect(selectionActions.hidden).toBe(false);
      click("#bank-import-clear-selection");
      expect(selectionActions.hidden).toBe(true);
      expect(document.querySelector<HTMLInputElement>(checkbox(50))?.checked).toBe(false);
      click(checkbox(50));
      filter(action);
      click("#bank-import-next");
      click(checkbox(26));
      filter(action);
      expect(document.querySelector<HTMLInputElement>(checkbox(50))?.checked).toBe(true);
      expect(document.querySelector<HTMLInputElement>(checkbox(26))?.checked).toBe(true);
      expect(document.querySelector("#bank-import-selection-count")?.textContent).toBe(
        "2 lignes cochées",
      );
      click(`#bank-import-${opposite}-selection`);
      expect(selectionActions.hidden).toBe(true);
      expect(visibleChoices()).toEqual(action === "add" ? [53] : [0]);
      expect(invoke).not.toHaveBeenCalledWith("import_bank_statement", expect.anything());
      click("#bank-import-confirm");
      await vi.waitFor(() => expect(document.querySelector(".bank-import-dialog")).toBeNull());
      expect(invoke).toHaveBeenCalledWith("import_bank_statement", {
        previewId: "preview",
        choices: Array.from({ length: 54 }, (_, index) => {
          if (index === 25) return { action: "match", transactionId: "debit" };
          if (index === 53) return { action: "add" };
          return { action: [26, 50].includes(index) ? opposite : "skip" };
        }),
      });
    },
  );

  it("keeps the household view when a pending register request finishes", async () => {
    const invoke = await openRegister();
    const original = invoke.getMockImplementation()!;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    invoke.mockImplementation(async (command, args) => {
      if (command === "list_register") await pending;
      return original(command, args);
    });
    click("#filter-unreconciled");
    click("#household-nav");
    finish();
    await vi.waitFor(async () => {
      await Promise.all(invoke.mock.results.map((result) => result.value));
      expect(document.querySelector(".page-heading h1")?.textContent).toBe("Vue d’ensemble");
    });
  });

  it("shows the current balance and a separate amount for future transactions", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2027, 0, 1, 12));
    await openRegister();
    expect(document.querySelector(".balance-card > strong")?.textContent).toContain("80,00");
    expect(document.querySelector(".balance-card")?.textContent).toMatch(
      /Avec opérations futures · 130,00/,
    );
    expect(document.querySelector(".account-balance")?.textContent).toContain("80,00");
  });

  it("starts with no accounts and opens the register after creating the first account", async () => {
    const invoke = await openRegister({ accounts: [], transactions: [] });
    expect(document.querySelector(".page-heading h1")?.textContent).toBe("Mes comptes");
    expect(document.querySelector("[data-account]")).toBeNull();
    expect(invoke.mock.calls.some(([command]) => command === "list_register")).toBe(false);

    click("#empty-add-account");
    const form = document.querySelector<HTMLFormElement>("#account-form")!;
    expect(form.closest("dialog")?.open).toBe(true);
    field(form, "name").value = "Compte personnel";
    submit(form);
    await vi.waitFor(() =>
      expect(document.querySelector(".page-heading h1")?.textContent).toBe("Compte personnel"),
    );
    expect(document.querySelectorAll("[data-account]")).toHaveLength(1);
    expect(document.querySelector("tr[data-transaction]")).toBeNull();
    expect(document.querySelector("#new-transaction")).not.toBeNull();
    expect(document.querySelector("#edit-account")?.textContent).toBe("Modifier le compte");
  });

  it("loads the selected account’s balance history only when requested", async () => {
    const invoke = await openRegister();
    expect(document.querySelector<HTMLElement>("#balance-history")!.hidden).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith("balance_history", expect.anything());
    click("#balance-history-toggle");
    await vi.waitFor(() =>
      expect(document.querySelectorAll("#balance-history circle")).toHaveLength(12),
    );
    expect(invoke).toHaveBeenCalledWith(
      "balance_history",
      expect.objectContaining({ accountId: "one" }),
    );
    expect(document.querySelector("#balance-history")?.textContent).toContain("60,00");
    expect(document.querySelector("#balance-history-toggle")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
    click("#balance-history-toggle");
    expect(document.querySelector<HTMLElement>("#balance-history")!.hidden).toBe(true);
  });

  it("shows the forecast using the current balance and lets a chart point open its detail", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2027, 0, 2, 12));
    Element.prototype.scrollIntoView = vi.fn();
    const invoke = await openRegister({
      transactions: [
        {
          id: "later",
          accountId: "one",
          date: "2027-02-01",
          label: "Facture",
          category: "Divers",
          amount: -120,
          reconciled: false,
        },
      ],
    });
    click("#balance-forecast-toggle");
    await vi.waitFor(() =>
      expect(document.querySelector("#balance-forecast")?.textContent).toContain("Solde négatif"),
    );
    expect(invoke).toHaveBeenCalledWith("forecast_transactions", {
      accountId: "one",
      today: "2027-01-02",
      end: "2027-04-02",
    });
    expect(document.querySelector("#balance-forecast strong")?.textContent).toContain("20,00");
    document
      .querySelector<SVGElement>(".forecast-point")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector<HTMLDetailsElement>(".forecast-days details")!.open).toBe(true);
    expect(document.querySelector(".forecast-days")?.textContent).toContain("Facture");
  });

  it("defaults a new operation to the local calendar date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2027, 0, 2, 0, 30));
    const iso = vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2027-01-01T23:30:00.000Z");
    await openRegister();
    expect(
      document.querySelector<HTMLInputElement>('#transaction-form input[name="date"]')?.value,
    ).toBe("2027-01-02");
    vi.setSystemTime(new Date(2027, 0, 3, 0, 30));
    click("#new-transaction");
    expect(
      document.querySelector<HTMLInputElement>('#transaction-form input[name="date"]')?.value,
    ).toBe("2027-01-03");
    iso.mockRestore();
  });

  it("keeps the account list scroll position after a refresh", async () => {
    await openRegister();
    document.querySelector<HTMLElement>(".sidebar-accounts")!.scrollTop = 120;
    const filter = document.querySelector<HTMLSelectElement>("#transaction-filter")!;
    filter.value = "credit";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).not.toContain("Courses"),
    );
    expect(document.querySelector<HTMLElement>(".sidebar-accounts")!.scrollTop).toBe(120);
    expect(document.querySelector(".sidebar-accounts #choose-database")).toBeNull();
    expect(document.querySelector(".sidebar > .database-controls #choose-database")).toBeNull();
  });

  it("shows the next five pending schedules in date order, including overdue and transfer details", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2027, 0, 15, 12));
    const item = (id: string, nextDue: string, kind: "debit" | "credit" | "transfer") => {
      const series = {
        accountId: "one",
        label: id,
        category: "Divers",
        nextDue,
        amount: kind === "credit" ? 20 : -20,
        kind,
        destinationAccountId: kind === "transfer" ? "two" : null,
        anchorDay: Number(nextDue.slice(-2)),
      };
      return { ...series, id, frequency: "Mensuelle", series };
    };
    await openRegister({
      accounts: [
        { id: "one", name: "Principal", kind: "Compte courant", openingBalance: 0, bank: "" },
        { id: "two", name: "Livret", kind: "Épargne", openingBalance: 0, bank: "" },
      ],
      transactions: [],
      schedules: [
        item("Sixième", "2027-03-01", "debit"),
        item("Virement", "2027-01-18", "transfer"),
        item("Ancienne", "2027-01-10", "debit"),
        item("Salaire", "2027-01-16", "credit"),
        item("Loyer", "2027-02-01", "debit"),
        item("Internet", "2027-02-05", "debit"),
      ],
    });
    click("#household-breadcrumb");
    const rows = [...document.querySelectorAll<HTMLElement>(".household-schedule-row")];
    expect(rows).toHaveLength(5);
    expect(
      rows.map((row) => row.querySelector(".household-schedule-name strong")?.textContent),
    ).toEqual(["Ancienne", "Salaire", "Virement", "Loyer", "Internet"]);
    expect(rows[0].textContent).toContain("En retard");
    expect(rows[1].textContent).toContain("+ 20,00");
    expect(rows[2].textContent).toContain("Principal → Livret");
    expect(document.querySelector(".household-schedules")?.textContent).not.toContain("Sixième");
    click("#household-schedules");
    expect(document.querySelector(".page-heading h1")?.textContent).toBe("Échéances");
  });

  it("shows an empty state when the household has no schedules", async () => {
    await openRegister({ schedules: [] });
    click("#household-breadcrumb");
    expect(document.querySelector(".household-schedules")?.textContent).toContain(
      "Aucune échéance à venir",
    );
    expect(document.querySelector("#household-overdue")).toBeNull();
  });

  it("opens all overdue schedules from the household and records one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2027, 0, 15, 12));
    const schedules = Array.from({ length: 6 }, (_, index) => {
      const series = {
        accountId: "one",
        label: `Échéance ${index}`,
        category: "Divers",
        nextDue: `2027-01-0${index + 1}`,
        amount: -20,
        kind: "debit" as const,
        anchorDay: index + 1,
      };
      return { ...series, id: String(index), frequency: "Mensuelle", series };
    });
    const invoke = await openRegister({ schedules });
    click("#household-breadcrumb");
    expect(document.querySelector("#household-overdue")?.textContent).toBe("6 échéances en retard");
    expect(document.querySelectorAll(".household-schedule-row")).toHaveLength(5);
    click("#household-overdue");
    expect(document.querySelector(".schedule-list-heading h2")?.textContent).toBe(
      "Échéances en retard",
    );
    expect(document.querySelectorAll(".schedule-row")).toHaveLength(6);
    expect(document.querySelector('[data-edit-schedule="0"]')).not.toBeNull();
    click('[data-record-schedule="0"]');
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("record_schedule", {
        id: "0",
        originalDue: "2027-01-01",
        expectedDue: "2027-01-01",
      }),
    );
    await vi.waitFor(() => expect(document.querySelectorAll(".schedule-row")).toHaveLength(5));
  });

  it("opens the account list from the breadcrumb and navigates to a selected account", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2027, 2, 1, 12));
    await openRegister({
      accounts: [
        {
          id: "one",
          name: "Principal",
          kind: "Compte courant",
          openingBalance: 100,
          bank: "Banque",
        },
        { id: "two", name: "Livret", kind: "Épargne", openingBalance: 200, bank: "Banque" },
      ],
      transactions: [
        {
          id: "deposit",
          accountId: "two",
          date: "2027-01-01",
          label: "Intérêts",
          category: "Divers",
          amount: 25,
          reconciled: false,
        },
      ],
    });
    click("#accounts-breadcrumb");
    expect(document.querySelector(".page-heading h1")?.textContent).toBe("Mes comptes");
    expect(document.querySelector(".accounts-overview")?.textContent).toContain("Comptes courants");
    expect(document.querySelector(".accounts-overview")?.textContent).toContain(
      "Comptes d’épargne",
    );
    expect(document.querySelector('[data-open-account="two"]')?.textContent).toContain("225,00");
    click('[data-open-account="two"]');
    await vi.waitFor(() =>
      expect(document.querySelector(".page-heading h1")?.textContent).toBe("Livret"),
    );
    expect(document.querySelector("tbody")?.textContent).toContain("Intérêts");
    click("#accounts-breadcrumb");
    click("#list-add-account");
    expect(document.querySelector<HTMLDialogElement>("#account-dialog")?.open).toBe(true);
  });

  it("opens the household overview with per-type totals and links to accounts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2027, 2, 1, 12));
    await openRegister({
      accounts: [
        {
          id: "one",
          name: "Principal",
          kind: "Compte courant",
          openingBalance: -20,
          bank: "Banque",
        },
        { id: "two", name: "Livret", kind: "Épargne", openingBalance: 200, bank: "" },
        { id: "three", name: "Assurance", kind: "Assurance vie", openingBalance: 300, bank: "" },
      ],
      transactions: [
        {
          id: "interest",
          accountId: "two",
          date: "2027-01-01",
          label: "Intérêts",
          category: "Divers",
          amount: 25,
          reconciled: false,
        },
      ],
    });
    click("#household-breadcrumb");
    expect(document.querySelector(".page-heading h1")?.textContent).toBe("Vue d’ensemble");
    const cards = document.querySelectorAll<HTMLElement>(".household-summary .summary-card");
    expect(cards[0].textContent).toContain("505,00");
    expect(cards[1].textContent).toContain("20,00");
    expect(cards[2].textContent).toContain("225,00");
    expect(cards[3].textContent).toContain("300,00");
    expect(document.querySelector('[data-household-account="two"]')?.textContent).toContain(
      "225,00",
    );
    click('[data-household-account="two"]');
    await vi.waitFor(() =>
      expect(document.querySelector(".page-heading h1")?.textContent).toBe("Livret"),
    );
    expect(document.querySelector("tbody")?.textContent).toContain("Intérêts");
    click("#accounts-breadcrumb");
    click("#household-breadcrumb");
    click("#household-accounts");
    expect(document.querySelector(".page-heading h1")?.textContent).toBe("Mes comptes");
    click("#household-nav");
    expect(document.querySelector(".page-heading h1")?.textContent).toBe("Vue d’ensemble");
  });

  it("creates an account and can update its type and number", async () => {
    const invoke = await openRegister();
    click(".add-account");
    const form = document.querySelector<HTMLFormElement>("#account-form")!;
    field(form, "name").value = "  Livret A  ";
    field(form, "kind").value = "Épargne";
    field(form, "bank").value = "  Banque  ";
    field(form, "accountNumber").value = "  00012 AB  ";
    field(form, "balance").value = "-12,50";
    submit(form);
    await vi.waitFor(() =>
      expect(document.querySelector(".page-heading h1")?.textContent).toBe("Livret A"),
    );
    expect(invoke).toHaveBeenCalledWith("create_account", {
      account: expect.objectContaining({
        name: "Livret A",
        kind: "Épargne",
        bank: "Banque",
        accountNumber: "00012 AB",
        openingBalance: -1250,
      }),
    });
    expect(document.querySelector(".account-item.active")?.textContent).toContain("Livret A");
    expect(document.querySelector(".balance-card")?.textContent).toContain("12,50");
    expect(document.querySelector("#account-number")?.textContent).toContain("00012 AB");

    click("#edit-account");
    const settingsForm = document.querySelector<HTMLFormElement>("#account-settings-form")!;
    expect(field(settingsForm, "accountNumber").value).toBe("00012 AB");
    expect(field(settingsForm, "kind").value).toBe("Épargne");
    field(settingsForm, "accountNumber").value = "";
    field(settingsForm, "kind").value = "Assurance vie";
    submit(settingsForm);
    await vi.waitFor(() => expect(document.querySelector("#account-number")).toBeNull());
    expect(document.querySelector(".account-heading .eyebrow")?.textContent).toContain(
      "Assurance vie",
    );
    expect(
      document.querySelector(".account-item.active")?.closest(".account-group")?.textContent,
    ).toContain("ASSURANCE VIE");
    expect(document.querySelector(".balance-card")?.textContent).toContain("12,50");
  });

  it("keeps archived registers accessible and restores them to the sidebar", async () => {
    const invoke = await openRegister();
    click("#edit-account");
    const form = document.querySelector<HTMLFormElement>("#account-settings-form")!;
    field(form, "name").value = "Compte renommé";
    field(form, "bank").value = "Nouvel établissement";
    const archive = form.querySelector<HTMLInputElement>('[name="archived"]')!;
    archive.checked = true;
    submit(form);
    await vi.waitFor(() =>
      expect(document.querySelector("h1")?.textContent).toBe("Compte renommé"),
    );
    expect(document.querySelector(".account-heading .eyebrow")?.textContent).toContain("Archivé");
    expect(document.querySelector("[data-account]")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("update_account", {
      id: "one",
      settings: {
        name: "Compte renommé",
        kind: "Compte courant",
        bank: "Nouvel établissement",
        accountNumber: null,
        archived: true,
      },
    });

    click("#accounts-nav");
    expect(document.querySelector(".archived-accounts > summary")?.textContent).toBe(
      "Comptes archivés (1)",
    );
    document.querySelector<HTMLDetailsElement>(".archived-accounts")!.open = true;
    click('[data-open-account="one"]');
    await vi.waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).toContain("Courses"),
    );
    click("#edit-account");
    const restore = document.querySelector<HTMLFormElement>("#account-settings-form")!;
    const checked = restore.querySelector<HTMLInputElement>('[name="archived"]')!;
    expect(checked.checked).toBe(true);
    checked.checked = false;
    submit(restore);
    await vi.waitFor(() =>
      expect(document.querySelector("[data-account]")?.textContent).toContain(
        "Nouvel établissement",
      ),
    );
  });

  it("opens the list of accounts on startup when only archives exist", async () => {
    const invoke = await openRegister({
      accounts: [
        {
          id: "old",
          name: "Historique",
          kind: "Épargne",
          openingBalance: 0,
          bank: "",
          archived: true,
        },
      ],
      transactions: [],
    });
    expect(document.querySelector("h1")?.textContent).toBe("Mes comptes");
    expect(document.querySelector(".archived-accounts")?.textContent).toContain("Historique");
    expect(invoke.mock.calls.some(([command]) => command === "list_register")).toBe(false);
  });

  it("shows an account creation error and allows a retry", async () => {
    await openRegister({ failAccount: true });
    click(".add-account");
    const form = document.querySelector<HTMLFormElement>("#account-form")!;
    field(form, "name").value = "Livret";
    submit(form);
    await vi.waitFor(() =>
      expect(form.querySelector("[role=alert]")?.textContent).toContain("Erreur de base"),
    );
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    expect(document.querySelector<HTMLDialogElement>("#account-dialog")?.open).toBe(true);
  });
});
