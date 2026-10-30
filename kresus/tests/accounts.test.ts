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
    expect(document.querySelector(".sidebar > .database-controls #choose-database")).not.toBeNull();
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
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("record_schedule", { id: "0" }));
    await vi.waitFor(() => expect(document.querySelectorAll(".schedule-row")).toHaveLength(5));
  });

  it("opens the account list from the breadcrumb and navigates to a selected account", async () => {
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

  it("creates and selects an account with its type and opening balance", async () => {
    const invoke = await openRegister();
    click(".add-account");
    const form = document.querySelector<HTMLFormElement>("#account-form")!;
    field(form, "name").value = "  Livret A  ";
    field(form, "kind").value = "Épargne";
    field(form, "bank").value = "  Banque  ";
    field(form, "balance").value = "-12.50";
    submit(form);
    await vi.waitFor(() =>
      expect(document.querySelector(".page-heading h1")?.textContent).toBe("Livret A"),
    );
    expect(invoke).toHaveBeenCalledWith("create_account", {
      account: expect.objectContaining({
        name: "Livret A",
        kind: "Épargne",
        bank: "Banque",
        openingBalance: -1250,
      }),
    });
    expect(document.querySelector(".account-item.active")?.textContent).toContain("Livret A");
    expect(document.querySelector(".balance-card")?.textContent).toContain("12,50");
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
