// Evaluation reads ground truth, so it is only available via "@closeloop/core/eval", never from the package root.
export { runEval, type EvalOptions, type EvalResult } from "./run.ts";
export { renderEvalMarkdown, renderReadmeResults, headline, type Headline } from "./report.ts";
export { scoreSplit, type SplitScore } from "./score.ts";
