import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";

// Run only under an isolated X11 display and session bus, with disposable application data.
if (
  process.env.GDK_BACKEND !== "x11" ||
  !process.env.DISPLAY ||
  !process.env.DBUS_SESSION_BUS_ADDRESS
)
  throw new Error("Utilisez une session Xvfb et D-Bus isolée ; voir le README.");
const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "kresus-native-dialogs-"));
const data = join(temp, "data");
const appData = join(data, "com.kissifrot.kresus");
mkdirSync(appData, { recursive: true });
for (const dir of ["config", "cache", "state"]) mkdirSync(join(temp, dir));
const generated = spawnSync(
  "python3",
  [join(root, "scripts/generate_test_database.py"), "--output", join(appData, "kresus.sqlite3")],
  { stdio: "inherit" },
);
if (generated.status !== 0) throw new Error("Base de test indisponible.");
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
const port = await freePort();
let nativePort = await freePort();
while (nativePort === port) nativePort = await freePort();
const endpoint = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  XDG_DATA_HOME: data,
  XDG_CONFIG_HOME: join(temp, "config"),
  XDG_CACHE_HOME: join(temp, "cache"),
  XDG_STATE_HOME: join(temp, "state"),
};
// Ensure a debug build cannot substitute paths for native file dialogs.
for (const key of ["KRESUS_E2E_BACKUP", "KRESUS_E2E_MONEY_SOURCE", "KRESUS_E2E_MONEY_DESTINATION"])
  delete env[key];
