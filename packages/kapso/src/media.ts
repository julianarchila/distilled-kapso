/**
 * Kapso media helpers -- hand-written.
 *
 * getMediaUrl answers with `download_url`, a Kapso URL whose `token` query
 * parameter alone authorizes the download for a few minutes (observed
 * 2026-11-17: 200 with no API key). downloadMedia takes that token;
 * {@link downloadFromUrl} reads it out of the URL so callers never handle it.
 */
import { InvalidInput } from "@distilled.cloud/core/errors";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { downloadMedia } from "./services/whatsapp.ts";

/**
 * Download the file behind a `download_url` from getMediaUrl. Fails with
 * `InvalidInput` when the URL has no `token`.
 */
export const downloadFromUrl = (downloadUrl: string | Redacted.Redacted<string>) =>
  Effect.suspend(() => {
    const raw = Redacted.isRedacted(downloadUrl) ? Redacted.value(downloadUrl) : downloadUrl;
    const token = URL.canParse(raw) ? new URL(raw).searchParams.get("token") : null;
    return token === null || token === ""
      ? Effect.fail(
          new InvalidInput({ member: "download_url", message: "download_url has no token" }),
        )
      : downloadMedia({ token: Redacted.make(token) });
  });
