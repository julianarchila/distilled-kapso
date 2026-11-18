/**
 * Kapso-specific error types.
 *
 * Re-exports the common HTTP errors from core and adds Kapso's own. Two
 * envelopes reach a caller, and the meaning is in the body, not the status:
 *
 * - Meta Graph errors, proxied: `{ error: { message, type, code, error_subcode?,
 *   error_data?, fbtrace_id } }`. Kapso changes the status: a missing template
 *   (Graph code 132001) answered 404 on 2026-11-17, where Meta sends 400.
 * - Kapso's own errors: `{ error: "<message>", code?: "<string>" }` (402, 403,
 *   409, 423, its own 400 validation, and the 422 for a closed 24-hour window,
 *   which come with no `code`).
 *
 * The classes below that one code identifies carry matchers (`applyErrorMatchers`);
 * generate.ts lists them on every operation. Every other Graph code becomes
 * {@link MetaGraphError}, with a `category` src/protocol.ts reads off the code.
 */
export {
  BadGateway,
  BadRequest,
  Conflict,
  ConfigError,
  Forbidden,
  GatewayTimeout,
  InternalServerError,
  Locked,
  NotFound,
  ServiceUnavailable,
  TooManyRequests,
  Unauthorized,
  UnprocessableEntity,
  HTTP_STATUS_MAP,
  DEFAULT_ERRORS,
  API_ERRORS,
} from "@distilled.cloud/core/errors";
export type { DefaultErrors } from "@distilled.cloud/core/errors";

import * as Category from "@distilled.cloud/core/category";
import { DurationSchema, UnknownErrorFields } from "@distilled.cloud/core/errors";
import * as Schema from "@distilled.cloud/core/schema-lite-typed";
import { applyErrorMatchers } from "@distilled.cloud/core/trait";

/** Unknown Kapso error -- returned when nothing else matches the failure. */
export class UnknownKapsoError
  extends /*@__PURE__*/ Schema.TaggedError<UnknownKapsoError>()(
    "UnknownKapsoError",
    UnknownErrorFields,
  ) {}

/** Schema parse error wrapper. */
export class KapsoParseError
  extends /*@__PURE__*/ Schema.TaggedError<KapsoParseError>()("KapsoParseError", {
    body: Schema.Unknown,
    cause: Schema.Unknown,
  }).pipe(Category.withParseError) {}

// ---- Meta Graph errors (`error.code`) ----------------------------------------

/**
 * More than 24 hours have passed since the user last wrote, so only a
 * template can reach them. Kapso checks the window itself before calling
 * Meta: on 2026-11-18 a text sent 23 minutes after the window closed got 422
 * `{ error: "Cannot send non-template messages outside the 24-hour window.",
 * next_steps }`, Kapso's envelope with no `code`. Meta's own refusal, Graph
 * code 131047, is matched too, at any status.
 */
export class ReengagementWindowClosed
  extends /*@__PURE__*/ Schema.TaggedError<ReengagementWindowClosed>()("ReengagementWindowClosed", {
    message: Schema.String,
    /** The failure's body; Kapso's refusal carries `next_steps` advice there. */
    body: /*@__PURE__*/ Schema.optional(Schema.Unknown),
  }).pipe(Category.withBadRequestError) {}
applyErrorMatchers(ReengagementWindowClosed, [
  { status: 422, message: { includes: "outside the 24-hour window" } },
  { body: { "/error/code": 131047 } },
]);

/**
 * Meta throttled the call: app (4), WhatsApp Business Account (80007),
 * throughput (130429), spam rate (131048) or pair rate (131056) limits. The
 * codes are the `throttling` category of Kapso's own client
 * (@kapso/whatsapp-cloud-api, src/errors/categorize.ts). Retried by default.
 */
export class GraphRateLimited
  extends /*@__PURE__*/ Schema.TaggedError<GraphRateLimited>()("GraphRateLimited", {
    message: Schema.String,
    code: Schema.Number,
    retryAfter: /*@__PURE__*/ Schema.optional(DurationSchema),
  }).pipe(
    Category.withThrottlingError,
    /*@__PURE__*/ Category.withRetryable({ throttling: true }),
  ) {}
applyErrorMatchers(GraphRateLimited, [
  { body: { "/error/code": 4 } },
  { body: { "/error/code": 80007 } },
  { body: { "/error/code": 130429 } },
  { body: { "/error/code": 131048 } },
  { body: { "/error/code": 131056 } },
]);

/**
 * Any other Graph error. `category` groups the code the way Kapso's own
 * client does (`template`, `media`, `parameter`, `permission`, ...); `code`,
 * `subcode` and `fbtraceId` are Meta's.
 */
export class MetaGraphError
  extends /*@__PURE__*/ Schema.TaggedError<MetaGraphError>()("MetaGraphError", {
    status: Schema.Number,
    message: Schema.String,
    code: Schema.Number,
    subcode: /*@__PURE__*/ Schema.optional(Schema.Number),
    type: /*@__PURE__*/ Schema.optional(Schema.String),
    details: /*@__PURE__*/ Schema.optional(Schema.String),
    fbtraceId: /*@__PURE__*/ Schema.optional(Schema.String),
    category: Schema.String,
  }) {}

// ---- Kapso's own errors ------------------------------------------------------