const driver = spawn(
  process.env.TAURI_DRIVER || "tauri-driver",
  ["--port", String(port), "--native-port", String(nativePort)],
  { env, stdio: ["ignore", "inherit", "inherit"] },
);
let driverError;
driver.on("error", (error) => {
  driverError = error;
});
let session;
async function request(method, path, body) {
  const response = await fetch(endpoint + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json();
  if (!response.ok || data.value?.error) throw new Error(JSON.stringify(data.value));
  return data.value;
}
async function waitFor(fn, description) {
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    if (driverError) throw driverError;
    if (driver.exitCode !== null) throw new Error("Le pilote s’est arrêté.");
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${description} : délai dépassé${last ? ` (${last})` : ""}`);
}
async function click(selector) {
  const result = await request("POST", `/session/${session}/element`, {
    using: "css selector",
    value: selector,
  });
  await request(
    "POST",
    `/session/${session}/element/${result["element-6066-11e4-a52e-4f735466cecf"]}/click`,
    {},
  );
}
async function text(selector) {
  const result = await request("POST", `/session/${session}/element`, {
    using: "css selector",
    value: selector,
  });
  return request(
    "GET",
    `/session/${session}/element/${result["element-6066-11e4-a52e-4f735466cecf"]}/text`,
  );
}
function xdotool(...args) {
  const result = spawnSync("xdotool", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`xdotool : ${result.stderr}`);
  return result.stdout.trim();
}
async function dialog() {
  return waitFor(() => {
    const found = spawnSync(
      "xdotool",
      ["search", "--onlyvisible", "--name", "^(Open File|Save File)$"],
      { encoding: "utf8" },
    );
    return found.status === 0 ? found.stdout.trim().split("\n").at(-1) : null;
  }, "Dialogue natif");
}
async function closeDialog(id) {
  xdotool("windowfocus", "--sync", id);
  xdotool("key", "Escape");
  await waitFor(
    () =>
      spawnSync("xdotool", ["search", "--onlyvisible", "--name", "^(Open File|Save File)$"])
        .status !== 0,
    "Fermeture du dialogue natif",
  );
}
// GTK's location entry allows selection without changing the real user's clipboard.
async function selectPath(id, path) {
  xdotool("windowfocus", "--sync", id);
  xdotool("key", "ctrl+l");
  xdotool("key", "ctrl+a");
  xdotool("type", "--clearmodifiers", "--", path);
  xdotool("key", "Return");
  // GTK may first select the file and require a second Enter to open it.
  await new Promise((resolve) => setTimeout(resolve, 700));
  const stillOpen = spawnSync("xdotool", [
    "search",
    "--onlyvisible",
    "--name",
    "^(Open File|Save File)$",
  ]);
  if (stillOpen.status === 0) {
    xdotool("windowfocus", "--sync", id);
    xdotool("key", "Return");
  }
  await waitFor(
    () =>
      spawnSync("xdotool", ["search", "--onlyvisible", "--name", "^(Open File|Save File)$"])
        .status !== 0,
    "Validation du dialogue natif",
  );
}
try {
  await waitFor(async () => (await request("GET", "/status"))?.ready, "Pilote WebDriver");
  const result = await request("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "wry",
        unhandledPromptBehavior: "ignore",
        "tauri:options": { application: join(root, "src-tauri/target/debug/kresus") },
      },
    },
  });
  session = result.sessionId;
  await waitFor(
    async () => (await text(".page-heading h1")) === "Compte courant — test",
    "Registre",
  );
  for (const [selector, name] of [
    ["#choose-database", "Ouverture d’une base"],
    ["#backup-database", "Sauvegarde"],
    ["#restore-database", "Restauration"],
    ["#import-money", "Import Money"],
  ]) {
    await click(selector);
    const id = await dialog();
    await closeDialog(id);
    console.log(`${name} : dialogue natif ouvert et annulé au clavier`);
  }
  if (existsSync(join(temp, "backup.sqlite3")))
    throw new Error("L’annulation a créé une sauvegarde.");
  const backupPath = join(temp, "native-backup.sqlite3");
  await click("#backup-database");
  await selectPath(await dialog(), backupPath);
  await waitFor(() => existsSync(backupPath), "Création de la sauvegarde native");
  await waitFor(
    async () => (await text(".database-error")).includes("Sauvegarde créée"),
    "Confirmation de sauvegarde",
  );
  await click("#choose-database");
  await selectPath(await dialog(), backupPath);
  await waitFor(
    async () =>
      (
        await request("POST", `/session/${session}/execute/sync`, {
          script: "return document.querySelector('.database-controls small')?.textContent",
          args: [],
        })
      )?.includes("native-backup.sqlite3"),
    "Ouverture de la base choisie",
  );
  await click("#default-database");
  await waitFor(
    async () =>
      (
        await request("POST", `/session/${session}/execute/sync`, {
          script: "return document.querySelector('.database-controls small')?.textContent",
          args: [],
        })
      )?.includes("Base habituelle"),
    "Retour à la base habituelle",
  );
  await click("#restore-database");
  await selectPath(await dialog(), backupPath);
  await waitFor(async () => {
    try {
      return (await text(".confirmation-dialog[open]")).includes("remplacées");
    } catch {
      return false;
    }
  }, "Confirmation de restauration");
  await click(".confirmation-cancel");
  await click("#restore-database");
  await selectPath(await dialog(), backupPath);
  await waitFor(async () => {
    try {
      return (await text(".confirmation-dialog[open]")).includes("remplacées");
    } catch {
      return false;
    }
  }, "Confirmation de restauration");
  await click(".confirmation-accept");
  await waitFor(
    async () => (await text(".database-error")).includes("Sauvegarde restaurée"),
    "Restauration native",
  );
  console.log(
    "Dialogues natifs : sauvegarde, ouverture et confirmation de restauration vérifiées.",
  );
  // Copy the fixture into the disposable directory and never alter the original.
  const sample = process.env.KRESUS_MONEY_SAMPLE ?? resolve(root, "../references/Money.mny");
  if (existsSync(sample)) {
    const moneyPath = join(temp, "money-sample.mny");
    copyFileSync(sample, moneyPath);
    await click("#import-money");
    await selectPath(await dialog(), moneyPath);
    const preview = await waitFor(async () => {
      try {
        return await text(".money-import-dialog[open]");
      } catch {
        return null;
      }
    }, "Aperçu du fichier Money sélectionné");
    if (
      !preview.includes("Compte courant") ||
      !preview.includes("875,00") ||
      !preview.includes("138 catégories")
    )
      throw new Error("Aperçu Money inattendu après sélection native.");
    await click(".money-import-dialog .cancel-money");
    await waitFor(
      async () => (await text(".page-heading h1")) === "Compte courant — test",
      "Annulation de l’import Money",
    );
    console.log("Sélection native Money : aperçu et annulation vérifiés.");
  } else {
    console.log("Sélection native Money ignorée : fichier de référence absent.");
  }
} finally {
  if (session)
    try {
      await request("DELETE", `/session/${session}`);
    } catch {}
  driver.kill();
  rmSync(temp, { recursive: true, force: true });
}
