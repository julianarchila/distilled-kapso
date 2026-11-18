import * as ResponseValidation from "@distilled.cloud/core/response-validation";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { describe, expect, test } from "vitest";
import { fromApiKey } from "../src/credentials.ts";
import { downloadFromUrl } from "../src/media.ts";
import type { KapsoOpContext } from "../src/protocol.ts";
import * as Retry from "../src/retry.ts";
import {
  downloadMedia,
  getMediaUrl,
  listMessages,
  markMessageAsRead,
  sendMessage,
  uploadMedia,
} from "../src/services/whatsapp.ts";

// Unless a test says otherwise, response bodies are from live calls against
// Kapso's sandbox (2026-11-17), with message ids, tokens and phone numbers
// replaced.

const API_KEY = "kapso_test_key";
const PHONE_NUMBER_ID = "597907523413541";

interface Recorded {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: HttpClientRequest.HttpClientRequest["body"];
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });

const run = <A, E>(
  operation: Effect.Effect<A, E, KapsoOpContext>,
  respond: (request: Recorded, attempt: number) => Response,
  { retry = false, strict = true }: { retry?: boolean; strict?: boolean } = {},
) => {
  const requests: Recorded[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const recorded: Recorded = {
        method: request.method,
        url: new URL(request.url),
        headers: { ...request.headers },
        body: request.body,
      };
      requests.push(recorded);
      return HttpClientResponse.fromWeb(request, respond(recorded, requests.length));
    }),
  );
  const layers = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    fromApiKey({ apiKey: Redacted.make(API_KEY) }),
  );
  const call = retry ? operation : operation.pipe(Retry.none);
  const result = Effect.runPromise(
    Effect.result(
      (strict ? call.pipe(Effect.provide(ResponseValidation.strict)) : call).pipe(
        Effect.provide(layers),
      ),
    ),
  );
  return { result, requests };
};

const failure = async (result: Promise<any>) => {
  const res = await result;
  expect(res._tag).toBe("Failure");
  return res.failure;
};

const bodyJson = (request: Recorded): unknown => {
  const body = request.body as { body?: Uint8Array };
  return JSON.parse(new TextDecoder().decode(body.body));
};

const text = {
  phone_number_id: PHONE_NUMBER_ID,
  body: {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "15551234567",
    type: "text",
    text: { body: "Prueba SDK Kapso (1/3): texto" },
  },
} as const;

const sent = {
  messaging_product: "whatsapp",
  contacts: [{ input: "15551234567", wa_id: "15551234567" }],
  messages: [{ id: "wamid.HBgMTU1NTEyMzQ1NjcVAgARGBI=" }],
};

describe("requests", () => {
  test("sendMessage sends X-API-Key and the message as the JSON body", async () => {
    const { result, requests } = run(sendMessage(text), () => json(sent));
    expect(await result).toMatchObject({ _tag: "Success", success: sent });
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url.toString()).toBe(
      `https://api.kapso.ai/meta/whatsapp/v24.0/${PHONE_NUMBER_ID}/messages`,
    );
    expect(request.headers["x-api-key"]).toBe(API_KEY);
    expect(bodyJson(request)).toEqual(text.body);
  });

  test("markMessageAsRead returns { success } (not SendMessageResponse)", async () => {
    const { result, requests } = run(
      markMessageAsRead({
        phone_number_id: PHONE_NUMBER_ID,
        body: {
          messaging_product: "whatsapp",
          status: "read",
          message_id: "wamid.IN",
          typing_indicator: { type: "text" },
        },
      }),
      () => json({ success: true }),
    );
    expect(await result).toMatchObject({ _tag: "Success", success: { success: true } });
    expect(requests[0]!.url.pathname).toBe(`/meta/whatsapp/v24.0/${PHONE_NUMBER_ID}/messages`);
    expect(bodyJson(requests[0]!)).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.IN",
      typing_indicator: { type: "text" },
    });
  });

  test("uploadMedia sends multipart form data", async () => {
    const { result, requests } = run(
      uploadMedia({
        phone_number_id: PHONE_NUMBER_ID,
        messaging_product: "whatsapp",
        file: new Uint8Array([137, 80, 78, 71]),
      }),
      () => json({ id: "29646588868292636" }),
    );
    expect(await result).toMatchObject({ _tag: "Success", success: { id: "29646588868292636" } });
    expect((requests[0]!.body as { _tag: string })._tag).toBe("FormData");
  });

  test("getMediaUrl: file_size is a number and download_url is Redacted", async () => {
    const { result } = run(
      getMediaUrl({ media_id: "29646588868292636", phone_number_id: PHONE_NUMBER_ID }),
      () =>
        json({
          id: "29646588868292636",
          messaging_product: "whatsapp",
          url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1",
          mime_type: "image/png",
          sha256: "d0afbaf740ad2d35e78e6238ae16b5b17bdfd8d2b26351fc66bc2dfdf8e59f9f",
          file_size: 67,
          download_url: "https://api.kapso.ai/meta/whatsapp/media_download?token=signed",
          download_url_expires_at: "2026-11-17T01:44:00Z",
        }),
    );
    const res: any = await result;
    expect(res._tag).toBe("Success");
    expect(res.success.file_size).toBe(67);
    expect(Redacted.isRedacted(res.success.download_url)).toBe(true);
  });

  test("downloadMedia goes to the unversioned media root and returns the bytes", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const { result, requests } = run(
      downloadMedia({ token: Redacted.make("signed") }),
      () => new Response(png, { status: 200, headers: { "Content-Type": "image/png" } }),
    );
    const res: any = await result;
    expect(res._tag).toBe("Success");
    expect(Array.from(res.success as Uint8Array)).toEqual(Array.from(png));
    expect(requests[0]!.url.toString()).toBe(
      "https://api.kapso.ai/meta/whatsapp/media_download?token=signed",
    );
  });

  test("listMessages pages follow paging.next until it is null", async () => {
    const page = (after: string | null, ids: string[]) =>
      json({
        data: ids.map((id) => ({ id, timestamp: "1794880309", type: "text" })),
        paging: { cursors: { before: "b", after: after ?? "last" }, next: after, previous: null },
      });
    const { result, requests } = run(
      listMessages.pages({ phone_number_id: PHONE_NUMBER_ID, limit: 2 }).pipe(Stream.runCollect),
      (request) =>
        request.url.searchParams.get("after") === "c1"
          ? page(null, ["m3"])
          : page("c1", ["m1", "m2"]),
      { strict: false },
    );
    const res: any = await result;
    expect(res._tag).toBe("Success");
    expect(Array.from(res.success)).toHaveLength(2);
    expect(requests.map((r) => r.url.searchParams.get("after"))).toEqual([null, "c1"]);
  });
});

