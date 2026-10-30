import { invoke } from "@tauri-apps/api/core";
import type { Category, Schedule, Transaction } from "./types";
import { categories, selectedAccount, setCategories, setSchedules, setTransactions } from "./state";
import { escapeHtml } from "./format";
import { render } from "./accounts";

export function categoryLabel(category: Category): string {
  const parent = categories.find((item) => item.id === category.parentId);
  return parent ? `${parent.name} · ${category.name}` : category.name;
}

// Include a current legacy value so editing never silently changes its category.
export function categoryOptions(current = ""): string {
  const labels = categories.map(categoryLabel).sort((a, b) => a.localeCompare(b, "fr"));
  if (current && !labels.includes(current)) labels.push(current);
  return labels
    .map(
      (label) =>
        `<option value="${escapeHtml(label)}" ${label === current ? "selected" : ""}>${escapeHtml(label)}</option>`,
    )
    .join("");
}

export async function refreshCategories() {
  setCategories(await invoke<Category[]>("list_categories"));
}

export function renderCategories() {
  render();
  document.querySelector(".nav-item.selected")?.classList.remove("selected");
  document.querySelector("#categories-nav")?.classList.add("selected");
  const roots = categories
    .filter((category) => !category.parentId)
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  const row = (category: Category) =>
    `<div class="category-row ${category.parentId ? "subcategory-row" : ""}"><span>${category.parentId ? "↳ " : "▤ "}${escapeHtml(category.name)}</span><div><button class="schedule-record" data-rename="${escapeHtml(category.id)}">Renommer</button><button class="schedule-record" data-merge="${escapeHtml(category.id)}">Fusionner</button><button class="secondary-button category-delete" data-delete-category="${escapeHtml(category.id)}">Supprimer</button></div></div>`;
  document.querySelector<HTMLDivElement>(".page-content")!.innerHTML =
    `<div class="page-heading"><div><div class="eyebrow">ORGANISATION</div><h1>Catégories</h1><p>Classez vos opérations et échéances par catégorie.</p></div><button class="primary-button" id="new-category"><span>+</span> Nouvelle catégorie</button></div><section class="category-panel">${
      roots
        .map(
          (root) =>
            `${row(root)}${categories
              .filter((item) => item.parentId === root.id)
              .sort((a, b) => a.name.localeCompare(b.name, "fr"))
              .map(row)
              .join("")}`,
        )
        .join("") || '<p class="category-empty">Aucune catégorie.</p>'
    }</section><p class="category-message" role="alert"></p><dialog id="category-dialog"><form id="category-form"><div class="dialog-heading"><h2></h2><button type="button" class="dialog-close category-close" aria-label="Fermer">×</button></div><label class="category-name-label">Nom<input name="name" maxlength="80"></label><label class="category-parent-label">Catégorie principale<select name="parent"><option value="">Aucune — catégorie principale</option>${roots.map((root) => `<option value="${escapeHtml(root.id)}">${escapeHtml(root.name)}</option>`).join("")}</select></label><label class="category-target-label">Fusionner vers<select name="target"></select></label><p class="editor-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-button category-close">Annuler</button><button type="submit" class="primary-button">Enregistrer</button></div></form></dialog>`;
  const dialog = document.querySelector<HTMLDialogElement>("#category-dialog")!;
  const form = document.querySelector<HTMLFormElement>("#category-form")!;
  let mode: "create" | "rename" | "merge" = "create";
  let selected: Category | undefined;
  const show = (action: typeof mode, category?: Category) => {
    mode = action;
    selected = category;
    form.reset();
    form.querySelector<HTMLElement>(".editor-error")!.textContent = "";
    form.querySelector("h2")!.textContent =
      action === "create"
        ? "Nouvelle catégorie"
        : action === "rename"
          ? "Renommer la catégorie"
          : "Fusionner la catégorie";
    form.querySelector<HTMLElement>(".category-name-label")!.hidden = action === "merge";
    form.querySelector<HTMLElement>(".category-parent-label")!.hidden = action !== "create";
    form.querySelector<HTMLElement>(".category-target-label")!.hidden = action !== "merge";
    const name = form.elements.namedItem("name") as HTMLInputElement;
    name.required = action !== "merge";
    name.value = action === "rename" ? category!.name : "";
    const target = form.elements.namedItem("target") as HTMLSelectElement;
    target.required = action === "merge";
    target.innerHTML =
      action === "merge"
        ? categories
            .filter(
              (item) =>
                item.id !== category!.id && Boolean(item.parentId) === Boolean(category!.parentId),
            )
            .map(
              (item) =>
                `<option value="${escapeHtml(item.id)}">${escapeHtml(categoryLabel(item))}</option>`,
            )
            .join("")
        : "";
    dialog.showModal();
  };
  document.querySelector("#new-category")?.addEventListener("click", () => show("create"));
  document.querySelectorAll<HTMLElement>("[data-rename]").forEach((button) =>
    button.addEventListener("click", () =>
      show(
        "rename",
        categories.find((item) => item.id === button.dataset.rename),
      ),
    ),
  );
  document.querySelectorAll<HTMLElement>("[data-merge]").forEach((button) =>
    button.addEventListener("click", () =>
      show(
        "merge",
        categories.find((item) => item.id === button.dataset.merge),
      ),
    ),
  );
  dialog
    .querySelectorAll(".category-close")
    .forEach((button) => button.addEventListener("click", () => dialog.close()));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    button.disabled = true;
    try {
      if (mode === "create")
        await invoke("create_category", {
          category: {
            id: crypto.randomUUID(),
            name: String(values.get("name")).trim(),
            parentId: String(values.get("parent")) || null,
          },
        });
      if (mode === "rename")
        await invoke("rename_category", {
          id: selected!.id,
          name: String(values.get("name")).trim(),
        });
      if (mode === "merge")
        await invoke("merge_category", {
          sourceId: selected!.id,
          targetId: String(values.get("target")),
        });
      await refreshCategories();
      // Reload labels changed by a rename or merge before returning to another view.
      setTransactions(
        await invoke<Transaction[]>("list_transactions", { accountId: selectedAccount.id }),
      );
      setSchedules(await invoke<Schedule[]>("list_schedules"));
      dialog.close();
      renderCategories();
    } catch (error) {
      form.querySelector<HTMLElement>(".editor-error")!.textContent = String(error);
      button.disabled = false;
    }
  });
  document.querySelectorAll<HTMLElement>("[data-delete-category]").forEach((button) =>
    button.addEventListener("click", async () => {
      const item = categories.find((category) => category.id === button.dataset.deleteCategory);
      if (!item || !window.confirm(`Supprimer « ${categoryLabel(item)} » ?`)) return;
      try {
        await invoke("delete_category", { id: item.id });
        await refreshCategories();
        renderCategories();
      } catch (error) {
        document.querySelector<HTMLElement>(".category-message")!.textContent = String(error);
      }
    }),
  );
}
