/**
 * Kapso pagination -- hand-written.
 *
 * listMessages and listConversations page by cursor: `after` in,
 * `paging.next` out, null on the last page (patches/004-pagination.json).
 * Core's paginateCursor reads exactly that, so it is re-exported as is.
 */
export { paginateCursor } from "@distilled.cloud/core/pagination";
