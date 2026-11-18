#!/usr/bin/env node
/**
 * Fetches Kapso's WhatsApp (Meta proxy) OpenAPI spec to ../specs/.
 *
 * Kapso publishes its API descriptions as OpenAPI 3.1 YAML files on its
 * documentation site (listed under "OpenAPI Specs" in
 * https://docs.kapso.ai/llms.txt). There is no public git repository and no
 * versioned URL, so the mirror snapshots the file. Only the document the
 * generator reads is fetched: the Meta proxy, not the platform, workflows or
 * agent specs.
 *
 * The YAML is written verbatim; scripts/convert.ts parses it with `yaml`.
 *
 * Usage:
 *   node fetch-specs.ts
 *
 * The spec is saved to:
 *   ../specs/openapi-whatsapp.yaml
 */

import { existsSync, mkdirSync } from "fs";
import { writeFile } from "fs/promises";

const SPECS: ReadonlyArray<{ url: string; output: string }> = [
  {
    url: "https://docs.kapso.ai/api/meta/whatsapp/openapi-whatsapp.yaml",
    output: "openapi-whatsapp.yaml",
  },
];
const SPECS_DIR = "../specs";

if (!existsSync(SPECS_DIR)) {
  mkdirSync(SPECS_DIR, { recursive: true });
}

async function main() {
  for (const spec of SPECS) {
    console.log(`Fetching ${spec.url}...`);
    const response = await fetch(spec.url, {
      headers: { "user-agent": "distilled.cloud-kapso-spec-mirror" },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${spec.url}: ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    // Fail here rather than in the generator: an HTML error page or a gutted
    // response is still text, but it is not an OpenAPI document.
    if (!/^openapi: 3\./m.test(text) || !/^paths:/m.test(text)) {
      throw new Error(
        `${spec.url} returned no top-level \`openapi\`/\`paths\` — not an OpenAPI document`,
      );
    }
    const outputPath = `${SPECS_DIR}/${spec.output}`;
    console.log(`Writing ${outputPath}...`);
    // A trailing newline, so a re-fetch of the same document is byte-identical.
    await writeFile(outputPath, text.endsWith("\n") ? text : `${text}\n`);
  }
  console.log("Done!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
