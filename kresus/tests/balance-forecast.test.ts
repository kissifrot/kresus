import { describe, expect, it } from "vitest";
import { calculateForecast, forecastEnd } from "../src/balance-forecast";
import type { Schedule } from "../src/types";

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  const series = {
    accountId: "a",
    label: "Loyer",
    category: "Divers",
    nextDue: "2028-01-31",
    amount: -3000,
    kind: "debit" as const,
    anchorDay: 31,
  };
  return { ...series, id: "one", frequency: "Mensuelle", series, ...overrides };
}

describe("balance forecast", () => {
  it("clamps the three-month horizon at month end", () => {
    expect(forecastEnd("2027-11-30")).toBe("2028-02-29");
    expect(forecastEnd("2026-11-30")).toBe("2027-02-28");
  });
  it("includes each overdue and future occurrence, known future operations and limited series", () => {
    const points = calculateForecast(
      "a",
      "2028-03-01",
      10000,
      [
        { date: "2028-03-02", label: "Achat", amount: -500 },
        { date: "2028-07-01", label: "Hors période", amount: -999 },
      ],
      [schedule({ remainingCount: 3 })],
    );
    expect(points.map((p) => [p.date, p.balance])).toEqual([
      ["2028-03-01", 10000],
      ["2028-03-01", 4000],
      ["2028-03-02", 3500],
      ["2028-03-31", 500],
      ["2028-06-01", 500],
    ]);
    expect(points[1]!.movements.map((m) => [m.date, m.overdue])).toEqual([
      ["2028-01-31", true],
      ["2028-02-29", true],
    ]);
  });
  it("uses edited occurrence amounts, dates and accounts and signs transfers for both accounts", () => {
    const series = {
      accountId: "a",
      destinationAccountId: "b",
      label: "Épargne",
      category: "Divers",
      nextDue: "2028-01-15",
      amount: -2000,
      kind: "transfer" as const,
      anchorDay: 15,
    };
    const transfer = schedule({
      ...series,
      id: "transfer",
      frequency: "Mensuelle",
      series,
      remainingCount: 3,
      futureOverrides: [
        { ...series, originalDue: "2028-02-15", nextDue: "2028-02-20", amount: -3000 },
      ],
    });
    const source = calculateForecast("a", "2028-01-01", 10000, [], [transfer]);
    const destination = calculateForecast("b", "2028-01-01", 10000, [], [transfer]);
    expect(source.map((p) => p.balance)).toEqual([10000, 8000, 5000, 3000, 3000]);
    expect(destination.map((p) => p.balance)).toEqual([10000, 12000, 15000, 17000, 17000]);
    expect(source[2]!.date).toBe("2028-02-20");
    expect(
      calculateForecast("other", "2028-01-01", 10000, [], [transfer]).map((p) => p.balance),
    ).toEqual([10000, 10000]);
  });
  it("respects an inclusive end date and the twice-monthly cadence through leap February", () => {
    const series = {
      accountId: "a",
      label: "Abonnement",
      category: "Divers",
      nextDue: "2028-02-15",
      amount: -100,
      kind: "debit" as const,
      anchorDay: 15,
    };
    const item = schedule({ ...series, frequency: "Bimensuelle", series, endDate: "2028-03-15" });
    const points = calculateForecast("a", "2028-02-01", 1000, [], [item]);
    expect(
      points.filter((point) => point.movements.length).map((point) => [point.date, point.balance]),
    ).toEqual([
      ["2028-02-15", 900],
      ["2028-02-29", 800],
      ["2028-03-15", 700],
    ]);
  });
});
