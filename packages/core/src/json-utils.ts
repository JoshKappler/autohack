/**
 * Robust JSON extraction from Claude output.
 *
 * The naive `output.match(/\{[\s\S]*\}/)` is greedy and matches from the FIRST
 * `{` to the LAST `}` in the entire output. When Claude wraps JSON in markdown
 * fences or includes multiple JSON-like objects in prose, JSON.parse fails on
 * the resulting malformed string.
 *
 * This utility walks the string tracking brace depth to find all top-level
 * JSON objects, then tries parsing each from last to first (Claude tends to
 * put its final structured answer last).
 */

/**
 * Extract and parse a JSON object from mixed Claude output.
 * Returns the first successfully-parsed object containing `requiredKey`,
 * or null if none found.
 */
export function extractJsonWithKey<T = Record<string, unknown>>(
  output: string,
  requiredKey: string,
): T | null {
  // Strip markdown code fences
  const cleaned = output.replace(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g, "$1");

  // Find all top-level JSON objects by tracking brace depth
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        blocks.push(cleaned.slice(start, i + 1));
        start = -1;
      }
    }
  }

  // Try last block first (Claude puts final answer last), then iterate backward
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(blocks[i]);
      if (parsed && typeof parsed === "object" && requiredKey in parsed) {
        return parsed as T;
      }
    } catch {}
  }

  // Fallback: try any block without key requirement
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(blocks[i]) as T;
    } catch {}
  }

  return null;
}
