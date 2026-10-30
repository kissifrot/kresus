// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { click, openRegister } from "../tests/register-fixtures";

it("measures the register with 10,000 historical operations", async () => {
  // Spread entries over ten years without depending on the system clock.
  const entries = Array.from({ length: 10_000 }, (_, index) => ({
    id: `operation-${String(index).padStart(5, "0")}`,
    accountId: "one",
    date: new Date(Date.UTC(2017, 0, 1 + Math.floor((index * 3652) / 10_000)))
      .toISOString()
      .slice(0, 10),
    label: `Destinataire ${index % 100}`,
    category: "Divers",
    amount: index % 2 ? 10 : -5,
    reconciled: index % 2 === 0,
  }));
  const measure = (name: string, started: number) =>
    console.log(`${name}: ${(performance.now() - started).toFixed(0)} ms`);
  let started = performance.now();
  const invoke = await openRegister({
    transactions: entries,
    schedules: [],
    accounts: [
      {
        id: "one",
        name: "Compte principal",
        kind: "Compte courant",
        openingBalance: 100,
        bank: "",
      },
      { id: "two", name: "Autre compte", kind: "Épargne", openingBalance: 0, bank: "" },
    ],
  });
  measure("Chargement initial (module + interface)", started);
  expect(document.querySelectorAll("tr[data-transaction]")).toHaveLength(100);
  expect(document.querySelector(".table-footer")?.textContent).toContain(
    "10 000".replace(/\s/g, ""),
  );
  expect(document.querySelector(".balance-card strong")?.textContent?.replace(/\s/g, "")).toContain(
    "25100,00",
  );

  started = performance.now();
  const filter = document.querySelector<HTMLSelectElement>("#transaction-filter")!;
  filter.value = "credit";
  filter.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(
    () => expect(document.querySelector(".table-footer")?.textContent).toContain("5000"),
    { timeout: 60_000 },
  );
  measure("Filtre crédits", started);
  expect(document.querySelectorAll("tr[data-transaction]")).toHaveLength(100);
  expect(invoke).toHaveBeenCalledWith(
    "list_register",
    expect.objectContaining({ page: 1, filter: "credit" }),
  );
  expect(document.querySelector(".table-footer")?.textContent).toContain("5000");

  started = performance.now();
  click("[data-reconcile]");
  await vi.waitFor(
    () =>
      expect(invoke).toHaveBeenCalledWith("toggle_transaction_reconciliation", expect.anything()),
    { timeout: 60_000 },
  );
  await vi.waitFor(
    () => expect(document.querySelector("[data-reconcile]")?.classList.contains("done")).toBe(true),
    { timeout: 60_000 },
  );
  measure("Pointage et actualisation", started);

  started = performance.now();
  click('[data-account="two"]');
  await vi.waitFor(
    () => expect(document.querySelector(".page-heading h1")?.textContent).toBe("Autre compte"),
    { timeout: 60_000 },
  );
  measure("Changement vers un compte vide", started);
  started = performance.now();
  click('[data-account="one"]');
  await vi.waitFor(
    () => expect(document.querySelector(".page-heading h1")?.textContent).toBe("Compte principal"),
    { timeout: 60_000 },
  );
  measure("Retour au compte historique (filtre crédits)", started);
  expect(document.querySelectorAll("tr[data-transaction]")).toHaveLength(100);
});

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
});
afterEach(() => {
  vi.doUnmock("@tauri-apps/api/core");
});
