import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Tauri also generates mobile assets; keep only the desktop assets used by this project.
const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "kresus-icons-"));
try {
  const result = spawnSync(
    process.execPath,
    [join(root, "node_modules/@tauri-apps/cli/tauri.js"), "icon", "assets/kresus-icon.svg", "--output", temporary],
    { cwd: root, stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error("La génération des icônes Tauri a échoué.");
  for (const name of [
    "32x32.png", "64x64.png", "128x128.png", "128x128@2x.png", "icon.png", "icon.ico", "icon.icns",
    "Square30x30Logo.png", "Square44x44Logo.png", "Square71x71Logo.png", "Square89x89Logo.png",
    "Square107x107Logo.png", "Square142x142Logo.png", "Square150x150Logo.png", "Square284x284Logo.png",
    "Square310x310Logo.png", "StoreLogo.png",
  ]) copyFileSync(join(temporary, name), join(root, "src-tauri/icons", name));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