/**
 * Another message to this recipient is still being sent (409). Its body has
 * no `code`, only the message. Retried by default. From Kapso's spec; two and
 * five concurrent sends to one recipient on 2026-11-17 did not trigger it.
 */
export class MessageInFlight
  extends /*@__PURE__*/ Schema.TaggedError<MessageInFlight>()("MessageInFlight", {
    message: Schema.String,
  }).pipe(Category.withConflictError, Category.withRetryableError) {}
applyErrorMatchers(MessageInFlight, [{ status: 409, message: { includes: "in-flight" } }]);

/**
 * On a shared number another app handles this conversation (409
 * `thread_not_owner`, `thread_ownership_unknown` or
 * `meta_business_agent_control`). Send a template, or send with
 * `xKapsoTakeControl: "true"` where Kapso is the escalation app.
 */
export class ThreadNotOwner
  extends /*@__PURE__*/ Schema.TaggedError<ThreadNotOwner>()("ThreadNotOwner", {
    message: Schema.String,
  }).pipe(Category.withConflictError) {}
applyErrorMatchers(ThreadNotOwner, [
  { status: 409, body: { "/code": "thread_not_owner" } },
  { status: 409, body: { "/code": "thread_ownership_unknown" } },
  { status: 409, body: { "/code": "meta_business_agent_control" } },
]);

/**
 * The project cannot pay Meta's fee for this message (402
 * `insufficient_credits`, `service_credits_exhausted`, `pricing_missing`, ...).
 */
export class PaymentRequired
  extends /*@__PURE__*/ Schema.TaggedError<PaymentRequired>()("PaymentRequired", {
    message: Schema.String,
  }).pipe(Category.withQuotaError) {}
applyErrorMatchers(PaymentRequired, [{ status: 402 }]);

/**
 * Outbound sends are paused while Kapso reviews the project (423
 * `project_under_review`). Without a `Retry-After` header a person is
 * reviewing and retrying does not help, so this class is not retried;
 * src/protocol.ts raises {@link SendsPausedRetryable} when the header is set.
 * It carries no `LockedError` category on purpose: core retries every
 * `LockedError` as transient. Marking messages as read keeps working.
 */
export class SendsPaused
  extends /*@__PURE__*/ Schema.TaggedError<SendsPaused>()("SendsPaused", {
    message: Schema.String,
  }) {}
applyErrorMatchers(SendsPaused, [{ status: 423, body: { "/code": "project_under_review" } }]);

/** {@link SendsPaused} while an automatic review runs; retried after `retryAfter`. */
export class SendsPausedRetryable
  extends /*@__PURE__*/ Schema.TaggedError<SendsPausedRetryable>()("SendsPausedRetryable", {
    message: Schema.String,
    retryAfter: DurationSchema,
  }).pipe(Category.withLockedError, /*@__PURE__*/ Category.withRetryable()) {}

/**
 * The contact asked WhatsApp to stop marketing messages from this number (422
 * `marketing_preference_stopped`). Kapso refuses before reaching Meta and does
 * not charge; send a utility or authentication template instead.
 */
export class MarketingPreferenceStopped
  extends /*@__PURE__*/ Schema.TaggedError<MarketingPreferenceStopped>()(
    "MarketingPreferenceStopped",
    { message: Schema.String },
  ).pipe(Category.withBadRequestError) {}
applyErrorMatchers(MarketingPreferenceStopped, [
  { body: { "/code": "marketing_preference_stopped" } },
]);

/**
 * A sandbox number serves only the messaging endpoints (403, "Sandbox
 * WhatsApp configurations only support messaging endpoints"), observed on
 * 2026-11-17 for contacts, calls, templates, flows, phone numbers and blocked
 * users.
 */
export class SandboxNotSupported
  extends /*@__PURE__*/ Schema.TaggedError<SandboxNotSupported>()("SandboxNotSupported", {
    message: Schema.String,
  }).pipe(Category.withAuthError) {}
applyErrorMatchers(SandboxNotSupported, [
  { status: 403, message: { includes: "Sandbox WhatsApp configurations only support" } },
]);

/** The errors any operation can answer (above); part of every operation's error union. */
export type KapsoCommonError =
  | ReengagementWindowClosed
  | GraphRateLimited
  | MetaGraphError
  | MessageInFlight
  | ThreadNotOwner
  | PaymentRequired
  | SendsPaused
  | SendsPausedRetryable
  | MarketingPreferenceStopped
  | SandboxNotSupported;

/**
 * Kapso webhook signature verification failed: the `X-Webhook-Signature`
 * header is missing, or it does not match the raw request body.
 */
export class KapsoWebhookSignatureError
  extends /*@__PURE__*/ Schema.TaggedError<KapsoWebhookSignatureError>()(
    "KapsoWebhookSignatureError",
    {
      message: Schema.String,
      cause: /*@__PURE__*/ Schema.optional(Schema.Unknown),
    },
  ).pipe(Category.withAuthError) {}

/** The Kapso webhook body is not a JSON object (checked after its signature). */
export class KapsoWebhookPayloadParseError
  extends /*@__PURE__*/ Schema.TaggedError<KapsoWebhookPayloadParseError>()(
    "KapsoWebhookPayloadParseError",
    {
      message: Schema.String,
      cause: /*@__PURE__*/ Schema.optional(Schema.Unknown),
    },
  ).pipe(Category.withParseError) {}
