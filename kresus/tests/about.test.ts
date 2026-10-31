// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { showAbout } from "../src/about";
import config from "../src-tauri/tauri.conf.json";

it("shows the packaged icon and version and closes the about dialog", () => {
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
  dialog.querySelector("button")!.click();
  expect(document.querySelector(".about-dialog")).toBeNull();
  vi.restoreAllMocks();
});
