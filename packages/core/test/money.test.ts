import { describe, expect, it } from "vitest";
import { applyBps, assertPaise, formatINR, gatewayFee, gstOnFee, settlementBreakdown, sumPaise } from "../src/money.ts";

describe("paise arithmetic", () => {
  it("rounds bps half-up in integer arithmetic", () => {
    expect(applyBps(10_000, 200)).toBe(200); // ₹100 × 2% = ₹2.00 exactly
    expect(applyBps(125, 200)).toBe(3); // 2.5 paise → 3 (half-up)
    expect(applyBps(124, 200)).toBe(2); // 2.48 → 2
    expect(applyBps(0, 200)).toBe(0);
  });

  it("charges GST at 18% of the fee, not of the payment", () => {
    const fee = gatewayFee(1_00_000, 200); // ₹1,000 × 2% = ₹20 = 2000 paise
    expect(fee).toBe(2_000);
    expect(gstOnFee(fee)).toBe(360); // 18% of ₹20 = ₹3.60
    expect(settlementBreakdown(1_00_000, 200)).toEqual({ fee: 2_000, gst: 360, net: 97_640 });
  });

  it("keeps amount = fee + gst + net for awkward amounts", () => {
    for (const amount of [1, 49, 99, 4_999, 12_345_67, 99_99_999]) {
      const { fee, gst, net } = settlementBreakdown(amount, 190);
      expect(fee + gst + net).toBe(amount);
      for (const v of [fee, gst, net]) expect(Number.isSafeInteger(v)).toBe(true);
    }
  });

  it("rejects non-integer or unsafe money", () => {
    expect(() => assertPaise(1.5)).toThrow();
    expect(() => assertPaise(Number.MAX_SAFE_INTEGER + 2)).toThrow();
    expect(() => applyBps(-1, 200)).toThrow();
    expect(() => applyBps(100, 1.5)).toThrow();
    expect(() => sumPaise([1, 0.5])).toThrow();
  });

  it("formats rupees with Indian digit grouping", () => {
    expect(formatINR(12_345_678)).toBe("₹1,23,456.78");
    expect(formatINR(5)).toBe("₹0.05");
    expect(formatINR(-1_00_00_000_00)).toBe("-₹1,00,00,000.00");
  });
});
