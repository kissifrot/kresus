import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import net from "node:net";

// Isolate the Tauri data directory so tests never open the user's real database.
const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "kresus-webdriver-"));
const data = join(temp, "data");
const appData = join(data, "com.kissifrot.kresus");
mkdirSync(appData, { recursive: true });
const generation = spawnSync("python3", [join(root, "scripts/generate_test_database.py"), "--output", join(appData, "kresus.sqlite3")], { stdio: "inherit" });
if (generation.status !== 0) throw new Error("Création de la base fictive impossible.");
// Choose private ports instead of attaching to an existing WebDriver service.
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
const port = await freePort();
let nativePort = await freePort();
while (nativePort === port) nativePort = await freePort();
const endpoint = `http://127.0.0.1:${port}`;
const defaultMoneySample = resolve(root, "../references/Money.mny");
const moneySample = process.env.KRESUS_MONEY_SAMPLE ?? (existsSync(defaultMoneySample) ? defaultMoneySample : undefined);
const moneyDestination = join(temp, "import.sqlite3");
const executable = process.env.TAURI_DRIVER || "tauri-driver";
const driver = spawn(executable, ["--port", String(port), "--native-port", String(nativePort)], { env: { ...process.env, XDG_DATA_HOME: data, ...(moneySample ? { KRESUS_E2E_MONEY_SOURCE: resolve(moneySample), KRESUS_E2E_MONEY_DESTINATION: moneyDestination } : {}) }, stdio: ["ignore", "inherit", "inherit"] });
let driverError;
driver.on("error", (error) => { driverError = error; });
let session;
async function request(method, path, body) {
  const result = await fetch(endpoint + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const response = await result.json();
  if (!result.ok || response.value?.error) throw new Error(JSON.stringify(response.value));
  return response.value;
}
async function waitFor(fn, description) {
  const end = performance.now() + 30_000;
  let last;
  while (performance.now() < end) {
    if (driverError) throw driverError;
    if (driver.exitCode !== null) throw new Error(`tauri-driver s’est arrêté (${driver.exitCode}).`);
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${description} : délai dépassé${last ? ` (${last})` : ""}`);
}
async function element(selector) {
  const value = await request("POST", `/session/${session}/element`, { using: "css selector", value: selector });
  return value["element-6066-11e4-a52e-4f735466cecf"];
}
async function text(selector) { return request("GET", `/session/${session}/element/${await element(selector)}/text`); }
async function click(selector) { await request("POST", `/session/${session}/element/${await element(selector)}/click`, {}); }
async function execute(script, ...args) { return request("POST", `/session/${session}/execute/sync`, { script, args }); }
// Fill real form controls and emit the same input/change events as the UI.
async function fill(form, values) {
  await execute(`for (const [name, value] of Object.entries(arguments[1])) { const field = document.querySelector(arguments[0]).elements.namedItem(name); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); }`, form, values);
}
async function visible(selector) { return execute("return !!document.querySelector(arguments[0]);", selector); }
async function categoryId(name) { return execute("return [...document.querySelectorAll('.category-row')].find(row => row.querySelector('span').textContent.includes(arguments[0]))?.querySelector('[data-rename]')?.dataset.rename || null;", name); }
async function action(label, fn, check) {
  const started = performance.now();
  await fn();
  await waitFor(check, label);
  console.log(`${label} : ${(performance.now() - started).toFixed(0)} ms`);
}
try {
  await waitFor(async () => (await request("GET", "/status"))?.ready, "Démarrage de tauri-driver");
  const started = performance.now();
  const result = await request("POST", "/session", { capabilities: { alwaysMatch: { browserName: "wry", unhandledPromptBehavior: "accept", "tauri:options": { application: join(root, "src-tauri/target/debug/kresus") } } } });
  session = result.sessionId;
  await waitFor(async () => (await text(".page-heading h1")) === "Compte courant — test", "Ouverture du registre");
  await waitFor(async () => (await text(".table-footer")).includes("10000"), "Chargement de 10 000 opérations");
  console.log(`Démarrage Tauri et chargement du compte : ${(performance.now() - started).toFixed(0)} ms`);
  await action("Page suivante", () => click("#next-page"), async () => (await request("GET", `/session/${session}/element/${await element("#page-input")}/property/value`)) === "2");
  await action("Filtre à pointer", () => click("#filter-unreconciled"), async () => (await request("GET", `/session/${session}/element/${await element("#transaction-filter")}/property/value`)) === "unreconciled");
  await action("Vue d’ensemble", () => click("#household-nav"), async () => (await text(".page-heading h1")) === "Vue d’ensemble");
  await action("Échéances", () => click("#schedules-nav"), async () => (await text(".page-heading h1")) === "Échéances");
  await action("Catégories", () => click("#categories-nav"), async () => (await text(".page-heading h1")) === "Catégories");
  await action("Rapport de dépenses", () => click("#spending-nav"), async () => (await text(".page-heading h1")) === "Répartition des dépenses" && !(await text(".spending-panel")).includes("Chargement"));
  // Work exclusively in the isolated temporary database created above.
  await click(".add-account");
  await fill("#account-form", { name: "Compte recette", kind: "Compte courant", bank: "Banque fictive", balance: "100.00" });
  await click('#account-form button[type="submit"]');
  await waitFor(async () => (await text(".page-heading h1")) === "Compte recette", "Création du compte");
  await execute("const el = document.querySelector('#transaction-filter'); el.value = 'all'; el.dispatchEvent(new Event('change', { bubbles: true }));");
  await waitFor(async () => (await request("GET", `/session/${session}/element/${await element("#transaction-filter")}/property/value`)) === "all", "Réinitialisation du filtre");
  if (!(await text(".balance-card")).includes("100,00")) throw new Error("Solde initial incorrect");
  console.log("Compte : création et solde initial OK");

  await click("#new-transaction");
  await fill("#transaction-form", { label: "Achat recette", amount: "12.34", cheque: "0012345", note: "Commentaire initial" });
  await click('#transaction-form button[type="submit"]');
  await waitFor(async () => (await text("tbody")).includes("Achat recette"), "Création d’opération");
  if (!(await text("tbody")).includes("0012345") || !(await text("tbody")).includes("Commentaire initial") || !(await text(".balance-card")).includes("87,66")) throw new Error("Chèque, commentaire ou solde incorrect");
  await click("tbody tr[data-transaction] .date-cell");
  await fill(".transaction-editor", { label: "Achat modifié", amount: "20.00", note: "Commentaire modifié" });
  await click('.transaction-editor button[type="submit"]');
  await waitFor(async () => (await text("tbody")).includes("Achat modifié"), "Modification d’opération");
  if (!(await text(".balance-card")).includes("80,00") || !(await text("tbody")).includes("Commentaire modifié")) throw new Error("Solde ou commentaire après modification incorrect");
  await click("[data-reconcile]");
  await waitFor(async () => (await text("[data-reconcile]")) === "P", "Pointage");
  await click("[data-delete]");
  await waitFor(async () => !(await text("tbody")).includes("Achat modifié"), "Suppression d’opération");
  if (!(await text(".balance-card")).includes("100,00")) throw new Error("Solde après suppression incorrect");
  console.log("Opérations : création, chèque, commentaire, modification, pointage et suppression OK");

  await click("#new-transfer");
  await fill("#transfer-form", { destinationId: "test-courant", amount: "25.50", note: "Virement recette" });
  await click('#transfer-form button[type="submit"]');
  await waitFor(async () => (await text("tbody")).includes("Virement vers Compte courant"), "Création de virement");
  if (!(await text(".balance-card")).includes("74,50")) throw new Error("Solde du virement incorrect");
  await click("tbody tr[data-transaction] .date-cell");
  await waitFor(() => visible('#transfer-dialog[open]'), "Édition de virement");
  await fill("#transfer-form", { amount: "30.00" });
  await click('#transfer-form button[type="submit"]');
  await waitFor(async () => (await text(".balance-card")).includes("70,00"), "Modification du virement");
  await click('[data-account="test-courant"]');
  await waitFor(async () => (await text(".page-heading h1")) === "Compte courant — test", "Compte destinataire");
  await waitFor(async () => (await text("tbody")).includes("Virement depuis Compte recette"), "Opération liée");
  if (!(await text("tbody")).includes("30,00")) throw new Error("Montant lié incorrect");
  const transferDeleteId = await execute("return [...document.querySelectorAll('tbody tr')].find(row => row.textContent.includes('Virement depuis Compte recette'))?.querySelector('[data-delete]')?.dataset.delete;");
  await click(`[data-delete="${transferDeleteId}"]`);
  await waitFor(async () => !(await text("tbody")).includes("Virement depuis Compte recette"), "Suppression du virement");
  await click('[data-account="test-courant"]');
  await waitFor(async () => (await text(".page-heading h1")) === "Compte courant — test", "Retour au compte source");
  await execute("return [...document.querySelectorAll('[data-account]')].find(button => button.textContent.includes('Compte recette')).click();");
  await waitFor(async () => (await text(".page-heading h1")) === "Compte recette", "Retour au compte recette");
  if (!(await text(".balance-card")).includes("100,00") || (await text("tbody")).includes("Virement vers")) throw new Error("La suppression du virement n’a pas restauré les deux comptes");
  console.log("Virements : création, modification et suppression des deux mouvements OK");

  await click("#categories-nav");
  await click("#new-category");
  await fill("#category-form", { name: "Catégorie recette" });
  await click('#category-form button[type="submit"]');
  await waitFor(async () => await categoryId("Catégorie recette"), "Création de catégorie");
  const rootId = await categoryId("Catégorie recette");
  await click("#new-category");
  await fill("#category-form", { name: "Sous-catégorie recette", parent: rootId });
  await click('#category-form button[type="submit"]');
  await waitFor(async () => await categoryId("Sous-catégorie recette"), "Création de sous-catégorie");
  const childId = await categoryId("Sous-catégorie recette");
  await click(`[data-rename="${childId}"]`);
  await fill("#category-form", { name: "Sous-catégorie renommée" });
  await click('#category-form button[type="submit"]');
  await waitFor(async () => await categoryId("Sous-catégorie renommée"), "Renommage de catégorie");
  await click(`[data-merge="${childId}"]`);
  await fill("#category-form", { target: "food-store" });
  await click('#category-form button[type="submit"]');
  await waitFor(async () => !(await categoryId("Sous-catégorie renommée")), "Fusion de sous-catégorie");
  await click(`[data-delete-category="${rootId}"]`);
  await waitFor(async () => !(await categoryId("Catégorie recette")), "Suppression de catégorie");
  console.log("Catégories : création, renommage, fusion et suppression OK");

  await click("#schedules-nav");
  await click("#new-schedule");
  await fill("#schedule-form", { label: "Échéance recette", amount: "9.99", frequency: "Mensuelle" });
  await click('#schedule-form button[type="submit"]');
  await waitFor(async () => (await text(".schedule-list")).includes("Échéance recette"), "Création d’échéance");
  const scheduleId = await execute("return [...document.querySelectorAll('.schedule-row')].find(row => row.textContent.includes('Échéance recette'))?.querySelector('[data-edit-schedule]')?.dataset.editSchedule;");
  await click(`[data-edit-schedule="${scheduleId}"]`);
  await fill("#schedule-form", { amount: "11.50", scope: "occurrence" });
  await click('#schedule-form button[type="submit"]');
  await waitFor(async () => (await text(".schedule-list")).includes("11,50"), "Modification ponctuelle d’échéance");
  await click(`[data-record-schedule="${scheduleId}"]`);
  await waitFor(async () => !(await visible(`[data-record-schedule="${scheduleId}"]`)), "Enregistrement d’échéance");
  await click("#next-month");
  await waitFor(async () => await visible(`[data-edit-schedule="${scheduleId}"]`), "Occurrence suivante");
  await click(`[data-edit-schedule="${scheduleId}"]`);
  await fill("#schedule-form", { scope: "series", amount: "12.50" });
  await click('#schedule-form button[type="submit"]');
  await waitFor(async () => (await text(".schedule-list")).includes("12,50"), "Modification de série");
  await click("#next-month");
  await waitFor(async () => (await text(".schedule-list")).includes("12,50") && (await text(".schedule-list")).includes("Prévision"), "Prévision après modification de série");
  await click(`[data-delete-schedule="${scheduleId}"]`);
  await waitFor(async () => !(await visible(`[data-delete-schedule="${scheduleId}"]`)), "Suppression de série");
  await execute("return [...document.querySelectorAll('[data-account]')].find(button => button.textContent.includes('Compte recette')).click();");
  await waitFor(async () => (await text(".page-heading h1")) === "Compte recette", "Compte de l’échéance");
  await waitFor(async () => (await text("tbody")).includes("Échéance recette"), "Opération issue de l’échéance");
  if (!(await text("tbody")).includes("11,50")) throw new Error("Montant de l’échéance enregistrée incorrect");
  console.log("Échéances : création, modification ponctuelle et de série, enregistrement et suppression OK");
  // The debug-only E2E build substitutes paths for native portal dialogs.
  if (moneySample) {
    if (!existsSync(moneySample)) throw new Error("Fichier Money de test introuvable.");
    const destination = moneyDestination;
    await click("#import-money");
    await waitFor(() => visible(".money-import-dialog[open]"), "Aperçu Money");
    const preview = await text(".money-import-dialog");
    if (!preview.includes("138 catégories") || !preview.includes("875,00") || !preview.includes("2 opérations") || !preview.includes("2 échéances") || !preview.includes("exclus")) throw new Error("Aperçu Money incomplet.");
    if (existsSync(destination)) throw new Error("La base de destination existe avant l’import.");
    await click('.money-import-dialog button[type="submit"]');
    await waitFor(async () => existsSync(destination) && (await text(".balance-card")).includes("875,00"), "Import Money et affichage du compte");
    await waitFor(async () => (await text(".table-footer")).includes("2 opérations") || (await text(".table-footer")).includes("sur 2"), "Opérations importées");
    const verification = spawnSync("python3", ["-c", `import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
a = c.execute("SELECT name, opening_balance_cents FROM accounts ORDER BY name").fetchall()
t = c.execute("SELECT amount_cents FROM transactions ORDER BY amount_cents").fetchall()
n = c.execute("SELECT count(*) FROM categories WHERE id LIKE 'money-cat-%'").fetchone()[0]
s = c.execute("SELECT next_due, frequency, amount_cents FROM schedules ORDER BY next_due").fetchall()
assert a == [("Compte courant", 100000), ("Livret A", 200000)] and t == [(-10000,), (-2500,)] and n == 138 and s == [("2026-10-15", "Bimestrielle", -10000), ("2026-10-31", "Mensuelle", -12000)], (a, t, n, s)`, destination], { encoding: "utf8" });
    if (verification.status !== 0) throw new Error(`Base Money incorrecte : ${verification.stderr}`);
    await click("#schedules-nav");
    await click("#current-month");
    const offset = await execute("const now = new Date(); return (2026 - now.getFullYear()) * 12 + 9 - now.getMonth();");
    if (Math.abs(offset) > 240) throw new Error("Date système trop éloignée de l’échantillon Money.");
    for (let i = 0; i < Math.abs(offset); i++) await click(offset < 0 ? "#previous-month" : "#next-month");
    await waitFor(async () => await visible('[data-record-schedule="money-schedule-2"]'), "Virement récurrent importé");
    await click('[data-record-schedule="money-schedule-2"]');
    await waitFor(async () => !(await visible('[data-record-schedule="money-schedule-2"]')), "Enregistrement du virement récurrent");
    const transferCheck = spawnSync("python3", ["-c", `import sqlite3, sys
c=sqlite3.connect(sys.argv[1])
assert c.execute("SELECT next_due FROM schedules WHERE id='money-schedule-2'").fetchone() == ('2026-12-15',)
assert c.execute("SELECT count(*) FROM transfers").fetchone() == (1,)
assert c.execute("SELECT amount_cents FROM transactions WHERE id LIKE 'schedule-%' ORDER BY amount_cents").fetchall() == [(-10000,), (10000,)]`, destination], { encoding: "utf8" });
    if (transferCheck.status !== 0) throw new Error(`Virement récurrent incorrect : ${transferCheck.stderr}`);
    console.log("Import Money : aperçu, échéances, virement enregistré et base SQLite vérifiés (chemins de test)");
  } else console.log("Import Money ignoré : définir KRESUS_MONEY_SAMPLE pour tester le fichier fictif.");
  console.log("Parcours WebDriver réussi ; base utilisateur non utilisée.");
} finally {
  if (session) { try { await request("DELETE", `/session/${session}`); } catch {} }
  driver.kill();
  rmSync(temp, { recursive: true, force: true });
}
