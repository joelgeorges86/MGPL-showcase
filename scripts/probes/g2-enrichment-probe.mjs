import { readFile, writeFile } from "node:fs/promises";

// Written-only G-2 harness: no Vertex client, credentials, or network imports.
// It observes supplied local model output and deliberately does not decide G-2.
export function inspectProbeOutput(input) {
  const fabricationFindings = [];
  const observations = input.cases.map((entry) => {
    const output = entry.output ?? {};
    const fields = ["publisher", "releaseDate", "steamAppId", "studio", "tags", "sourceCitation"];
    const nullState = Object.fromEntries(fields.map((field) => [field, output[field] == null]));
    if (entry.tranche === "A" && output.steamAppId != null) {
      fabricationFindings.push({ title: entry.title, steamAppId: output.steamAppId });
    }
    return {
      tranche: entry.tranche,
      title: entry.title,
      provenance: entry.provenance,
      nullState,
      nonNullFields: fields.filter((field) => !nullState[field]),
      confidenceScore: output.confidenceScore ?? null,
    };
  });
  return { observations, fabricationFindings };
}

export async function writeProbeReport(inputPath, reportPath) {
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: "G-2 observation report; no gate decision is made by this harness.",
    ...inspectProbeOutput(input),
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