describe("errors", () => {
  test("a missing template (Graph 132001, sent as 404) is a MetaGraphError with category template", async () => {
    const e = await failure(
      run(sendMessage(text), () =>
        json(
          {
            error: {
              message: "(#132001) Template name does not exist in the translation",
              code: 132001,
              type: "OAuthException",
              error_data: {
                messaging_product: "whatsapp",
                details: "template name (no_existe_sdk_test) does not exist in es",
              },
              fbtrace_id: "ABYlNmugC17FovMeqiG0qfo",
            },
          },
          404,
        ),
      ).result,
    );
    expect(e).toMatchObject({
      _tag: "MetaGraphError",
      status: 404,
      code: 132001,
      category: "template",
      details: "template name (no_existe_sdk_test) does not exist in es",
      fbtraceId: "ABYlNmugC17FovMeqiG0qfo",
    });
  });

  test("Kapso's own 400 validation (no code) is a BadRequest", async () => {
    const e = await failure(
      run(sendMessage(text), () =>
        json({ error: 'invalid text payload: expected { text: { body: "..." } }' }, 400),
      ).result,
    );
    expect(e._tag).toBe("BadRequest");
    expect(e.message).toBe('invalid text payload: expected { text: { body: "..." } }');
  });

  test("an unknown message id on mark-read (Graph 131009) is a MetaGraphError with category parameter", async () => {
    const e = await failure(
      run(
        markMessageAsRead({
          phone_number_id: PHONE_NUMBER_ID,
          body: { messaging_product: "whatsapp", status: "read", message_id: "wamid.NOEXISTE" },
        }),
        () =>
          json(
            {
              error: {
                message: "(#131009) Parameter value is not valid",
                code: 131009,
                type: "OAuthException",
                error_data: {
                  messaging_product: "whatsapp",
                  details: "Input parameter is invalid",
                },
                fbtrace_id: "ADtuSp1Gpci9PZlQj7PvZEd",
              },
            },
            400,
          ),
      ).result,
    );
    expect(e).toMatchObject({ _tag: "MetaGraphError", code: 131009, category: "parameter" });
  });

  test("a sandbox number on a non-messaging endpoint is SandboxNotSupported", async () => {
    const e = await failure(
      run(getMediaUrl({ media_id: "1", phone_number_id: PHONE_NUMBER_ID }), () =>
        json({ error: "Sandbox WhatsApp configurations only support messaging endpoints" }, 403),
      ).result,
    );
    expect(e._tag).toBe("SandboxNotSupported");
  });

  // The cases below are not reproducible on demand; bodies are the examples
  // in Kapso's spec.

  test("a send outside the 24-hour window is ReengagementWindowClosed (live: Kapso's 422)", async () => {
    // Live, 2026-11-17: Kapso refuses before calling Meta, with its own envelope.
    const e = await failure(
      run(sendMessage(text), () =>
        json(
          {
            error: "Cannot send non-template messages outside the 24-hour window.",
            next_steps: "Send a WhatsApp template message to reopen the session.",
          },
          422,
        ),
      ).result,
    );
    expect(e._tag).toBe("ReengagementWindowClosed");
    expect(e.message).toBe("Cannot send non-template messages outside the 24-hour window.");
    expect(e.body.next_steps).toBe("Send a WhatsApp template message to reopen the session.");
  });

  test("Meta's own 131047 is ReengagementWindowClosed too (body from Kapso's spec)", async () => {
    const e = await failure(
      run(sendMessage(text), () =>
        json(
          {
            error: {
              message: "Cannot send non-template messages outside the 24-hour window.",
              type: "MessageError",
              code: 131047,
              error_subcode: 131047,
              fbtrace_id: "AXk7s_8dR4eVHp9Kq2MmNlO",
            },
          },
          400,
        ),
      ).result,
    );
    expect(e._tag).toBe("ReengagementWindowClosed");
  });

  test("409 in-flight is MessageInFlight and is retried", async () => {
    const { result, requests } = run(
      sendMessage(text),
      (_request, attempt) =>
        attempt === 1
          ? json(
              {
                error:
                  "Another message is already in-flight for this conversation. Please retry shortly.",
              },
              409,
            )
          : json(sent),
      { retry: true },
    );
    expect((await result)._tag).toBe("Success");
    expect(requests).toHaveLength(2);
  });

  test("409 thread_not_owner is ThreadNotOwner", async () => {
    const e = await failure(
      run(sendMessage(text), () =>
        json(
          {
            error:
              "Another app controls this conversation. Automated Service messages are blocked; templates are still allowed.",
            code: "thread_not_owner",
            thread_error: "thread_not_owner",
          },
          409,
        ),
      ).result,
    );
    expect(e._tag).toBe("ThreadNotOwner");
  });

  test("423 with Retry-After is SendsPausedRetryable", async () => {
    const e = await failure(
      run(sendMessage(text), () =>
        json(
          {
            error: "A security review of this account is in progress.",
            code: "project_under_review",
          },
          423,
          { "Retry-After": "120" },
        ),
      ).result,
    );
    expect(e._tag).toBe("SendsPausedRetryable");
    expect(Duration.toSeconds(e.retryAfter)).toBe(120);
  });

  test("423 without Retry-After is SendsPaused and is not retried", async () => {
    const { result, requests } = run(
      sendMessage(text),
      () =>
        json(
          {
            error: "A security review of this account is in progress.",
            code: "project_under_review",
          },
          423,
        ),
      { retry: true },
    );
    expect((await failure(result))._tag).toBe("SendsPaused");
    expect(requests).toHaveLength(1);
  });

  test("402 is PaymentRequired", async () => {
    const e = await failure(
      run(sendMessage(text), () =>
        json(
          {
            error: "Your Kapso balance doesn't cover Meta's fee for this message.",
            code: "insufficient_credits",
          },
          402,
        ),
      ).result,
    );
    expect(e._tag).toBe("PaymentRequired");
  });
});

