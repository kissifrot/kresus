// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML =
    '<button id="import-money"></button><p class="database-error"></p><div id="app"></div>';
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  vi.doUnmock("@tauri-apps/api/core");
  vi.doUnmock("../src/accounts");
  vi.doUnmock("../src/money-reader");
});

it("reviews accounts and warnings before importing selected types", async () => {
  const invoke = vi.fn(async (command: string) =>
    command === "choose_money_file"
      ? [1, 2, 3]
      : command === "import_money"
        ? "/tmp/import.sqlite3"
        : undefined,
  );
  const reload = vi.fn();
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  vi.doMock("../src/accounts", () => ({ reloadDatabase: reload }));
  vi.doMock("../src/money-reader", () => ({
    inspect: () => ({
      schedules: [],
      skippedSchedules: [
        "Échéance Money 3 · <Orange> · Compte · 2026-11-04 : durée limitée non prise en charge.",
      ],
      transfers: [],
      accounts: [
        { id: 1, name: "Compte <test>", openingBalance: 100000, balance: 87500, count: 1 },
      ],
      categories: [{ id: 2, name: "Maison", parentId: null }],
      operations: [
        { accountId: 1, date: "2026-01-01", label: "Loyer", category: "Maison", amount: -12500 },
      ],
      warnings: ["Placement exclu"],
    }),
  }));
  const { openMoneyImport } = await import("../src/money-import");
  await openMoneyImport();
  expect(document.querySelector("dialog")?.textContent).toContain("Placement exclu");
  expect(document.querySelector("dialog")?.textContent).toContain(
    "1 échéance ne sera pas importée",
  );
  expect(document.querySelector<HTMLTextAreaElement>(".money-skipped-details")?.value).toContain(
    "<Orange>",
  );
  expect(document.querySelector("dialog orange")).toBeNull();
  expect(document.querySelector("dialog")?.textContent).toContain("875,00");
  expect(document.querySelector("dialog test")).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("import_money", expect.anything());
  document.querySelector<HTMLSelectElement>('[data-kind="1"]')!.value = "Épargne";
  document
    .querySelector("dialog form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(reload).toHaveBeenCalledWith("/tmp/import.sqlite3"));
  expect(invoke).toHaveBeenCalledWith("import_money", { selection: [{ id: 1, kind: "Épargne" }] });
});
