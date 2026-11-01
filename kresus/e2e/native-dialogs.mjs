import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
// Emit the same event as a native menu item; native shortcut activation is checked separately.
async function menuAction(action) {
  await request("POST", `/session/${session}/execute/sync`, {
    script: "return window.__TAURI__.event.emit('kresus-menu', arguments[0])",
    args: [action],
  });
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
  // Exercise a real native menu accelerator, including Rust-to-WebView dispatch.
  const windowId = xdotool("search", "--onlyvisible", "--name", "Kresus — Finances familiales")
    .split("\n")
    .at(-1);
  xdotool("windowfocus", "--sync", windowId);
  xdotool("key", "ctrl+o");
  await closeDialog(await dialog());
  console.log("Menu natif : raccourci Ouvrir et annulation vérifiés.");
  xdotool("windowfocus", "--sync", windowId);
  xdotool("key", "alt+a", "Return");
  await waitFor(async () => (await text(".about-dialog[open]")).includes("Version"), "À propos");
  const about = await request("POST", `/session/${session}/execute/sync`, {
    script:
      "const d=document.querySelector('.about-dialog'); const i=d.querySelector('img'); return [d.textContent,i.complete,i.naturalWidth]",
    args: [],
  });
  const version = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")).version;
  if (!about[0].includes(version) || !about[1] || !about[2])
    throw new Error("Version ou icône absente de la fenêtre À propos.");
  await click(".about-dialog button");
  for (const [selector, name] of [
    ["open", "Ouverture d’une base"],
    ["backup", "Sauvegarde"],
    ["restore", "Restauration"],
    ["import", "Import Money"],
  ]) {
    await menuAction(selector);
    const id = await dialog();
    await closeDialog(id);
    console.log(`${name} : dialogue natif ouvert et annulé au clavier`);
  }
  if (existsSync(join(temp, "backup.sqlite3")))
    throw new Error("L’annulation a créé une sauvegarde.");
  const backupPath = join(temp, "native-backup.sqlite3");
  await menuAction("backup");
  await selectPath(await dialog(), backupPath);
  await waitFor(() => existsSync(backupPath), "Création de la sauvegarde native");
  await waitFor(
    async () => (await text(".database-error")).includes("Sauvegarde créée"),
    "Confirmation de sauvegarde",
  );
  await menuAction("open");
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
  // Build a representative older schema and controlled business data in a private copy.
  const legacyPath = join(temp, "legacy.sqlite3");
  copyFileSync(backupPath, legacyPath);
  const legacySetup = spawnSync(
    "python3",
    [
      "-c",
      `import sqlite3,sys,datetime
c=sqlite3.connect(sys.argv[1]); today=datetime.date.today()
c.execute("DROP TABLE schedule_limits")
c.execute("DROP TABLE schedule_future_overrides")
for table in ('schedules','schedule_overrides'):
 for column in ('payment_method','cheque'):
  c.execute(f'ALTER TABLE {table} DROP COLUMN {column}')
c.executemany("INSERT INTO accounts VALUES (?,?,?,?,?)", [('receipt-business','Compte métier','Compte courant',10000,''),('receipt-other','Autre compte métier','Épargne',0,'')])
rows=[('r1','receipt-business','2020-02-28','Début','Alimentation',-1000),('r2','receipt-business','2020-02-29','Bissextile','Factures',-2500),('r3','receipt-business','2020-03-01','Fin','Alimentation',-3000),('r4','receipt-business','2020-02-27','Avant','Divers',-9000),('r5','receipt-business','2020-03-02','Après','Divers',-9000),('r6','receipt-business','2020-02-29','Revenu','Revenus',5000),('rd','receipt-business','2020-02-29','Virement','Divers',-2000),('rc','receipt-other','2020-02-29','Virement','Divers',2000)]
c.executemany("INSERT INTO transactions (id,account_id,operation_date,label,category,amount_cents,reconciled) VALUES (?,?,?,?,?,?,0)",rows)
c.execute("INSERT INTO transfers VALUES ('receipt-transfer','rd','rc')")
for id,label,days in [('overdue-old','Retard ancien',-5),('overdue-recent','Retard récent',-2),('due-today','À échéance aujourd’hui',0)]:
 date=(today+datetime.timedelta(days=days)).isoformat()
 c.execute("INSERT INTO schedules (id,account_id,label,category,next_due,frequency,amount_cents,kind) VALUES (?,?,?,?,?,?,?,?)",(id,'receipt-business',label,'Factures',date,'Mensuelle',-345,'debit'))
 c.execute("INSERT INTO schedule_anchors VALUES (?,?)",(id,int(date[-2:])))
c.commit()`,
      legacyPath,
    ],
    { encoding: "utf8" },
  );
  if (legacySetup.status !== 0)
    throw new Error(`Préparation de base ancienne : ${legacySetup.stderr}`);
  await menuAction("open");
  await selectPath(await dialog(), legacyPath);
  await waitFor(
    async () =>
      (
        await request("POST", `/session/${session}/execute/sync`, {
          script: "return document.querySelector('.database-controls small').textContent",
          args: [],
        })
      ).includes("legacy.sqlite3"),
    "Ouverture de la base ancienne",
  );
  await click('[data-account="receipt-business"]');
  await waitFor(
    async () => (await text(".page-heading h1")) === "Compte métier",
    "Compte ancien migré",
  );
  const migrated = spawnSync(
    "python3",
    [
      "-c",
      `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
assert {'payment_method','cheque'} <= {x[1] for x in c.execute('pragma table_info(schedules)')}
assert c.execute("select count(*) from sqlite_master where name in ('schedule_limits','schedule_future_overrides')").fetchone()[0] == 2
assert c.execute("select count(*) from transactions where id like 'r%'").fetchone()[0] == 8
assert c.execute("select count(*) from schedules where account_id='receipt-business'").fetchone()[0] == 3`,
      legacyPath,
    ],
    { encoding: "utf8" },
  );
  if (migrated.status !== 0) throw new Error(`Migration de la base : ${migrated.stderr}`);
  // Reject an incompatible database while retaining the current migrated one.
  const incompatible = join(temp, "incompatible.sqlite3");
  writeFileSync(incompatible, "not a database");
  await menuAction("open");
  await selectPath(await dialog(), incompatible);
  await waitFor(
    async () =>
      (
        await request("POST", `/session/${session}/execute/sync`, {
          script: "return document.querySelector('.database-error').textContent",
          args: [],
        })
      ).includes("Ouverture impossible"),
    "Erreur d’ouverture",
  );
  if (
    !(
      await request("POST", `/session/${session}/execute/sync`, {
        script: "return document.querySelector('.database-controls small').textContent",
        args: [],
      })
    ).includes("legacy.sqlite3") ||
    (await text(".page-heading h1")) !== "Compte métier" ||
    readFileSync(incompatible, "utf8") !== "not a database"
  )
    throw new Error("L’ouverture invalide a changé la base active.");
  // Only pending dates strictly before today are overdue; process several series in order.
  await click("#schedules-nav");
  await waitFor(
    async () => (await text("#show-overdue")).includes("2 échéances"),
    "Deux séries en retard",
  );
  await click("#show-overdue");
  const labels = await request("POST", `/session/${session}/execute/sync`, {
    script:
      "return [...document.querySelectorAll('.schedule-row')].map(r=>r.querySelector('.schedule-row-copy strong').textContent)",
    args: [],
  });
  if (JSON.stringify(labels) !== JSON.stringify(["Retard ancien", "Retard récent"]))
    throw new Error(`Ordre ou filtre des retards incorrect : ${labels}`);
  await click('[data-record-schedule="overdue-old"]');
  await waitFor(
    async () => !(await text(".schedule-list")).includes("Retard ancien"),
    "Enregistrement du premier retard",
  );
  if (!(await text("#show-overdue")).includes("1 échéance"))
    throw new Error("Le compteur des retards n’a pas été actualisé.");
  await click('[data-record-schedule="overdue-recent"]');
  await waitFor(
    async () => (await text(".schedule-list")).includes("Aucune échéance en retard"),
    "Tous les retards enregistrés",
  );
  const overdueCheck = spawnSync(
    "python3",
    [
      "-c",
      `import sqlite3,sys,datetime
c=sqlite3.connect(sys.argv[1]); today=datetime.date.today()
r=c.execute("select operation_date,label,amount_cents from transactions where label like 'Retard %' order by operation_date").fetchall()
assert r==[((today-datetime.timedelta(days=5)).isoformat(),'Retard ancien',-345),((today-datetime.timedelta(days=2)).isoformat(),'Retard récent',-345)],r
assert c.execute("select next_due from schedules where id='due-today'").fetchone()[0]==today.isoformat()`,
      legacyPath,
    ],
    { encoding: "utf8" },
  );
  if (overdueCheck.status !== 0)
    throw new Error(`Enregistrements des retards : ${overdueCheck.stderr}`);
  // Compare an inclusive period spanning leap day, its single-day subset, and an empty account.
  await click("#spending-nav");
  await waitFor(
    async () => !(await text(".spending-panel")).includes("Chargement"),
    "Rapport métier",
  );
  async function report(account, start, end, expected) {
    await request("POST", `/session/${session}/execute/sync`, {
      script: `const f=document.querySelector('#spending-filter'); for(const [n,v] of Object.entries(arguments[0])) { f.elements[n].value=v; f.elements[n].dispatchEvent(new Event('change',{bubbles:true})); }`,
      args: [{ account, start, end }],
    });
    await click('#spending-filter button[type="submit"]');
    await waitFor(
      async () =>
        await request("POST", `/session/${session}/execute/sync`, {
          script: `const f=document.querySelector('#spending-filter'); const panel=document.querySelector('.spending-panel'); return !f.querySelector('button[type=submit]').disabled && f.elements.account.value===arguments[0] && (panel.querySelector('.spending-total strong')?.textContent ?? panel.textContent).includes(arguments[1]);`,
          args: [account, expected],
        }),
      `Rapport ${start} à ${end}`,
    );
  }
  await report("receipt-business", "2020-02-28", "2020-03-01", "65,00");
  const rows = await request("POST", `/session/${session}/execute/sync`, {
    script: "return [...document.querySelectorAll('.spending-row')].map(r=>r.textContent)",
    args: [],
  });
  if (
    rows.length !== 2 ||
    !rows.some((r) => r.includes("Alimentation") && r.includes("40,00")) ||
    !rows.some((r) => r.includes("Factures") && r.includes("25,00"))
  )
    throw new Error(`Répartition incorrecte : ${rows}`);
  await report("receipt-business", "2020-02-29", "2020-02-29", "25,00");
  await report("receipt-other", "2020-02-28", "2020-03-01", "Aucune dépense");
  console.log(
    "Base ancienne : migration et rejet d’une base invalide ; retards et rapport multicomptes vérifiés.",
  );
  await menuAction("default");
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
  await menuAction("restore");
  await selectPath(await dialog(), backupPath);
  await waitFor(async () => {
    try {
      return (await text(".confirmation-dialog[open]")).includes("remplacées");
    } catch {
      return false;
    }
  }, "Confirmation de restauration");
  await click(".confirmation-cancel");
  await menuAction("restore");
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
  // A malformed file must never replace the active database, even after confirmation.
  const invalidPath = join(temp, "invalid.sqlite3");
  writeFileSync(invalidPath, "not a SQLite database");
  const activePath = join(appData, "kresus.sqlite3");
  const snapshot = spawnSync(
    "python3",
    [
      "-c",
      `import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1]); print(json.dumps([c.execute("select count(*) from accounts").fetchone(), c.execute("select count(*) from transactions").fetchone(), c.execute("select sum(amount_cents) from transactions").fetchone()]))`,
      activePath,
    ],
    { encoding: "utf8" },
  );
  if (snapshot.status !== 0) throw new Error(snapshot.stderr);
  await menuAction("restore");
  await selectPath(await dialog(), invalidPath);
  await waitFor(async () => {
    try {
      return (await text(".confirmation-dialog[open]")).includes("remplacées");
    } catch {
      return false;
    }
  }, "Confirmation du fichier invalide");
  await click(".confirmation-accept");
  await waitFor(
    async () => (await text(".database-error")).includes("Restauration impossible"),
    "Erreur de restauration",
  );
  if (readFileSync(invalidPath, "utf8") !== "not a SQLite database")
    throw new Error("Le fichier invalide a été modifié.");
  const after = spawnSync(
    "python3",
    [
      "-c",
      `import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1]); print(json.dumps([c.execute("select count(*) from accounts").fetchone(), c.execute("select count(*) from transactions").fetchone(), c.execute("select sum(amount_cents) from transactions").fetchone()]))`,
      activePath,
    ],
    { encoding: "utf8" },
  );
  if (
    after.status !== 0 ||
    after.stdout !== snapshot.stdout ||
    (await text(".page-heading h1")) !== "Compte courant — test"
  )
    throw new Error("La restauration invalide a modifié la base active.");
  console.log("Restauration invalide : erreur affichée, fichiers et données préservés.");
  // Copy the fixture into the disposable directory and never alter the original.
  const sample = process.env.KRESUS_MONEY_SAMPLE ?? resolve(root, "../references/Money.mny");
  if (existsSync(sample)) {
    const moneyPath = join(temp, "money-sample.mny");
    copyFileSync(sample, moneyPath);
    await menuAction("import");
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
      !preview.includes("775,00") ||
      !preview.includes("138 catégories")
    )
      throw new Error("Aperçu Money inattendu après sélection native.");
    const destination = join(temp, "native-money.sqlite3");
    await click('.money-import-dialog button[type="submit"]');
    await closeDialog(await dialog());
    if (
      existsSync(destination) ||
      !(await text(".money-import-dialog[open]")).includes("Compte courant")
    )
      throw new Error("L’annulation de destination a modifié l’import.");
    await waitFor(
      async () =>
        await request("POST", `/session/${session}/execute/sync`, {
          script:
            "return !document.querySelector('.money-import-dialog button[type=submit]').disabled",
          args: [],
        }),
      "Réactivation de l’import",
    );
    await click('.money-import-dialog button[type="submit"]');
    await selectPath(await dialog(), destination);
    await waitFor(
      async () => existsSync(destination) && (await text(".balance-card")).includes("775,00"),
      "Import Money natif",
    );
    const verified = spawnSync(
      "python3",
      [
        "-c",
        `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
a=c.execute("SELECT name, opening_balance_cents FROM accounts ORDER BY name").fetchall()
t=c.execute("SELECT amount_cents FROM transactions ORDER BY amount_cents").fetchall()
n=c.execute("SELECT count(*) FROM categories WHERE id LIKE 'money-cat-%'").fetchone()[0]
s=c.execute("SELECT next_due,frequency,amount_cents FROM schedules ORDER BY next_due").fetchall()
pair = c.execute("SELECT d.amount_cents,d.reconciled,r.amount_cents,r.reconciled FROM transfers x JOIN transactions d ON d.id=x.debit_id JOIN transactions r ON r.id=x.credit_id WHERE x.id='money-transfer-9-10'").fetchone()
assert pair == (-10000,1,10000,0), pair
assert a == [('Compte courant',100000),('Livret A',200000)] and t == [(-10000,),(-10000,),(-2500,),(10000,)] and n == 138 and s == [('2026-10-15','Bimestrielle',-10000),('2026-10-31','Mensuelle',-12000)], (a,t,n,s)`,
        destination,
      ],
      { encoding: "utf8" },
    );
    if (verified.status !== 0) throw new Error(`Base Money native incorrecte : ${verified.stderr}`);
    console.log("Import Money natif : annulation, création et contenu SQLite vérifiés.");
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
