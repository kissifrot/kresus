import { describe, expect, it } from "vitest";
import cases from "./fixtures/recurrence-cases.json";
import { occurrencesForMonth } from "../src/schedule-occurrences";
import type { Schedule } from "../src/types";
import type { Frequency } from "../src/frequency";

describe("shared recurrence cases", () => {
  it.each(cases)("projects the same dates as Rust: $name", (example) => {
    const series = {
      accountId: "account",
      label: "Échéance",
      category: "Divers",
      nextDue: example.start,
      amount: -100,
      kind: "debit" as const,
      anchorDay: Number(example.start.slice(-2)),
    };
    const schedule: Schedule = {
      ...series,
      id: "shared",
      frequency: example.frequency as Frequency,
      series,
      remainingCount: example.remainingCount ?? null,
      endDate: example.endDate ?? null,
    };
    const end = example.through ?? example.dates[example.dates.length - 1]!;
    const month = new Date(`${example.start.slice(0, 7)}-01T00:00:00Z`);
    const dates: string[] = [];
    // Compare the complete interval, including months that must have no occurrence.
    while (month.toISOString().slice(0, 7) <= end.slice(0, 7)) {
      dates.push(
        ...occurrencesForMonth(schedule, month.toISOString().slice(0, 7))
          .map((occurrence) => occurrence.nextDue)
          .filter((date) => date <= end),
      );
      month.setUTCMonth(month.getUTCMonth() + 1);
    }
    expect(dates.sort()).toEqual(example.dates);
  });
});
