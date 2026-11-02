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
// Ground-truth readers are deliberately NOT exported here; eval imports them from "@closeloop/core/truth".
