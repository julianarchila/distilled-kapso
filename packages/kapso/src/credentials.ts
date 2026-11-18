/**
 * Kapso credentials -- hand-written.
 *
 * The `Credentials` service resolves `{ apiKey, apiBaseUrl, mediaBaseUrl }`
 * per request; the protocol layer sends the key as `X-API-Key`. The key is a
 * Kapso project API key (dashboard, Integrations > API keys).
 *
 * Kapso's Meta proxy answers from two roots. Every operation in the spec is
 * under the Graph-versioned `https://api.kapso.ai/meta/whatsapp/v24.0`, but
 * signed media downloads (`download_url` from getMediaUrl) live at
 * `https://api.kapso.ai/meta/whatsapp/media_download`, with no version: the
 * versioned path answers 404 (observed 2026-11-17). The protocol picks the
 * root per request from the operation's route (see protocol.ts).
 */
import * as EffectConfig from "@distilled.cloud/core/config";
import { ConfigError } from "@distilled.cloud/core/errors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";

/** The spec's `servers` entry: Kapso's Meta proxy at Graph API v24.0. */
export const DEFAULT_API_BASE_URL = "https://api.kapso.ai/meta/whatsapp/v24.0";

/** Where `download_url` points: the proxy root, without a Graph version. */
export const DEFAULT_MEDIA_BASE_URL = "https://api.kapso.ai/meta/whatsapp";

/**
 * The media root of an API base URL: the same URL without its trailing Graph
 * version (`.../meta/whatsapp/v24.0` → `.../meta/whatsapp`), so a caller who
 * points the API elsewhere sends media downloads (and the key) there too.
 */
export const mediaBaseUrlFor = (apiBaseUrl: string): string =>
  apiBaseUrl.replace(/\/v\d+(\.\d+)?\/?$/, "");

export interface Config {
  readonly apiKey: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
  readonly mediaBaseUrl: string;
}

export class Credentials
  extends /*@__PURE__*/ Context.Service<Credentials, Effect.Effect<Config, ConfigError>>()(
    "KapsoCredentials",
  ) {}

const envConfig = /*@__PURE__*/ EffectConfig.all({
  apiKey: /*@__PURE__*/ EffectConfig.Redacted("KAPSO_API_KEY"),
  apiBaseUrl: /*@__PURE__*/ EffectConfig.String("KAPSO_API_BASE_URL").pipe(
    /*@__PURE__*/ EffectConfig.withDefault(DEFAULT_API_BASE_URL),
  ),
  mediaBaseUrl: /*@__PURE__*/ EffectConfig.String("KAPSO_MEDIA_BASE_URL").pipe(
    /*@__PURE__*/ EffectConfig.withDefault(""),
  ),
});

/**
 * Reads KAPSO_API_KEY (required), KAPSO_API_BASE_URL and KAPSO_MEDIA_BASE_URL
 * (default: KAPSO_API_BASE_URL without its Graph version).
 */
export const CredentialsFromEnv: Layer.Layer<Credentials> = /*@__PURE__*/ Layer.succeed(
  Credentials,
  /*@__PURE__*/ envConfig.pipe(
    /*@__PURE__*/ Effect.mapError(
      () => new ConfigError({ message: "KAPSO_API_KEY environment variable is required" }),
    ),
    /*@__PURE__*/ Effect.map(({ apiKey, apiBaseUrl, mediaBaseUrl }) => ({
      apiKey,
      apiBaseUrl,
      mediaBaseUrl: mediaBaseUrl === "" ? mediaBaseUrlFor(apiBaseUrl) : mediaBaseUrl,
    })),
  ),
);

/** Layer from a redacted API key + optional base URLs (the media root follows `apiBaseUrl`). */
export const fromApiKey = (config: {
  readonly apiKey: Redacted.Redacted<string>;
  readonly apiBaseUrl?: string;
  readonly mediaBaseUrl?: string;
}): Layer.Layer<Credentials> =>
  Layer.succeed(
    Credentials,
    Effect.succeed({
      apiKey: config.apiKey,
      apiBaseUrl: config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
      mediaBaseUrl:
        config.mediaBaseUrl ?? mediaBaseUrlFor(config.apiBaseUrl ?? DEFAULT_API_BASE_URL),
    }),
  );
