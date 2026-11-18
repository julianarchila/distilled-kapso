/**
 * Kapso webhooks -- hand-written.
 *
 * Kapso signs every webhook (Kapso events and forwarded Meta payloads alike)
 * with HMAC-SHA256 over the raw request body, keyed by the webhook's
 * `secret_key`, and sends the lowercase hex digest in `X-Webhook-Signature`
 * with no `sha256=` prefix and no timestamp
 * (https://docs.kapso.ai/docs/platform/webhooks/security.md). Without a
 * timestamp a captured delivery can be replayed, so deduplicate on
 * `X-Idempotency-Key`, which stays the same across retries of one delivery.
 *
 * Kapso event webhooks (`kind: "kapso"`, payload version v2) name the event
 * in `X-Webhook-Event`. A buffered `whatsapp.message.received` delivery
 * arrives as a batch envelope `{ type, batch: true, data: [...], batch_info }`
 * whose items have the unbuffered shape; {@link eventsOf} flattens both.
 *
 * The payload types follow Kapso's event reference
 * (https://docs.kapso.ai/docs/platform/webhooks/message-events.md), checked
 * against 12 deliveries captured live on 2026-11-17 (text, image, audio,
 * video, sticker and reaction received; text sent, delivered and an image
 * that failed). Kapso's OpenAPI specs describe
 * no webhooks, so the types are hand-written and open
 * (`[key: string]: unknown`). Absent identity fields arrive as `null`, not
 * omitted (`username`, `context`, `from_parent_user_id`), and the reference
 * says not to assume `phone_number`, `from`, `to` or `wa_id` are present.
 *
 * A send that `sendMessage` accepted (200) can still fail: the failure
 * arrives only here, as `whatsapp.message.failed` with Meta's error in
 * `message.kapso.statuses[].errors` (131053 for an image WhatsApp rejects).
 *
 * Forwarded Meta payloads (`kind: "meta"`) are signed the same way, so
 * {@link verifySignature} and {@link constructEvent} accept them; they are
 * not typed here. A sandbox number refuses `kind: "meta"` webhooks (422).
 */
import * as CoreCrypto from "@distilled.cloud/core/crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { KapsoWebhookPayloadParseError, KapsoWebhookSignatureError } from "./errors.ts";

export type WebhookPayload = string | Uint8Array | ArrayBuffer;
export type WebhookSecret = string | Redacted.Redacted<string>;

/** Kapso's WhatsApp event names (`X-Webhook-Event`). */
export type WhatsappEventType =
  | "whatsapp.message.received"
  | "whatsapp.message.sent"
  | "whatsapp.message.delivered"
  | "whatsapp.message.read"
  | "whatsapp.message.failed"
  | "whatsapp.conversation.created"
  | "whatsapp.conversation.ended"
  | "whatsapp.conversation.inactive"
  | "whatsapp.contact.identity_changed"
  | "whatsapp.contact.marketing_preference_changed"
  | "whatsapp.thread.ownership_changed"
  | "whatsapp.thread.standby";

/** One entry of `message.kapso.statuses`, Meta's raw status history. */
export interface MessageStatus {
  readonly id?: string;
  /** `sent`, `delivered`, `read` or `failed`. */
  readonly status?: string;
  /** Unix epoch seconds, as a string. */
  readonly timestamp?: string;
  readonly recipient_id?: string;
  readonly recipient_user_id?: string | null;
  readonly pricing?: {
    readonly type?: string;
    readonly billable?: boolean;
    readonly category?: string;
    readonly pricing_model?: string;
    readonly [key: string]: unknown;
  };
  /** Meta's error, on a `failed` status. */
  readonly errors?: ReadonlyArray<{
    readonly code?: number;
    readonly title?: string;
    readonly message?: string;
    readonly error_data?: { readonly details?: string; readonly [key: string]: unknown };
    readonly [key: string]: unknown;
  }>;
  readonly [key: string]: unknown;
}

