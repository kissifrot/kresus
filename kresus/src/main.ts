import { listen } from "@tauri-apps/api/event";
import {
  runMenuAction,
  openRequestedDatabase,
  reloadDatabase,
  setTransactionCommentsVisible,
} from "./accounts";
import { invoke } from "@tauri-apps/api/core";

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
    await listen<string>(
      "kresus-menu",
      (event) => void initialized.then(() => runMenuAction(event.payload)),
    );
    await listen("kresus-file-request", () => void initialized.then(drainFileRequests));
  }
  const {
    path,
    warning,
    showTransactionComments = false,
  } = await invoke<{
    path: string | null;
    warning: string | null;
    showTransactionComments: boolean;
  }>("startup_database");
  setTransactionCommentsVisible(showTransactionComments);
  await reloadDatabase(path);
  if (warning) document.querySelector<HTMLElement>(".database-error")!.textContent = warning;
  if ("__TAURI_INTERNALS__" in window) drainFileRequests();
}
const initialized = initialize();
