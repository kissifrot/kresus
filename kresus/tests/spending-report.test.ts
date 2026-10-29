// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, field, openRegister, submit } from "./register-fixtures";

describe("spending report", () => {
  beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2027, 0, 15, 12));
    document.body.innerHTML = '<div id="app"></div>'; localStorage.clear();
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () { this.open = false; };
  });
  afterEach(() => { vi.useRealTimers(); vi.doUnmock("@tauri-apps/api/core"); });

  it("groups spending for the selected account and inclusive period, excluding income and transfers", async () => {
    const operation = (id: string, accountId: string, date: string, category: string, amount: number, transferId?: string) => ({ id, accountId, date, label: id, category, amount, transferId, reconciled: false });
    await openRegister({
      accounts: [{ id: "one", name: "Principal", kind: "Compte courant", openingBalance: 0, bank: "" }, { id: "two", name: "Épargne", kind: "Épargne", openingBalance: 0, bank: "" }],
      transactions: [operation("first", "one", "2027-01-01", "Alimentation", -10.1), operation("last", "one", "2027-01-31", "Alimentation", -0.2), operation("health", "one", "2027-01-15", "Santé · Pharmacie", -20), operation("income", "one", "2027-01-15", "Salaire", 200), operation("transfer", "one", "2027-01-15", "Divers", -500, "link"), operation("old", "one", "2026-12-31", "Ancien", -900), operation("other", "two", "2027-01-15", "Loisirs", -7)],
    });
    click("#spending-nav");
    await vi.waitFor(() => expect(document.querySelector(".spending-total")).not.toBeNull());
    const panel = document.querySelector(".spending-panel")!;
    expect(panel.textContent).toContain("30,30");
    expect(panel.textContent).toContain("Alimentation");
    expect(panel.textContent).toContain("10,30");
    expect(panel.textContent).toContain("Santé · Pharmacie");
    expect(panel.textContent).not.toContain("Salaire");
    expect(panel.textContent).not.toContain("Ancien");
    expect(panel.textContent).not.toContain("Loisirs");
    expect(panel.querySelectorAll("svg circle")).toHaveLength(2);
    const form = document.querySelector<HTMLFormElement>("#spending-filter")!;
    field(form, "start").value = "2027-01-15";
    field(form, "end").value = "2027-01-31";
    submit(form);
    await vi.waitFor(() => expect(document.querySelector(".spending-total")?.textContent).toContain("20,20"));
    expect(document.querySelector(".spending-list")?.textContent).not.toContain("10,30");
    const next = document.querySelector<HTMLFormElement>("#spending-filter")!;
    field(next, "account").value = "two"; submit(next);
    await vi.waitFor(() => expect(document.querySelector(".spending-list")?.textContent).toContain("Loisirs"));
    expect(document.querySelector(".spending-total")?.textContent).toContain("7,00");
  });

  it("handles empty and invalid periods without presenting misleading totals", async () => {
    await openRegister(); click("#spending-nav");
    await vi.waitFor(() => expect(document.querySelector(".spending-total")).not.toBeNull());
    const form = document.querySelector<HTMLFormElement>("#spending-filter")!;
    field(form, "start").value = "2027-02-01";
    field(form, "end").value = "2027-01-31";
    submit(form);
    expect(form.querySelector("[role=alert]")?.textContent).toContain("période valide");
    field(form, "end").value = "2027-02-28"; submit(form);
    await vi.waitFor(() => expect(document.querySelector(".spending-empty")?.textContent).toContain("Aucune dépense"));
    expect(document.querySelector(".spending-chart")).toBeNull();
  });

  it("includes operations outside the current register page", async () => {
    const entries = Array.from({ length: 150 }, (_, index) => ({ id: `row-${index}`, accountId: "one", date: "2027-01-15", label: "Achat", category: "Divers", amount: -1, reconciled: false }));
    await openRegister({ transactions: entries });
    expect(document.querySelectorAll("tr[data-transaction]")).toHaveLength(100);
    click("#spending-nav");
    await vi.waitFor(() => expect(document.querySelector(".spending-total")?.textContent).toContain("150,00"));
  });
});