/** `message.kapso`: Kapso's message-scoped additions. */
export interface MessageKapso {
  readonly direction?: "inbound" | "outbound";
  /** `delivered` on a received message; `sent`, `delivered`, `read` or `failed` on a sent one. */
  readonly status?: string;
  /** `pending` on a received message, `processed` on a sent one. */
  readonly processing_status?: string;
  /** Where the message came from, e.g. `cloud_api`. */
  readonly origin?: string;
  readonly has_media?: boolean;
  /** A text rendering of the message, media and transcript included. */
  readonly content?: string;
  /** Meta's status history; on status events (`sent`, `delivered`, `failed`, ...). */
  readonly statuses?: ReadonlyArray<MessageStatus>;
  /** Audio transcript, when Kapso transcribed one. */
  readonly transcript?: { readonly text?: string; readonly [key: string]: unknown };
  /**
   * Kapso-hosted copy of the media. It downloads with no API key (a redirect
   * to signed storage), so treat it as a secret.
   */
  readonly media_url?: string;
  readonly media_data?: {
    readonly url?: string;
    readonly filename?: string;
    readonly content_type?: string;
    readonly byte_size?: number;
    readonly [key: string]: unknown;
  };
  /** Type-specific data: `caption`, `emoji` and `message_id`, `mime_type`, ... */
  readonly message_type_data?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/**
 * The media object of a media message. `id` is Meta's media id (pass it to
 * getMediaUrl); `url` is Meta's own link, which needs Meta's access token;
 * `link` is Kapso's copy, like `kapso.media_url`.
 */
export interface WebhookMedia {
  readonly id?: string;
  readonly url?: string;
  readonly link?: string;
  readonly caption?: string;
  readonly mime_type?: string;
  readonly sha256?: string;
  readonly filename?: string;
  /** Audio: a voice note rather than an audio file. */
  readonly voice?: boolean;
  /** Sticker: animated. */
  readonly animated?: boolean;
  readonly [key: string]: unknown;
}

/** A WhatsApp message as Kapso delivers it: Meta's fields plus `kapso`. */
export interface WebhookMessage {
  /** The `wamid`. Status events of one message share it; deduplicate on `X-Idempotency-Key`. */
  readonly id: string;
  /** Unix epoch seconds, as a string. */
  readonly timestamp?: string;
  /** `text`, `image`, `audio`, `video`, `document`, `sticker`, `reaction`, ... */
  readonly type?: string;
  /** Sender, on a received message. */
  readonly from?: string;
  readonly from_user_id?: string | null;
  readonly from_parent_user_id?: string | null;
  /** Recipient, on a sent message. */
  readonly to?: string;
  readonly to_user_id?: string | null;
  readonly to_parent_user_id?: string | null;
  readonly username?: string | null;
  /** The message replied to, or `null`. */
  readonly context?: Readonly<Record<string, unknown>> | null;
  readonly text?: { readonly body?: string; readonly [key: string]: unknown };
  readonly image?: WebhookMedia;
  readonly video?: WebhookMedia;
  readonly audio?: WebhookMedia;
  readonly document?: WebhookMedia;
  readonly sticker?: WebhookMedia;
  readonly reaction?: {
    /** The message reacted to. */
    readonly message_id?: string;
    readonly emoji?: string;
    readonly [key: string]: unknown;
  };
  readonly kapso?: MessageKapso;
  readonly [key: string]: unknown;
}

export interface WebhookConversation {
  readonly id: string;
  readonly contact_name?: string | null;
  readonly phone_number?: string;
  readonly business_scoped_user_id?: string | null;
  readonly parent_business_scoped_user_id?: string | null;
  readonly username?: string | null;
  /** `active`, `ended`, ... */
  readonly status?: string;
  readonly last_active_at?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly phone_number_id?: string;
  /** Summary metrics only (counts, last message): never `contact_name`. */
  readonly kapso?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/** Body of the `whatsapp.message.*` events. */
export interface MessageEvent {
  readonly message: WebhookMessage;
  readonly conversation?: WebhookConversation;
  readonly is_new_conversation?: boolean;
  readonly phone_number_id?: string;
  readonly [key: string]: unknown;
}

/** Body of the `whatsapp.conversation.*` events. */
export interface ConversationEvent {
  readonly conversation: WebhookConversation;
  readonly phone_number_id?: string;
  readonly [key: string]: unknown;
}

/** A buffered delivery: several `whatsapp.message.received` bodies at once. */
export interface BatchEnvelope {
  readonly type: string;
  readonly batch: true;
  readonly data: ReadonlyArray<MessageEvent>;
  readonly batch_info?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/**
 * A forwarded Meta payload (`kind: "meta"` webhooks): the WhatsApp Cloud API
 * webhook body, `entry[].changes[].value` holding `messages` or `statuses`.
 * Only the envelope is typed, after Meta's webhook reference; no delivery has
 * been captured, because a sandbox number refuses Meta-format webhooks.
 */
export interface MetaWebhookBody {
  readonly object: "whatsapp_business_account";
  readonly entry: ReadonlyArray<{
    /** WhatsApp Business Account id. */
    readonly id?: string;
    readonly changes?: ReadonlyArray<{
      /** `messages` for messages and statuses. */
      readonly field?: string;
      readonly value?: Readonly<Record<string, unknown>>;
      readonly [key: string]: unknown;
    }>;
    readonly [key: string]: unknown;
  }>;
  readonly [key: string]: unknown;
}

/** Any webhook body Kapso sends, as received. */
export type WebhookBody =
  | MessageEvent
  | ConversationEvent
  | BatchEnvelope
  | MetaWebhookBody
  | Readonly<Record<string, unknown>>;

type MessageEventType = Extract<WhatsappEventType, `whatsapp.message.${string}`>;
type ConversationEventType = Extract<WhatsappEventType, `whatsapp.conversation.${string}`>;

/**
 * One event of a delivery: the event name and its body. Comparing `type`
 * narrows `payload`. `type` is the `X-Webhook-Event` value as received, so an
 * event Kapso adds later arrives under a name this union does not list.
 */
export type KapsoWebhookEvent =
  | { readonly type: MessageEventType; readonly payload: MessageEvent }
  | { readonly type: ConversationEventType; readonly payload: ConversationEvent }
  | {
      readonly type: Exclude<WhatsappEventType, MessageEventType | ConversationEventType>;
      readonly payload: Readonly<Record<string, unknown>>;
    };

export interface VerifySignatureOptions {
  /** Raw request body exactly as Kapso sent it. Do not pass parsed or reserialized JSON. */
  readonly payload: WebhookPayload;
  /** The `X-Webhook-Signature` header. */
  readonly signature: string | null | undefined;
  /** The webhook's `secret_key`. */
  readonly secret: WebhookSecret;
}

const textDecoder = /*@__PURE__*/ new TextDecoder("utf-8", { fatal: true });

const payloadToBytes = (payload: WebhookPayload): Uint8Array | string =>
  payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload;

const payloadToString = (payload: WebhookPayload): string =>
  typeof payload === "string"
    ? payload
    : textDecoder.decode(payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload);

/** Compares two hex strings without returning early on the first difference. */
const constantTimeEqual = (expected: string, candidate: string): boolean => {
  let difference = expected.length ^ candidate.length;
  const length = Math.max(expected.length, candidate.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (expected.charCodeAt(index) || 0) ^ (candidate.charCodeAt(index) || 0);
  }
  return difference === 0;
};

/**
 * Check `X-Webhook-Signature` against the raw body. Fails with
 * {@link KapsoWebhookSignatureError} when the header is missing or does not match.
 */
export const verifySignature = ({
  payload,
  signature,
  secret,
}: VerifySignatureOptions): Effect.Effect<void, KapsoWebhookSignatureError> =>
  Effect.gen(function* () {
    if (signature == null || signature.trim() === "") {
      return yield* new KapsoWebhookSignatureError({
        message: "X-Webhook-Signature header is required",
      });
    }
    const crypto = yield* CoreCrypto.Crypto;
    const key = Redacted.isRedacted(secret) ? Redacted.value(secret) : secret;
    const expected = yield* crypto.importHmacKey(key).pipe(
      Effect.flatMap((hmacKey) => crypto.hmacSha256(hmacKey, payloadToBytes(payload))),
      Effect.map(CoreCrypto.hex),
      Effect.mapError(
        (cause) =>
          new KapsoWebhookSignatureError({
            message: "Unable to compute the Kapso webhook signature",
            cause,
          }),
      ),
    );
    if (!constantTimeEqual(expected, signature.trim().toLowerCase())) {
      return yield* new KapsoWebhookSignatureError({
        message: "X-Webhook-Signature does not match the request body",
      });
    }
  });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Verify the signature, then parse the body. Fails with
 * {@link KapsoWebhookSignatureError} or {@link KapsoWebhookPayloadParseError}.
 */
export const constructEvent = (
  options: VerifySignatureOptions,
): Effect.Effect<WebhookBody, KapsoWebhookSignatureError | KapsoWebhookPayloadParseError> =>
  verifySignature(options).pipe(
    Effect.flatMap(() =>
      Effect.try({
        try: () => JSON.parse(payloadToString(options.payload)) as unknown,
        catch: (cause) =>
          new KapsoWebhookPayloadParseError({
            message: "Unable to parse the Kapso webhook body as JSON",
            cause,
          }),
      }),
    ),
    Effect.flatMap((parsed) =>
      isRecord(parsed)
        ? Effect.succeed(parsed as WebhookBody)
        : Effect.fail(
            new KapsoWebhookPayloadParseError({
              message: "The Kapso webhook body is not a JSON object",
            }),
          ),
    ),
  );

/** Whether a body is a forwarded Meta payload (a `kind: "meta"` webhook). */
export const isMetaPayload = (body: WebhookBody): body is MetaWebhookBody =>
  (body as { object?: unknown }).object === "whatsapp_business_account" &&
  Array.isArray((body as { entry?: unknown }).entry);

/** Whether a body is a buffered batch envelope. */
export const isBatch = (body: WebhookBody): body is BatchEnvelope =>
  (body as { batch?: unknown }).batch === true && Array.isArray((body as { data?: unknown }).data);

/**
 * The events of one delivery, in order: a batch envelope's items under its
 * `type`, or the single body under `eventType` (the `X-Webhook-Event` header).
 */
export const eventsOf = (
  body: WebhookBody,
  eventType: string | null | undefined,
): ReadonlyArray<KapsoWebhookEvent> =>
  (isBatch(body)
    ? body.data.map((payload) => ({ type: body.type, payload }))
    : [{ type: eventType ?? "", payload: body }]) as ReadonlyArray<KapsoWebhookEvent>;
