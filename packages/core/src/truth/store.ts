import type { Db } from "../db/open.ts";
import type { Dataset } from "../generator/generate.ts";
import { TruthLabelSchema, TruthLinkSchema, type TruthLabel, type TruthLink } from "../types.ts";

/** Ground-truth access. Imported by the generator and the evaluator only — never by the matcher. */
export function writeTruth(truth: Db, ds: Dataset): void {
  const meta = truth.prepare("INSERT INTO truth_meta (key, value) VALUES (?, ?)");
  const label = truth.prepare(
    `INSERT INTO truth_labels (entity_type, entity_id, noise_kind, expected_exception, expected_match_kind, split, details_json)
     VALUES (@entity_type, @entity_id, @noise_kind, @expected_exception, @expected_match_kind, @split, @details_json)`,
  );
  const link = truth.prepare("INSERT INTO truth_links (kind, from_id, to_ids_json, split) VALUES (@kind, @from_id, @to_ids_json, @split)");

  truth.transaction(() => {
    for (const [key, value] of Object.entries(ds.meta)) meta.run(key, String(value));
    for (const l of ds.labels) {
      const parsed = TruthLabelSchema.parse(l);
      label.run({ ...parsed, details_json: JSON.stringify(parsed.details) });
    }
    for (const l of ds.links) {
      const parsed = TruthLinkSchema.parse(l);
      link.run({ kind: parsed.kind, from_id: parsed.from_id, to_ids_json: JSON.stringify(parsed.to_ids), split: parsed.split });
    }
  })();
}

export function readTruthLabels(truth: Db): TruthLabel[] {
  const rows = truth.prepare("SELECT * FROM truth_labels ORDER BY id").all() as (Omit<TruthLabel, "details"> & { details_json: string })[];
  return rows.map(({ details_json, ...rest }) => TruthLabelSchema.parse({ ...rest, details: JSON.parse(details_json) as unknown }));
}

export function readTruthLinks(truth: Db): TruthLink[] {
  const rows = truth.prepare("SELECT kind, from_id, to_ids_json, split FROM truth_links ORDER BY id").all() as {
    kind: string;
    from_id: string;
    to_ids_json: string;
    split: string;
  }[];
  return rows.map((r) => TruthLinkSchema.parse({ kind: r.kind, from_id: r.from_id, to_ids: JSON.parse(r.to_ids_json) as unknown, split: r.split }));
}
