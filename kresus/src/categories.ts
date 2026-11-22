import { TEXT_NAME_LIMIT } from "./text-limits";
import { invoke } from "@tauri-apps/api/core";
import type { Category, CategoryKind, Schedule, Transaction } from "./types";
import { categories, selectedAccount, setCategories, setSchedules, setTransactions } from "./state";
import { escapeHtml } from "./format";
import { render } from "./accounts";
import { confirmAction } from "./confirmation";

export function categoryLabel(category: Category): string {
  const parent = categories.find((item) => item.id === category.parentId);
  return parent ? `${parent.name} · ${category.name}` : category.name;
}

const groupNames = { debit: "Dépenses", credit: "Recettes", common: "Communes" } as const;

function categoryGroups(preferred?: string) {
  if (preferred === "debit") return ["debit", "common", "credit"] as const;
  if (preferred === "credit") return ["credit", "common", "debit"] as const;
  return ["common", "debit", "credit"] as const;
}

// Keep an existing value available even if it is absent from the catalog.
export function categoryOptions(current = "", preferred?: string, emptyChoice = false): string {
  const groups = { debit: [] as string[], credit: [] as string[], common: [] as string[] };
  for (const category of categories)
    groups[category.kind ?? "common"].push(categoryLabel(category));
  if (current && !Object.values(groups).some((labels) => labels.includes(current)))
    groups.common.push(current);
  const options = (labels: string[]) =>
    labels
      .sort((a, b) => a.localeCompare(b, "fr"))
      .map(
        (label) =>
          `<option value="${escapeHtml(label)}" ${label === current ? "selected" : ""}>${escapeHtml(label)}</option>`,
      )
      .join("");
  const grouped = groups.debit.length || groups.credit.length;
  const kind = categoryKind(preferred);
  const prompt =
    emptyChoice || (!current && grouped && kind && !groups[kind].length && !groups.common.length)
      ? '<option value="">Choisir…</option>'
      : "";
  if (!grouped) return prompt + options(groups.common);
  return (
    prompt +
    categoryGroups(preferred)
      .filter((group) => groups[group].length)
      .map((group) => `<optgroup label="${groupNames[group]}">${options(groups[group])}</optgroup>`)
      .join("")
  );
}

export async function refreshCategories() {
  setCategories(await invoke<Category[]>("list_categories"));
}

async function createCategory(name: string, parentId: string | null, kind: CategoryKind | null) {
  const category: Category = { id: crypto.randomUUID(), name: name.trim(), parentId, kind };
  await invoke("create_category", { category });
  return category;
}

function categoryKind(value?: string): CategoryKind | null {
  return value === "debit" || value === "credit" ? value : null;
}

const categoryKindField = `<label class="category-kind-label">Groupe<select name="categoryKind"><option value="">Communes</option><option value="debit">Dépenses</option><option value="credit">Recettes</option></select></label>`;

function bindCategoryKindField(form: HTMLFormElement) {
  const parent = form.elements.namedItem("parent") as HTMLSelectElement;
  const select = form.elements.namedItem("categoryKind") as HTMLSelectElement;
  let rootKind = select.value;
  select.addEventListener("change", () => (rootKind = select.value));
  const sync = () => {
    select.disabled = !!parent.value;
    select.value = parent.value
      ? (categories.find((root) => root.id === parent.value)?.kind ?? "")
      : rootKind;
  };
  parent.addEventListener("change", sync);
  return () => {
    rootKind = select.value;
    sync();
  };
}

