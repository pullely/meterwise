import { dollarsToNano } from "@web-console-next/lib/money";

describe("dollarsToNano (MW2 budget form)", () => {
  it("turns a typed dollar amount into exact nano-USD", () => {
    expect(dollarsToNano("25")).toBe(25_000_000_000);
    expect(dollarsToNano("$0.01")).toBe(10_000_000);
    expect(dollarsToNano(" 0.02 ")).toBe(20_000_000);
    expect(dollarsToNano("1.000000001")).toBe(1_000_000_001);
  });

  it("is null when empty and NaN when not an amount", () => {
    expect(dollarsToNano("")).toBeNull();
    expect(dollarsToNano("   ")).toBeNull();
    expect(Number.isNaN(dollarsToNano("ten")!)).toBe(true);
    expect(Number.isNaN(dollarsToNano("-1")!)).toBe(true);
    expect(Number.isNaN(dollarsToNano("1.0000000001")!)).toBe(true);
  });
});
