#!/usr/bin/env -S node --conditions=bun
/**
 * convert — turn Kapso's WhatsApp (Meta proxy) OpenAPI spec into a Smithy 2.0
 * JSON model.
 *
 * Input:  specs/spec-mirror-kapso/specs/openapi-whatsapp.yaml  (YAML, parsed
 *         with the `yaml` package)
 *         patches/*.json  (RFC-6902 patches to the converted Smithy model,
 *                          under the upstream shape ids)
 * Output: .generated-specs/whatsapp.json
 *
 * The OpenAPI→Smithy converter lives in `@distilled.cloud/dev/codegen/openapi`;
 * this script is Kapso's pipeline config. `scripts/generate.ts` compiles the
 * model into src/services.
 *
 * Failures carry two envelopes (Meta's `{ error: { code, … } }` and Kapso's
 * `{ error, code? }`), and the meaning is in the body, not the status: the
 * same Graph error arrives as 400, 404 or 422. So no per-status error classes
 * are generated (`statusToErrorClass: {}`); src/protocol.ts and the classes in
 * src/errors.ts classify by body, and core's status map catches the rest.
 *
 * Several routes are a bare id (`/{media_id}`, `/{flow_id}`,
 * `/{phone_number_id}`), which the verbNoun heuristic reads as mechanical ids
 * and names from the route (`getRoot`); `operationNames` keeps the spec's own
 * operation ids for them.
 */
import * as path from "node:path";
import { runOpenApiConvert } from "@distilled.cloud/dev/codegen/openapi-cli";
import { finalizeConvert } from "@distilled.cloud/dev/codegen/patches";
import { parse as parseYaml } from "yaml";

const root = path.resolve(import.meta.dirname, "..");

await runOpenApiConvert({
  root,
  specs: [
    {
      name: "whatsapp",
      specPath: "specs/spec-mirror-kapso/specs/openapi-whatsapp.yaml",
    },
  ],
  patchesDir: "patches",
  // Finalized below, to set the telemetry names.
  finalize: false,
  parse: (text) => parseYaml(text),
  options: {
    namespace: "com.kapso.whatsapp",
    serviceName: "WhatsApp",
    skipDeprecated: true,
    // X-Kapso-Take-Control, the spec's only header parameter, is a real per-call input.
    headerParams: true,
    // Media upload is multipart with a binary `file` part; media download is bytes.
    binaryTypes: true,
    statusToErrorClass: {},
    operationNames: {
      "GET /{media_id}": "getMediaUrl",
      "DELETE /{media_id}": "deleteMedia",
      "GET /{flow_id}": "getFlow",
      "POST /{flow_id}": "updateFlowMetadata",
      "GET /{phone_number_id}": "getPhoneNumber",
      "POST /{phone_number_id}": "updatePhoneNumber",
    },
  },
});

// Patches, deferred operation names and telemetry traits. Telemetry names
// default to the package name with `@distilled.cloud/` stripped; published as
// `distilled-kapso`, they would read `DistilledKapso`, so they are set to what `@distilled.cloud/kapso` would
// get: spans `Kapso.<Operation>`, rpc.system.name `kapso-api`, path labels
// `kapso.<label>`.
await finalizeConvert({
  root,
  patchesDir: "patches",
  patchesFor: () => "",
  // The converter computed the names; finalize only applies them.
  operationNaming: "as-is",
  telemetry: { prefix: "Kapso", system: "kapso-api", labelNamespace: "kapso" },
});