// Keep the operation or schedule form open while a category is created.
export function bindCategoryCreation(form: HTMLFormElement) {
  const select = form.elements.namedItem("category") as HTMLSelectElement;
  const type = (form.elements.namedItem("type") ??
    form.elements.namedItem("kind")) as HTMLSelectElement | null;
  const setOptions = (current = "") => {
    select.innerHTML = categoryOptions(current, type?.value);
  };
  type?.addEventListener("change", () => {
    const currentKind = categories.find(
      (category) => categoryLabel(category) === select.value,
    )?.kind;
    const kind = categoryKind(type.value);
    setOptions(kind && currentKind && kind !== currentKind ? "" : select.value);
  });
  form.querySelector<HTMLButtonElement>(".add-category")!.addEventListener("click", () => {
    const dialog = document.createElement("dialog");
    const roots = categories.filter((category) => !category.parentId);
    dialog.innerHTML = `<form id="quick-category-form"><div class="dialog-heading"><h2>Nouvelle catégorie</h2><button type="button" class="dialog-close" aria-label="Fermer">×</button></div><label>Nom<input name="name" maxlength="${TEXT_NAME_LIMIT}" required autofocus></label><label>Catégorie principale<select name="parent"><option value="">Aucune — catégorie principale</option>${roots.map((root) => `<option value="${escapeHtml(root.id)}">${escapeHtml(root.name)}</option>`).join("")}</select></label>${categoryKindField}<p class="editor-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-button quick-category-cancel">Annuler</button><button type="submit" class="primary-button">Créer la catégorie</button></div></form>`;
    document.body.append(dialog);
    const close = () => {
      dialog.close();
      dialog.remove();
      select.focus();
    };
    dialog
      .querySelectorAll(".dialog-close, .quick-category-cancel")
      .forEach((button) => button.addEventListener("click", close));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    const categoryForm = dialog.querySelector<HTMLFormElement>("form")!;
    (categoryForm.elements.namedItem("categoryKind") as HTMLSelectElement).value =
      categoryKind(type?.value) ?? "";
    bindCategoryKindField(categoryForm);
    categoryForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = new FormData(categoryForm);
      const button = categoryForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      button.disabled = true;
      try {
        const category = await createCategory(
          String(values.get("name")),
          String(values.get("parent")) || null,
          categoryKind(String(values.get("categoryKind") ?? "")),
        );
        await refreshCategories();
        const label = categoryLabel(category);
        setOptions(label);
        close();
      } catch (error) {
        categoryForm.querySelector<HTMLElement>(".editor-error")!.textContent = String(error);
        button.disabled = false;
      }
    });
    dialog.showModal();
  });
  return setOptions;
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
      categoryGroups("debit")
        .map((group) => {
          const items = roots.filter((root) => (root.kind ?? "common") === group);
          if (!items.length) return "";
          const rows = items
            .map(
              (root) =>
                `${row(root)}${categories
                  .filter((item) => item.parentId === root.id)
                  .sort((a, b) => a.name.localeCompare(b.name, "fr"))
                  .map(row)
                  .join("")}`,
            )
            .join("");
          return `<section><h2 class="category-group-heading">${groupNames[group]}</h2>${rows}</section>`;
        })
        .join("") || '<p class="category-empty">Aucune catégorie.</p>'
    }</section><p class="category-message" role="alert"></p><dialog id="category-dialog"><form id="category-form"><div class="dialog-heading"><h2></h2><button type="button" class="dialog-close category-close" aria-label="Fermer">×</button></div><label class="category-name-label">Nom<input name="name" maxlength="${TEXT_NAME_LIMIT}"></label><label class="category-parent-label">Catégorie principale<select name="parent"><option value="">Aucune — catégorie principale</option>${roots.map((root) => `<option value="${escapeHtml(root.id)}">${escapeHtml(root.name)}</option>`).join("")}</select></label>${categoryKindField}<label class="category-target-label">Fusionner vers<select name="target"></select></label><p class="editor-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-button category-close">Annuler</button><button type="submit" class="primary-button">Enregistrer</button></div></form></dialog>`;
  const dialog = document.querySelector<HTMLDialogElement>("#category-dialog")!;
  const form = document.querySelector<HTMLFormElement>("#category-form")!;
  const resetKindField = bindCategoryKindField(form);
  let mode: "create" | "rename" | "merge" = "create";
  let selected: Category | undefined;
  const show = (action: typeof mode, category?: Category) => {
    mode = action;
    selected = category;
    form.reset();
    resetKindField();
    form.querySelector<HTMLElement>(".category-kind-label")!.hidden = action !== "create";
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
        await createCategory(
          String(values.get("name")),
          String(values.get("parent")) || null,
          categoryKind(String(values.get("categoryKind") ?? "")),
        );
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
      const accountId = selectedAccount?.id;
      if (accountId !== undefined)
        setTransactions(await invoke<Transaction[]>("list_transactions", { accountId }));
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
      if (
        !item ||
        !(await confirmAction(
          "Confirmer la suppression",
          `Supprimer « ${categoryLabel(item)} » ?`,
          "Supprimer",
        ))
      )
        return;
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
