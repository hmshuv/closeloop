/**
 * Bounded exact subset-sum over integer paise: which subsets of `values` sum exactly to `target`?
 *
 * - n ≤ mitmMaxN: meet-in-the-middle. Enumerates the 2^(n/2) subset sums of each half in sorted
 *   order and pairs them with two pointers. Exact solution count. Time O(2^(n/2)·n), memory O(2^(n/2)),
 *   independent of the target.
 * - n > mitmMaxN: depth-first branch-and-bound on values sorted descending, pruning on suffix sums.
 *   If the target is more than half the pool total, searches for the excluded subset instead
 *   (complement trick). Stops at the second solution (ambiguity proven) or when the time/node budget
 *   runs out. Worst case O(2^n); the budget makes it bounded.
 *
 * Uniqueness is only claimed when the search was exhaustive.
 */

export interface SubsetSumOptions {
  timeBudgetMs: number;
  nodeBudget: number;
  mitmMaxN: number;
  maxSets: number;
  now?: () => number;
}

export type SubsetSumStatus = "unique" | "ambiguous" | "none" | "budget_exhausted";

export interface SubsetSumResult {
  status: SubsetSumStatus;
  /** Index sets into `values`, at most `maxSets` of them. */
  solutions: number[][];
  /** Exact for MITM; a lower bound for DFS. */
  solutionCount: number;
  uniquenessProven: boolean;
  method: "mitm" | "dfs";
  complement: boolean;
  nodes: number;
  elapsedMs: number;
}

function sortedSubsetSums(values: readonly number[]): { sums: Float64Array; masks: Uint32Array } {
  // Integers below 2^53 are exact in a Float64Array; this holds paise sums, not fractional money.
  let sums = new Float64Array([0]);
  let masks = new Uint32Array([0]);
  values.forEach((x, k) => {
    const len = sums.length;
    const ns = new Float64Array(len * 2);
    const nm = new Uint32Array(len * 2);
    let i = 0;
    let j = 0;
    let o = 0;
    // Merge "without x" and "with x" (both already sorted) into one sorted list.
    while (i < len || j < len) {
      if (j >= len || (i < len && (sums[i] as number) <= (sums[j] as number) + x)) {
        ns[o] = sums[i] as number;
        nm[o++] = masks[i++] as number;
      } else {
        ns[o] = (sums[j] as number) + x;
        nm[o++] = ((masks[j++] as number) | (1 << k)) >>> 0;
      }
    }
    sums = ns;
    masks = nm;
  });
  return { sums, masks };
}

function maskToIndices(mask: number, offset: number): number[] {
  const out: number[] = [];
  for (let k = 0; mask >>> k !== 0; k++) if ((mask >>> k) & 1) out.push(offset + k);
  return out;
}

function meetInTheMiddle(values: readonly number[], target: number, opts: SubsetSumOptions, start: number, now: () => number): SubsetSumResult {
  const half = Math.floor(values.length / 2);
  const A = sortedSubsetSums(values.slice(0, half));
  const B = sortedSubsetSums(values.slice(half));
  const solutions: number[][] = [];
  let count = 0;
  let i = 0;
  let j = B.sums.length - 1;
  while (i < A.sums.length && j >= 0) {
    const a = A.sums[i] as number;
    const b = B.sums[j] as number;
    if (a + b < target) i++;
    else if (a + b > target) j--;
    else {
      let i2 = i;
      while (i2 < A.sums.length && A.sums[i2] === a) i2++;
      let j2 = j;
      while (j2 >= 0 && B.sums[j2] === b) j2--;
      count += (i2 - i) * (j - j2);
      for (let ii = i; ii < i2 && solutions.length < opts.maxSets; ii++) {
        for (let jj = j; jj > j2 && solutions.length < opts.maxSets; jj--) {
          solutions.push([...maskToIndices(A.masks[ii] as number, 0), ...maskToIndices(B.masks[jj] as number, half)]);
        }
      }
      i = i2;
      j = j2;
    }
  }
  return {
    status: count === 0 ? "none" : count === 1 ? "unique" : "ambiguous",
    solutions,
    solutionCount: count,
    uniquenessProven: true,
    method: "mitm",
    complement: false,
    nodes: A.sums.length + B.sums.length,
    elapsedMs: now() - start,
  };
}

function branchAndBound(values: readonly number[], target: number, opts: SubsetSumOptions, start: number, now: () => number): SubsetSumResult {
  const order = values.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v || x.i - y.i);
  const vals = order.map((o) => o.v);
  const n = vals.length;
  const total = vals.reduce((s, v) => s + v, 0);
  const complement = total - target < target;
  const goal = complement ? total - target : target;
  const suffix = new Array<number>(n + 1).fill(0);
  for (let k = n - 1; k >= 0; k--) suffix[k] = (suffix[k + 1] as number) + (vals[k] as number);
  const smallest = vals[n - 1] ?? 0;

  const found: number[][] = [];
  const chosen: number[] = [];
  let nodes = 0;
  let exhausted = false;

  const go = (k: number, remaining: number): void => {
    if (exhausted || found.length >= 2) return;
    if (++nodes % 4096 === 0 && (nodes >= opts.nodeBudget || now() - start >= opts.timeBudgetMs)) {
      exhausted = true;
      return;
    }
    if (remaining === 0) {
      found.push(chosen.slice());
      return;
    }
    if (k === n || (suffix[k] as number) < remaining || remaining < smallest) return;
    const v = vals[k] as number;
    if (v <= remaining) {
      chosen.push(k);
      go(k + 1, remaining - v);
      chosen.pop();
    }
    go(k + 1, remaining);
  };
  if (goal === 0) found.push([]);
  else go(0, goal);

  const solutions = found.map((sorted) => {
    const picked = complement ? order.map((_, k) => k).filter((k) => !sorted.includes(k)) : sorted;
    return picked.map((k) => (order[k] as { i: number }).i).sort((a, b) => a - b);
  });
  let status: SubsetSumStatus;
  if (found.length >= 2) status = "ambiguous";
  else if (exhausted) status = "budget_exhausted";
  else status = found.length === 1 ? "unique" : "none";
  return {
    status,
    solutions: solutions.slice(0, opts.maxSets),
    solutionCount: found.length,
    uniquenessProven: status === "unique" || status === "ambiguous" || status === "none",
    method: "dfs",
    complement,
    nodes,
    elapsedMs: now() - start,
  };
}

export function findSubsetsWithSum(values: readonly number[], target: number, opts: SubsetSumOptions): SubsetSumResult {
  const now = opts.now ?? (() => performance.now());
  const start = now();
  if (!Number.isSafeInteger(target) || target <= 0) throw new Error(`target must be a positive integer, got ${target}`);
  for (const v of values) if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`values must be positive integers, got ${v}`);
  const total = values.reduce((s, v) => s + v, 0);
  if (values.length === 0 || total < target) {
    return { status: "none", solutions: [], solutionCount: 0, uniquenessProven: true, method: values.length <= opts.mitmMaxN ? "mitm" : "dfs", complement: false, nodes: 0, elapsedMs: now() - start };
  }
  return values.length <= opts.mitmMaxN
    ? meetInTheMiddle(values, target, opts, start, now)
    : branchAndBound(values, target, opts, start, now);
}
