import { describe, expect, it } from "vitest";
import { centsInput, euro, parseCents, parsePositiveCents } from "../src/format";

describe("money conversion", () => {
  it("converts decimal input to exact cents and back for editing", () => {
    for (const [input, cents] of [
      ["0.01", 1],
      ["0.10", 10],
      ["0.29", 29],
      ["-12.50", -1250],
      ["12,50", 1250],
      ["1 234,56 €", 123456],
      ["1\u202f234\u00a0567,89 €", 123456789],
      ["1 000 000 000,00", 100000000000],
      ["1000000000.00", 100000000000],
    ] as const) {
      expect(parseCents(input)).toBe(cents);
      expect(parseCents(centsInput(cents))).toBe(cents);
    }
    expect(euro(parseCents("0.10") + parseCents("0.20"))).toContain("0,30");
  });
  it("rejects fractions of a cent and invalid or excessive inputs", () => {
    for (const input of [
      "0.001",
      "1e3",
      "",
      "1000000000.01",
      "abc",
      "1,234",
      "1.234,56",
      "12 34,56",
      "1,2,3",
    ])
      expect(() => parseCents(input)).toThrow();
  });
  it("rejects zero and negative amounts for operations but permits signed opening balances", () => {
    for (const input of ["0", "-1,00"]) expect(() => parsePositiveCents(input)).toThrow();
    expect(parseCents("-1 234,56 €")).toBe(-123456);
    expect(parsePositiveCents("0,01")).toBe(1);
  });
});
