// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { showAbout } from "../src/about";
import config from "../src-tauri/tauri.conf.json";

it("shows the packaged icon, version and Tauri link and closes the about dialog", () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
  showAbout();
  const dialog = document.querySelector<HTMLDialogElement>(".about-dialog[open]")!;
  expect(dialog.textContent).toContain(`Version ${config.version}`);
  expect(dialog.querySelector("img")?.src).toContain("128x128.png");
  expect(dialog.textContent).toContain("Propulsé par Tauri");
  const tauriLink = dialog.querySelector("a")!;
  expect(tauriLink.textContent).toBe("Tauri");
  expect(tauriLink.href).toBe("https://tauri.app/");
  expect(tauriLink.target).toBe("_blank");
  dialog.querySelector("button")!.click();
  expect(document.querySelector(".about-dialog")).toBeNull();
  vi.restoreAllMocks();
});
