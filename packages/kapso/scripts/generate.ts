#!/usr/bin/env -S node --conditions=bun
/**
 * generate — turn the Smithy JSON model in .generated-specs into the Kapso
 * Effect SDK.
 *
 * Input:  .generated-specs/whatsapp.json  (written by scripts/convert.ts)
 * Output: src/services/whatsapp.ts  +  src/services/index.ts
 *
 * The smithy→SDK compiler and CLI pipeline live in
 * `@distilled.cloud/dev/codegen`; this script is Kapso's provider spec. Kapso
 * keeps the wire's snake_case member names on the TS surface (the spelling
 * Meta's and Kapso's docs use), so there is no member renaming.
 */
import { runGeneratorCli } from "@distilled.cloud/dev/codegen/cli";
import type { SdkSpec } from "@distilled.cloud/dev/codegen/generator";
import {
  ERROR_MATCHERS_TRAIT,
  NULLABLE_TRAIT,
  RAW_RESPONSE_TRAIT,
} from "@distilled.cloud/dev/codegen/openapi";
import { JSON_PRELUDE, TS_JSON_PRELUDE } from "@distilled.cloud/dev/codegen/prelude";

const SENSITIVE_TRAIT = "smithy.api#sensitive";

const spec: SdkSpec = {
  nullableTrait: NULLABLE_TRAIT,
  errorMatchersTrait: ERROR_MATCHERS_TRAIT,
  // `format: binary` members (the multipart `file` part of uploadMedia and
  // uploadFlowAssets) take bytes; the REST protocol sends each as a form part.
  prelude: {
    ...JSON_PRELUDE,
    Blob: "S.Union([S.instanceOf(Blob), S.instanceOf(Uint8Array), S.instanceOf(ArrayBuffer)])",
  },
  tsPrelude: {
    ...TS_JSON_PRELUDE,
    Blob: "Blob | Uint8Array | ArrayBuffer",
  },

  extraBindings: [
    {
      // Sole member of a synthesized wrapper for bare array/scalar response
      // bodies; as the response's only member, the response IS the payload.
      trait: RAW_RESPONSE_TRAIT,
      binding: "rawResponse",
      pipe: "T.RawResponse()",
      rootPipe: "T.RawResponseRoot()",
    },
  ],

  // Sensitive strings (signed media download tokens): Redacted on the way
  // out, `string | Redacted` accepted on the way in.
  memberTraitPipes: {
    [SENSITIVE_TRAIT]: "T.SensitiveValue",
  },
  memberTsType: (m) =>
    SENSITIVE_TRAIT in m.traits
      ? `string | Redacted.Redacted<string>${m.nullable ? " | null" : ""}`
      : undefined,

  // downloadMedia's raw `Blob` response is returned as the response bytes,
  // whatever the file's own Content-Type (image/png, audio/ogg, ...).
  shapeOverride: ({ name, def }) =>
    def.type === "structure" &&
    Object.keys(def.members ?? {}).length === 1 &&
    def.members.body?.target === "smithy.api#Blob" &&
    RAW_RESPONSE_TRAIT in (def.members.body.traits ?? {})
      ? [
          `export type ${name} = Uint8Array;`,
          `export const ${name} = /*@__PURE__*/ S.instanceOf(Uint8Array).pipe(T.BinaryResponse()) as S.Schema<${name}>;`,
        ]
      : undefined,

  // The spec's `oneOf`s carry no discriminator, and their wire names are the
  // TS names, so the TS type is the case union and the schema stays opaque.
  union: ({ name, caseTargets, tsRef }) => [
    `export type ${name} = ${caseTargets.map(tsRef).join(" | ") || "unknown"};`,
    `export const ${name} = /*@__PURE__*/ S.Unknown as any as S.Schema<${name}>;\n`,
  ],

  // listMessages and listConversations page by cursor: `after` in,
  // `paging.next` out (patches/004-pagination.json).
  paginationProfiles: {
    cursor: {
      strategy: "paginateCursor",
      itemsFallback: "data",
    },
  },

  operationDecl: {
    contextType: "KapsoOpContext",
    commonErrorType: "KapsoOpError",
    // Errors any operation can answer (src/errors.ts), then the fallback.
    commonErrorClasses: [
      "ReengagementWindowClosed",
      "GraphRateLimited",
      "MessageInFlight",
      "ThreadNotOwner",
      "PaymentRequired",
      "SendsPaused",
      "MarketingPreferenceStopped",
      "SandboxNotSupported",
      "UnknownKapsoError",
    ],
    protocol: "KapsoProtocol",
    retry: "Retry.Retry",
  },

  sourceNote: ".generated-specs (specs/spec-mirror-kapso)",

  // `effect/Redacted` is only referenced by modules with sensitive members;
  // import it exactly there.
  postProcess: (code) =>
    code.includes("Redacted.Redacted<")
      ? code.replace(
          `import * as S from "@distilled.cloud/core/schema-lite";`,
          `import * as S from "@distilled.cloud/core/schema-lite";\nimport * as Redacted from "effect/Redacted";`,
        )
      : code,
};

runGeneratorCli({
  description: "Generate the Kapso Effect SDK from the Smithy model",
  convert: () => import("./convert.ts"),
  root: `${import.meta.dirname}/..`,
  // scripts/convert.ts applies patches/ to the model; nothing to apply here.
  patchesDir: false,
  spec: () => spec,
});
