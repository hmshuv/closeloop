import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  addDays,
  businessDaysBetween,
  isBusinessDay,
  windowStart,
  type BankCalendar,
} from "../src/calendar.ts";
import { loadConfig } from "../src/config.ts";

const cal: BankCalendar = loadConfig().calendar;

describe("Indian bank calendar", () => {
  it("treats Sundays, 2nd/4th Saturdays and listed holidays as non-business days", () => {
    expect(isBusinessDay("2026-10-04", cal)).toBe(false); // Sunday
    expect(isBusinessDay("2026-10-10", cal)).toBe(false); // 2nd Saturday
    expect(isBusinessDay("2026-10-24", cal)).toBe(false); // 4th Saturday
    expect(isBusinessDay("2026-10-17", cal)).toBe(true); // 3rd Saturday
    expect(isBusinessDay("2026-10-31", cal)).toBe(true); // 5th Saturday
    expect(isBusinessDay("2026-10-02", cal)).toBe(false); // Gandhi Jayanti
    expect(isBusinessDay("2026-10-05", cal)).toBe(true); // Monday
  });

  it("computes T+n across weekends and holidays", () => {
    expect(addBusinessDays("2026-10-01", 1, cal)).toBe("2026-10-03"); // Thu → (Fri holiday) → Sat 1st
    expect(addBusinessDays("2026-10-09", 1, cal)).toBe("2026-10-12"); // Fri → skip 2nd Sat + Sun → Mon
    expect(addBusinessDays("2026-10-09", 2, cal)).toBe("2026-10-13");
    expect(addBusinessDays("2026-10-04", 0, cal)).toBe("2026-10-05"); // T+0 on a Sunday rolls forward
  });

  it("counts business days in (from, to]", () => {
    expect(businessDaysBetween("2026-10-09", "2026-10-12", cal)).toBe(1);
    expect(businessDaysBetween("2026-10-12", "2026-10-12", cal)).toBe(0);
    expect(businessDaysBetween("2026-10-12", "2026-10-09", cal)).toBe(-1);
  });

  it("windowStart agrees with brute force", () => {
    for (const date of ["2026-10-05", "2026-10-12", "2026-10-21", "2026-10-31"]) {
      for (const n of [0, 1, 3, 7]) {
        const start = windowStart(date, n, cal);
        expect(businessDaysBetween(start, date, cal)).toBeLessThanOrEqual(n);
        expect(businessDaysBetween(addDays(start, -1), date, cal)).toBeGreaterThan(n);
      }
    }
  });
});
