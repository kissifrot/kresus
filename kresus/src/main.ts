import { invoke } from "@tauri-apps/api/core";
import type { Account, Schedule, Category } from "./types";
import { accounts, setAccounts, setSelectedAccount, setSchedules, setCategories } from "./state";
import { migrateBrowserTransactions, refreshTransactions } from "./transactions";

async function initialize() {
  setAccounts(await invoke<Account[]>("list_accounts"));
  setSelectedAccount(accounts[0]);
  setSchedules(await invoke<Schedule[]>("list_schedules"));
  setCategories(await invoke<Category[]>("list_categories"));
  await migrateBrowserTransactions();
  await refreshTransactions();
}
void initialize();
