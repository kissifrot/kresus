// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
  vi.doUnmock("@tauri-apps/api/core");
});

it("switches databases, supports cancellation and returns to the default database", async () => {
  let active = "default";
  let choice: string | null = "/tmp/test.sqlite3";
  const invoke = vi.fn(async (command: string) => {
    if (command === "choose_database") {
      if (choice === "invalid") throw new Error("Base incompatible");
      if (choice) active = "test";
      return choice;
    }
    if (command === "use_default_database") {
      active = "default";
      return;
    }
    if (command === "list_accounts")
      return [
        {
          id: active,
          name: active === "default" ? "Principal" : "Compte test",
          kind: "Compte courant",
          openingBalance: 0,
          currentBalance: 0,
          bank: "",
        },
      ];
    if (command === "list_schedules" || command === "list_categories") return [];
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
    throw new Error(command);
  });
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  await import("../src/main");
  const { runMenuAction } = await import("../src/accounts");
  await vi.waitFor(() =>
    expect(document.querySelector(".page-heading h1")?.textContent).toBe("Principal"),
  );
  void runMenuAction("open");
  await vi.waitFor(() =>
    expect(document.querySelector(".page-heading h1")?.textContent).toBe("Compte test"),
  );
  expect(document.querySelector(".database-controls")?.textContent).toContain("test.sqlite3");
  expect(document.querySelector('[data-account="default"]')).toBeNull();
  choice = null;
  void runMenuAction("open");
  await vi.waitFor(() =>
    expect(document.body.classList.contains("database-switching")).toBe(false),
  );
  expect(document.querySelector(".page-heading h1")?.textContent).toBe("Compte test");
  choice = "invalid";
  void runMenuAction("open");
  await vi.waitFor(() =>
    expect(document.querySelector(".database-error")?.textContent).toContain("Base incompatible"),
  );
  expect(document.querySelector(".page-heading h1")?.textContent).toBe("Compte test");
  void runMenuAction("default");
  await vi.waitFor(() =>
    expect(document.querySelector(".page-heading h1")?.textContent).toBe("Principal"),
  );
  expect(document.querySelector(".database-controls")?.textContent).toContain("Base habituelle");
});

it("confirms restoration, refreshes data, and reports backup and restore failures", async () => {
  let active = "before";
  let failRestore = false;
  let failBackup = false;
  const invoke = vi.fn(async (command: string) => {
    if (command === "backup_database") {
      if (failBackup) throw new Error("Destination inaccessible");
      return "/tmp/backup.sqlite3";
    }
    if (command === "choose_restore_file") return "/tmp/backup.sqlite3";
    if (command === "restore_database") {
      if (failRestore) throw new Error("Fichier invalide");
      active = "after";
      return;
    }
    if (command === "list_accounts")
      return [
        {
          id: active,
          name: active,
          kind: "Compte courant",
          openingBalance: 0,
          currentBalance: 0,
          bank: "",
        },
      ];
    if (command === "list_schedules" || command === "list_categories") return [];
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
    throw new Error(command);
  });
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  await import("../src/main");
  const { runMenuAction } = await import("../src/accounts");
  await vi.waitFor(() => expect(document.querySelector(".database-controls")).not.toBeNull());
  void runMenuAction("backup");
  await vi.waitFor(() =>
    expect(document.querySelector(".database-error")?.textContent).toContain("Sauvegarde créée"),
  );
  failBackup = true;
  void runMenuAction("backup");
  await vi.waitFor(() =>
    expect(document.querySelector(".database-error")?.textContent).toContain(
      "Destination inaccessible",
    ),
  );
  expect(document.querySelector(".page-heading h1")?.textContent).toBe("before");

  void runMenuAction("restore");
  await vi.waitFor(() =>
    expect(document.querySelector(".confirmation-dialog[open]")).not.toBeNull(),
  );
  expect(document.querySelector(".confirmation-message")?.textContent).toContain("backup.sqlite3");
  const backupsBefore = invoke.mock.calls.filter(
    ([command]) => command === "backup_database",
  ).length;
  await runMenuAction("backup");
  expect(invoke.mock.calls.filter(([command]) => command === "backup_database")).toHaveLength(
    backupsBefore,
  );
  (document.querySelector(".confirmation-cancel") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.querySelector(".confirmation-dialog")).toBeNull());
  await Promise.resolve();
  expect(invoke).not.toHaveBeenCalledWith("restore_database", expect.anything());
  failRestore = true;
  void runMenuAction("restore");
  await vi.waitFor(() =>
    expect(document.querySelector(".confirmation-dialog[open]")).not.toBeNull(),
  );
  (document.querySelector(".confirmation-accept") as HTMLButtonElement).click();
  await vi.waitFor(() =>
    expect(document.querySelector(".database-error")?.textContent).toContain("Fichier invalide"),
  );
  expect(document.querySelector(".page-heading h1")?.textContent).toBe("before");
  failRestore = false;
  void runMenuAction("restore");
  await vi.waitFor(() =>
    expect(document.querySelector(".confirmation-dialog[open]")).not.toBeNull(),
  );
  (document.querySelector(".confirmation-accept") as HTMLButtonElement).click();
  await vi.waitFor(() =>
    expect(document.querySelector(".page-heading h1")?.textContent).toBe("after"),
  );
  expect(document.querySelector(".database-error")?.textContent).toContain("Sauvegarde restaurée");
});
