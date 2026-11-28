import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  renameSync,
} from "node:fs";
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
  [join(root, "scripts/generate_test_database.py"), "--output", join(appData, "comptes.kresus")],
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
const defaultMoneySample = resolve(root, "tests/fixtures/money-reference.mny");
const moneySample = process.env.KRESUS_MONEY_SAMPLE ?? defaultMoneySample;
const moneyDestination = join(temp, "import.kresus");
const ofxSource = join(temp, "releve.ofx");
const backupPath = join(temp, "backup.kresus");
const executable = process.env.TAURI_DRIVER || "tauri-driver";
const driver = spawn(executable, ["--port", String(port), "--native-port", String(nativePort)], {
  env: {
    ...process.env,
    XDG_DATA_HOME: data,
    KRESUS_E2E_BACKUP: backupPath,
    KRESUS_E2E_OFX_SOURCE: ofxSource,
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
    // Creating a WebKit session may be slow on a cold CI runner.
    signal: AbortSignal.timeout(path === "/session" ? 60_000 : 20_000),
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
// Emit the same event as a native menu item; native shortcut activation is checked separately.
async function menuAction(action) {
  await request("POST", `/session/${session}/execute/sync`, {
    script: "return window.__TAURI__.event.emit('kresus-menu', arguments[0])",
    args: [action],
  });
}
async function text(selector) {
  return request("GET", `/session/${session}/element/${await element(selector)}/text`);
}
async function click(selector) {
  await request("POST", `/session/${session}/element/${await element(selector)}/click`, {});
}
async function clickRegisterControl(selector) {
  // Center the button in the register so the sticky header cannot cover it.
  await waitFor(
    () =>
      execute(
        `const button = document.querySelector(arguments[0]);
         if (!button) return false;
         button.scrollIntoView({block: 'center', inline: 'center'});
         const rect = button.getBoundingClientRect();
         return button.contains(document.elementFromPoint(
           rect.left + rect.width / 2, rect.top + rect.height / 2
         ));`,
        selector,
      ),
    `Bouton du registre accessible pour ${selector}`,
  );
  await click(selector);
}

// Schedule options can extend the dialog beyond the viewport; scroll its own content.
async function submitSchedule() {
  await execute(
    "const dialog = document.querySelector('#schedule-dialog'); dialog.scrollTop = dialog.scrollHeight",
  );
  await waitFor(
    () =>
      execute(
        "const r = document.querySelector('#schedule-form button[type=submit]').getBoundingClientRect(), d = document.querySelector('#schedule-dialog').getBoundingClientRect(); return r.top >= Math.max(0, d.top) - 1 && r.bottom <= Math.min(innerHeight, d.bottom) + 1",
      ),
    "Bouton d’enregistrement de l’échéance visible",
  );
  await click('#schedule-form button[type="submit"]');
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
async function openSession(path) {
  const result = await request("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "wry",
        unhandledPromptBehavior: "accept",
        "tauri:options": {
          application: join(root, "src-tauri/target/debug/kresus"),
          args: [path],
        },
      },
    },
  });
  session = result.sessionId;
}

try {
  await waitFor(async () => (await request("GET", "/status"))?.ready, "Démarrage de tauri-driver");
  const started = performance.now();
  const external = join(temp, "Foyer fictif.kresus");
  copyFileSync(join(appData, "comptes.kresus"), external);
  const rename = spawnSync("python3", [
    "-c",
    "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"UPDATE accounts SET name='Compte externe' WHERE id='test-courant'\"); c.commit()",
    external,
  ]);
  if (rename.status !== 0) throw new Error("Préparation de la base externe impossible.");
  await openSession(external);
  await waitFor(
    async () => (await text(".page-heading h1")) === "Compte externe",
    "Ouverture au démarrage",
  );
  await menuAction("default");
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
  // A second process forwards the document to the existing window via the isolated session bus.
  const launchFile = (path) =>
    spawnSync(join(root, "src-tauri/target/debug/kresus"), [path], {
      env: { ...process.env, XDG_DATA_HOME: data },
      encoding: "utf8",
      timeout: 15000,
    });
  const opened = launchFile(external);
  if (opened.status !== 0) throw new Error(`Ouverture externe impossible : ${opened.stderr}`);
  await waitFor(
    async () => (await text(".page-heading h1")) === "Compte externe",
    "Ouverture du fichier externe",
  );
  const invalid = join(temp, "invalide.kresus");
  writeFileSync(invalid, "not a database");
  const rejected = launchFile(invalid);
  if (rejected.status !== 0) throw new Error("Transmission de la base invalide impossible.");
  await waitFor(
    async () => (await text(".database-error")).includes("Ouverture impossible"),
    "Erreur de base invalide",
  );
  if ((await text(".page-heading h1")) !== "Compte externe")
    throw new Error("La base active a changé après une erreur.");
  await menuAction("default");
  await waitFor(
    async () => (await text(".page-heading h1")) === "Compte courant — test",
    "Retour à la base habituelle",
  );
  console.log(
    "Fichier Kresus : ouverture dans la fenêtre existante et refus d’une base invalide vérifiés",
  );
  // The chart is loaded on demand and works on the large test database.
  await click("#balance-history-toggle");
  await waitFor(
    async () =>
      (await execute("return document.querySelectorAll('#balance-history circle').length")) > 2,
    "Historique du solde",
  );
  await screenshot("historique-solde-1280x820");
  await request("POST", `/session/${session}/window/rect`, { width: 900, height: 620 });
  await screenshot("historique-solde-900x620");
  await request("POST", `/session/${session}/window/rect`, { width: 1280, height: 820 });
  await click("#balance-history-toggle");
  console.log("Historique du solde : points quotidiens chargés depuis SQLite");
  // Add a future movement temporarily so the forecast has a deterministic clickable point.
  await execute(`const date = new Date(); date.setDate(date.getDate() + 5);
    const local = [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
    return window.__TAURI__.core.invoke('create_transaction', {transaction: {id:'forecast-e2e', accountId:'test-courant', date:local, label:'Prévision fictive', category:'Divers', amount:-12345}});`);
  await click("#balance-forecast-toggle");
  await waitFor(
    async () =>
      (await execute("return document.querySelectorAll('#balance-forecast circle').length")) >= 2,
    "Prévision du solde",
  );
  if ((await text("#balance-forecast")).includes("Impossible de charger"))
    throw new Error("La prévision du solde n’a pas pu être chargée.");
  for (const [width, height] of [
    [900, 620],
    [1100, 700],
    [1280, 820],
  ]) {
    await request("POST", `/session/${session}/window/rect`, { width, height });
    await execute("document.querySelector('#balance-forecast').scrollIntoView({block:'start'})");
    const layout =
      await execute(`const panel=document.querySelector('#balance-forecast').getBoundingClientRect();
      const plot=document.querySelector('#balance-forecast svg').getBoundingClientRect();
      const content=document.querySelector('.page-content').getBoundingClientRect();
      return {panel:panel.width, plot:plot.width, content:content.width, left:panel.left-content.left, right:panel.right-content.right, plotTop:plot.top, plotBottom:plot.bottom, viewport:window.innerHeight};`);
    if (
      layout.panel <= 0 ||
      layout.plot < 100 ||
      layout.left < -1 ||
      layout.right > 1 ||
      layout.plotTop < 0 ||
      layout.plotBottom > layout.viewport
    )
      throw new Error(
        `Prévision mal dimensionnée à ${width} × ${height} : ${JSON.stringify(layout)}`,
      );
    await screenshot(`prevision-solde-${width}x${height}`);
  }
  await click("#balance-forecast .forecast-point");
  await waitFor(
    async () =>
      await execute(
        "return document.querySelector('#balance-forecast details[open]')?.textContent.includes('Prévision fictive')",
      ),
    "Détail de la prévision au clic",
  );
  await screenshot("prevision-solde-detail");
  await click("#balance-forecast-toggle");
  await execute("return window.__TAURI__.core.invoke('delete_transaction',{id:'forecast-e2e'})");
  console.log("Prévision du solde : trois tailles et détail au clic vérifiés");
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
    if (width === 900) {
      // Stress a long label and larger text to catch min-content overflow.
      const stressed = await execute(`
        const style = document.createElement('style');
        style.textContent = '#schedule-form .form-row label { font-size: 16px }';
        document.head.append(style);
        const label = document.querySelector('#schedule-form .schedule-reference');
        const original = label.firstChild.textContent;
        label.firstChild.textContent = 'Référence_de_l_occurrence_avec_un_libellé_particulièrement_long';
        const d = document.querySelector('#schedule-dialog');
        const result = {scroll: d.scrollWidth, client: d.clientWidth};
        label.firstChild.textContent = original;
        style.remove();
        return result;
      `);
      if (stressed.scroll > stressed.client + 1)
        throw new Error(`Formulaire tronqué avec texte agrandi : ${JSON.stringify(stressed)}`);
    }
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
        "[name=reference]",
        "[name=note]",
      ],
      cancel: ".dialog-cancel",
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
  await activateFocused("#new-transaction");
  await waitFor(() => visible("#transaction-dialog[open]"), "Création virement au clavier");
  await fill("#transaction-form", { type: "transfer" });
  await screenshot("formulaire-virement");
  await execute("document.querySelector('#transaction-form [name=type]').focus()");
  for (const field of [
    "[name=sourceId]",
    "[name=destinationId]",
    "[name=debitReference]",
    "[name=creditReference]",
    "[name=date]",
    "[name=amount]",
    "[name=category]",
    "[name=note]",
    ".dialog-cancel",
  ])
    await tabTo(`#transaction-form ${field}`);
  await key("\uE007");
  await waitFor(
    async () => !(await visible("#transaction-dialog[open]")),
    "Annulation du virement au clavier",
  );
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
    const controlSizes = await execute(
      `return ['#transaction-search','#transaction-search-scope','#transaction-search-form button','#transaction-filter'].map(selector => document.querySelector(selector).getBoundingClientRect().height)`,
    );
    if (Math.max(...controlSizes) - Math.min(...controlSizes) > 1)
      throw new Error(`Contrôles du registre désalignés à ${width} × ${height} : ${controlSizes}`);
    // The page controls must remain aligned and separate from the register summary.
    const pagination = await execute(`
      const footer = document.querySelector('.table-footer').getBoundingClientRect();
      const summary = document.querySelector('.table-footer > span').getBoundingClientRect();
      const controls = [...document.querySelectorAll('.pagination button, .pagination input')].map(el => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, clipped: el.scrollWidth > el.clientWidth + 1 };
      });
      const p = document.querySelector('.pagination').getBoundingClientRect();
      return { footer: {left: footer.left, right: footer.right}, summary: {right: summary.right, bottom: summary.bottom}, pagination: {left: p.left, top: p.top, right: p.right}, controls };
    `);
    if (
      pagination.pagination.left < pagination.footer.left - 1 ||
      pagination.pagination.right > pagination.footer.right + 1 ||
      (pagination.summary.right > pagination.pagination.left &&
        pagination.summary.bottom > pagination.pagination.top) ||
      pagination.controls.some((control) => control.clipped) ||
      Math.max(...pagination.controls.map((control) => control.height)) -
        Math.min(...pagination.controls.map((control) => control.height)) >
        1 ||
      Math.max(...pagination.controls.map((control) => control.top)) -
        Math.min(...pagination.controls.map((control) => control.top)) >
        1
    )
      throw new Error(
        `Pagination mal disposée à ${width} × ${height} : ${JSON.stringify(pagination)}`,
      );
    await screenshot(`registre-${width}x${height}`);
    await execute("document.querySelector('.table-footer').scrollIntoView({block: 'center'})");
    await waitFor(
      () =>
        execute(
          "const r = document.querySelector('.table-footer').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight",
        ),
      "Pagination visible",
    );
    await screenshot(`pagination-${width}x${height}`);
    await execute("document.querySelector('#transaction-filter').focus()");
    await tabTo("tbody tr[data-transaction]", 3);
    await key("\uE007");
    await waitFor(() => visible(".transaction-editor"), "Éditeur au clavier");
    if (width === 900) {
      await fill(".transaction-editor", { note: "Modification conservée" });
      await click(".transaction-editor .add-category");
      await fill("#quick-category-form", { name: "Catégorie depuis édition" });
      await click('#quick-category-form button[type="submit"]');
      await waitFor(
        async () => !(await visible("#quick-category-form")),
        "Catégorie depuis édition",
      );
      const values = await execute(
        "const f=document.querySelector('.transaction-editor'); return [f.elements.category.value, f.elements.note.value]",
      );
      if (values.join("|") !== "Catégorie depuis édition|Modification conservée")
        throw new Error(`Édition modifiée par la création de catégorie : ${values}`);
    }
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
  for (const [width, height] of [
    [900, 620],
    [1280, 820],
  ]) {
    await request("POST", `/session/${session}/window/rect`, { width, height });
    await screenshot(`foyer-${width}x${height}`);
  }
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
  for (const [width, height] of [
    [900, 620],
    [1280, 820],
  ]) {
    await request("POST", `/session/${session}/window/rect`, { width, height });
    await screenshot(`categories-${width}x${height}`);
  }
  await action(
    "Rapport de dépenses",
    () => click("#spending-nav"),
    async () =>
      (await text(".page-heading h1")) === "Répartition des dépenses" &&
      !(await text(".spending-panel")).includes("Chargement"),
  );
  for (const [width, height] of [
    [900, 620],
    [1280, 820],
  ]) {
    await request("POST", `/session/${session}/window/rect`, { width, height });
    await screenshot(`rapport-${width}x${height}`);
  }
  // Work exclusively in the isolated temporary database created above.
  await click(".add-account");
  if (
    !(await execute(
      `const style = (name) => {
         const optional = document.querySelector('#account-form [name=' + name + ']').closest('label').querySelector('.optional');
         return optional && [getComputedStyle(optional).color, getComputedStyle(optional).fontWeight].join('/');
       };
       return !!style('bank') && style('bank') === style('accountNumber');`,
    ))
  )
    throw new Error("Le numéro de compte doit reprendre le style facultatif de l’établissement.");
  await fill("#account-form", {
    name: "Compte recette",
    kind: "Compte courant",
    bank: "Banque fictive",
    accountNumber: "00012 AB",
    balance: "100.00",
  });
  await click('#account-form button[type="submit"]');
  await waitFor(
    async () => (await text(".page-heading h1")) === "Compte recette",
    "Création du compte",
  );
  if (!(await text("#account-number")).includes("00012 AB"))
    throw new Error("Le numéro de compte saisi doit conserver ses zéros initiaux.");
  await click("#edit-account");
  await fill("#account-settings-form", { accountNumber: "00034" });
  await click('#account-settings-form button[type="submit"]');
  await waitFor(
    async () => (await text("#account-number")).includes("00034"),
    "Modification du numéro de compte",
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
  // Create a subcategory without losing the open transaction or schedule form.
  const quickAccountId = await execute(
    "return document.querySelector('.account-item.active').dataset.account",
  );
  await click("#new-transaction");
  await fill("#transaction-form", { label: "Saisie en cours", amount: "12,34" });
  await click("#transaction-form .add-category");
  await fill("#quick-category-form", { name: "Recette rapide" });
  await execute(
    "const s=document.querySelector('#quick-category-form [name=parent]'); s.value=[...s.options].find(o => o.textContent === 'Alimentation').value",
  );
  await screenshot("categorie-rapide-operation");
  await click('#quick-category-form button[type="submit"]');
  await waitFor(
    async () => !(await visible("#quick-category-form")),
    "Création rapide de catégorie",
  );
  const quickTransaction = await execute(
    `const f=document.querySelector('#transaction-form'); return [f.elements.label.value,f.elements.amount.value,f.elements.category.value]`,
  );
  if (quickTransaction.join("|") !== "Saisie en cours|12,34|Alimentation · Recette rapide")
    throw new Error(`Formulaire d’opération modifié : ${quickTransaction}`);
  await click("#transaction-form .dialog-cancel");
  await click("#schedules-nav");
  await waitFor(() => visible("#new-schedule"), "Vue des échéances");
  await click("#new-schedule");
  await fill("#schedule-form", { label: "Échéance en cours", amount: "15" });
  await click("#schedule-form .add-category");
  await fill("#quick-category-form", { name: "Recette échéance" });
  await click('#quick-category-form button[type="submit"]');
  await waitFor(async () => !(await visible("#quick-category-form")), "Catégorie d’échéance");
  const quickSchedule = await execute(
    `const f=document.querySelector('#schedule-form'); return [f.elements.label.value,f.elements.amount.value,f.elements.category.value]`,
  );
  if (quickSchedule.join("|") !== "Échéance en cours|15|Recette échéance")
    throw new Error(`Formulaire d’échéance modifié : ${quickSchedule}`);
  await click("#schedule-form .schedule-close.secondary-button");
  await execute(
    "document.querySelectorAll('[data-account]').forEach(el => { if (el.dataset.account === arguments[0]) el.click(); })",
    quickAccountId,
  );
  await waitFor(
    async () => (await text(".page-heading h1")) === "Compte recette",
    "Retour au compte",
  );
  console.log("Catégories rapides : opération et échéance vérifiées");
  await menuAction("backup");
  await waitFor(
    async () => (await text(".database-error")).includes("Sauvegarde créée"),
    "Sauvegarde",
  );
  // A second backup to the same debug-selected path must not overwrite the first.
  const savedBytes = readFileSync(backupPath);
  await menuAction("backup");
  await waitFor(
    async () => (await text(".database-error")).includes("Sauvegarde impossible"),
    "Erreur de sauvegarde",
  );
  if (
    !readFileSync(backupPath).equals(savedBytes) ||
    !(await text(".balance-card")).includes("100,00")
  )
    throw new Error("Échec de sauvegarde : données modifiées");
  await click("#new-transaction");
  await fill("#transaction-form", { label: "À effacer par restauration", amount: "10.00" });
  await click('#transaction-form button[type="submit"]');
  await waitFor(
    async () => (await text("tbody")).includes("À effacer par restauration"),
    "Opération après sauvegarde",
  );
  await menuAction("restore");
  await waitFor(() => visible(".confirmation-dialog[open]"), "Confirmation de restauration");
  if (!(await text(".confirmation-message")).includes("remplacées"))
    throw new Error("Avertissement de restauration absent");
  await click(".confirmation-cancel");
  if (!(await text("tbody")).includes("À effacer par restauration"))
    throw new Error("Restauration effectuée malgré l’annulation");
  await menuAction("restore");
  await waitFor(() => visible(".confirmation-dialog[open]"), "Confirmation de restauration");
  await click(".confirmation-accept");
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
  const purchaseDate = await execute(
    "return document.querySelector('#transaction-form [name=date]').value",
  );
  await fill("#transaction-form", {
    label: "Achat recette",
    amount: "12.34",
    reference: "0012345",
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
    (await text("tbody")).includes("Commentaire initial") ||
    !(await text(".balance-card")).includes("87,66")
  )
    throw new Error("Chèque, visibilité du commentaire ou solde incorrect");
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
  await menuAction("toggle-transaction-comments");
  await waitFor(
    async () => (await text("tbody")).includes("Commentaire initial"),
    "Affichage des commentaires",
  );
  await click("#amount-filter");
  await fill("#amount-filter-form", { exact: "12,35" });
  await click('#amount-filter-form button[type="submit"]');
  await waitFor(async () => await visible(".empty-row"), "Montant exact sans résultat");
  await click("#amount-filter");
  await fill("#amount-filter-form", { mode: "range", min: "12,30", max: "12,34" });
  await click('#amount-filter-form button[type="submit"]');
  await waitFor(
    async () => (await text("tbody")).includes("Achat recette"),
    "Filtre de montant avec borne incluse",
  );
  if (!/Montant · 12,30 à 12,34\s€/.test(await text("#amount-filter")))
    throw new Error("Intervalle absent du bouton Montant.");
  await click("#period-filter");
  await fill("#period-filter-form", { end: "1970-01-01" });
  await click('#period-filter-form button[type="submit"]');
  await waitFor(async () => await visible(".empty-row"), "Période avec fin seule sans résultat");
  await click("#period-filter");
  await click('[data-period-shortcut="this-year"]');
  const currentYear = purchaseDate.slice(0, 4);
  const shortcutDates = await execute(
    "const form = document.querySelector('#period-filter-form'); return [form.elements.start.value, form.elements.end.value]",
  );
  if (shortcutDates[0] !== `${currentYear}-01-01` || shortcutDates[1] !== `${currentYear}-12-31`)
    throw new Error("Le raccourci Cette année doit remplir les dates de l’année civile.");
  const purchaseDateLabel = purchaseDate.split("-").reverse().join("/");
  await fill("#period-filter-form", { start: "", end: purchaseDate });
  await click('#period-filter-form button[type="submit"]');
  await waitFor(
    async () => (await text("#period-filter")) === `Période · Jusqu’au ${purchaseDateLabel}`,
    "Effacement d’une date préremplie par le raccourci",
  );
  await click("#period-filter");
  await fill("#period-filter-form", { start: "1970-01-02", end: purchaseDate });
  await click('#period-filter-form button[type="submit"]');
  await waitFor(
    async () => (await text("tbody")).includes("Achat recette"),
    "Période combinée au montant avec date de fin incluse",
  );
  if ((await text("#period-filter")) !== `Période · 02/01/1970 au ${purchaseDateLabel}`)
    throw new Error("Dates absentes du bouton Période.");
  await request("POST", `/session/${session}/window/rect`, { width: 900, height: 620 });
  await waitFor(
    () =>
      execute(
        `const groups = [...document.querySelectorAll('.register-filter-actions')];
         const heading = document.querySelector('.transactions-panel .panel-heading').getBoundingClientRect();
         return innerWidth <= 900 && groups.length === 2 && groups.every(group => {
           const filter = group.querySelector('button').getBoundingClientRect();
           const clear = group.querySelector('.register-filter-clear')?.getBoundingClientRect();
           return clear && group.getBoundingClientRect().right <= heading.right &&
             clear.width === 32 && clear.height === filter.height && clear.top === filter.top;
         });`,
      ),
    "Les filtres de montant et de période tiennent dans le registre à 900 pixels",
  );
  await request("POST", `/session/${session}/window/rect`, { width: 1280, height: 820 });
  await execute("document.querySelector('#period-filter').focus()");
  await key("\uE004");
  if (!(await execute("return document.activeElement.id === 'period-filter-quick-clear'")))
    throw new Error("La touche Tab n’atteint pas la croix du filtre de période.");
  await key("\uE007");
  await waitFor(
    async () => (await text("#period-filter")) === "Période",
    "Effacement de la période",
  );
  if (
    !(await execute(
      "return !document.querySelector('#period-filter-dialog').open && document.activeElement.id === 'period-filter'",
    )) ||
    !/12,30/.test(await text("#amount-filter"))
  )
    throw new Error(
      "L’effacement direct de la période doit rendre le focus et conserver le montant.",
    );
  await execute("document.querySelector('#amount-filter').focus()");
  await key("\uE004");
  if (!(await execute("return document.activeElement.id === 'amount-filter-quick-clear'")))
    throw new Error("La touche Tab n’atteint pas la croix du filtre de montant.");
  await key("\uE007");
  await waitFor(async () => (await text("#amount-filter")) === "Montant", "Effacement du montant");
  if (
    !(await execute(
      "return !document.querySelector('#amount-filter-dialog').open && document.activeElement.id === 'amount-filter'",
    ))
  )
    throw new Error("L’effacement direct du montant doit rendre le focus au bouton Montant.");
  const purchaseId = await execute(
    "return document.querySelector('tr[data-transaction]').dataset.transaction",
  );
  await execute("document.querySelector('.sidebar-accounts .account-item:not(.active)').click()");
  await waitFor(
    () =>
      execute(
        "return !!document.querySelector('#transaction-search') && !document.querySelector('tbody').textContent.includes('Achat recette')",
      ),
    "Ouverture d’un autre compte",
  );
  await execute(`document.querySelector('#transaction-search').value = 'Commentaire initial';
    const scope = document.querySelector('#transaction-search-scope');
    scope.value = 'all';
    scope.dispatchEvent(new Event('change', { bubbles: true }));`);
  await waitFor(() => visible("[data-search-result]"), "Recherche dans tous les comptes");
  await click(`[data-search-result="${purchaseId}"]`);
  await waitFor(
    () =>
      execute(
        `return document.activeElement.dataset.transaction === ${JSON.stringify(purchaseId)}`,
      ),
    "Ouverture de l’opération dans son registre",
  );
  await execute("document.querySelector('#transaction-filter').focus()");
  await key("\uE004");
  if (!(await execute("return document.activeElement.matches('.register-table')")))
    throw new Error("La touche Tab n’atteint pas la zone de défilement du registre.");
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
  await clickRegisterControl("[data-reconcile]");
  await waitFor(async () => (await text("[data-reconcile]")) === "P", "Pointage");
  await clickRegisterControl("[data-delete]");
  await waitFor(() => visible("#delete-transaction-dialog[open]"), "Confirmation de suppression");
  if (!(await text(".delete-confirmation-message")).includes("Achat modifié"))
    throw new Error("Confirmation d’opération incorrecte");
  await click(".delete-cancel");
  if (!(await text("tbody")).includes("Achat modifié"))
    throw new Error("L’annulation a supprimé l’opération");
  await clickRegisterControl("[data-delete]");
  await click(".delete-confirm");
  await waitFor(
    async () => !(await text("tbody")).includes("Achat modifié"),
    "Suppression d’opération",
  );
  if (!(await text(".balance-card")).includes("100,00"))
    throw new Error("Solde après suppression incorrect");
  console.log(
    "Opérations : création, chèque, commentaire, modification, pointage et suppression OK",
  );

  await click("#new-transaction");
  await fill("#transaction-form", { type: "transfer" });
  await fill("#transaction-form", {
    destinationId: "test-courant",
    amount: "25.50",
    note: "Virement recette",
  });
  await click('#transaction-form button[type="submit"]');
  await waitFor(
    async () => (await text("tbody")).includes("Virement vers Compte courant"),
    "Création de virement",
  );
  if (!(await text(".balance-card")).includes("74,50"))
    throw new Error("Solde du virement incorrect");
  await execute("document.querySelector('tbody tr[data-transaction]').focus()");
  await key("\uE007");
  await waitFor(() => visible(".transfer-editor"), "Édition de virement au clavier");
  if (!(await execute("return document.querySelector('.summary-grid').hidden")))
    throw new Error("Le résumé reste affiché pendant la modification du virement.");
  await request("POST", `/session/${session}/window/rect`, { width: 900, height: 620 });
  const editorSize = await execute(
    "const p=document.querySelector('.transaction-editor-panel'); return [p.scrollWidth,p.clientWidth]",
  );
  if (editorSize[0] > editorSize[1] + 1)
    throw new Error("Éditeur de virement tronqué à la taille minimale.");
  await screenshot("editeur-virement-900x620");
  await request("POST", `/session/${session}/window/rect`, { width: 1280, height: 820 });
  await fill(".transfer-editor", { amount: "30.00" });
  await click('.transfer-editor button[type="submit"]');
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
  await clickRegisterControl(`[data-delete="${transferDeleteId}"]`);
  await waitFor(
    () => visible("#delete-transaction-dialog[open]"),
    "Confirmation de suppression du virement",
  );
  if (!(await text(".delete-confirmation-message")).includes("deux opérations"))
    throw new Error("Confirmation du virement incorrecte");
  await click(".delete-cancel");
  if (!(await text("tbody")).includes("Virement depuis Compte recette"))
    throw new Error("L’annulation a supprimé le virement");
  await clickRegisterControl(`[data-delete="${transferDeleteId}"]`);
  await click(".delete-confirm");
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
  await waitFor(() => visible(".confirmation-dialog[open]"), "Confirmation de catégorie");
  if (!(await text(".confirmation-message")).includes("Catégorie recette"))
    throw new Error("Confirmation de catégorie incorrecte");
  await click(".confirmation-cancel");
  if (!(await categoryId("Catégorie recette")))
    throw new Error("Catégorie supprimée malgré l’annulation");
  await click(`[data-delete-category="${rootId}"]`);
  await click(".confirmation-accept");
  await waitFor(async () => !(await categoryId("Catégorie recette")), "Suppression de catégorie");
  console.log("Catégories : création, renommage, fusion et suppression OK");

  await click("#schedules-nav");
  await click("#new-schedule");
  await fill("#schedule-form", {
    label: "Échéance recette",
    note: "Commentaire échéance",
    amount: "9.99",
    frequency: "Mensuelle",
  });
  await submitSchedule();
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
  await fill("#schedule-form", { paymentMethod: "cheque", reference: "0012345", amount: "15.00" });
  await submitSchedule();
  await waitFor(async () => !(await visible("#schedule-dialog[open]")), "Modification future");
  await click(`[data-edit-future="${scheduleId}"][data-original-due="${futureOriginal}"]`);
  const futureValues = await execute(
    "const f=document.querySelector('#schedule-form'); return [f.elements.amount.value,f.elements.reference.value]",
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
  await submitSchedule();
  await waitFor(
    async () => (await text(".schedule-list")).includes("11,50"),
    "Modification ponctuelle d’échéance",
  );
  await click(`[data-record-schedule="${scheduleId}"]`);
  await waitFor(
    async () => !(await visible(`[data-record-schedule="${scheduleId}"]`)),
    "Enregistrement d’échéance",
  );
  const recordedComment = spawnSync(
    "python3",
    [
      "-c",
      "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); row=c.execute(\"SELECT note FROM transactions WHERE label='Échéance recette'\").fetchone(); assert row == ('Commentaire échéance',), row",
      join(appData, "comptes.kresus"),
    ],
    { encoding: "utf8" },
  );
  if (recordedComment.status !== 0)
    throw new Error(`Commentaire de l’échéance absent : ${recordedComment.stderr}`);
  await click("#next-month");
  await waitFor(
    async () => await visible(`[data-edit-schedule="${scheduleId}"]`),
    "Occurrence suivante",
  );
  await click(`[data-edit-schedule="${scheduleId}"]`);
  await fill("#schedule-form", { scope: "series", amount: "12.50" });
  await submitSchedule();
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
  await waitFor(() => visible(".confirmation-dialog[open]"), "Confirmation d’échéance");
  if (!(await text(".confirmation-message")).includes("opérations déjà enregistrées"))
    throw new Error("Confirmation d’échéance incorrecte");
  await click(".confirmation-cancel");
  if (!(await visible(`[data-delete-schedule="${scheduleId}"]`)))
    throw new Error("Échéance supprimée malgré l’annulation");
  await click(`[data-delete-schedule="${scheduleId}"]`);
  await click(".confirmation-accept");
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
    reference: "0012345",
  });
  await submitSchedule();
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
  await submitSchedule();
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
  await click("#new-transaction");
  await fill("#transaction-form", { type: "transfer" });
  await fill("#transaction-form", { destinationId: "test-courant", amount: "10,00" });
  await click('#transaction-form button[type="submit"]');
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
      join(appData, "comptes.kresus"),
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
  await submitSchedule();
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
      join(appData, "comptes.kresus"),
      receiptId,
    ],
    { encoding: "utf8" },
  );
  if (transferCheck.status !== 0) throw new Error("Virement récurrent : " + transferCheck.stderr);
  console.log("Virement récurrent : création manuelle et opérations liées vérifiées OK");

  const postedDate = end.replaceAll("-", "");
  writeFileSync(
    ofxSource,
    `<?xml version="1.0" encoding="UTF-8"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS>
<CURDEF>EUR</CURDEF>
<BANKACCTFROM><BANKID>12345</BANKID><ACCTID>00123456789</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><DTPOSTED>${postedDate}</DTPOSTED><TRNAMT>-8.25</TRNAMT><FITID>matched</FITID><NAME>Virement bancaire OFX</NAME></STMTTRN>
<STMTTRN><DTPOSTED>${postedDate}</DTPOSTED><TRNAMT>32.17</TRNAMT><FITID>added</FITID><NAME>Remboursement OFX</NAME><REFNUM>000123</REFNUM></STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>0.00</BALAMT><DTASOF>${postedDate}</DTASOF></LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
  );
  await click(`[data-account="${receiptId}"]`);
  await waitFor(async () => (await text(".page-heading h1")) === "Compte recette", "Compte OFX");
  await click("#bank-import");
  await waitFor(() => visible(".bank-import-dialog[open]"), "Aperçu du relevé OFX");
  if (
    !(await text(".bank-import-dialog")).includes("00123456789") ||
    !(await text(".bank-import-dialog")).includes("Solde de clôture")
  )
    throw new Error(
      "L’aperçu OFX doit afficher le compte du fichier et demander de vérifier le rapprochement.",
    );
  await click('[data-bank-filter="add"]');
  const additions = await text("#bank-import-lines");
  if (!additions.includes("Remboursement OFX") || additions.includes("Virement bancaire OFX"))
    throw new Error("Le compteur des ajouts doit filtrer le relevé sur les opérations à ajouter.");
  await click("#bank-import-confirm");
  await waitFor(
    async () => (await text(".bank-import-dialog .editor-error")).includes("une ligne à vérifier"),
    "Message de validation des choix OFX",
  );
  if (!(await execute("return document.activeElement.dataset.bankLine === '0'")))
    throw new Error("Le choix requis de la première ligne OFX doit recevoir le focus.");
  await execute(`
    const choice = document.querySelector('[data-bank-line="0"]');
    const match = [...choice.options].find(option => option.textContent.includes('Virement vers Compte courant'));
    if (!match) throw new Error('Virement non suggéré');
    choice.value = match.value;
    choice.dispatchEvent(new Event('change', { bubbles: true }));
  `);
  await click("#bank-import-confirm");
  await waitFor(
    async () =>
      (await text(".bank-import-status")).includes("1 opération ajoutée") &&
      (await text("tbody")).includes("Remboursement OFX"),
    "Import du relevé et actualisation du registre",
  );
  const ofxCheck = spawnSync(
    "python3",
    [
      "-c",
      `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
rows=c.execute("SELECT e.fit_id,t.label,t.amount_cents,t.reconciled,t.reference FROM bank_statement_entries e JOIN transactions t ON t.id=e.transaction_id WHERE e.account_id=? ORDER BY e.fit_id", (sys.argv[2],)).fetchall()
target_name=c.execute("SELECT name FROM accounts WHERE id='test-courant'").fetchone()[0]
assert rows == [('added','Remboursement OFX',3217,1,'000123'),('matched','Virement vers '+target_name,-825,1,None)], rows
assert c.execute("SELECT count(*) FROM transactions WHERE label='Virement bancaire OFX'").fetchone() == (0,)
print(c.execute("SELECT opening_balance_cents+COALESCE((SELECT sum(amount_cents) FROM transactions WHERE account_id=a.id AND reconciled=1 AND operation_date<=?),0) FROM accounts a WHERE id=?", (sys.argv[3],sys.argv[2])).fetchone()[0])`,
      join(appData, "comptes.kresus"),
      receiptId,
      end,
    ],
    { encoding: "utf8" },
  );
  if (ofxCheck.status !== 0) throw new Error(`Écritures OFX incorrectes : ${ofxCheck.stderr}`);
  const pointed = Number(ofxCheck.stdout.trim());
  const euroText = (cents) =>
    new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" })
      .format(cents / 100)
      .replace(/\s/g, "");
  const gapIs = async (amount) =>
    (await text("#reconciliation-gap")).replace(/\s/g, "").startsWith(euroText(amount));
  await waitFor(() => gapIs(-pointed), "Écart avec le solde OFX");
  const prefilled = await execute(
    "return [document.querySelector('#reconciliation-date').value, document.querySelector('#reconciliation-amount').value]",
  );
  if (prefilled[0] !== end || prefilled[1] !== "0,00")
    throw new Error("Le solde OFX nul et sa date doivent être préremplis.");
  const enterClosingBalance = (cents) =>
    execute(`
    const input = document.querySelector('#reconciliation-amount');
    input.value = ${JSON.stringify((cents / 100).toFixed(2))};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await enterClosingBalance(pointed + 1);
  await waitFor(() => gapIs(1), "Écart d’un centime");
  await enterClosingBalance(pointed);
  await waitFor(() => visible("#reconciliation-gap[data-balanced]"), "Solde saisi équilibré");
  const ofxOperation = await execute(`
    return [...document.querySelectorAll('tr[data-transaction]')]
      .find(row => row.textContent.includes('Remboursement OFX')).dataset.transaction;
  `);
  await clickRegisterControl(`[data-reconcile="${ofxOperation}"]`);
  await waitFor(() => gapIs(3217), "L’écart évolue au dépointage");
  await clickRegisterControl(`[data-reconcile="${ofxOperation}"]`);
  await waitFor(() => visible("#reconciliation-gap[data-balanced]"), "Repointage au centime");
  await click("#end-reconciliation");
  await click("#start-reconciliation");
  if ((await execute("return document.querySelector('#reconciliation-amount').value")) !== "")
    throw new Error("Le rapprochement manuel doit autoriser la saisie d’un nouveau solde.");
  await click("#end-reconciliation");
  await click("#bank-import");
  await waitFor(
    async () => (await text("#bank-import-summary")).includes("2 doublons"),
    "Réimport OFX et détection des doublons",
  );
  await click("#bank-import-balance");
  await waitFor(() => gapIs(-pointed), "Vérification du solde d’un relevé déjà importé");
  await click("#end-reconciliation");
  console.log("Relevé OFX : aperçu, rapprochement, ajout, doublons et écart de clôture vérifiés");

  await click("#new-transaction");
  await fill("#transaction-form", { label: "Achat ventilé recette", amount: "100" });
  await click("#transaction-form .toggle-splits");
  await execute(`
    const lines = document.querySelectorAll('#transaction-form .split-row');
    lines[0].querySelector('select').value = 'Alimentation · Recette rapide';
    lines[1].querySelector('select').value = 'Factures';
    lines[0].querySelector('.split-amount').value = '80,25';
    const last = lines[1].querySelector('.split-amount');
    last.value = '19,75';
    last.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await waitFor(
    async () => (await text("#transaction-form .split-balance")).includes("entièrement ventilé"),
    "Total de la ventilation",
  );
  await click('#transaction-form button[type="submit"]');
  await waitFor(
    async () => (await text("tbody")).includes("Achat ventilé recette"),
    "Enregistrement de l’écriture ventilée",
  );
  const splitRegister = await execute(`
    const rows = [...document.querySelectorAll('tr[data-transaction]')]
      .filter(row => row.textContent.includes('Achat ventilé recette'));
    return rows.map(row => [row.dataset.transaction, row.querySelectorAll('[data-reconcile]').length]);
  `);
  if (splitRegister.length !== 1 || splitRegister[0][1] !== 1)
    throw new Error("Une écriture ventilée doit comporter un seul pointage.");
  const splitId = splitRegister[0][0];
  await clickRegisterControl(`[data-reconcile="${splitId}"]`);
  await waitFor(
    () => visible(`[data-reconcile="${splitId}"][aria-pressed="true"]`),
    "Pointage de la ventilation",
  );
  await click("#spending-nav");
  await waitFor(
    () =>
      execute(`
      return [...document.querySelectorAll('.spending-row')].some(row =>
        row.textContent.includes('Recette rapide') && row.textContent.includes('80,25')
      );
    `),
    "Part de l’écriture ventilée dans le rapport",
  );
  await click(`[data-account="${receiptId}"]`);
  await waitFor(() => visible(`[data-transaction="${splitId}"]`), "Retour au registre ventilé");
  console.log("Ventilation : écriture unique, pointage et part dans le rapport vérifiés");

  await click("#edit-account");
  await fill("#account-settings-form", { name: "Compte clôturé", bank: "Nouvelle banque" });
  await click('#account-settings-form [name="archived"]');
  await click('#account-settings-form button[type="submit"]');
  await waitFor(
    async () =>
      (await text(".page-heading h1")) === "Compte clôturé" &&
      /nouvelle banque/i.test(await text(".account-heading .eyebrow")) &&
      !(await visible(`[data-account="${receiptId}"]`)),
    "Modification et archivage du compte",
  );
  await click("#accounts-nav");
  await click(".archived-accounts > summary");
  await click(`[data-open-account="${receiptId}"]`);
  await waitFor(
    async () =>
      /archivé/i.test(await text(".account-heading .eyebrow")) &&
      (await text("tbody")).includes("Remboursement OFX"),
    "Registre du compte archivé",
  );
  await click("#edit-account");
  await click('#account-settings-form [name="archived"]');
  await click('#account-settings-form button[type="submit"]');
  await waitFor(() => visible(`[data-account="${receiptId}"]`), "Réactivation du compte");
  console.log("Compte : nom, établissement, archive et accès au registre vérifiés");

  // The debug-only E2E build substitutes paths for native portal dialogs.
  if (moneySample) {
    if (!existsSync(moneySample)) throw new Error("Fichier Money de test introuvable.");
    const destination = moneyDestination;
    await menuAction("import");
    await waitFor(() => visible(".money-import-dialog[open]"), "Aperçu Money");
    await execute("document.querySelector('.money-import-dialog .dialog-close').focus()");
    await tabTo('.money-import-dialog input[name="account"]');
    await tabTo('.money-import-dialog button[type="submit"]');
    const preview = await text(".money-import-dialog");
    if (
      !preview.includes("138 catégories") ||
      !preview.replace(/\s/g, "").includes("3576,46") ||
      !preview.includes("12 opérations") ||
      !preview.includes("12 échéances") ||
      !preview.includes("3 virements enregistrés") ||
      preview.includes("ne sera pas importée") ||
      preview.includes("ne seront pas importées")
    )
      throw new Error(`Aperçu Money incomplet : ${preview}`);
    await execute(
      "[...document.querySelectorAll('.money-import-dialog details summary')].find(s => s.textContent.startsWith('Voir les échéances')).click()",
    );
    const schedulePreview = await text(".money-import-dialog");
    if (!schedulePreview.includes("04/08/2027") || !schedulePreview.includes("19/03/2027"))
      throw new Error("Dates de fin absentes de l’aperçu.");
    if (
      !schedulePreview.includes("Test périodicité trimestrielle") ||
      !schedulePreview.includes("Orange bimensuel") ||
      !schedulePreview.includes("EDF semestriel")
    )
      throw new Error("Échéances trimestrielle ou bimensuelle absentes de l’aperçu.");
    if (existsSync(destination)) throw new Error("La base de destination existe avant l’import.");
    // Importing only one side must fail without leaving a new database behind.
    await execute(
      "document.querySelectorAll('.money-import-dialog input[name=account]')[1].click()",
    );
    await click('.money-import-dialog button[type="submit"]');
    await waitFor(
      async () => (await text(".money-import-dialog .editor-error")).includes("deux comptes"),
      "Refus d’un virement incomplet",
    );
    if (existsSync(destination)) throw new Error("Une base partielle a été conservée.");
    await execute(
      "document.querySelectorAll('.money-import-dialog input[name=account]')[1].click()",
    );
    await execute(
      "document.querySelector('.money-import-dialog button[type=submit]').scrollIntoView({block: 'nearest'})",
    );
    await screenshot("import-money-apres-erreur");
    await click('.money-import-dialog button[type="submit"]');
    await waitFor(
      async () =>
        existsSync(destination) &&
        (await text(".balance-card")).replace(/\s/g, "").includes("3576,46"),
      "Import Money et affichage du compte",
    );
    await waitFor(
      async () =>
        (await text(".table-footer")).includes("12 opérations") ||
        (await text(".table-footer")).includes("sur 12"),
      "Opérations importées",
    );
    const verification = spawnSync(
      "python3",
      [join(root, "e2e/check_money_import.py"), destination],
      { encoding: "utf8" },
    );
    if (verification.status !== 0)
      throw new Error(`Base Money incorrecte : ${verification.stderr}`);
    async function checkMoneySpending(total, expectedRows) {
      await click("#spending-nav");
      await waitFor(
        () => visible('#spending-filter button[type="submit"]:enabled'),
        "Rapport du compte importé",
      );
      await fill("#spending-filter", { start: "2026-11-18", end: "2026-11-18" });
      await click('#spending-filter button[type="submit"]');
      await waitFor(
        async () => (await text(".spending-total strong")).replace(/\s/g, "") === total,
        `Total des dépenses ventilées importées (${total})`,
      );
      const rows = await execute(`
        return Array.from(document.querySelectorAll('.spending-row'), row => [
          row.querySelector('.spending-name').textContent,
          row.querySelector('strong').textContent.replace(/\\s/g, ''),
        ]);
      `);
      if (JSON.stringify(rows) !== JSON.stringify(expectedRows))
        throw new Error(`Répartition des dépenses Money incorrecte : ${JSON.stringify(rows)}`);
    }
    await checkMoneySpending("135,41€", [
      ["Alimentation", "80,25€"],
      ["Équipement du logement · Travaux / Décoration", "20,10€"],
      ["Auto/moto · Entretien/réparations", "19,75€"],
      ["Abonnement/factures · Service d'entretien", "15,31€"],
    ]);
    console.log("Rapport Money : quatre parts dans les catégories attendues, total 135,41 €");

    await click('[data-account="money-account-2"]');
    const invoice = '[data-transaction="money-transaction-32"]';
    const pointedInvoice = `${invoice} [data-reconcile][aria-pressed="true"]`;
    await waitFor(() => visible(pointedInvoice), "Facture Money pointée");
    await click(`${invoice} .transaction-label`);
    const originalParts = await execute(`
      return [...document.querySelectorAll('.transaction-editor .split-amount')].map(input => input.value);
    `);
    if (originalParts.join("|") !== "20,10|15,31")
      throw new Error(`Parts de la facture Money avant modification : ${originalParts}`);
    await fill(".transaction-editor", { amount: "37,41" });
    await execute(`
      const inputs = document.querySelectorAll('.transaction-editor .split-amount');
      inputs[0].value = '24,10';
      inputs[1].value = '13,31';
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await click('.transaction-editor button[type="submit"]');
    await waitFor(
      async () =>
        !(await visible(".transaction-editor")) &&
        (await visible(pointedInvoice)) &&
        (await text(`${invoice} .amount.debit`)) === "37,41",
      "Facture modifiée et toujours pointée",
    );
    await click(`${invoice} .transaction-label`);
    const savedParts = await execute(`
      return [...document.querySelectorAll('.transaction-editor .split-amount')].map(input => input.value);
    `);
    if (savedParts.join("|") !== "24,10|13,31")
      throw new Error(`Parts de la facture Money après modification : ${savedParts}`);
    await click(".transaction-editor .cancel-editor");
    await checkMoneySpending("137,41€", [
      ["Alimentation", "80,25€"],
      ["Équipement du logement · Travaux / Décoration", "24,10€"],
      ["Auto/moto · Entretien/réparations", "19,75€"],
      ["Abonnement/factures · Service d'entretien", "13,31€"],
    ]);
    console.log("Facture Money modifiée : pointage conservé et rapport recalculé à 137,41 €");

    await click('[data-account="money-account-2"]');
    await waitFor(
      async () =>
        (await visible(invoice)) &&
        (await text(".balance-card")).replace(/\s/g, "").includes("-3578,46€"),
      "Solde de −3 578,46 € avant suppression",
    );
    await request("POST", `/session/${session}/window/rect`, { width: 900, height: 620 });
    await waitFor(
      () =>
        execute(
          `const table = document.querySelector('.register-table');
           const right = table.getBoundingClientRect().right;
           const amounts = [...document.querySelectorAll(arguments[0] + ' .amount')];
           return innerWidth <= 900 && table.scrollWidth <= table.clientWidth + 1 &&
             amounts.length === 3 && amounts.every(cell => cell.getBoundingClientRect().right <= right + 1);`,
          invoice,
        ),
      "Montants du registre Money visibles sans défilement horizontal à 900 pixels",
    );
    await clickRegisterControl(`${invoice} [data-delete]`);
    await waitFor(
      () => visible("#delete-transaction-dialog[open]"),
      "Confirmation de suppression de la facture",
    );
    if (!(await text(".delete-confirmation-message")).includes("Test ventilation facture"))
      throw new Error("La confirmation doit identifier la facture ventilée.");
    await click(".delete-confirm");
    await waitFor(
      async () =>
        !(await visible(invoice)) &&
        (await text(".balance-card")).replace(/\s/g, "").includes("-3541,05€"),
      "Registre et solde après suppression de la facture",
    );
    await request("POST", `/session/${session}/window/rect`, { width: 1280, height: 820 });
    const remainingSpending = [
      ["Alimentation", "80,25€"],
      ["Auto/moto · Entretien/réparations", "19,75€"],
    ];
    await checkMoneySpending("100,00€", remainingSpending);
    console.log(
      "Facture Money supprimée : deux parts retirées du rapport et solde augmenté de 37,41 €",
    );

    writeFileSync(
      ofxSource,
      `<?xml version="1.0" encoding="UTF-8"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS>
<CURDEF>EUR</CURDEF>
<BANKACCTFROM><BANKID>12345</BANKID><ACCTID>00123456789</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><DTPOSTED>20261118</DTPOSTED><TRNAMT>-100.00</TRNAMT><FITID>money-split-groceries</FITID><NAME>Courses du relevé OFX</NAME></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
    );
    await click('[data-account="money-account-2"]');
    const groceries = '[data-transaction="money-transaction-29"]';
    await waitFor(
      () => visible(`${groceries} [data-reconcile][aria-pressed="false"]`),
      "Courses ventilées importées de Money avant rapprochement",
    );
    await click("#bank-import");
    await waitFor(() => visible(".bank-import-dialog[open]"), "Aperçu OFX des courses");
    await execute(`
      const choice = document.querySelector('[data-bank-line="0"]');
      const match = [...choice.options].find(option => option.value === 'match:money-transaction-29');
      if (!match) throw new Error('Opération ventilée Money absente des suggestions OFX');
      choice.value = match.value;
      choice.dispatchEvent(new Event('change', { bubbles: true }));
    `);
    await click("#bank-import-confirm");
    await waitFor(
      async () =>
        (await visible(`${groceries} [data-reconcile][aria-pressed="true"]`)) &&
        (await text(".bank-import-status")).includes("0 opérations ajoutées · 1 rapprochée") &&
        (await text(".balance-card")).replace(/\s/g, "").includes("-3541,05€"),
      "Rapprochement de l’opération Money sans nouvelle écriture ni variation du solde",
    );
    function checkMatchedGroceries(reconciled) {
      const matchCheck = spawnSync(
        "python3",
        [
          "-c",
          `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
assert c.execute("SELECT transaction_id FROM bank_statement_entries WHERE fit_id='money-split-groceries'").fetchall() == [('money-transaction-29',)]
assert c.execute("SELECT count(*) FROM transactions WHERE account_id='money-account-2'").fetchone() == (11,)
assert c.execute("SELECT reconciled FROM transactions WHERE id='money-transaction-29'").fetchone() == (int(sys.argv[2]),)
assert c.execute("SELECT category,amount_cents,note FROM transaction_splits WHERE transaction_id='money-transaction-29' ORDER BY position").fetchall() == [
    ('Alimentation',-8025,'alimentation'), ('Auto/moto · Entretien/réparations',-1975,'entretien')
]
print(c.execute("SELECT opening_balance_cents + COALESCE((SELECT sum(amount_cents) FROM transactions WHERE account_id=a.id AND reconciled=1 AND operation_date<='2026-11-18'),0) FROM accounts a WHERE id='money-account-2'").fetchone()[0])`,
          destination,
          reconciled ? "1" : "0",
        ],
        { encoding: "utf8" },
      );
      if (matchCheck.status !== 0)
        throw new Error(
          `Rapprochement OFX de la ventilation Money incorrect : ${matchCheck.stderr}`,
        );
      return Number(matchCheck.stdout.trim());
    }
    const pointedMoneyBalance = checkMatchedGroceries(true);
    await enterClosingBalance(pointedMoneyBalance);
    await waitFor(() => visible("#reconciliation-gap[data-balanced]"), "Écart initial nul");
    await clickRegisterControl(`${groceries} [data-reconcile]`);
    await waitFor(
      async () =>
        (await visible(`${groceries} [data-reconcile][aria-pressed="false"]`)) &&
        (await gapIs(-10000)),
      "Dépointage et écart de −100 €",
    );
    checkMatchedGroceries(false);
    await click("#bank-import");
    await waitFor(
      async () => (await text(".bank-import-dialog")).includes("Déjà importée"),
      "Ligne OFX reconnue même quand l’opération est dépointée",
    );
    await click("#bank-import-cancel");
    await clickRegisterControl(`${groceries} [data-reconcile]`);
    await waitFor(
      async () =>
        (await visible(`${groceries} [data-reconcile][aria-pressed="true"]`)) &&
        (await visible("#reconciliation-gap[data-balanced]")),
      "Repointage et retour à zéro",
    );
    checkMatchedGroceries(true);
    await click("#end-reconciliation");

    await checkMoneySpending("100,00€", remainingSpending);
    console.log(
      "Courses Money : écart de −100 € au dépointage puis retour à zéro, parts et lien OFX conservés",
    );

    await request("DELETE", `/session/${session}`);
    session = undefined;
    await openSession(destination);
    await waitFor(
      () => visible(`${groceries} [data-reconcile][aria-pressed="true"]`),
      "Pointage de l’opération ventilée après redémarrage",
    );
    checkMatchedGroceries(true);
    await click(`${groceries} .transaction-label`);
    const reopenedParts = await execute(`
      return [...document.querySelectorAll('.transaction-editor .split-amount')].map(input => input.value);
    `);
    if (reopenedParts.join("|") !== "80,25|19,75")
      throw new Error(`Montants ventilés après redémarrage : ${reopenedParts}`);
    await click(".transaction-editor .cancel-editor");
    async function checkRecognizedMoneyOfx(context) {
      await click("#bank-import");
      await waitFor(
        async () =>
          (await text(".bank-import-dialog")).includes("Déjà importée") &&
          (await visible("#bank-import-balance:not([hidden]):enabled")),
        `Relevé OFX reconnu ${context}`,
      );
      if (await visible("#bank-import-confirm:not([hidden])"))
        throw new Error(`Le doublon OFX ne doit pas pouvoir être ajouté ${context}.`);
      await click("#bank-import-balance");
      await waitFor(() => visible("#end-reconciliation"), "Vérification du relevé déjà importé");
      await click("#end-reconciliation");
    }
    await checkRecognizedMoneyOfx("après redémarrage");
    checkMatchedGroceries(true);
    await checkMoneySpending("100,00€", remainingSpending);
    console.log(
      "Après redémarrage : pointage, parts et lien OFX persistants, relevé reconnu sans doublon",
    );

    renameSync(backupPath, join(temp, "backup-base-fictive.kresus"));
    await menuAction("backup");
    await waitFor(
      async () =>
        existsSync(backupPath) && (await text(".database-error")).includes("Sauvegarde créée"),
      "Sauvegarde de la base Money rapprochée",
    );
    await click('[data-account="money-account-2"]');
    await waitFor(() => visible(groceries), "Registre avant modification de la base sauvegardée");
    await clickRegisterControl(`${groceries} [data-delete]`);
    await waitFor(
      () => visible("#delete-transaction-dialog[open]"),
      "Confirmation de suppression dans la base de test",
    );
    await click(".delete-confirm");
    await waitFor(
      async () => !(await visible(groceries)),
      "Opération supprimée avant restauration",
    );
    function checkDeletedGroceries(reimported) {
      const result = spawnSync(
        "python3",
        [
          "-c",
          `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
reimported=int(sys.argv[2])
assert c.execute("SELECT count(*) FROM transactions WHERE id='money-transaction-29'").fetchone() == (0,)
assert c.execute("SELECT count(*) FROM transaction_splits WHERE transaction_id='money-transaction-29'").fetchone() == (0,)
assert c.execute("SELECT count(*) FROM transactions WHERE account_id='money-account-2'").fetchone() == (10+reimported,)
linked=c.execute("SELECT t.id,t.label,t.amount_cents,t.reconciled FROM bank_statement_entries e JOIN transactions t ON t.id=e.transaction_id WHERE e.fit_id='money-split-groceries'").fetchall()
assert [row[1:] for row in linked] == ([('Courses du relevé OFX',-10000,1)] if reimported else []), linked
assert c.execute("SELECT count(*) FROM bank_statement_entries WHERE fit_id='money-split-groceries'").fetchone() == (reimported,)
if reimported: print(linked[0][0])`,
          destination,
          reimported ? "1" : "0",
        ],
        { encoding: "utf8" },
      );
      if (result.status !== 0)
        throw new Error(`Lien du relevé OFX après suppression ou réimport : ${result.stderr}`);
      return result.stdout.trim();
    }
    checkDeletedGroceries(false);
    await click("#bank-import");
    await waitFor(
      () => visible(".bank-import-dialog[open] [data-bank-line]"),
      "La ligne OFX redevient importable après suppression",
    );
    await execute(`
      const choice = document.querySelector('[data-bank-line="0"]');
      choice.value = "add";
      choice.dispatchEvent(new Event("change", { bubbles: true }));
    `);
    await click("#bank-import-confirm");
    await waitFor(
      async () =>
        (await text(".bank-import-status")).includes("1 opération ajoutée · 0 rapprochées") &&
        (await text("tbody")).includes("Courses du relevé OFX"),
      "Nouvelle opération créée depuis le même relevé OFX",
    );
    await click("#end-reconciliation");
    const reimportedId = checkDeletedGroceries(true);
    await checkRecognizedMoneyOfx("après réimport");
    if (checkDeletedGroceries(true) !== reimportedId)
      throw new Error("La ligne OFX doit rester liée à la même écriture après vérification.");
    console.log(
      "Après suppression et réimport : une seule nouvelle écriture, reconnue sans doublon",
    );

    await menuAction("restore");
    await waitFor(
      () => visible(".confirmation-dialog[open]"),
      "Confirmation de restauration de la base Money",
    );
    await click(".confirmation-accept");
    await waitFor(
      async () =>
        (await text(".database-error")).includes("Sauvegarde restaurée") &&
        (await visible(`${groceries} [data-reconcile][aria-pressed="true"]`)),
      "Opération ventilée restaurée avec son pointage",
    );
    checkMatchedGroceries(true);
    await checkRecognizedMoneyOfx("après restauration");
    checkMatchedGroceries(true);
    await checkMoneySpending("100,00€", remainingSpending);
    console.log(
      "Après restauration : opération pointée, parts et lien OFX rétablis, relevé reconnu sans doublon",
    );

    await click("#schedules-nav");
    // Record only the remaining occurrence; the two imported operations must not be duplicated.
    await click("#current-month");
    const remainingOffset = await execute(
      "const d=new Date(); return (2026-d.getFullYear())*12+11-d.getMonth()",
    );
    if (Math.abs(remainingOffset) > 240)
      throw new Error("Date système trop éloignée de l’échantillon Money.");
    for (let i = 0; i < Math.abs(remainingOffset); i++)
      await click(remainingOffset < 0 ? "#previous-month" : "#next-month");
    await waitFor(
      () => visible('[data-record-schedule="money-schedule-7"]'),
      "Dernière occurrence importée",
    );
    await click('[data-record-schedule="money-schedule-7"]');
    await waitFor(
      async () => !(await visible('[data-record-schedule="money-schedule-7"]')),
      "Fin de la série importée",
    );
    const startedCheck = spawnSync(
      "python3",
      [
        "-c",
        `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
assert c.execute("SELECT count(*) FROM schedules WHERE id='money-schedule-7'").fetchone() == (0,)
rows=c.execute("SELECT operation_date,amount_cents FROM transactions WHERE label='Série mensuelle limit. 3 déj com' ORDER BY operation_date").fetchall()
assert rows == [('2026-10-06',-20000),('2026-11-06',-20000),('2026-12-06',-20000)],rows`,
        destination,
      ],
      { encoding: "utf8" },
    );
    if (startedCheck.status !== 0)
      throw new Error(`Série Money déjà commencée : ${startedCheck.stderr}`);
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
