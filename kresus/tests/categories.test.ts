// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Category = { id: string; name: string; parentId: string | null };

async function openCategories() {
  let categories: Category[] = [
    { id: "food", name: "Alimentation", parentId: null },
    { id: "other", name: "Divers", parentId: null },
  ];
  const invoke = vi.fn(async (command: string, args?: Record<string, any>) => {
    switch (command) {
      case "list_accounts":
        return [
          {
            id: "one",
            name: "Compte",
            kind: "Compte courant",
            openingBalance: 0,
            currentBalance: 0,
            bank: "",
          },
        ];
      case "list_schedules":
      case "list_transactions":
        return [];
      case "list_register":
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
      case "list_categories":
        return categories;
      case "create_category":
        categories = [...categories, args!.category];
        return;
      case "rename_category":
        categories = categories.map((item) =>
          item.id === args!.id ? { ...item, name: args!.name } : item,
        );
        return;
      case "merge_category":
        categories = categories.filter((item) => item.id !== args!.sourceId);
        return;
      case "delete_category":
        categories = categories.filter((item) => item.id !== args!.id);
        return;
      default:
        throw new Error(`Unexpected command ${command}`);
    }
  });
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  await import("../src/main");
  await vi.waitFor(() => expect(document.querySelector("#categories-nav")).not.toBeNull());
  (document.querySelector("#categories-nav") as HTMLButtonElement).click();
  return invoke;
}
const click = (selector: string) => (document.querySelector(selector) as HTMLButtonElement).click();
const submit = (form: HTMLFormElement) =>
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

describe("category management", () => {
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
    vi.restoreAllMocks();
    vi.doUnmock("@tauri-apps/api/core");
  });

  it("creates a subcategory and offers it in the operation form", async () => {
    const invoke = await openCategories();
    click("#new-category");
    const form = document.querySelector<HTMLFormElement>("#category-form")!;
    (form.elements.namedItem("name") as HTMLInputElement).value = "Marché";
    (form.elements.namedItem("parent") as HTMLSelectElement).value = "food";
    submit(form);
    await vi.waitFor(() =>
      expect(document.querySelector(".category-panel")?.textContent).toContain("Marché"),
    );
    expect(invoke).toHaveBeenCalledWith("create_category", {
      category: expect.objectContaining({ name: "Marché", parentId: "food" }),
    });
    click('[data-account="one"]');
    await vi.waitFor(() => expect(document.querySelector("#transaction-form")).not.toBeNull());
    expect(
      document.querySelector<HTMLSelectElement>('#transaction-form select[name="category"]')
        ?.textContent,
    ).toContain("Alimentation · Marché");
  });

  it("renames, merges and deletes categories through the interface", async () => {
    const invoke = await openCategories();
    click('[data-rename="food"]');
    let form = document.querySelector<HTMLFormElement>("#category-form")!;
    (form.elements.namedItem("name") as HTMLInputElement).value = "Repas";
    submit(form);
    await vi.waitFor(() =>
      expect(document.querySelector(".category-panel")?.textContent).toContain("Repas"),
    );
    expect(invoke).toHaveBeenCalledWith("rename_category", { id: "food", name: "Repas" });
    click('[data-merge="food"]');
    form = document.querySelector<HTMLFormElement>("#category-form")!;
    (form.elements.namedItem("target") as HTMLSelectElement).value = "other";
    submit(form);
    await vi.waitFor(() => expect(document.querySelector('[data-merge="food"]')).toBeNull());
    expect(invoke).toHaveBeenCalledWith("merge_category", { sourceId: "food", targetId: "other" });
    click('[data-delete-category="other"]');
    expect(document.querySelector(".confirmation-dialog[open]")).not.toBeNull();
    click(".confirmation-cancel");
    expect(invoke).not.toHaveBeenCalledWith("delete_category", expect.anything());
    click('[data-delete-category="other"]');
    click(".confirmation-accept");
    await vi.waitFor(() =>
      expect(document.querySelector(".category-panel")?.textContent).toContain("Aucune catégorie"),
    );
    expect(invoke).toHaveBeenCalledWith("delete_category", { id: "other" });
  });
});