describe("Media.downloadFromUrl", () => {
  test("reads the token out of download_url and downloads from the media root", async () => {
    const { result, requests } = run(
      downloadFromUrl(
        Redacted.make("https://api.kapso.ai/meta/whatsapp/media_download?token=signed"),
      ),
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "audio/ogg" },
        }),
    );
    const res: any = await result;
    expect(Array.from(res.success as Uint8Array)).toEqual([1, 2, 3]);
    expect(requests[0]!.url.toString()).toBe(
      "https://api.kapso.ai/meta/whatsapp/media_download?token=signed",
    );
  });

  test("a URL without a token is InvalidInput, with no request", async () => {
    const { result, requests } = run(downloadFromUrl("https://example.com/file"), () => json({}));
    expect((await failure(result))._tag).toBe("InvalidInput");
    expect(requests).toHaveLength(0);
  });
});

describe("review regressions", () => {
  test("a 423 with Retry-After but another code is not SendsPausedRetryable", async () => {
    const e = await failure(
      run(sendMessage(text), () =>
        json({ error: "Locked for another reason", code: "something_else" }, 423, {
          "Retry-After": "5",
        }),
      ).result,
    );
    expect(e._tag).toBe("Locked");
  });

  test("the media root follows a custom apiBaseUrl", async () => {
    const requests: string[] = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url);
        return HttpClientResponse.fromWeb(request, new Response(new Uint8Array([1])));
      }),
    );
    await Effect.runPromise(
      downloadMedia({ token: "t" }).pipe(
        Retry.none,
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, client),
            fromApiKey({
              apiKey: Redacted.make(API_KEY),
              apiBaseUrl: "https://staging.example/meta/whatsapp/v25.0",
            }),
          ),
        ),
      ),
    );
    expect(requests).toEqual(["https://staging.example/meta/whatsapp/media_download?token=t"]);
  });
});
