import type * as API from "@distilled.cloud/core/api";
import type { API_ERRORS, ConfigError, InvalidInput } from "@distilled.cloud/core/errors";
import {
  makeRestProtocol,
  unknownErrorProps,
  type RestErrorInfo,
} from "@distilled.cloud/core/protocol-rest";
import { parseRetryAfter } from "@distilled.cloud/core/retry-after";
import type { SdkError } from "@distilled.cloud/core/sdk-error";
import { getErrorMatchers } from "@distilled.cloud/core/trait";
/**
 * KapsoProtocol -- hand-written.
 *
 * Kapso's Meta proxy speaks API-key-authenticated JSON REST, so the protocol
 * is one `makeRestProtocol` call from `core/protocol-rest`:
 *
 *   request:  `X-API-Key: <key>` + the base URL from the credentials,
 *             resolved from the calling fiber on every request.
 *             downloadMedia (`/media_download`) goes to the unversioned
 *             media root; everything else to the versioned API root.
 *
 *   response: 2xx JSON is the payload (downloadMedia's body is the file's
 *             bytes). A failure carries Meta's envelope
 *             `{ error: { message, code, error_subcode?, error_data?, fbtrace_id } }`
 *             or Kapso's `{ error: "<message>", code?: "<string>" }`.
 *             `errorEnvelope` reads both. `classifyError` turns a 423 with
 *             `Retry-After` into SendsPausedRetryable and any Graph code
 *             without a class of its own into MetaGraphError; everything
 *             else goes to the classes in errors.ts (matched by body), then
 *             core's status map, then UnknownKapsoError.
 */
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Credentials, type Config } from "./credentials.ts";
import {
  GraphRateLimited,
  type KapsoCommonError,
  KapsoParseError,
  MetaGraphError,
  ReengagementWindowClosed,
  SendsPausedRetryable,
  UnknownKapsoError,
} from "./errors.ts";

/**
 * Error channel shared by every generated Kapso operation. Generated service
 * files annotate operations with `API.OperationMethod<I, O, KapsoOpError,
 * KapsoOpContext>` explicitly so the compiler never infers these back out of
 * the schema generics.
 */
export type KapsoOpError =
  | InstanceType<(typeof API_ERRORS)[number]>
  | KapsoCommonError
  | UnknownKapsoError
  | ConfigError
  | HttpClientError.HttpClientError
  | KapsoParseError
  | InvalidInput
  | SdkError;

/** Context (requirements) shared by every generated Kapso operation. */
export type KapsoOpContext = Credentials | HttpClient.HttpClient;

/**
 * Graph codes that have a class of their own in errors.ts, read off those
 * classes' `/error/code` matchers. classifyError runs before the matchers, so
 * it must leave these codes to them.
 */
const OWN_CLASS_CODES = /*@__PURE__*/ new Set(
  [ReengagementWindowClosed, GraphRateLimited].flatMap((cls) =>
    (getErrorMatchers(cls) ?? []).flatMap((matcher) => {
      const code = matcher.body?.["/error/code"];
      return typeof code === "number" ? [code] : [];
    }),
  ),
);

/**
 * Graph codes by category, after Kapso's own client (@kapso/whatsapp-cloud-api,
 * src/errors/categorize.ts, MIT). A code not listed falls back by range and
 * status in {@link categorize}.
 */
const CATEGORY_CODES: ReadonlyArray<readonly [string, ReadonlyArray<number>]> = [
  ["authorization", [0, 190]],
  ["permission", [3, 10]],
  ["parameter", [33, 100, 130472, 131008, 131009, 131021, 131026, 135000]],
  ["media", [131051, 131052, 131053]],
  ["server", [131000, 131016, 131057, 133004, 133005]],
  ["integrity", [368, 130497, 131031]],
  ["wabaConfig", [131037]],
  ["businessEligibility", [131042, 134011]],
  ["phoneRegistration", [131045, 133000, 133006, 133008, 133009, 133010, 133015, 133016]],
  ["template", [132000, 132001, 132005, 132007, 132012, 132015, 132016]],
  ["flow", [132068, 132069]],
  ["synchronization", [2593107, 2593108]],
];
const CATEGORY_BY_CODE = /*@__PURE__*/ new Map(
  CATEGORY_CODES.flatMap(([category, codes]) => codes.map((code) => [code, category] as const)),
);

const categorize = (code: number, status: number): string =>
  CATEGORY_BY_CODE.get(code) ??
  (code >= 200 && code <= 299
    ? "permission"
    : status === 401
      ? "authorization"
      : status === 403
        ? "permission"
        : status >= 500
          ? "server"
          : "parameter");

interface GraphError {
  readonly message?: string;
  readonly code: number;
  readonly error_subcode?: number;
  readonly type?: string;
  readonly error_data?: { readonly details?: string };
  readonly fbtrace_id?: string;
}

/** Meta's `error` object, when the body carries one (a numeric `code` tells it from Kapso's string `error`). */
const graphError = (body: unknown): GraphError | undefined => {
  const error = (body as { error?: unknown } | null)?.error;
  return error !== null &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "number"
    ? (error as GraphError)
    : undefined;
};

const classifyError = (info: RestErrorInfo): unknown => {
  if (info.status === 423 && info.code === "project_under_review") {
    const retryAfter = parseRetryAfter(info.headers);
    // Without the header, SendsPaused (not retried) matches by body.
    return retryAfter === undefined
      ? undefined
      : new SendsPausedRetryable({ message: info.message, retryAfter });
  }
  const graph = graphError(info.body);
  // 5xx stays core's retried InternalServerError/BadGateway/... .
  if (graph === undefined || OWN_CLASS_CODES.has(graph.code) || info.status >= 500) {
    return undefined;
  }
  return new MetaGraphError({
    status: info.status,
    message: graph.message ?? info.message,
    code: graph.code,
    subcode: graph.error_subcode,
    type: graph.type,
    details: graph.error_data?.details,
    fbtraceId: graph.fbtrace_id,
    category: categorize(graph.code, info.status),
  });
};

/** The route of downloadMedia, served from the unversioned media root. */
const MEDIA_DOWNLOAD_URI = "/media_download";

export const KapsoProtocol: Layer.Layer<API.Protocol> = /*@__PURE__*/ makeRestProtocol<Config>({
  // The Credentials service holds an effect -- resolving it here (per
  // request, on the calling fiber) picks up context-provided credentials.
  credentials: /*@__PURE__*/ Effect.flatMap(Credentials, (resolve) => resolve),
  baseUrl: (creds, { uri }) => (uri === MEDIA_DOWNLOAD_URI ? creds.mediaBaseUrl : creds.apiBaseUrl),
  headers: (creds) => ({ "X-API-Key": Redacted.value(creds.apiKey) }),
  errorEnvelope: (body) => {
    if (body === null || typeof body !== "object") return undefined;
    const graph = graphError(body);
    if (graph !== undefined) return { code: graph.code, message: graph.message };
    const rec = body as Record<string, unknown>;
    return {
      code: typeof rec.code === "string" ? rec.code : undefined,
      message: typeof rec.error === "string" ? rec.error : undefined,
    };
  },
  classifyError,
  unknownError: (info) => new UnknownKapsoError(unknownErrorProps(info)),
  parseError: ({ body, cause }) => new KapsoParseError({ body, cause }),
});
