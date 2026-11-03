import type { Metadata } from "next";
import { ExceptionQueue } from "@/components/exception-queue";
import { PageTitle } from "@/components/ui";
import { snapshot } from "@/lib/snapshot";

export const metadata: Metadata = { title: "Exceptions" };

export default function ExceptionsPage() {
  const s = snapshot();
  const llmIds = Object.entries(s.details)
    .filter(([, d]) => d.explanation.source === "llm")
    .map(([id]) => id);
  return (
    <>
      <PageTitle title="Exception queue">
        Every exception the engine raised for October, largest amount first. Each one links to its evidence, the rule that fired, an explanation and its audit history. Approvals happen in the MCP agent, not here.
      </PageTitle>
      <ExceptionQueue items={s.exceptions} llmIds={llmIds} />
    </>
  );
}
