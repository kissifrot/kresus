import { listen } from "@tauri-apps/api/event";
import { runMenuAction, openRequestedDatabase } from "./accounts";
import { invoke } from "@tauri-apps/api/core";
import type { Account, Schedule, Category } from "./types";
import { accounts, setAccounts, setSelectedAccount, setSchedules, setCategories } from "./state";
import { migrateBrowserTransactions, refreshTransactions } from "./transactions";

// Serialize file requests, including those received during initial rendering.
let openRequests = Promise.resolve();
function drainFileRequests() {
  openRequests = openRequests
    .then(async () => {
      for (const path of await invoke<string[]>("take_file_requests"))
        await openRequestedDatabase(path);
    })
    .catch((error) => console.error("Unable to process file-open requests", error));
}

async function initialize() {
  if ("__TAURI_INTERNALS__" in window) {
    await listen<string>("kresus-menu", (event) => void runMenuAction(event.payload));
    await listen("kresus-file-request", () => void initialized.then(drainFileRequests));
  }
  setAccounts(await invoke<Account[]>("list_accounts"));
  if (!accounts[0]) throw new Error("La base ne contient aucun compte.");
  setSelectedAccount(accounts[0]);
  setSchedules(await invoke<Schedule[]>("list_schedules"));
  setCategories(await invoke<Category[]>("list_categories"));
  await migrateBrowserTransactions();
  await refreshTransactions();
  if ("__TAURI_INTERNALS__" in window) drainFileRequests();
}
const initialized = initialize();
