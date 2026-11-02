export const CLOSELOOP_VERSION = "0.1.0";

export * from "./money.ts";
export * from "./calendar.ts";
export * from "./config.ts";
export * from "./types.ts";
export * from "./db/open.ts";
export { FINANCIAL_TABLES } from "./db/schema.ts";
export { generateDataset, GATEWAY_PARTY, type Dataset, type DatasetMeta, type GenerateOptions } from "./generator/generate.ts";
export { partitionDataset, datasetHash, heldoutCoverage, type CoverageRow } from "./generator/split.ts";
export { loadDataset } from "./generator/load.ts";
export { COVERAGE_TARGETS, HELDOUT_ONLY_NOISE, NOISE_EXPECTATIONS } from "./generator/catalog.ts";
export { reconcile, type ReconResult, type ClassifiedException } from "./matcher/reconcile.ts";
export { runReconciliation, summarize, ReconSummarySchema, type ReconSummary, type RunOptions } from "./matcher/run.ts";
export { loadSource, datasetMeta } from "./matcher/load.ts";
export { EXPOSURE_BY_TYPE, exposureClassOf, summarizeExposure, type ExposureSummary } from "./matcher/exposure.ts";
export { findSubsetsWithSum, type SubsetSumResult, type SubsetSumOptions } from "./matcher/subsetsum.ts";
export { computeTieOut, type TieOut } from "./matcher/tieout.ts";
export * from "./matcher/types.ts";
export { approveBatchCandidate, type ApproveBatchResult, type LeftoverOutcome } from "./review/batch.ts";
// Ground-truth readers are deliberately NOT exported here; eval imports them from "@closeloop/core/truth".
