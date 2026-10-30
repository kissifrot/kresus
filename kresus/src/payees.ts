import { invoke } from "@tauri-apps/api/core";

// Populate a form's datalist without affecting its current input value.
export async function loadPayeeSuggestions(list: HTMLDataListElement) {
  try {
    const payees = await invoke<string[]>("list_payees");
    list.replaceChildren(
      ...payees.map((payee) => {
        const option = document.createElement("option");
        option.value = payee;
        return option;
      }),
    );
  } catch (error) {
    console.error("Impossible de charger les suggestions de destinataires.", error);
  }
}
