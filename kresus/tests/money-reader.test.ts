import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Buffer } from "buffer";
import {
  cents,
  decodeMoney,
  inspect,
  rc4,
  hasPostedTransfers,
  readMoneySchedules,
} from "../src/money-reader";

describe("Money reader", () => {
  it("rejects invalid files and fractional cents without changing input", () => {
    const bytes = Buffer.alloc(4096);
    expect(() => decodeMoney(bytes)).toThrow();
    expect(bytes.equals(Buffer.alloc(4096))).toBe(true);
    expect(cents("-0.2900")).toBe(-29);
    expect(() => cents("1.001")).toThrow();
    expect(rc4(Buffer.from("Key"), Buffer.from("Plaintext")).toString("hex")).toBe(
      "bbf316e8d940af0ad3",
    );
  });
  it("distinguishes recurring transfer templates from posted and unresolved transfers", () => {
    const link = [{ htrnFrom: 1, htrnLink: 2 }];
    const templates = [
      { htrn: 1, frq: 3, hacct: 10, hacctLink: 20 },
      { htrn: 2, frq: 3, hacct: 20, hacctLink: 10 },
    ];
    expect(hasPostedTransfers(link, templates, [{ lHtrn: 1 }])).toBe(false);
    expect(hasPostedTransfers(link, templates, [])).toBe(true);
    expect(
      hasPostedTransfers(link, [{ ...templates[0], frq: -1 }, templates[1]], [{ lHtrn: 1 }]),
    ).toBe(true);
    expect(hasPostedTransfers(link, templates.slice(0, 1), [{ lHtrn: 1 }])).toBe(true);
  });
  it("reports unsupported recurrence and limited series instead of guessing", () => {
    const template = {
      htrn: 1,
      hacct: 2,
      amt: "-12.00",
      frq: 3,
      hsec: null,
      act: -1,
      hacctLink: null,
      grftt: 2097152,
    };
    const base = {
      hbill: 1,
      hbillHead: 1,
      st: 3,
      frq: 3,
      cFrqInst: 1,
      dt: new Date("2026-10-31T00:00:00Z"),
      dtMax: new Date("2200-12-31T00:00:00Z"),
      cInstMax: -1,
      iinst: 0,
      iinstNextUnpaid: 0,
      iinstLastSkipped: -1,
      cDaysAutoEnter: -1,
      lHtrn: 1,
    };
    for (const bill of [
      { ...base, cInstMax: 5 },
      { ...base, cFrqInst: 3 },
      { ...base, iinstNextUnpaid: 2 },
    ]) {
      const result = readMoneySchedules([bill], [template], [], [{ hacct: 2 }], [], () => "Divers");
      expect(result.schedules).toHaveLength(0);
      expect(result.warnings[0]).toContain("non importée");
    }
  });
  const sample = resolve("../references/Money.mny");
  it.skipIf(!existsSync(sample))(
    "reads the local Money sample and its exact account balance",
    () => {
      const preview = inspect(Buffer.from(readFileSync(sample)));
      expect(preview.accounts).toHaveLength(2);
      expect(preview.categories).toHaveLength(138);
      expect(preview.operations.map((operation) => operation.amount).sort((a, b) => a - b)).toEqual(
        [-10000, -2500],
      );
      const current = preview.accounts.find((account) => account.name === "Compte courant")!;
      const saving = preview.accounts.find((account) => account.name === "Livret A")!;
      expect([
        current.openingBalance,
        current.balance,
        saving.openingBalance,
        saving.balance,
      ]).toEqual([100000, 87500, 200000, 200000]);
      expect(preview.schedules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "Orange",
            amount: -12000,
            frequency: "Mensuelle",
            nextDue: "2026-10-31",
            kind: "debit",
          }),
          expect.objectContaining({
            label: "Orange",
            amount: -10000,
            frequency: "Bimestrielle",
            nextDue: "2026-10-15",
            kind: "transfer",
            destinationAccountId: saving.id,
          }),
        ]),
      );
      expect(preview.warnings.length).toBeGreaterThan(0);
    },
  );
});
