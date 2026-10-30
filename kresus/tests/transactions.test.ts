// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRegister, field, submit, click } from "./register-fixtures";

describe("transaction register", () => {
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

  it("searches the whole account history, combines filters and clears the search", async () => {
    const entries = Array.from({ length: 120 }, (_, i) => ({
      id: `item-${String(i).padStart(3, "0")}`,
      accountId: "one",
      date: "2027-01-01",
      label: i === 0 ? "Électricité" : `Opération ${i}`,
      category: "Divers",
      amount: -1,
      reconciled: false,
    }));
    const invoke = await openRegister({ transactions: entries });
    click("#next-page");
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLInputElement>("#page-input")?.value).toBe("2"),
    );
    document.querySelector<HTMLInputElement>("#transaction-search")!.value = "ÉLECTRICITÉ";
    submit(document.querySelector<HTMLFormElement>("#transaction-search-form")!);
    await vi.waitFor(() =>
      expect(document.querySelectorAll("tr[data-transaction]")).toHaveLength(1),
    );
    expect(document.querySelector("tbody")?.textContent).toContain("Électricité");
    expect(document.querySelector<HTMLInputElement>("#page-input")?.value).toBe("1");
    expect(invoke).toHaveBeenCalledWith(
      "list_register",
      expect.objectContaining({ search: "ÉLECTRICITÉ", page: 1 }),
    );
    const filter = document.querySelector<HTMLSelectElement>("#transaction-filter")!;
    filter.value = "credit";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).toContain("Aucune opération"),
    );
    document.querySelector<HTMLInputElement>("#transaction-search")!.value = "";
    submit(document.querySelector<HTMLFormElement>("#transaction-search-form")!);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith(
        "list_register",
        expect.objectContaining({ search: "", filter: "credit" }),
      ),
    );
  });

  it("shows the year for historical operations with the same day and month", async () => {
    await openRegister({
      transactions: [
        {
          id: "old",
          accountId: "one",
          date: "2016-10-29",
          label: "Ancienne",
          category: "Divers",
          amount: -1,
          reconciled: false,
        },
        {
          id: "recent",
          accountId: "one",
          date: "2026-10-29",
          label: "Récente",
          category: "Divers",
          amount: -1,
          reconciled: false,
        },
      ],
    });
    expect(document.querySelector('tr[data-transaction="old"] .date-cell')?.textContent).toContain(
      "2016",
    );
    expect(
      document.querySelector('tr[data-transaction="recent"] .date-cell')?.textContent,
    ).toContain("2026");
  });

  it("distinguishes negative balances from zero and updates after an operation", async () => {
    await openRegister({
      accounts: [
        { id: "one", name: "Principal", kind: "Compte courant", openingBalance: 0, bank: "" },
      ],
      transactions: [],
    });
    expect(document.querySelector(".balance-card")?.classList.contains("negative-balance")).toBe(
      false,
    );
    click("#new-transaction");
    const form = document.querySelector<HTMLFormElement>("#transaction-form")!;
    field(form, "label").value = "Paiement";
    field(form, "date").value = "2027-01-01";
    field(form, "amount").value = "0.01";
    submit(form);
    await vi.waitFor(() =>
      expect(document.querySelector(".balance-card")?.classList.contains("negative-balance")).toBe(
        true,
      ),
    );
    expect(document.querySelector(".balance-card strong")?.textContent).toContain("0,01");
    click("[data-delete]");
    await vi.waitFor(() =>
      expect(document.querySelector(".balance-card")?.classList.contains("negative-balance")).toBe(
        false,
      ),
    );
  });

  it("filters unreconciled operations from the summary and returns to the first page", async () => {
    const entries = Array.from({ length: 150 }, (_, i) => ({
      id: `item-${String(i).padStart(3, "0")}`,
      accountId: "one",
      date: "2027-01-01",
      label: `Opération ${i}`,
      category: "Divers",
      amount: -1,
      reconciled: i % 2 === 0,
    }));
    const invoke = await openRegister({ transactions: entries });
    click("#next-page");
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLInputElement>("#page-input")?.value).toBe("2"),
    );
    click("#filter-unreconciled");
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLSelectElement>("#transaction-filter")?.value).toBe(
        "unreconciled",
      ),
    );
    expect(document.querySelector<HTMLInputElement>("#page-input")?.value).toBe("1");
    expect(document.querySelectorAll("tr[data-transaction]")).toHaveLength(75);
    expect(invoke).toHaveBeenCalledWith(
      "list_register",
      expect.objectContaining({ filter: "unreconciled", page: 1 }),
    );
    expect(document.querySelector(".reconciliation-card")?.textContent).toContain("75");
  });

  it("allows the summary filter when no operations are awaiting reconciliation", async () => {
    await openRegister({ transactions: [] });
    click("#filter-unreconciled");
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLSelectElement>("#transaction-filter")?.value).toBe(
        "unreconciled",
      ),
    );
    expect(document.querySelector("tbody")?.textContent).toContain("Aucune opération");
  });

  it("filters current-month credits and debits from their summary cards", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2027, 0, 15, 12));
    const entry = (id: string, date: string, amount: number) => ({
      id,
      accountId: "one",
      date,
      label: id,
      category: "Divers",
      amount,
      reconciled: false,
    });
    const invoke = await openRegister({
      transactions: [
        entry("Entrée du mois", "2027-01-01", 15),
        entry("Sortie du mois", "2027-01-02", -5),
        entry("Ancienne entrée", "2026-12-01", 30),
        entry("Ancienne sortie", "2026-12-02", -10),
      ],
    });
    click("#filter-month-credit");
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLSelectElement>("#transaction-filter")?.value).toBe(
        "month-credit",
      ),
    );
    expect(document.querySelector("tbody")?.textContent).toContain("Entrée du mois");
    expect(document.querySelector("tbody")?.textContent).not.toContain("Ancienne entrée");
    expect(invoke).toHaveBeenCalledWith(
      "list_register",
      expect.objectContaining({ filter: "month-credit", month: "2027-01", page: 1 }),
    );
    click("#filter-month-debit");
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLSelectElement>("#transaction-filter")?.value).toBe(
        "month-debit",
      ),
    );
    expect(document.querySelector("tbody")?.textContent).toContain("Sortie du mois");
    expect(document.querySelector("tbody")?.textContent).not.toContain("Ancienne sortie");
  });

  it("paginates filtered history with stable same-day ordering and cent-accurate balances", async () => {
    const entries = Array.from({ length: 205 }, (_, i) => ({
      id: `id-${String(i).padStart(3, "0")}`,
      accountId: "one",
      date: "2027-01-01",
      label: `Opération ${i}`,
      category: "Divers",
      amount: i % 2 ? -0.1 : 0.2,
      reconciled: false,
    }));
    await openRegister({ transactions: entries.reverse() });
    expect(document.querySelectorAll("tr[data-transaction]")).toHaveLength(100);
    expect(document.querySelector("tbody tr")?.getAttribute("data-transaction")).toBe("id-204");
    expect(
      document.querySelector('tr[data-transaction="id-204"] .running-balance')?.textContent,
    ).toContain("110,40");
    click("#next-page");
    await vi.waitFor(() =>
      expect(document.querySelector("tbody tr")?.getAttribute("data-transaction")).toBe("id-104"),
    );
    expect(
      document.querySelector('tr[data-transaction="id-104"] .running-balance')?.textContent,
    ).toContain("105,40");
    const form = document.querySelector<HTMLFormElement>("#page-form")!;
    document.querySelector<HTMLInputElement>("#page-input")!.value = "3";
    submit(form);
    await vi.waitFor(() =>
      expect(document.querySelectorAll("tr[data-transaction]")).toHaveLength(5),
    );
    expect(
      document.querySelector('tr[data-transaction="id-000"] .running-balance')?.textContent,
    ).toContain("100,20");
    const filter = document.querySelector<HTMLSelectElement>("#transaction-filter")!;
    filter.value = "debit";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLInputElement>("#page-input")!.value).toBe("1"),
    );
    expect(document.querySelector(".table-footer")?.textContent).toContain("102");
    click("#next-page");
    await vi.waitFor(() =>
      expect(document.querySelectorAll("tr[data-transaction]")).toHaveLength(2),
    );
    expect(
      document.querySelector('tr[data-transaction="id-001"] .running-balance')?.textContent,
    ).toContain("100,10");
  });

  it("summarizes only the selected account's operations in the current local month", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2027, 0, 15, 12));
    const entry = (id: string, accountId: string, date: string, amount: number) => ({
      id,
      accountId,
      date,
      amount,
      label: id,
      category: "Divers",
      reconciled: false,
    });
    await openRegister({
      accounts: [
        { id: "one", name: "Principal", kind: "Compte courant", openingBalance: 0, bank: "" },
        { id: "two", name: "Épargne", kind: "Épargne", openingBalance: 0, bank: "" },
      ],
      transactions: [
        entry("credit-1", "one", "2027-01-01", 0.1),
        entry("credit-2", "one", "2027-01-31", 0.2),
        entry("debit", "one", "2027-01-15", -12.5),
        entry("past-year", "one", "2026-01-15", 500),
        entry("previous-month", "one", "2026-12-31", -200),
        entry("next-month", "one", "2027-02-01", 300),
        entry("other-account", "two", "2027-01-15", 700),
      ],
    });
    const cards = () => document.querySelectorAll<HTMLElement>(".summary-card");
    expect(cards()[1].textContent).toContain("0,30");
    expect(cards()[1].textContent).toContain("2 opérations créditrices");
    expect(cards()[2].textContent).toContain("12,50");
    expect(cards()[2].textContent).toContain("1 opération débitrice");
    const filter = document.querySelector<HTMLSelectElement>("#transaction-filter")!;
    filter.value = "debit";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
    expect(cards()[1].textContent).toContain("0,30");
    click('[data-account="two"]');
    await vi.waitFor(() =>
      expect(document.querySelector(".page-heading h1")?.textContent).toBe("Épargne"),
    );
    expect(cards()[1].textContent).toContain("700,00");
    expect(cards()[1].textContent).toContain("1 opération créditrice");
    expect(cards()[2].textContent).toContain("0,00");
    expect(cards()[2].textContent).toContain("0 opérations débitrices");
  });

  it("creates a debit with a cheque and refreshes the account balance", async () => {
    const invoke = await openRegister();
    click("#new-transaction");
    const form = document.querySelector<HTMLFormElement>("#transaction-form")!;
    field(form, "label").value = "Réparation";
    field(form, "date").value = "2027-01-03";
    field(form, "amount").value = "12.34";
    field(form, "cheque").value = "0012345";
    submit(form);
    await vi.waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).toContain("Réparation"),
    );
    expect(invoke).toHaveBeenCalledWith("create_transaction", {
      transaction: expect.objectContaining({ accountId: "one", amount: -1234, cheque: "0012345" }),
    });
    expect(document.querySelector(".balance-card")?.textContent).toContain("117,66");
    expect(document.querySelector(".account-item.active .account-balance")?.textContent).toContain(
      "117,66",
    );
  });

  it("creates, edits, cancels and clears an operation comment safely", async () => {
    const invoke = await openRegister({ transactions: [] });
    click("#new-transaction");
    let form = document.querySelector<HTMLFormElement>("#transaction-form")!;
    field(form, "label").value = "Test commentaire";
    field(form, "date").value = "2027-01-03";
    field(form, "amount").value = "12.34";
    field(form, "note").value = "Note <importante>\nSeconde ligne";
    submit(form);
    await vi.waitFor(() =>
      expect(document.querySelector(".transaction-note")?.textContent).toContain(
        "Note <importante>",
      ),
    );
    expect(invoke).toHaveBeenCalledWith(
      "create_transaction",
      expect.objectContaining({
        transaction: expect.objectContaining({ note: "Note <importante>\nSeconde ligne" }),
      }),
    );
    expect(document.querySelector(".transaction-note > importante")).toBeNull();
    click("tr[data-transaction] .date-cell");
    form = document.querySelector<HTMLFormElement>(".transaction-editor")!;
    expect(field(form, "note").value).toBe("Note <importante>\nSeconde ligne");
    field(form, "note").value = "Annulé";
    click(".cancel-editor");
    expect(document.querySelector(".transaction-note")?.textContent).not.toContain("Annulé");
    click("tr[data-transaction] .date-cell");
    form = document.querySelector<HTMLFormElement>(".transaction-editor")!;
    field(form, "note").value = "Modifié";
    submit(form);
    await vi.waitFor(() =>
      expect(document.querySelector(".transaction-note")?.textContent).toBe("Modifié"),
    );
    click("tr[data-transaction] .date-cell");
    form = document.querySelector<HTMLFormElement>(".transaction-editor")!;
    field(form, "note").value = "";
    submit(form);
    await vi.waitFor(() => expect(document.querySelector(".transaction-note")).toBeNull());
  });

  it("suggests previous payees from other accounts while allowing a new label", async () => {
    const invoke = await openRegister({
      accounts: [
        { id: "one", name: "Principal", kind: "Compte courant", openingBalance: 100, bank: "" },
        { id: "two", name: "Épargne", kind: "Épargne", openingBalance: 0, bank: "" },
      ],
      transactions: [
        {
          id: "other",
          accountId: "two",
          date: "2027-01-01",
          label: "Marché <bio>",
          category: "Divers",
          amount: -10,
          reconciled: false,
        },
      ],
    });
    click("#new-transaction");
    const form = document.querySelector<HTMLFormElement>("#transaction-form")!;
    expect(field(form, "label").getAttribute("list")).toBe("payee-suggestions");
    await vi.waitFor(() =>
      expect(
        [...form.querySelectorAll<HTMLOptionElement>("#payee-suggestions option")].map(
          (option) => option.value,
        ),
      ).toContain("Marché <bio>"),
    );
    expect(invoke).toHaveBeenCalledWith("list_payees");
    field(form, "label").value = "Nouveau destinataire";
    field(form, "date").value = "2027-01-02";
    field(form, "amount").value = "5";
    submit(form);
    await vi.waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).toContain("Nouveau destinataire"),
    );
    click("#new-transaction");
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll<HTMLOptionElement>("#payee-suggestions option")].map(
          (option) => option.value,
        ),
      ).toContain("Nouveau destinataire"),
    );
  });

  it("suggests payees when editing without replacing the existing or typed label", async () => {
    const invoke = await openRegister({
      accounts: [
        { id: "one", name: "Principal", kind: "Compte courant", openingBalance: 100, bank: "" },
        { id: "two", name: "Épargne", kind: "Épargne", openingBalance: 0, bank: "" },
      ],
      transactions: [
        {
          id: "original",
          accountId: "one",
          date: "2027-01-01",
          label: "Libellé initial",
          category: "Divers",
          amount: -10,
          reconciled: false,
        },
        {
          id: "other",
          accountId: "two",
          date: "2027-01-02",
          label: "Marché <bio>",
          category: "Divers",
          amount: -5,
          reconciled: false,
        },
      ],
    });
    click('tr[data-transaction="original"] td.date-cell');
    const form = document.querySelector<HTMLFormElement>(".transaction-editor")!;
    expect(field(form, "label").value).toBe("Libellé initial");
    expect(field(form, "label").getAttribute("list")).toBe("edit-payee-suggestions");
    field(form, "label").value = "Nouveau libellé";
    await vi.waitFor(() =>
      expect(
        [...form.querySelectorAll<HTMLOptionElement>("#edit-payee-suggestions option")].map(
          (option) => option.value,
        ),
      ).toContain("Marché <bio>"),
    );
    expect(field(form, "label").value).toBe("Nouveau libellé");
    submit(form);
    await vi.waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).toContain("Nouveau libellé"),
    );
    expect(invoke).toHaveBeenCalledWith("update_transaction", {
      transaction: expect.objectContaining({ id: "original", label: "Nouveau libellé" }),
    });
  });

  it("creates a linked transfer visible in both accounts and deletes both sides", async () => {
    const invoke = await openRegister({
      accounts: [
        { id: "one", name: "Principal", kind: "Compte courant", openingBalance: 100, bank: "" },
        { id: "two", name: "Épargne", kind: "Épargne", openingBalance: 200, bank: "" },
      ],
      transactions: [],
    });
    click("#new-transfer");
    const form = document.querySelector<HTMLFormElement>("#transfer-form")!;
    field(form, "destinationId").value = "one";
    field(form, "amount").value = "25.50";
    submit(form);
    expect(form.querySelector("[role=alert]")?.textContent).toContain("deux comptes différents");
    expect(invoke.mock.calls.filter(([command]) => command === "create_transfer")).toHaveLength(0);
    field(form, "destinationId").value = "two";
    field(form, "date").value = "2027-01-15";
    field(form, "note").value = "Épargne";
    submit(form);
    await vi.waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).toContain("Virement vers Épargne"),
    );
    expect(invoke).toHaveBeenCalledWith("create_transfer", {
      transfer: expect.objectContaining({
        sourceId: "one",
        destinationId: "two",
        amount: 2550,
        date: "2027-01-15",
        note: "Épargne",
      }),
    });
    expect(document.querySelector('[data-account="one"] .account-balance')?.textContent).toContain(
      "74,50",
    );
    expect(document.querySelector('[data-account="two"] .account-balance')?.textContent).toContain(
      "225,50",
    );
    click('[data-account="two"]');
    await vi.waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).toContain("Virement depuis Principal"),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    click("[data-delete]");
    await vi.waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).not.toContain("Virement"),
    );
    expect(document.querySelector('[data-account="one"] .account-balance')?.textContent).toContain(
      "100,00",
    );
    expect(document.querySelector('[data-account="two"] .account-balance')?.textContent).toContain(
      "200,00",
    );
    vi.restoreAllMocks();
  });

  it("edits a linked transfer from the credited account and updates both balances", async () => {
    const invoke = await openRegister({
      accounts: [
        { id: "one", name: "Principal", kind: "Compte courant", openingBalance: 100, bank: "" },
        { id: "two", name: "Épargne", kind: "Épargne", openingBalance: 200, bank: "" },
      ],
      transactions: [],
    });
    click("#new-transfer");
    let form = document.querySelector<HTMLFormElement>("#transfer-form")!;
    field(form, "destinationId").value = "two";
    field(form, "amount").value = "25";
    field(form, "date").value = "2027-01-15";
    submit(form);
    await vi.waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).toContain("Virement vers Épargne"),
    );
    click('[data-account="two"]');
    await vi.waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).toContain("Virement depuis Principal"),
    );
    click("tr[data-transaction] td.date-cell");
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLDialogElement>("#transfer-dialog")?.open).toBe(true),
    );
    form = document.querySelector<HTMLFormElement>("#transfer-form")!;
    expect(form.querySelector("h2")?.textContent).toBe("Modifier le virement");
    expect(field(form, "sourceId").value).toBe("one");
    expect(field(form, "destinationId").value).toBe("two");
    field(form, "amount").value = "40";
    field(form, "date").value = "2027-02-01";
    submit(form);
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-account="two"] .account-balance')?.textContent,
      ).toContain("240,00"),
    );
    expect(document.querySelector('[data-account="one"] .account-balance')?.textContent).toContain(
      "60,00",
    );
    expect(invoke).toHaveBeenCalledWith("update_transfer", {
      transfer: expect.objectContaining({
        sourceId: "one",
        destinationId: "two",
        amount: 4000,
        date: "2027-02-01",
      }),
    });
    click('[data-account="one"]');
    await vi.waitFor(() => expect(document.querySelector("tbody")?.textContent).toContain("40,00"));
  });

  it("shows current balances for all accounts and updates them after editing and deleting", async () => {
    await openRegister({
      accounts: [
        { id: "one", name: "Principal", kind: "Compte courant", openingBalance: 100, bank: "" },
        { id: "two", name: "Épargne", kind: "Épargne", openingBalance: 200, bank: "" },
      ],
      transactions: [
        {
          id: "debit",
          accountId: "one",
          date: "2027-01-01",
          label: "Courses",
          category: "Alimentation",
          amount: -20,
          reconciled: false,
        },
        {
          id: "other",
          accountId: "two",
          date: "2027-01-02",
          label: "Intérêts",
          category: "Divers",
          amount: 25,
          reconciled: false,
        },
      ],
    });
    const balance = (id: string) =>
      document.querySelector(`[data-account="${id}"] .account-balance`)?.textContent;
    expect(balance("one")).toContain("80,00");
    expect(balance("two")).toContain("225,00");
    click('tr[data-transaction="debit"] td.date-cell');
    const form = document.querySelector<HTMLFormElement>(".transaction-editor")!;
    field(form, "amount").value = "30";
    submit(form);
    await vi.waitFor(() => expect(balance("one")).toContain("70,00"));
    click('[data-delete="debit"]');
    await vi.waitFor(() => expect(balance("one")).toContain("100,00"));
    expect(balance("two")).toContain("225,00");
  });

  it("edits a transaction and restores the summary after saving or cancelling", async () => {
    const invoke = await openRegister();
    click('tr[data-transaction="debit"] td.date-cell');
    expect(document.querySelector<HTMLElement>(".summary-grid")?.hidden).toBe(true);
    let form = document.querySelector<HTMLFormElement>(".transaction-editor")!;
    field(form, "label").value = "Courses modifiées";
    field(form, "amount").value = "30";
    submit(form);
    await vi.waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).toContain("Courses modifiées"),
    );
    expect(invoke).toHaveBeenCalledWith("update_transaction", {
      transaction: expect.objectContaining({
        id: "debit",
        amount: -3000,
        label: "Courses modifiées",
      }),
    });
    expect(document.querySelector<HTMLElement>(".summary-grid")?.hidden).toBe(false);
    click('tr[data-transaction="debit"] td.date-cell');
    form = document.querySelector<HTMLFormElement>(".transaction-editor")!;
    field(form, "label").value = "Annulé";
    click(".cancel-editor");
    expect(document.querySelector(".transaction-editor")).toBeNull();
    expect(document.querySelector<HTMLElement>(".summary-grid")?.hidden).toBe(false);
    expect(document.querySelector("tbody")?.textContent).not.toContain("Annulé");
    expect(invoke.mock.calls.filter(([command]) => command === "update_transaction")).toHaveLength(
      1,
    );
  });

  it("filters, reconciles and deletes operations while retaining running balances", async () => {
    const invoke = await openRegister();
    const filter = document.querySelector<HTMLSelectElement>("#transaction-filter")!;
    filter.value = "unreconciled";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.querySelector("tbody")?.textContent).toContain("Courses");
    await vi.waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).not.toContain("Salaire"),
    );
    expect(
      document.querySelector('tr[data-transaction="debit"] .running-balance')?.textContent,
    ).toContain("80,00");
    click('[data-reconcile="debit"]');
    await vi.waitFor(() =>
      expect(document.querySelector("tbody")?.textContent).toContain("Aucune opération"),
    );
    expect(invoke).toHaveBeenCalledWith("toggle_transaction_reconciliation", { id: "debit" });
    const reset = document.querySelector<HTMLSelectElement>("#transaction-filter")!;
    reset.value = "all";
    reset.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-reconcile="debit"]')?.textContent).toBe("P"),
    );
    click('[data-delete="debit"]');
    await vi.waitFor(() =>
      expect(document.querySelector('tr[data-transaction="debit"]')).toBeNull(),
    );
    expect(invoke).toHaveBeenCalledWith("delete_transaction", { id: "debit" });
    expect(document.querySelector("tbody")?.textContent).toContain("Salaire");
  });
});
