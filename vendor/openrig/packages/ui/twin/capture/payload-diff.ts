// OPR.0.4.1.11.2 (FR-4) — data-medium capture: a deterministic payload before/after artifact.
// For non-visual / data-shape slices, the highest-bandwidth intent+proof artifact is the data
// itself: canonical before + canonical after + the set of changed paths. Pure + deterministic
// (keys sorted, change paths sorted) so the artifact is reproducible and reviewable side by side,
// the data-medium peer of intent.png.

/** Recursively sort object keys so JSON serialization is insertion-order-independent. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortValue(src[key]);
    return out;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable, indented JSON with recursively-sorted keys. Deterministic. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value), null, 2);
}

/**
 * Deep diff of two payloads → sorted leaf-path entries: `added (+)`, `removed (-)`, `changed (~)`.
 * Arrays + scalars are compared as leaves (by canonical JSON); plain objects are recursed.
 */
export function diffPaths(before: unknown, after: unknown, prefix = ""): string[] {
  const results: string[] = [];
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const p = prefix ? `${prefix}.${key}` : key;
      const inB = key in before;
      const inA = key in after;
      if (inB && !inA) results.push(`removed (-): ${p}`);
      else if (!inB && inA) results.push(`added (+): ${p}`);
      else results.push(...diffPaths(before[key], after[key], p));
    }
  } else if (canonicalJson(before) !== canonicalJson(after)) {
    results.push(`changed (~): ${prefix}`);
  }
  return results.sort();
}

/** Assemble the durable data-medium artifact: canonical before/after + the changed-path summary. */
export function buildPayloadDiff(input: { before: unknown; after: unknown }): string {
  const changed = diffPaths(input.before, input.after);
  return [
    "# BEFORE",
    canonicalJson(input.before),
    "",
    "# AFTER",
    canonicalJson(input.after),
    "",
    "# CHANGED",
    changed.length ? changed.join("\n") : "(no changes)",
    "",
  ].join("\n");
}
