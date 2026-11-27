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

it.each([
  { destination: "default", defaultAvailable: true, path: null },
  { destination: "alternative", defaultAvailable: true, path: "/tmp/import.kresus" },
  { destination: "new file", defaultAvailable: false, path: "/tmp/import.kresus" },
])("imports selected accounts to $destination", async ({ destination, defaultAvailable, path }) => {
  let cancelSelection = destination === "alternative";
  const invoke = vi.fn(async (command: string) => {
    if (command === "choose_money_file") return [1, 2, 3];
    if (command === "set_money_preview") return defaultAvailable;
    if (command === "import_money") return cancelSelection ? null : { path };
  });
  const reload = vi.fn();
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  vi.doMock("../src/accounts", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/accounts")>()),
    reloadDatabase: reload,
  }));
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
  const selectedKind = document.querySelector<HTMLSelectElement>('[data-kind="1"]')!;
  const submit = document.querySelector<HTMLButtonElement>('dialog button[type="submit"]')!;
  const otherLocation = document.querySelector<HTMLButtonElement>("#money-import-other-location");
  expect(submit.textContent).toBe(
    defaultAvailable ? "Importer dans la base habituelle" : "Choisir un emplacement",
  );
  expect(otherLocation?.textContent).toBe(
    defaultAvailable ? "Choisir un autre emplacement" : undefined,
  );
  expect(selectedKind.value).toBe("Compte courant");
  selectedKind.value = "Assurance vie";
  if (cancelSelection) {
    otherLocation!.click();
    expect(submit.disabled).toBe(true);
    await vi.waitFor(() => expect(otherLocation!.disabled).toBe(false));
    expect(document.querySelector("dialog[open]")).not.toBeNull();
    expect(selectedKind.value).toBe("Assurance vie");
    expect(reload).not.toHaveBeenCalled();
    cancelSelection = false;
  }
  (destination === "alternative" ? otherLocation! : submit).click();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledWith(path));
  expect(invoke).toHaveBeenCalledWith("import_money", {
    selection: [{ id: 1, kind: "Assurance vie" }],
    chooseAnotherLocation: destination !== "default",
  });
});
