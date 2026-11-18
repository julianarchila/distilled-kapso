#!/usr/bin/env node
/**
 * Runs stacks/distilled-submodules/spec-repos/kapso/fetch-specs.ts the way a spec mirror runs it: from a
 * `.meta/` directory beside `specs/`, so the spec lands at
 * packages/kapso/specs/spec-mirror-kapso/specs/, the path a submodule would
 * hold upstream.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const meta = path.join(root, "packages/kapso/specs/spec-mirror-kapso/.meta");
mkdirSync(meta, { recursive: true });
execFileSync(
  process.execPath,
  [path.join(root, "stacks/distilled-submodules/spec-repos/kapso/fetch-specs.ts")],
  {
    cwd: meta,
    stdio: "inherit",
  },
);
