import { describe, expect, it } from "vitest";
import { centsInput, euro, parseCents } from "../src/format";

describe("money conversion", () => {
  it("converts decimal input to exact cents and back for editing", () => {
    for (const [input, cents] of [
      ["0.01", 1],
      ["0.10", 10],
      ["0.29", 29],
      ["-12.50", -1250],
      ["1000000000.00", 100000000000],
    ] as const) {
      expect(parseCents(input)).toBe(cents);
      expect(parseCents(centsInput(cents))).toBe(cents);
    }
    expect(euro(parseCents("0.10") + parseCents("0.20"))).toContain("0,30");
  });
  it("rejects fractions of a cent and invalid or excessive inputs", () => {
    for (const input of ["0.001", "1e3", "", "1000000000.01", "abc"])
      expect(() => parseCents(input)).toThrow();
  });
});
