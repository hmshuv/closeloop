import { z } from "zod";

/** Integer paise (1 rupee = 100 paise). Money is never a float anywhere in CloseLoop. */
export type Paise = number;

export const PaiseSchema = z.number().int().safe();

export const GST_BPS = 1800;

export function assertPaise(value: number, label = "amount"): Paise {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer number of paise, got ${value}`);
  }
  return value;
}

/**
 * amount × bps / 10_000, rounded half-up, in integer arithmetic.
 * Used for gateway fees (bps of the payment) and GST (bps of the fee).
 */
export function applyBps(amount: Paise, bps: number): Paise {
  assertPaise(amount);
  if (amount < 0) throw new Error(`applyBps expects a non-negative amount, got ${amount}`);
  if (!Number.isInteger(bps) || bps < 0) throw new Error(`bps must be a non-negative integer, got ${bps}`);
  const scaled = amount * bps + 5_000;
  assertPaise(scaled, "amount × bps");
  return Math.floor(scaled / 10_000);
}

export function gatewayFee(amount: Paise, feeBps: number): Paise {
  return applyBps(amount, feeBps);
}

/** GST is levied on the gateway fee, not on the payment amount. */
export function gstOnFee(fee: Paise, gstBps: number = GST_BPS): Paise {
  return applyBps(fee, gstBps);
}

export interface FeeBreakdown {
  fee: Paise;
  gst: Paise;
  net: Paise;
}

/** settlement_amount = amount − fee − GST on fee */
export function settlementBreakdown(amount: Paise, feeBps: number, gstBps: number = GST_BPS): FeeBreakdown {
  const fee = gatewayFee(amount, feeBps);
  const gst = gstOnFee(fee, gstBps);
  return { fee, gst, net: amount - fee - gst };
}

export function sumPaise(values: Iterable<Paise>): Paise {
  let total = 0;
  for (const v of values) total += assertPaise(v);
  return assertPaise(total, "sum");
}

/** Indian digit grouping: 12345678 paise → "₹1,23,456.78". */
export function formatINR(amount: Paise): string {
  assertPaise(amount);
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const rupees = Math.floor(abs / 100).toString();
  const paise = (abs % 100).toString().padStart(2, "0");
  const lastThree = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}` : lastThree;
  return `${sign}₹${grouped}.${paise}`;
}
