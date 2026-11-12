import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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
    expect(
      readPostedTransfers(
        [link],
        [
          { ...debit, grftt: 6 },
          { ...credit, grftt: 2 },
        ],
        [],
        accounts,
      ),
    ).toEqual([{ debitId: 1, creditId: 2 }]);
    for (const [links, entries, available] of [
      [[link], [debit], accounts],
      [[link], [debit, { ...credit, amt: "9.00" }], accounts],
      [[link], [debit, { ...credit, hacctLink: 30 }], accounts],
      [[link, link], [debit, credit], accounts],
      [[], [debit, credit], accounts],
      [[link], [debit, credit], accounts.slice(0, 1)],
      [[link], [debit, { ...credit, grftt: 0 }], accounts],
      [[link], [debit, { ...credit, grftt: 2 }], accounts],
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
  it("imports the verified twice-monthly Money transfer and rejects unverified variants", () => {
    // Synthetic records retain only the fields needed by the observed Money encoding.
    const bill = {
      hbill: 2,
      hbillHead: 2,
      st: 3,
      frq: 3,
      cFrqInst: 2,
      dt: new Date("2026-10-15T00:00:00Z"),
      dtMax: new Date("2200-12-31T00:00:00Z"),
      cInstMax: -1,
      iinst: 0,
      iinstNextUnpaid: 0,
      iinstLastSkipped: -1,
      cDaysAutoEnter: -1,
      lHtrn: 7,
    };
    const debit = {
      htrn: 7,
      hacct: 2,
      hacctLink: 3,
      amt: "-100.00",
      frq: 3,
      hsec: null,
      act: -1,
      grftt: 2097154,
    };
    const credit = { htrn: 8, hacct: 3, hacctLink: 2, amt: "100.00" };
    const read = (value: typeof bill, entries = [debit, credit]) =>
      readMoneySchedules(
        [value],
        entries,
        [{ htrnFrom: 7, htrnLink: 8 }],
        [{ hacct: 2 }, { hacct: 3 }],
        [],
        () => "Divers",
      );
    expect(read(bill).schedules[0]).toMatchObject({
      frequency: "Bimensuelle",
      nextDue: "2026-10-15",
      kind: "transfer",
      destinationAccountId: 3,
      amount: -10000,
    });
    for (const variant of [
      { ...bill, dt: new Date("2026-10-16T00:00:00Z") },
      { ...bill, cInstMax: 2, dtMax: new Date("2026-10-31T00:00:00Z") },
      { ...bill, st: 1, iinstNextUnpaid: 1 },
    ])
      expect(read(variant).skippedSchedules).toHaveLength(1);
    expect(read(bill, [debit]).skippedSchedules).toHaveLength(1);
    expect(read(bill, [debit, { ...credit, amt: "99.00" }]).skippedSchedules).toHaveLength(1);
  });
  it("imports only the observed unlimited, unstarted semiannual debit", () => {
    const source = {
      htrn: 28,
      hacct: 2,
      amt: "-100.0000",
      frq: 5,
      hsec: null,
      act: -1,
      hacctLink: null as number | null,
      grftt: 2097152,
      grfstem: 2176,
      grfEntryMethods: 1,
      fPrint: false,
      lHpay: 16,
    };
    const bill = {
      hbill: 12,
      hbillHead: 12,
      st: 3,
      frq: 5,
      cFrqInst: 2,
      dt: new Date("2026-11-13T00:00:00Z"),
      dtMax: new Date("2200-12-31T00:00:00Z"),
      cInstMax: -1,
      iinst: 0,
      iinstNextUnpaid: 0,
      iinstLastSkipped: -1,
      cDaysAutoEnter: -1,
      lHtrn: 28,
    };
    const read = (b: typeof bill, t: typeof source) =>
      readMoneySchedules(
        [b],
        [t],
        [],
        [{ hacct: 2 }],
        [{ hpay: 16, szFull: "EDF semestriel" }],
        () => "Divers",
      );
    const result = read(bill, source);
    expect(result.schedules[0]).toMatchObject({
      id: 12,
      label: "EDF semestriel",
      frequency: "Semestrielle",
      nextDue: "2026-11-13",
      anchorDay: 13,
      amount: -10000,
      kind: "debit",
      endDate: null,
      paymentMethod: null,
    });
    expect(
      result.warnings.some((warning) => warning.includes("méthode de paiement non reconnue")),
    ).toBe(true);
    for (const [b, t] of [
      [{ ...bill, cFrqInst: 1 }, source],
      [{ ...bill, cInstMax: 2, dtMax: new Date("2027-05-13T00:00:00Z") }, source],
      [{ ...bill, st: 1, iinstNextUnpaid: 1 }, source],
      [bill, { ...source, amt: "100.00" }],
      [bill, { ...source, hacctLink: 3 }],
    ] as const) {
      expect(read(b, t).schedules).toHaveLength(0);
      expect(read(b, t).skippedSchedules).toHaveLength(1);
    }
  });
  it("imports only the observed unlimited, unstarted quarterly debit", () => {
    const source = {
      htrn: 1,
      hacct: 2,
      amt: "-100.00",
      frq: 4,
      hsec: null,
      act: -1,
      hacctLink: null as number | null,
      grftt: 2097152,
      grfstem: 2050,
      grfEntryMethods: 1,
      fPrint: false,
    };
    const bill = {
      hbill: 1,
      hbillHead: 1,
      st: 3,
      frq: 4,
      cFrqInst: 1,
      dt: new Date("2026-11-06T00:00:00Z"),
      dtMax: new Date("2200-12-31T00:00:00Z"),
      cInstMax: -1,
      iinst: 0,
      iinstNextUnpaid: 0,
      iinstLastSkipped: -1,
      cDaysAutoEnter: -1,
      lHtrn: 1,
    };
    const read = (b: typeof bill, t: typeof source) =>
      readMoneySchedules([b], [t], [], [{ hacct: 2 }], [], () => "Divers");
    expect(read(bill, source).schedules[0]).toMatchObject({
      frequency: "Trimestrielle",
      nextDue: "2026-11-06",
      anchorDay: 6,
      amount: -10000,
      endDate: null,
      paymentMethod: "cheque",
    });
    for (const [b, t] of [
      [{ ...bill, cFrqInst: 2 }, source],
      [{ ...bill, cInstMax: 2, dtMax: new Date("2027-02-06T00:00:00Z") }, source],
      [{ ...bill, st: 1, iinstNextUnpaid: 1 }, source],
      [bill, { ...source, amt: "100.00" }],
      [bill, { ...source, hacctLink: 3 }],
    ] as const) {
      expect(read(b, t).schedules).toHaveLength(0);
      expect(read(b, t).skippedSchedules).toHaveLength(1);
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
      ["2023-12-31", "2024-04-30", 3, 2, false],
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
  it("advances a started limited series without losing its original month-end anchor", () => {
    const source = {
      htrn: 1,
      hacct: 2,
      amt: "-12.00",
      frq: 3,
      hsec: null,
      act: -1,
      hacctLink: null,
      grftt: 2097152,
    };
    const bill = {
      hbill: 1,
      hbillHead: 1,
      st: 1,
      frq: 3,
      cFrqInst: 1,
      iinst: 0,
      iinstNextUnpaid: 1,
      iinstLastSkipped: -1,
      cDaysAutoEnter: -1,
      lHtrn: 1,
      dt: new Date("2024-01-31T00:00:00Z"),
      dtMax: new Date("2024-03-31T00:00:00Z"),
      cInstMax: 3,
    };
    const read = (b: typeof bill) =>
      readMoneySchedules([b], [source], [], [{ hacct: 2 }], [], () => "Divers");
    expect(read(bill).schedules[0]).toMatchObject({
      nextDue: "2024-02-29",
      anchorDay: 31,
      endDate: "2024-03-31",
    });
    for (const b of [
      { ...bill, iinstNextUnpaid: 3 },
      { ...bill, iinstNextUnpaid: -1 },
      { ...bill, iinstLastSkipped: 0 },
      { ...bill, cInstMax: -1 },
    ])
      expect(read(b).skippedSchedules).toHaveLength(1);
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
      [{ ...source, amt: "12.00" }, null],
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
  const sample = resolve("tests/fixtures/money-reference.mny");
  it("reads the local Money sample and its exact account balance", () => {
    const preview = inspect(Buffer.from(readFileSync(sample)));
    expect(preview.accounts).toHaveLength(2);
    expect(preview.categories).toHaveLength(138);
    expect(preview.operations.map((operation) => operation.amount).sort((a, b) => a - b)).toEqual([
      -364155, -22500, -20000, -20000, -10000, -10000, -10000, -10000, -2500, 10000, 10000, 10000,
    ]);
    expect(preview.operations.find((operation) => operation.id === 21)).toMatchObject({
      reference: "0      200001",
      note: "",
    });
    expect(preview.operations.find((operation) => operation.id === 22)).toMatchObject({
      reference: "0      200002",
      note: "Une note",
    });
    expect(preview.operations.find((operation) => operation.id === 19)).toMatchObject({
      reference: "0   100000001",
    });
    const current = preview.accounts.find((account) => account.name === "Compte courant")!;
    const saving = preview.accounts.find((account) => account.name === "Livret A")!;
    expect([
      current.openingBalance,
      current.balance,
      saving.openingBalance,
      saving.balance,
    ]).toEqual([100000, -349155, 200000, 210000]);
    expect(preview.transfers).toEqual([
      { debitId: 9, creditId: 10 },
      { debitId: 17, creditId: 16 },
      { debitId: 19, creditId: 20 },
    ]);
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
    expect(preview.operations.find((operation) => operation.id === 17)).toMatchObject({
      accountId: current.id,
      amount: -10000,
      reconciled: false,
    });
    expect(preview.operations.find((operation) => operation.id === 16)).toMatchObject({
      accountId: saving.id,
      amount: 10000,
      reconciled: true,
    });
    expect(preview.schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Orange mensuel",
          amount: -12000,
          frequency: "Mensuelle",
          nextDue: "2026-10-31",
          kind: "debit",
          paymentMethod: "cheque",
        }),
      ]),
    );
    expect(preview.operations.find((op) => op.id === 18)).toMatchObject({
      date: "2026-10-06",
      amount: -20000,
    });
    expect(preview.operations.find((op) => op.id === 23)).toMatchObject({
      date: "2026-11-06",
      amount: -20000,
    });
    expect(preview.schedules.find((schedule) => schedule.id === 7)).toMatchObject({
      nextDue: "2026-12-06",
      endDate: "2026-12-06",
      anchorDay: 6,
    });
    expect(preview.warnings.length).toBeGreaterThan(0);
    expect(preview.skippedSchedules).toHaveLength(0);
    expect(preview.schedules).toHaveLength(12);
    expect(preview.schedules.find((schedule) => schedule.id === 12)).toMatchObject({
      label: "EDF semestriel",
      frequency: "Semestrielle",
      nextDue: "2026-11-13",
      anchorDay: 13,
      amount: -10000,
      kind: "debit",
      paymentMethod: null,
    });
    expect(preview.schedules.find((schedule) => schedule.id === 2)).toMatchObject({
      label: "Orange bimensuel",
      frequency: "Bimensuelle",
      nextDue: "2026-10-15",
      amount: -10000,
      kind: "transfer",
      destinationAccountId: saving.id,
    });
    expect(preview.schedules.find((schedule) => schedule.id === 6)).toMatchObject({
      label: "Test périodicité trimestrielle",
      frequency: "Trimestrielle",
      nextDue: "2026-11-06",
      amount: -10000,
      paymentMethod: "cheque",
      endDate: null,
    });
    expect(preview.schedules.find((schedule) => schedule.id === 9)).toMatchObject({
      label: "Test méthode prélèv",
      amount: -12300,
      paymentMethod: null,
    });
    expect(preview.schedules.find((schedule) => schedule.id === 5)).toMatchObject({
      nextDue: "2026-11-19",
      frequency: "Bimestrielle",
    });
    expect(preview.schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 3,
          nextDue: "2026-11-04",
          amount: 20000,
          endDate: "2027-08-04",
          paymentMethod: null,
        }),
        expect.objectContaining({
          id: 4,
          nextDue: "2026-11-19",
          amount: 30000,
          endDate: "2027-03-19",
        }),
      ]),
    );
  });
});
