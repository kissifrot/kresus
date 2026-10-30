import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
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
const generation = spawnSync(
  "python3",
  [join(root, "scripts/generate_test_database.py"), "--output", join(appData, "kresus.sqlite3")],
  { stdio: "inherit" },
);
if (generation.status !== 0) throw new Error("Création de la base fictive impossible.");
// Choose private ports instead of attaching to an existing WebDriver service.
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
const defaultMoneySample = resolve(root, "../references/Money.mny");
const moneySample =
  process.env.KRESUS_MONEY_SAMPLE ??
  (existsSync(defaultMoneySample) ? defaultMoneySample : undefined);
const moneyDestination = join(temp, "import.sqlite3");
const executable = process.env.TAURI_DRIVER || "tauri-driver";
const driver = spawn(executable, ["--port", String(port), "--native-port", String(nativePort)], {
  env: {
    ...process.env,
    XDG_DATA_HOME: data,
    KRESUS_E2E_BACKUP: join(temp, "backup.sqlite3"),
    ...(moneySample
      ? {
          KRESUS_E2E_MONEY_SOURCE: resolve(moneySample),
          KRESUS_E2E_MONEY_DESTINATION: moneyDestination,
        }
      : {}),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
let driverError;
driver.on("error", (error) => {
  driverError = error;
});
let session;
async function request(method, path, body) {
  const result = await fetch(endpoint + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const response = await result.json();
  if (!result.ok || response.value?.error) throw new Error(JSON.stringify(response.value));
  return response.value;
}
async function waitFor(fn, description) {
  const end = performance.now() + 30_000;
  let last;
  while (performance.now() < end) {
    if (driverError) throw driverError;
    if (driver.exitCode !== null)
      throw new Error(`tauri-driver s’est arrêté (${driver.exitCode}).`);
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${description} : délai dépassé${last ? ` (${last})` : ""}`);
}
async function element(selector) {
  const value = await request("POST", `/session/${session}/element`, {
    using: "css selector",
    value: selector,
  });
  return value["element-6066-11e4-a52e-4f735466cecf"];
}
async function text(selector) {
  return request("GET", `/session/${session}/element/${await element(selector)}/text`);
}
async function click(selector) {
  await request("POST", `/session/${session}/element/${await element(selector)}/click`, {});
}
async function execute(script, ...args) {
  return request("POST", `/session/${session}/execute/sync`, { script, args });
}
// Fill real form controls and emit the same input/change events as the UI.
async function fill(form, values) {
  await execute(
    `for (const [name, value] of Object.entries(arguments[1])) { const field = document.querySelector(arguments[0]).elements.namedItem(name); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); }`,
    form,
    values,
  );
}
async function visible(selector) {
  return execute("return !!document.querySelector(arguments[0]);", selector);
}
// Use WebDriver key actions, exercising focus and the native WebView event path.
async function key(value) {
  await request("POST", `/session/${session}/actions`, {
    actions: [
      {
        type: "key",
        id: "keyboard",
        actions: [
          { type: "keyDown", value },
          { type: "keyUp", value },
        ],
      },
    ],
  });
  await request("DELETE", `/session/${session}/actions`);
}
// Walk the actual tab order instead of moving focus directly to each target.
async function tabTo(selector, max = 30) {
  for (let i = 0; i <= max; i++) {
    if (await execute("return document.activeElement.matches(arguments[0])", selector)) return;
    await key("\uE004");
  }
  throw new Error(`Élément inaccessible avec Tab : ${selector}`);
}
async function activateFocused(selector) {
  await execute("document.querySelector(arguments[0]).focus()", selector);
  await key("\uE007");
}
async function screenshot(name) {
  if (!process.env.KRESUS_E2E_SCREENSHOTS) return;
  const directory = resolve(process.env.KRESUS_E2E_SCREENSHOTS);
  mkdirSync(directory, { recursive: true });
  const encoded = await request("GET", `/session/${session}/screenshot`);
  writeFileSync(join(directory, `${name}.png`), Buffer.from(encoded, "base64"));
}
async function categoryId(name) {
  return execute(
    "return [...document.querySelectorAll('.category-row')].find(row => row.querySelector('span').textContent.includes(arguments[0]))?.querySelector('[data-rename]')?.dataset.rename || null;",
    name,
  );
}
async function action(label, fn, check) {
  const started = performance.now();
  await fn();
  await waitFor(check, label);
  console.log(`${label} : ${(performance.now() - started).toFixed(0)} ms`);
}
try {
  await waitFor(async () => (await request("GET", "/status"))?.ready, "Démarrage de tauri-driver");
  const started = performance.now();
  const result = await request("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "wry",
        unhandledPromptBehavior: "accept",
        "tauri:options": { application: join(root, "src-tauri/target/debug/kresus") },
      },
    },
  });
  session = result.sessionId;
  await waitFor(
    async () => (await text(".page-heading h1")) === "Compte courant — test",
    "Ouverture du registre",
  );
  await waitFor(
    async () => (await text(".table-footer")).includes("10000"),
    "Chargement de 10 000 opérations",
  );
  console.log(
    `Démarrage Tauri et chargement du compte : ${(performance.now() - started).toFixed(0)} ms`,
  );
  // Check keyboard focus and activation without programmatically clicking the destination.
  await execute("document.querySelector('#household-nav').focus()");
  await key("\uE004"); // Tab
  if (!(await execute("return document.activeElement.id === 'schedules-nav'")))
    throw new Error("Navigation au clavier : le focus n’atteint pas Échéances.");
  await key("\uE007"); // Enter
  await waitFor(
    async () => (await text(".page-heading h1")) === "Échéances",
    "Ouverture des échéances au clavier",
  );
  await execute("document.querySelector('#new-schedule').focus()");
  await key("\uE007");
  await waitFor(() => visible("#schedule-dialog[open]"), "Ouverture du formulaire au clavier");
  for (const field of [
    "[name=accountId]",
    "[name=label]",
    "[name=category]",
    "[name=kind]",
    "[name=amount]",
    "[name=paymentMethod]",
    "[name=nextDue]",
    "[name=frequency]",
    "[name=limitType]",
    "button[type=submit]",
  ])
    await tabTo(`#schedule-dialog ${field}`);
  await key("\uE00C"); // Escape
  await waitFor(
    async () => !(await visible("#schedule-dialog[open]")),
    "Fermeture du formulaire au clavier",
  );
  console.log("Clavier : Tab, Entrée et Échap OK");

  // Inspect actual WebView layouts at minimum, intermediate and normal window sizes.
  for (const [width, height] of [
    [900, 620],
    [1100, 700],
    [1280, 820],
  ]) {
    await request("POST", `/session/${session}/window/rect`, { width, height });
    await waitFor(
      async () => (await execute("return window.innerWidth")) <= width,
      "Redimensionnement",
    );
    await screenshot(`echeances-${width}x${height}`);
    await click("#new-schedule");
    await waitFor(() => visible("#schedule-dialog[open]"), "Formulaire d’échéance");
    const layout = await execute(
      `const d=document.querySelector('#schedule-dialog'); const r=d.getBoundingClientRect(); return {left:r.left,right:r.right,width:innerWidth,scroll:d.scrollWidth,client:d.clientWidth, submit:!!d.querySelector('button[type=submit]')}`,
    );
    if (
      layout.left < -1 ||
      layout.right > layout.width + 1 ||
      layout.scroll > layout.client + 1 ||
      !layout.submit
    )
      throw new Error(`Formulaire tronqué à ${width} × ${height} : ${JSON.stringify(layout)}`);
    await screenshot(`formulaire-${width}x${height}`);
    // At reduced height, keyboard focus must scroll the submit button into view.
    await execute("document.querySelector('#schedule-dialog button[type=submit]').focus()");
    const submitVisible = await execute(
      `const d=document.querySelector('#schedule-dialog').getBoundingClientRect(); const b=document.querySelector('#schedule-dialog button[type=submit]').getBoundingClientRect(); return b.top >= d.top && b.bottom <= d.bottom && b.bottom <= innerHeight`,
    );
    if (!submitVisible)
      throw new Error(`Bouton d’enregistrement inaccessible à ${width} × ${height}`);
    await key("\uE00C");
    await waitFor(
      async () => !(await visible("#schedule-dialog[open]")),
      "Fermeture du formulaire",
    );
  }
  console.log("Tailles de fenêtre : formulaire vérifié à 900 × 620, 1100 × 700 et 1280 × 820");
  await execute("document.querySelector('[data-account=\"test-courant\"]').click()");
  await waitFor(
    async () => (await text(".page-heading h1")) === "Compte courant — test",
    "Retour au registre",
  );
  // Exercise the tab order in each main form and close it through its own controls.
  for (const scenario of [
    {
      trigger: ".add-account",
      dialog: "#account-dialog",
      fields: ["[name=name]", "[name=kind]", "[name=bank]", "[name=balance]"],
      cancel: ".account-close",
    },
    {
      trigger: "#new-transaction",
      dialog: "#transaction-dialog",
      fields: [
        "[name=type]",
        "[name=label]",
        "[name=date]",
        "[name=amount]",
        "[name=category]",
        "[name=cheque]",
        "[name=note]",
      ],
      cancel: ".dialog-cancel",
    },
    {
      trigger: "#new-transfer",
      dialog: "#transfer-dialog",
      fields: [
        "[name=sourceId]",
        "[name=destinationId]",
        "[name=date]",
        "[name=amount]",
        "[name=category]",
        "[name=note]",
      ],
      cancel: ".transfer-close",
    },
  ]) {
    await activateFocused(scenario.trigger);
    await waitFor(
      () => visible(`${scenario.dialog}[open]`),
      `Ouverture clavier ${scenario.dialog}`,
    );
    for (const field of scenario.fields) await tabTo(`${scenario.dialog} ${field}`);
    await tabTo(`${scenario.dialog} ${scenario.cancel}`);
    await key("\uE007");
    await waitFor(
      async () => !(await visible(`${scenario.dialog}[open]`)),
      `Annulation clavier ${scenario.dialog}`,
    );
  }
  await activateFocused("#categories-nav");
  await waitFor(
    async () => (await text(".page-heading h1")) === "Catégories",
    "Catégories au clavier",
  );
  await activateFocused("#new-category");
  await waitFor(() => visible("#category-dialog[open]"), "Formulaire catégorie au clavier");
  for (const field of ["[name=name]", "[name=parent]", "button[type=submit]", ".category-close"])
    await tabTo(`#category-dialog ${field}`);
  await key("\uE007");
  await waitFor(async () => !(await visible("#category-dialog[open]")), "Annulation catégorie");
  await activateFocused("#spending-nav");
  await waitFor(
    async () =>
      (await text(".page-heading h1")) === "Répartition des dépenses" &&
      !(await text(".spending-panel")).includes("Chargement"),
    "Rapport au clavier",
  );
  await execute("document.querySelector('#spending-filter [name=account]').focus()");
  for (const field of ["[name=start]", "[name=end]", "button[type=submit]"])
    await tabTo(`#spending-filter ${field}`);
  await activateFocused('[data-account="test-courant"]');
  await waitFor(
    async () => (await text(".page-heading h1")) === "Compte courant — test",
    "Registre au clavier",
  );
  console.log(
    "Clavier : formulaires de compte, opération, virement, catégorie et rapport accessibles par Tab et Entrée",
  );

  // Exercise the register and sticky editor at every supported window size.
  for (const [width, height] of [
    [900, 620],
    [1100, 700],
    [1280, 820],
  ]) {
    await request("POST", `/session/${session}/window/rect`, { width, height });
    await waitFor(
      async () => (await execute("return window.innerWidth")) <= width,
      "Taille du registre",
    );
    await screenshot(`registre-${width}x${height}`);
    await execute("document.querySelector('thead input[type=checkbox]').focus()");
    await tabTo("tbody tr[data-transaction]", 3);
    await key("\uE007");
    await waitFor(() => visible(".transaction-editor"), "Éditeur au clavier");
    const layout = await execute(
      `const p=document.querySelector('.transaction-editor-panel'); const r=p.getBoundingClientRect(); const t=document.querySelector('.table-wrap'); t.scrollLeft=t.scrollWidth; const reachesEnd=t.scrollLeft >= t.scrollWidth-t.clientWidth-1; t.scrollLeft=0; return {left:r.left,right:r.right,width:innerWidth,scroll:p.scrollWidth,client:p.clientWidth,tableScrollable:reachesEnd}`,
    );
    if (
      layout.left < -1 ||
      layout.right > layout.width + 1 ||
      layout.scroll > layout.client + 1 ||
      !layout.tableScrollable
    )
      throw new Error(`Éditeur tronqué à ${width} × ${height} : ${JSON.stringify(layout)}`);
    await screenshot(`registre-editeur-${width}x${height}`);
    await tabTo(".transaction-editor .cancel-editor");
    const visibleButton = await execute(
      `const p=document.querySelector('.transaction-editor-panel').getBoundingClientRect(), b=document.activeElement.getBoundingClientRect(); return b.top >= p.top && b.bottom <= p.bottom && b.bottom <= innerHeight`,
    );
    if (!visibleButton) throw new Error(`Annulation invisible à ${width} × ${height}`);
    await key("\uE007");
    await waitFor(
      async () => !(await visible(".transaction-editor")),
      "Annulation éditeur au clavier",
    );
    if (!(await execute("return document.activeElement.matches('tr[data-transaction]')")))
      throw new Error("Focus non restitué à la ligne du registre.");
  }
  console.log("Registre et éditeur : trois tailles et annulation clavier vérifiées");
  await action(
    "Page suivante",
    () => click("#next-page"),
    async () =>
      (await request(
        "GET",
        `/session/${session}/element/${await element("#page-input")}/property/value`,
      )) === "2",
  );
  await action(
    "Filtre à pointer",
    () => click("#filter-unreconciled"),
    async () =>
      (await request(
        "GET",
        `/session/${session}/element/${await element("#transaction-filter")}/property/value`,
      )) === "unreconciled",
  );
  await action(
    "Vue d’ensemble",
    () => click("#household-nav"),
    async () => (await text(".page-heading h1")) === "Vue d’ensemble",
  );
  await action(
    "Échéances",
    () => click("#schedules-nav"),
    async () => (await text(".page-heading h1")) === "Échéances",
  );
  await action(
    "Catégories",
    () => click("#categories-nav"),
    async () => (await text(".page-heading h1")) === "Catégories",
  );
  await action(
    "Rapport de dépenses",
    () => click("#spending-nav"),
    async () =>
      (await text(".page-heading h1")) === "Répartition des dépenses" &&
      !(await text(".spending-panel")).includes("Chargement"),
  );
  // Work exclusively in the isolated temporary database created above.
  await click(".add-account");
  await fill("#account-form", {
    name: "Compte recette",
    kind: "Compte courant",
    bank: "Banque fictive",
    balance: "100.00",
  });
  await click('#account-form button[type="submit"]');
  await waitFor(
    async () => (await text(".page-heading h1")) === "Compte recette",
    "Création du compte",
  );
  await execute(
    "const el = document.querySelector('#transaction-filter'); el.value = 'all'; el.dispatchEvent(new Event('change', { bubbles: true }));",
  );
  await waitFor(
    async () =>
      (await request(
        "GET",
        `/session/${session}/element/${await element("#transaction-filter")}/property/value`,
      )) === "all",
    "Réinitialisation du filtre",
  );
  if (!(await text(".balance-card")).includes("100,00")) throw new Error("Solde initial incorrect");
  console.log("Compte : création et solde initial OK");
  await click("#backup-database");
  await waitFor(
    async () => (await text(".database-error")).includes("Sauvegarde créée"),
    "Sauvegarde",
  );
  await click("#new-transaction");
  await fill("#transaction-form", { label: "À effacer par restauration", amount: "10.00" });
  await click('#transaction-form button[type="submit"]');
  await waitFor(
    async () => (await text("tbody")).includes("À effacer par restauration"),
    "Opération après sauvegarde",
  );
  await click("#restore-database");
  await waitFor(
    async () => (await text(".database-error")).includes("Sauvegarde restaurée"),
    "Restauration",
  );
  await execute(
    "return [...document.querySelectorAll('[data-account]')].find(button => button.textContent.includes('Compte recette')).click();",
  );
  await waitFor(
    async () => (await text(".page-heading h1")) === "Compte recette",
    "Compte restauré",
  );
  if (
    (await text("tbody")).includes("À effacer par restauration") ||
    !(await text(".balance-card")).includes("100,00")
  )
    throw new Error("La restauration n’a pas rétabli les données sauvegardées");
  console.log("Sauvegarde et restauration : données et solde vérifiés");

  await click("#new-transaction");
  await fill("#transaction-form", {
    label: "Achat recette",
    amount: "12.34",
    cheque: "0012345",
    note: "Commentaire initial",
  });
  // Clipboard access is opt-in and must use a private Xvfb display.
  if (process.env.KRESUS_E2E_CLIPBOARD === "1") {
    if (process.env.GDK_BACKEND !== "x11" || !process.env.DISPLAY)
      throw new Error(
        "Le test du presse-papiers nécessite GDK_BACKEND=x11 et un affichage Xvfb isolé.",
      );
    const clipboard = spawnSync("xclip", ["-selection", "clipboard"], {
      input: "12,34 €",
      encoding: "utf8",
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (clipboard.status !== 0)
      throw new Error("Presse-papiers X11 indisponible : installer xclip.");
    const amountInput = await element('#transaction-form input[name="amount"]');
    await request("POST", `/session/${session}/element/${amountInput}/clear`, {});
    await request("POST", `/session/${session}/element/${amountInput}/value`, {
      text: "\uE009v\uE000",
      value: ["\uE009", "v", "\uE000"],
    });
    const pasted = await request(
      "GET",
      `/session/${session}/element/${amountInput}/property/value`,
    );
    if (pasted !== "12,34 €") throw new Error("Collage incorrect : " + pasted);
    console.log("Collage d’un montant français OK");
  } else console.log("Collage réel ignoré : voir KRESUS_E2E_CLIPBOARD dans le README.");
  await tabTo('#transaction-form button[type="submit"]');
  await key("\uE007");
  await waitFor(
    async () => (await text("tbody")).includes("Achat recette"),
    "Création d’opération",
  );
  if (
    !(await text("tbody")).includes("0012345") ||
    !(await text("tbody")).includes("Commentaire initial") ||
    !(await text(".balance-card")).includes("87,66")
  )
    throw new Error("Chèque, commentaire ou solde incorrect");
  await execute(
    "document.querySelector('#transaction-search').value='Commentaire initial'; document.querySelector('#transaction-search-form').requestSubmit()",
  );
  await waitFor(
    async () => (await text("tbody")).includes("Achat recette"),
    "Recherche par commentaire",
  );
  await execute(
    "document.querySelector('#transaction-search').value='introuvable'; document.querySelector('#transaction-search-form').requestSubmit()",
  );
  await waitFor(
    async () => !(await text("tbody")).includes("Achat recette"),
    "Recherche sans résultat",
  );
  await execute(
    "document.querySelector('#transaction-search').value=''; document.querySelector('#transaction-search-form').requestSubmit()",
  );
  await waitFor(
    async () => (await text("tbody")).includes("Achat recette"),
    "Réinitialisation recherche",
  );
  console.log("Recherche par commentaire et réinitialisation OK");
  await execute("document.querySelector('thead input[type=checkbox]').focus()");
  await key("\uE004");
  if (!(await execute("return document.activeElement.matches('tbody tr[data-transaction]')")))
    throw new Error("La touche Tab n’atteint pas la première opération.");
  await key("\uE007");
  await waitFor(async () => await visible(".transaction-editor"), "Édition au clavier");
  if (
    !(await execute(
      "return document.activeElement.name === 'label' && !!document.activeElement.closest('.transaction-editor')",
    ))
  )
    throw new Error("Focus absent de l’éditeur d’opération.");
  await fill(".transaction-editor", {
    label: "Achat modifié",
    amount: "20.00",
    note: "Commentaire modifié",
  });
  await click('.transaction-editor button[type="submit"]');
  await waitFor(
    async () => (await text("tbody")).includes("Achat modifié"),
    "Modification d’opération",
  );
  if (
    !(await text(".balance-card")).includes("80,00") ||
    !(await text("tbody")).includes("Commentaire modifié")
  )
    throw new Error("Solde ou commentaire après modification incorrect");
  await click("[data-reconcile]");
  await waitFor(async () => (await text("[data-reconcile]")) === "P", "Pointage");
  await click("[data-delete]");
  await waitFor(
    async () => !(await text("tbody")).includes("Achat modifié"),
    "Suppression d’opération",
  );
  if (!(await text(".balance-card")).includes("100,00"))
    throw new Error("Solde après suppression incorrect");
  console.log(
    "Opérations : création, chèque, commentaire, modification, pointage et suppression OK",
  );

  await click("#new-transfer");
  await fill("#transfer-form", {
    destinationId: "test-courant",
    amount: "25.50",
    note: "Virement recette",
  });
  await click('#transfer-form button[type="submit"]');
  await waitFor(
    async () => (await text("tbody")).includes("Virement vers Compte courant"),
    "Création de virement",
  );
  if (!(await text(".balance-card")).includes("74,50"))
    throw new Error("Solde du virement incorrect");
  await execute("document.querySelector('tbody tr[data-transaction]').focus()");
  await key("\uE007");
  await waitFor(() => visible("#transfer-dialog[open]"), "Édition de virement au clavier");
  await fill("#transfer-form", { amount: "30.00" });
  await click('#transfer-form button[type="submit"]');
  await waitFor(
    async () => (await text(".balance-card")).includes("70,00"),
    "Modification du virement",
  );
  await click('[data-account="test-courant"]');
  await waitFor(
    async () => (await text(".page-heading h1")) === "Compte courant — test",
    "Compte destinataire",
  );
  await waitFor(
    async () => (await text("tbody")).includes("Virement depuis Compte recette"),
    "Opération liée",
  );
  if (!(await text("tbody")).includes("30,00")) throw new Error("Montant lié incorrect");
  const transferDeleteId = await execute(
    "return [...document.querySelectorAll('tbody tr')].find(row => row.textContent.includes('Virement depuis Compte recette'))?.querySelector('[data-delete]')?.dataset.delete;",
  );
  await click(`[data-delete="${transferDeleteId}"]`);
  await waitFor(
    async () => !(await text("tbody")).includes("Virement depuis Compte recette"),
    "Suppression du virement",
  );
  await click('[data-account="test-courant"]');
  await waitFor(
    async () => (await text(".page-heading h1")) === "Compte courant — test",
    "Retour au compte source",
  );
  await execute(
    "return [...document.querySelectorAll('[data-account]')].find(button => button.textContent.includes('Compte recette')).click();",
  );
  await waitFor(
    async () => (await text(".page-heading h1")) === "Compte recette",
    "Retour au compte recette",
  );
  if (
    !(await text(".balance-card")).includes("100,00") ||
    (await text("tbody")).includes("Virement vers")
  )
    throw new Error("La suppression du virement n’a pas restauré les deux comptes");
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
  await waitFor(
    async () => await categoryId("Sous-catégorie recette"),
    "Création de sous-catégorie",
  );
  const childId = await categoryId("Sous-catégorie recette");
  await click(`[data-rename="${childId}"]`);
  await fill("#category-form", { name: "Sous-catégorie renommée" });
  await click('#category-form button[type="submit"]');
  await waitFor(async () => await categoryId("Sous-catégorie renommée"), "Renommage de catégorie");
  await click(`[data-merge="${childId}"]`);
  await fill("#category-form", { target: "food-store" });
  await click('#category-form button[type="submit"]');
  await waitFor(
    async () => !(await categoryId("Sous-catégorie renommée")),
    "Fusion de sous-catégorie",
  );
  await click(`[data-delete-category="${rootId}"]`);
  await waitFor(async () => !(await categoryId("Catégorie recette")), "Suppression de catégorie");
  console.log("Catégories : création, renommage, fusion et suppression OK");

  await click("#schedules-nav");
  await click("#new-schedule");
  await fill("#schedule-form", {
    label: "Échéance recette",
    amount: "9.99",
    frequency: "Mensuelle",
  });
  await click('#schedule-form button[type="submit"]');
  await waitFor(
    async () => (await text(".schedule-list")).includes("Échéance recette"),
    "Création d’échéance",
  );
  const scheduleId = await execute(
    "return [...document.querySelectorAll('.schedule-row')].find(row => row.textContent.includes('Échéance recette'))?.querySelector('[data-edit-schedule]')?.dataset.editSchedule;",
  );
  await click("#schedule-year-view");
  await waitFor(
    async () => (await text(".annual-schedules")).includes("Échéance recette"),
    "Vue annuelle des échéances",
  );
  // Edit a projection, including when the next occurrence is in the next year.
  const currentMonth = await execute("return new Date().getMonth();");
  if (currentMonth === 11) await click("#next-year");
  const futureOriginal = await execute(
    'return document.querySelector(`[data-edit-future="${arguments[0]}"]`)?.dataset.originalDue',
    scheduleId,
  );
  if (!futureOriginal) throw new Error("Prévision annuelle introuvable");
  await click(`[data-edit-future="${scheduleId}"][data-original-due="${futureOriginal}"]`);
  await fill("#schedule-form", { paymentMethod: "cheque", cheque: "0012345", amount: "15.00" });
  await click('#schedule-form button[type="submit"]');
  await waitFor(async () => !(await visible("#schedule-dialog[open]")), "Modification future");
  await click(`[data-edit-future="${scheduleId}"][data-original-due="${futureOriginal}"]`);
  const futureValues = await execute(
    "const f=document.querySelector('#schedule-form'); return [f.elements.amount.value,f.elements.cheque.value]",
  );
  if (futureValues[0] !== "15,00" || futureValues[1] !== "0012345")
    throw new Error("Modification future non conservée");
  await click(".schedule-close");
  if (currentMonth === 11) await click("#previous-year");
  console.log("Occurrence future : modification et relecture dans la vue annuelle OK");
  await click(`[data-annual-month="${currentMonth}"]`);
  await waitFor(
    async () => await visible(`[data-edit-schedule="${scheduleId}"]`),
    "Retour au mois depuis la vue annuelle",
  );
  await click(`[data-edit-schedule="${scheduleId}"]`);
  await fill("#schedule-form", { amount: "11.50", scope: "occurrence" });
  await click('#schedule-form button[type="submit"]');
  await waitFor(
    async () => (await text(".schedule-list")).includes("11,50"),
    "Modification ponctuelle d’échéance",
  );
  await click(`[data-record-schedule="${scheduleId}"]`);
  await waitFor(
    async () => !(await visible(`[data-record-schedule="${scheduleId}"]`)),
    "Enregistrement d’échéance",
  );
  await click("#next-month");
  await waitFor(
    async () => await visible(`[data-edit-schedule="${scheduleId}"]`),
    "Occurrence suivante",
  );
  await click(`[data-edit-schedule="${scheduleId}"]`);
  await fill("#schedule-form", { scope: "series", amount: "12.50" });
  await click('#schedule-form button[type="submit"]');
  await waitFor(
    async () => (await text(".schedule-list")).includes("12,50"),
    "Modification de série",
  );
  await click("#next-month");
  await waitFor(
    async () =>
      (await text(".schedule-list")).includes("12,50") &&
      (await text(".schedule-list")).includes("Prévision"),
    "Prévision après modification de série",
  );
  await click(`[data-delete-schedule="${scheduleId}"]`);
  await waitFor(
    async () => !(await visible(`[data-delete-schedule="${scheduleId}"]`)),
    "Suppression de série",
  );
  await execute(
    "return [...document.querySelectorAll('[data-account]')].find(button => button.textContent.includes('Compte recette')).click();",
  );
  await waitFor(
    async () => (await text(".page-heading h1")) === "Compte recette",
    "Compte de l’échéance",
  );
  await waitFor(
    async () => (await text("tbody")).includes("Échéance recette"),
    "Opération issue de l’échéance",
  );
  if (!(await text("tbody")).includes("11,50"))
    throw new Error("Montant de l’échéance enregistrée incorrect");
  console.log(
    "Échéances : création, modification ponctuelle et de série, enregistrement et suppression OK",
  );
  // Validate a bounded series until its final occurrence is consumed.
  await click("#schedules-nav");
  await click("#new-schedule");
  await fill("#schedule-form", {
    label: "Recette limitée",
    amount: "7.00",
    limitType: "count",
    remainingCount: "2",
    paymentMethod: "cheque",
    cheque: "0012345",
  });
  await click('#schedule-form button[type="submit"]');
  await waitFor(
    async () => (await text(".schedule-list")).includes("Recette limitée"),
    "Création série limitée",
  );
  const limitedId = await execute(
    "return [...document.querySelectorAll('.schedule-row')].find(r => r.textContent.includes('Recette limitée')).querySelector('[data-record-schedule]').dataset.recordSchedule",
  );
  await click(`[data-record-schedule="${limitedId}"]`);
  await waitFor(
    async () => !(await visible(`[data-record-schedule="${limitedId}"]`)),
    "Première occurrence limitée",
  );
  await click("#next-month");
  await waitFor(
    async () => await visible(`[data-record-schedule="${limitedId}"]`),
    "Dernière occurrence limitée",
  );
  await click(`[data-record-schedule="${limitedId}"]`);
  await waitFor(
    async () => !(await visible(`[data-record-schedule="${limitedId}"]`)),
    "Fin série limitée",
  );
  await execute(
    "return [...document.querySelectorAll('[data-account]')].find(button => button.textContent.includes('Compte recette')).click();",
  );
  await waitFor(
    async () => (await text("tbody")).includes("Recette limitée"),
    "Opérations de série limitée",
  );
  const limitedRows = await execute(
    "return [...document.querySelectorAll('tbody tr')].filter(r=>r.textContent.includes('Recette limitée')).map(r=>r.textContent)",
  );
  if (limitedRows.length !== 2 || limitedRows.filter((r) => r.includes("0012345")).length !== 1)
    throw new Error("Fin de série ou numéro de chèque incorrect : " + JSON.stringify(limitedRows));
  console.log("Série limitée : deux occurrences enregistrées, numéro non répété OK");
  // An end date is inclusive, including when two past occurrences are overdue.
  await click("#schedules-nav");
  await click("#new-schedule");
  const dates = await execute(
    `const now = new Date(); const fmt = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-01'; return [fmt(new Date(now.getFullYear(), now.getMonth()-2, 1)), fmt(new Date(now.getFullYear(), now.getMonth()-1, 1))]`,
  );
  await fill("#schedule-form", {
    label: "Recette fin datée",
    amount: "3,45",
    nextDue: dates[0],
    limitType: "date",
    endDate: dates[1],
  });
  await click('#schedule-form button[type="submit"]');
  await waitFor(
    async () => (await text(".schedule-list")).includes("Recette fin datée"),
    "Création date limite",
  );
  const datedId = await execute(
    "return [...document.querySelectorAll('.schedule-row')].find(r => r.textContent.includes('Recette fin datée')).querySelector('[data-record-schedule]').dataset.recordSchedule",
  );
  await click("#household-nav");
  await waitFor(async () => await visible("#household-overdue"), "Retard dans le foyer");
  await click("#household-overdue");
  await waitFor(
    async () => (await text(".schedule-list-heading")).includes("en retard"),
    "Liste des retards",
  );
  await click(`[data-record-schedule="${datedId}"]`);
  const monthLabel = await execute(
    `return new Intl.DateTimeFormat("fr-FR", { month: "short", year: "numeric" }).format(new Date(arguments[0]+"T12:00:00"))`,
    dates[1],
  );
  await waitFor(
    async () =>
      (await visible(`[data-record-schedule="${datedId}"]`)) &&
      (await text(".schedule-list")).includes(monthLabel),
    "Deuxième échéance en retard",
  );
  const dueAfter = await execute(
    "return [...document.querySelectorAll('.schedule-row')].find(r=>r.textContent.includes('Recette fin datée')).querySelector('time').textContent",
  );
  if (!dueAfter.includes("1")) throw new Error("Date limite avancée incorrectement");
  await click(`[data-record-schedule="${datedId}"]`);
  await waitFor(
    async () => !(await visible(`[data-record-schedule="${datedId}"]`)),
    "Fin inclusive de la série",
  );
  console.log("Retards depuis le foyer et date de fin inclusive : OK");
  await click("#spending-nav");
  await waitFor(
    async () => !(await text(".spending-panel")).includes("Chargement"),
    "Rapport chargé",
  );
  await fill("#spending-filter", { start: "2027-02-01", end: "2027-01-01" });
  await click('#spending-filter button[type="submit"]');
  await waitFor(
    async () => (await text(".spending-error")).includes("période valide"),
    "Rejet période inversée",
  );
  console.log("Rapport : période inversée rejetée OK");
  await execute(
    "return [...document.querySelectorAll('[data-account]')].find(button => button.textContent.includes('Compte recette')).click();",
  );
  await waitFor(
    async () => (await text(".page-heading h1")) === "Compte recette",
    "Compte du rapport",
  );
  const receiptId = await execute(
    "return [...document.querySelectorAll('[data-account]')].find(button => button.textContent.includes('Compte recette')).dataset.account",
  );
  await click("#new-transfer");
  await fill("#transfer-form", { destinationId: "test-courant", amount: "10,00" });
  await click('#transfer-form button[type="submit"]');
  await waitFor(
    async () => (await text("tbody")).includes("Virement vers Compte courant"),
    "Virement pour rapport",
  );
  await click("#spending-nav");
  await waitFor(
    async () => !(await text(".spending-panel")).includes("Chargement"),
    "Rapport avec virement",
  );
  const end = await execute(
    "const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')",
  );
  await fill("#spending-filter", { start: dates[0], end });
  await click('#spending-filter button[type="submit"]');
  await waitFor(async () => await visible(".spending-total strong"), "Totaux du rapport");
  const query = spawnSync(
    "python3",
    [
      "-c",
      `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
rows=c.execute("SELECT t.amount_cents, EXISTS(SELECT 1 FROM transfers x WHERE x.debit_id=t.id OR x.credit_id=t.id) FROM transactions t WHERE t.account_id=? AND t.operation_date BETWEEN ? AND ?",sys.argv[2:]).fetchall()
assert any(transfer for amount,transfer in rows), rows
print(sum(-amount for amount,transfer in rows if amount<0 and not transfer))`,
      join(appData, "kresus.sqlite3"),
      receiptId,
      dates[0],
      end,
    ],
    { encoding: "utf8" },
  );
  if (query.status !== 0) throw new Error("Lecture rapport : " + query.stderr);
  const expected = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" })
    .format(Number(query.stdout.trim()) / 100)
    .replace(/\s/g, "");
  const actual = (await text(".spending-total strong")).replace(/\s/g, "");
  await waitFor(
    async () => (await text(".spending-total strong")).replace(/\s/g, "") === expected,
    `Total du rapport attendu ${expected}, reçu ${actual}`,
  );
  console.log("Rapport : total SQLite et exclusion du virement vérifiés OK");
  await click("#schedules-nav");
  await click("#new-schedule");
  await fill("#schedule-form", {
    label: "Virement périodique recette",
    kind: "transfer",
    accountId: receiptId,
    destinationAccountId: "test-courant",
    amount: "8,25",
    nextDue: end,
    frequency: "Bimestrielle",
  });
  await click('#schedule-form button[type="submit"]');
  await waitFor(
    async () => (await text(".schedule-list")).includes("Virement périodique recette"),
    "Création virement récurrent",
  );
  const recurringId = await execute(
    "return [...document.querySelectorAll('.schedule-row')].find(r => r.textContent.includes('Virement périodique recette')).querySelector('[data-record-schedule]').dataset.recordSchedule",
  );
  await click(`[data-record-schedule="${recurringId}"]`);
  await waitFor(
    async () => !(await visible(`[data-record-schedule="${recurringId}"]`)),
    "Enregistrement du virement récurrent",
  );
  const transferCheck = spawnSync(
    "python3",
    [
      "-c",
      `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
rows=c.execute("SELECT d.account_id,d.amount_cents,r.account_id,r.amount_cents FROM transfers x JOIN transactions d ON d.id=x.debit_id JOIN transactions r ON r.id=x.credit_id WHERE d.note LIKE '%Virement périodique recette%'").fetchall()
assert rows==[(sys.argv[2],-825,'test-courant',825)],rows`,
      join(appData, "kresus.sqlite3"),
      receiptId,
    ],
    { encoding: "utf8" },
  );
  if (transferCheck.status !== 0) throw new Error("Virement récurrent : " + transferCheck.stderr);
  console.log("Virement récurrent : création manuelle et opérations liées vérifiées OK");
  // The debug-only E2E build substitutes paths for native portal dialogs.
  if (moneySample) {
    if (!existsSync(moneySample)) throw new Error("Fichier Money de test introuvable.");
    const destination = moneyDestination;
    await click("#import-money");
    await waitFor(() => visible(".money-import-dialog[open]"), "Aperçu Money");
    await execute("document.querySelector('.money-import-dialog .dialog-close').focus()");
    await tabTo('.money-import-dialog input[name="account"]');
    await tabTo('.money-import-dialog button[type="submit"]');
    const preview = await text(".money-import-dialog");
    if (
      !preview.includes("138 catégories") ||
      !preview.includes("875,00") ||
      !preview.includes("2 opérations") ||
      !preview.includes("2 échéances") ||
      !preview.includes("exclus")
    )
      throw new Error("Aperçu Money incomplet.");
    if (existsSync(destination)) throw new Error("La base de destination existe avant l’import.");
    await click('.money-import-dialog button[type="submit"]');
    await waitFor(
      async () => existsSync(destination) && (await text(".balance-card")).includes("875,00"),
      "Import Money et affichage du compte",
    );
    await waitFor(
      async () =>
        (await text(".table-footer")).includes("2 opérations") ||
        (await text(".table-footer")).includes("sur 2"),
      "Opérations importées",
    );
    const verification = spawnSync(
      "python3",
      [
        "-c",
        `import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
a = c.execute("SELECT name, opening_balance_cents FROM accounts ORDER BY name").fetchall()
t = c.execute("SELECT amount_cents FROM transactions ORDER BY amount_cents").fetchall()
n = c.execute("SELECT count(*) FROM categories WHERE id LIKE 'money-cat-%'").fetchone()[0]
s = c.execute("SELECT next_due, frequency, amount_cents FROM schedules ORDER BY next_due").fetchall()
assert a == [("Compte courant", 100000), ("Livret A", 200000)] and t == [(-10000,), (-2500,)] and n == 138 and s == [("2026-10-15", "Bimestrielle", -10000), ("2026-10-31", "Mensuelle", -12000)], (a, t, n, s)`,
        destination,
      ],
      { encoding: "utf8" },
    );
    if (verification.status !== 0)
      throw new Error(`Base Money incorrecte : ${verification.stderr}`);
    await click("#schedules-nav");
    await click("#current-month");
    const offset = await execute(
      "const now = new Date(); return (2026 - now.getFullYear()) * 12 + 9 - now.getMonth();",
    );
    if (Math.abs(offset) > 240)
      throw new Error("Date système trop éloignée de l’échantillon Money.");
    for (let i = 0; i < Math.abs(offset); i++)
      await click(offset < 0 ? "#previous-month" : "#next-month");
    await waitFor(
      async () => await visible('[data-record-schedule="money-schedule-2"]'),
      "Virement récurrent importé",
    );
    await click('[data-record-schedule="money-schedule-2"]');
    await waitFor(
      async () => !(await visible('[data-record-schedule="money-schedule-2"]')),
      "Enregistrement du virement récurrent",
    );
    const transferCheck = spawnSync(
      "python3",
      [
        "-c",
        `import sqlite3, sys
c=sqlite3.connect(sys.argv[1])
assert c.execute("SELECT next_due FROM schedules WHERE id='money-schedule-2'").fetchone() == ('2026-12-15',)
assert c.execute("SELECT count(*) FROM transfers").fetchone() == (1,)
assert c.execute("SELECT amount_cents FROM transactions WHERE id LIKE 'schedule-%' ORDER BY amount_cents").fetchall() == [(-10000,), (10000,)]`,
        destination,
      ],
      { encoding: "utf8" },
    );
    if (transferCheck.status !== 0)
      throw new Error(`Virement récurrent incorrect : ${transferCheck.stderr}`);
    console.log(
      "Import Money : aperçu, échéances, virement enregistré et base SQLite vérifiés (chemins de test)",
    );
  } else
    console.log("Import Money ignoré : définir KRESUS_MONEY_SAMPLE pour tester le fichier fictif.");
  console.log("Parcours WebDriver réussi ; base utilisateur non utilisée.");
} finally {
  if (session) {
    try {
      await request("DELETE", `/session/${session}`);
    } catch {}
  }
  driver.kill();
  rmSync(temp, { recursive: true, force: true });
}
