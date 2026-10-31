import { listen } from "@tauri-apps/api/event";
import { runMenuAction } from "./accounts";
import { invoke } from "@tauri-apps/api/core";
import type { Account, Schedule, Category } from "./types";
import { accounts, setAccounts, setSelectedAccount, setSchedules, setCategories } from "./state";
import { migrateBrowserTransactions, refreshTransactions } from "./transactions";

async function initialize() {
  if ("__TAURI_INTERNALS__" in window) {
    await listen<string>("kresus-menu", (event) => void runMenuAction(event.payload));
  }
  setAccounts(await invoke<Account[]>("list_accounts"));
  if (!accounts[0]) throw new Error("La base ne contient aucun compte.");
  setSelectedAccount(accounts[0]);
  setSchedules(await invoke<Schedule[]>("list_schedules"));
  setCategories(await invoke<Category[]>("list_categories"));
  await migrateBrowserTransactions();
  await refreshTransactions();
}
void initialize();
