import { localDate } from "./format";
import { listen } from "@tauri-apps/api/event";
import { runMenuAction, openRequestedDatabase, openInitialAccount } from "./accounts";
import { invoke } from "@tauri-apps/api/core";
import type { Account, Schedule, Category } from "./types";
import { setAccounts, setSchedules, setCategories } from "./state";

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
  setAccounts(await invoke<Account[]>("list_accounts", { today: localDate(new Date()) }));
  setSchedules(await invoke<Schedule[]>("list_schedules"));
  setCategories(await invoke<Category[]>("list_categories"));
  await openInitialAccount();
  if ("__TAURI_INTERNALS__" in window) drainFileRequests();
}
const initialized = initialize();
