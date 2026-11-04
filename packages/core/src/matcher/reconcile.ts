import type { CloseLoopConfig } from "../config.ts";
import { exposureClassOf } from "./exposure.ts";
import { stage1Items } from "./stage1-items.ts";
import { stage2Bank, type DeferredSettlement, type Stage2Options } from "./stage2-bank.ts";
import type { BatchStats } from "./stage2-batch.ts";
import type { GatewayReportStats } from "./stage2-report.ts";
import { stage3Ledger } from "./stage3-ledger.ts";
import { stage4Timing } from "./stage4-timing.ts";
import { computeTieOut, tieOutExceptions, type TieOut } from "./tieout.ts";
import type { ExceptionDraft, ExposureClass, MatchDraft, SourceData } from "./types.ts";

export type ClassifiedException = ExceptionDraft & { exposure_class: ExposureClass };

export interface ReconResult {
  matches: MatchDraft[];
  exceptions: ClassifiedException[];
  pending: { payments_in_window: number; receipts_in_grace: number };
  /** Possible members of open batch exceptions (status unresolved_in_batch). */
  deferred: DeferredSettlement[];
  tieOut: TieOut;
  batch: BatchStats;
  /** Null when no gateway recon report was imported. */
  gateway: GatewayReportStats | null;
  durationMs: number;
}

/**
 * The deterministic engine. Pure: source records in, matches + exceptions out.
 * It never sees ground truth and never writes financial records.
 */
export function reconcile(src: SourceData, cfg: CloseLoopConfig, period: { from: string; to: string }, opts: Stage2Options = {}): ReconResult {
  const started = performance.now();
  const s1 = stage1Items(src, cfg);
  const s2 = stage2Bank(src, cfg, opts);
  const s3 = stage3Ledger(src, cfg);
  const s4 = stage4Timing(src, cfg);
  const tieOut = computeTieOut({ from: period.from, to: period.to, ...s3.tieOut });
  const exceptions = [...s1.exceptions, ...s2.exceptions, ...s3.exceptions, ...s4, ...tieOutExceptions(tieOut)].map((e) => ({
    ...e,
    exposure_class: exposureClassOf(e.type),
  }));
  return {
    matches: [...s1.matches, ...s2.matches, ...s3.matches],
    exceptions,
    pending: { payments_in_window: s1.pendingInWindow, receipts_in_grace: s3.pendingReceipts },
    deferred: s2.deferred,
    tieOut,
    batch: s2.batch,
    gateway: s2.gateway,
    durationMs: performance.now() - started,
  };
}
