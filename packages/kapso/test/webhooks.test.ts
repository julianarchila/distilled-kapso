import { createHmac } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { describe, expect, test } from "vitest";
import { constructEvent, eventsOf, isMetaPayload, verifySignature } from "../src/webhooks.ts";

// Bodies are the examples in Kapso's event reference
// (https://docs.kapso.ai/docs/platform/webhooks/message-events.md); the
// signature is computed the way its security page describes: hex
// HMAC-SHA256 of the raw body, keyed by the webhook's secret_key.

const SECRET = "whsec_test";
const sign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(body).digest("hex");

const received = JSON.stringify({
  message: {
    id: "wamid.123",
    timestamp: "1730092800",
    type: "text",
    from: "16315551181",
    text: { body: "Hello" },
    kapso: {
      direction: "inbound",
      status: "received",
      processing_status: "pending",
      origin: "cloud_api",
      has_media: false,
      content: "Hello",
    },
  },
  conversation: { id: "conv_123", phone_number_id: "123456789012345" },
  is_new_conversation: true,
  phone_number_id: "123456789012345",
});

const batch = JSON.stringify({
  type: "whatsapp.message.received",
  batch: true,
  data: [
    { message: { id: "wamid.111", type: "text", text: { body: "First in batch" } } },
    { message: { id: "wamid.112", type: "text", text: { body: "Second in batch" } } },
  ],
  batch_info: { size: 2 },
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect));

describe("verifySignature", () => {
  test("accepts the hex HMAC of the raw body, as string or bytes, with a Redacted secret", async () => {
    for (const payload of [received, new TextEncoder().encode(received)]) {
      const res = await run(
        verifySignature({ payload, signature: sign(received), secret: Redacted.make(SECRET) }),
      );
      expect(res._tag).toBe("Success");
    }
  });

  test("rejects a missing header, a tampered body and a wrong secret", async () => {
    const cases = [
      { payload: received, signature: undefined },
      { payload: received.replace("Hello", "Hullo"), signature: sign(received) },
      { payload: received, signature: sign(received, "other") },
    ];
    for (const { payload, signature } of cases) {
      const res: any = await run(verifySignature({ payload, signature, secret: SECRET }));
      expect(res._tag).toBe("Failure");
      expect(res.failure._tag).toBe("KapsoWebhookSignatureError");
    }
  });
});

describe("constructEvent / eventsOf", () => {
  test("an unbuffered delivery is one event named by X-Webhook-Event", async () => {
    const res: any = await run(
      constructEvent({ payload: received, signature: sign(received), secret: SECRET }),
    );
    expect(res._tag).toBe("Success");
    const events = eventsOf(res.success, "whatsapp.message.received");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "whatsapp.message.received",
      payload: { message: { id: "wamid.123", kapso: { direction: "inbound" } } },
    });
  });

  test("a batch envelope flattens to its items under the envelope's type", async () => {
    const res: any = await run(
      constructEvent({ payload: batch, signature: sign(batch), secret: SECRET }),
    );
    const events = eventsOf(res.success, "whatsapp.message.received");
    expect(events.map((e) => (e.payload as any).message.id)).toEqual(["wamid.111", "wamid.112"]);
    expect(events.every((e) => e.type === "whatsapp.message.received")).toBe(true);
  });

  test("a signed body that is not a JSON object is a KapsoWebhookPayloadParseError", async () => {
    for (const payload of ["not json", "[1,2]"]) {
      const res: any = await run(
        constructEvent({ payload, signature: sign(payload), secret: SECRET }),
      );
      expect(res.failure._tag).toBe("KapsoWebhookPayloadParseError");
    }
  });
});

describe("captured deliveries", () => {
  // Trimmed and sanitized from deliveries captured live on 2026-11-17.
  const imageReceived = JSON.stringify({
    message: {
      id: "wamid.IMAGE",
      from: "15551234567",
      type: "image",
      image: {
        id: "2257046005695222",
        url: "https://lookaside.fbsbx.com/<redacted>",
        link: "https://app.kapso.ai/<redacted>",
        sha256: "2yt83AognDON/9PvDuZ9xnUQkmU9PCwcT++Ga6ui7lU=",
        caption: "<redacted text>",
        mime_type: "image/jpeg",
      },
      kapso: {
        origin: "cloud_api",
        status: "delivered",
        direction: "inbound",
        has_media: true,
        media_url: "https://app.kapso.ai/<redacted>",
        media_data: {
          filename: "image_355402af5b77.jpeg",
          byte_size: 86122,
          content_type: "image/jpeg",
        },
        processing_status: "pending",
      },
      context: null,
      username: null,
      timestamp: "1794882612",
      from_user_id: "CO.<bsuid>",
      from_parent_user_id: null,
    },
    conversation: { id: "00000000-0000-4000-8000-000000000000", username: null, status: "active" },
    phone_number_id: "597907523413541",
    is_new_conversation: false,
  });

  const imageFailed = JSON.stringify({
    message: {
      id: "wamid.SENT",
      to: "15551234567",
      type: "image",
      image: { id: "1152502524144202", caption: "<redacted text>" },
      kapso: {
        status: "failed",
        direction: "outbound",
        statuses: [
          {
            id: "wamid.SENT",
            status: "failed",
            timestamp: "1794882717",
            recipient_id: "15551234567",
            errors: [
              {
                code: 131053,
                title: "Media upload error",
                message: "Media upload error",
                error_data: { details: "Image is invalid." },
              },
            ],
          },
        ],
        processing_status: "processed",
      },
      context: null,
      username: null,
    },
    phone_number_id: "597907523413541",
  });

  test("an inbound image carries Meta's media id and nulls for absent identity fields", async () => {
    const res: any = await run(
      constructEvent({ payload: imageReceived, signature: sign(imageReceived), secret: SECRET }),
    );
    const [event] = eventsOf(res.success, "whatsapp.message.received");
    const message = (event!.payload as any).message;
    expect(message.image.id).toBe("2257046005695222");
    expect(message.context).toBeNull();
    expect(message.kapso.media_data.byte_size).toBe(86122);
  });

  test("a send that failed after a 200 reports Meta's error in kapso.statuses", async () => {
    const res: any = await run(
      constructEvent({ payload: imageFailed, signature: sign(imageFailed), secret: SECRET }),
    );
    const [event] = eventsOf(res.success, "whatsapp.message.failed");
    expect((event!.payload as any).message.kapso.statuses[0].errors[0].code).toBe(131053);
  });
});

describe("isMetaPayload", () => {
  // Envelope from Meta's WhatsApp Cloud API webhook reference; not captured
  // live (a sandbox number refuses kind: "meta" webhooks).
  const meta = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "102290129340398",
        changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [] } }],
      },
    ],
  });

  test("tells a forwarded Meta payload from a Kapso event", async () => {
    const forwarded: any = await run(
      constructEvent({ payload: meta, signature: sign(meta), secret: SECRET }),
    );
    expect(isMetaPayload(forwarded.success)).toBe(true);
    const kapso: any = await run(
      constructEvent({ payload: received, signature: sign(received), secret: SECRET }),
    );
    expect(isMetaPayload(kapso.success)).toBe(false);
  });
});
