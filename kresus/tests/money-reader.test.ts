import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Buffer } from "buffer";
import {
  cents,
  decodeMoney,
  inspect,
  rc4,
  readPostedTransfers,
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
  it("resolves posted pairs and rejects broken or ambiguous Money transfers", () => {
    const accounts = [{ hacct: 10 }, { hacct: 20 }];
    const debit = { htrn: 1, frq: -1, hacct: 10, hacctLink: 20, amt: "-10.00", grftt: 2 };
    const credit = { htrn: 2, frq: -1, hacct: 20, hacctLink: 10, amt: "10.00", grftt: 6 };
    const link = { htrnFrom: 2, htrnLink: 1 };
    expect(readPostedTransfers([link], [debit, credit], [], accounts)).toEqual([
      { debitId: 1, creditId: 2 },
    ]);
    for (const [links, entries, available] of [
      [[link], [debit], accounts],
      [[link], [debit, { ...credit, amt: "9.00" }], accounts],
      [[link], [debit, { ...credit, hacctLink: 30 }], accounts],
      [[link, link], [debit, credit], accounts],
      [[], [debit, credit], accounts],
      [[link], [debit, credit], accounts.slice(0, 1)],
      [[link], [debit, { ...credit, grftt: 0 }], accounts],
    ] as const)
      expect(() => readPostedTransfers([...links], [...entries], [], [...available])).toThrow();
    const templates = [
      { ...debit, frq: 3 },
      { ...credit, frq: 3 },
    ];
    expect(readPostedTransfers([link], templates, [{ lHtrn: 1 }], accounts)).toEqual([]);
    expect(() => readPostedTransfers([link], templates, [], accounts)).toThrow();
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
      expect(result.skippedSchedules).toHaveLength(1);
      expect(result.skippedSchedules[0]).toContain("Échéance Money 1");
    }
  });
  it("accepts consistent finite limits with month-end and leap-year anchors", () => {
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
      iinst: 0,
      iinstNextUnpaid: 0,
      iinstLastSkipped: -1,
      cDaysAutoEnter: -1,
      lHtrn: 1,
    };
    for (const [start, end, count, interval, valid] of [
      ["2024-01-31", "2024-03-31", 3, 1, true],
      ["2024-01-31", "2024-02-29", 2, 1, true],
      ["2023-12-31", "2024-04-30", 3, 2, true],
      ["2026-11-19", "2027-03-20", 5, 1, true],
      ["2024-01-31", "2024-03-31", 2, 1, false],
      ["2024-01-31", "2024-01-30", 1, 1, false],
      ["2024-01-31", "2024-03-31", -1, 1, false],
    ] as const) {
      const bill = {
        ...base,
        cFrqInst: interval,
        dt: new Date(start + "T00:00:00Z"),
        dtMax: new Date(end + "T00:00:00Z"),
        cInstMax: count,
      };
      const result = readMoneySchedules([bill], [template], [], [{ hacct: 2 }], [], () => "Divers");
      if (valid) expect(result.schedules[0]?.endDate).toBe(end);
      else expect(result.skippedSchedules).toHaveLength(1);
    }
  });
  it("imports only the observed cheque signature and warns about unknown payment flags", () => {
    const bill = {
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
    const source = {
      htrn: 1,
      hacct: 2,
      amt: "-12.00",
      frq: 3,
      hsec: null,
      act: -1,
      hacctLink: null,
      grftt: 2097152,
      grfstem: 2050,
      grfEntryMethods: 1,
      fPrint: false,
    };
    for (const [template, expected] of [
      [source, "cheque"],
      [{ ...source, grfstem: 2051 }, null],
      [{ ...source, fPrint: true }, null],
    ] as const) {
      const result = readMoneySchedules([bill], [template], [], [{ hacct: 2 }], [], () => "Divers");
      expect(result.schedules[0]?.paymentMethod).toBe(expected);
      expect(
        result.warnings.some((warning) => warning.includes("méthode de paiement non reconnue")),
      ).toBe(expected === null);
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
        [-10000, -10000, -2500, 10000],
      );
      const current = preview.accounts.find((account) => account.name === "Compte courant")!;
      const saving = preview.accounts.find((account) => account.name === "Livret A")!;
      expect([
        current.openingBalance,
        current.balance,
        saving.openingBalance,
        saving.balance,
      ]).toEqual([100000, 77500, 200000, 210000]);
      expect(preview.transfers).toEqual([{ debitId: 9, creditId: 10 }]);
      expect(preview.operations.find((operation) => operation.id === 9)).toMatchObject({
        accountId: current.id,
        amount: -10000,
        reconciled: true,
      });
      expect(preview.operations.find((operation) => operation.id === 10)).toMatchObject({
        accountId: saving.id,
        amount: 10000,
        reconciled: false,
      });
      expect(preview.schedules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "Orange",
            amount: -12000,
            frequency: "Mensuelle",
            nextDue: "2026-10-31",
            kind: "debit",
            paymentMethod: "cheque",
          }),
          expect.objectContaining({
            label: "Orange",
            amount: -10000,
            frequency: "Bimestrielle",
            nextDue: "2026-10-15",
            kind: "transfer",
            paymentMethod: null,
            destinationAccountId: saving.id,
          }),
        ]),
      );
      expect(preview.warnings.length).toBeGreaterThan(0);
      expect(preview.skippedSchedules).toHaveLength(1);
      expect(preview.schedules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 3,
            nextDue: "2026-11-04",
            amount: 20000,
            endDate: "2027-08-04",
          }),
          expect.objectContaining({
            id: 4,
            nextDue: "2026-11-19",
            amount: 30000,
            endDate: "2027-03-19",
          }),
        ]),
      );
      expect(preview.skippedSchedules.join("\n")).toContain("périodicité");
    },
  );
});
