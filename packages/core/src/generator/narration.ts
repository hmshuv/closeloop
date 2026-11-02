import { dayOfYear } from "../calendar.ts";
import type { Rng } from "./rng.ts";

/** Most of a merchant's payouts arrive through its nodal bank, so UTRs often share a long prefix. */
const UTR_BANKS = { AXIS: 0.7, HDFC: 0.1, ICIC: 0.1, SBIN: 0.05, KKBK: 0.05 } as const;
const IFSC = ["UTIB0000004", "HDFC0000240", "ICIC0000104", "SBIN0000691", "KKBK0000958"] as const;

/** NEFT-style UTR, 16 chars: 4-letter bank code + "N" + yy + day-of-year + 6-digit sequence. */
export function makeUtr(rng: Rng, date: string): string {
  const bank = rng.weighted(UTR_BANKS);
  return `${bank}N${date.slice(2, 4)}${String(dayOfYear(date)).padStart(3, "0")}${rng.digits(6)}`;
}

export function makeMerchantId(rng: Rng): string {
  return `MID${rng.alnum(11, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789")}`;
}

/** Narration formats seen in the dev split. The matcher's rules may be written around these. */
export const DEV_FORMATS: readonly ((utrText: string, ctx: { mid: string; ifsc: string }) => string)[] = [
  (u, c) => `NEFT CR-${u}-RAZORPAY SOFTWARE PVT LTD-SETTL ${c.mid}`,
  (u) => `NEFT/${u}/RZPY SETTL/RAZORPAY SOFTWARE`,
  (u, c) => `BY TRANSFER-NEFT*${c.ifsc}*${u}*RAZORPAY SOFTW`,
];

export function devNarration(rng: Rng, utrText: string, mid: string): string {
  return rng.pick(DEV_FORMATS)(utrText, { mid, ifsc: rng.pick(IFSC) });
}

/**
 * Held-out only: a payout format never present in dev. The UTR is broken into
 * dot-separated groups after a "REF" label, next to other long alphanumeric tokens.
 */
export function heldoutNarration(utr: string, mid: string): { narration: string; printed: string } {
  const printed = `${utr.slice(0, 5)}.${utr.slice(5, 10)}.${utr.slice(10)}`;
  return { narration: `IMPS-INF/RZP PAYOUTS/${mid}/REF ${printed}/SETTLEMENT CR`, printed };
}

const DIGITS = "0123456789";
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Replace `count` distinct positions with a different character of the same class. */
export function typoUtr(rng: Rng, utr: string, count: number): string {
  const chars = utr.split("");
  for (const i of rng.sample([...chars.keys()], count)) {
    const c = chars[i] as string;
    const pool = DIGITS.includes(c) ? DIGITS : LETTERS;
    let r = c;
    while (r === c) r = rng.pick(pool.split(""));
    chars[i] = r;
  }
  return chars.join("");
}

export function truncateUtr(rng: Rng, utr: string): string {
  return utr.slice(0, rng.int(10, 13));
}

export function spaceOrHyphenate(rng: Rng, utr: string): string {
  const cuts = rng.sample([...Array(utr.length - 1).keys()].map((i) => i + 1), rng.int(1, 2)).sort((a, b) => a - b);
  let out = "";
  let last = 0;
  for (const cut of cuts) {
    out += utr.slice(last, cut) + rng.pick([" ", "-"]);
    last = cut;
  }
  return out + utr.slice(last);
}

const OCR_SWAPS: Record<string, string> = { "0": "O", O: "0", "1": "I", I: "1", "5": "S", S: "5", "8": "B", B: "8" };

/** Held-out only: OCR-style confusions (0↔O, 1↔I, 5↔S, 8↔B) at 1–3 positions. */
export function ocrConfuse(rng: Rng, utr: string): string {
  const chars = utr.split("");
  const eligible = [...chars.keys()].filter((i) => (chars[i] as string) in OCR_SWAPS);
  for (const i of rng.sample(eligible, rng.int(1, 3))) chars[i] = OCR_SWAPS[chars[i] as string] as string;
  return chars.join("");
}

const VENDORS = [
  "ACME SUPPLIES PVT LTD",
  "SHREE GANESH LOGISTICS",
  "NIMBUS CLOUD SERVICES",
  "KAVERI PACKAGING CO",
  "BLUEDART EXPRESS LTD",
  "PRIME OFFICE SPACES LLP",
] as const;

export interface DebitSpec {
  narration: string;
  party: string;
  reference: string;
  amount: number;
}

export function makeDebit(rng: Rng): DebitSpec {
  const roll = rng.int(1, 10);
  if (roll <= 6) {
    const vendor = rng.pick(VENDORS);
    const ref = `INV-${rng.digits(5)}`;
    return {
      narration: `NEFT DR-${rng.pick(IFSC)}-${vendor}-${ref}`,
      party: vendor,
      reference: ref,
      amount: rng.int(5_000_00, 3_00_000_00),
    };
  }
  if (roll <= 8) {
    const ref = `CIN${rng.digits(14)}`;
    return { narration: `GST PAYMENT-CBIC-${ref}`, party: "GST Payable", reference: ref, amount: rng.int(20_000_00, 2_00_000_00) };
  }
  if (roll === 9) {
    const ref = `SAL${rng.digits(6)}`;
    return { narration: `ACH DR-PAYROLL-${ref}`, party: "Salaries Payable", reference: ref, amount: rng.int(1_00_000_00, 4_00_000_00) };
  }
  const ref = `CHG${rng.digits(8)}`;
  return { narration: `CHRG: SMS ALERT CHARGES ${ref}`, party: "Bank Charges", reference: ref, amount: rng.int(500, 5_000) };
}
