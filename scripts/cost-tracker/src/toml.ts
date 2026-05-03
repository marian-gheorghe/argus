/**
 * Minimal TOML parser sufficient for our needs:
 *   - top-level `[section]` headers (no dotted-name nesting)
 *   - `key = value` lines where value is a string (single- or double-quoted),
 *     a number (int or float), or a boolean
 *   - `# comment` lines and trailing comments
 *
 * This is intentionally small — pricing.toml + policy.toml are both flat
 * `[section] key = value` files we control. We avoid adding a TOML dep just
 * for this. If the format ever needs arrays or inline tables, swap this out.
 *
 * Returns a `Record<string, Record<string, scalar>>` where the top-level keys
 * are section names. Keys outside any section are placed in the (rarely
 * needed) empty-string key section.
 */
export type TomlScalar = string | number | boolean;
export type TomlSection = Record<string, TomlScalar>;
export type TomlDocument = Record<string, TomlSection>;

export function parseToml(input: string): TomlDocument {
  const out: TomlDocument = {};
  // Lines outside any section live under "" — callers usually ignore this.
  let currentSection = "";
  out[currentSection] = {};

  const lines = input.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const stripped = stripComment(rawLine).trim();
    if (stripped.length === 0) continue;

    // Section header: [name]
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      const name = stripped.slice(1, -1).trim();
      if (name.length === 0) {
        throw new Error(`TOML parse error on line ${i + 1}: empty section header`);
      }
      currentSection = name;
      if (!out[currentSection]) {
        out[currentSection] = {};
      }
      continue;
    }

    // key = value
    const eq = stripped.indexOf("=");
    if (eq === -1) {
      throw new Error(
        `TOML parse error on line ${i + 1}: expected "key = value", got: ${stripped}`,
      );
    }
    const key = stripped.slice(0, eq).trim();
    const valueText = stripped.slice(eq + 1).trim();
    if (key.length === 0) {
      throw new Error(`TOML parse error on line ${i + 1}: empty key`);
    }
    const value = parseScalar(valueText, i + 1);
    const section = out[currentSection];
    // currentSection is always present in `out` (initialised on header switch).
    if (!section) {
      throw new Error(`TOML parse error on line ${i + 1}: section state corrupted`);
    }
    section[key] = value;
  }

  return out;
}

function stripComment(line: string): string {
  // A '#' inside a quoted string isn't a comment. We scan char-by-char.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === "#" && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(text: string, lineNo: number): TomlScalar {
  if (text === "true") return true;
  if (text === "false") return false;

  // Quoted strings.
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }

  // Numbers — TOML allows integers and floats; we accept JS-parseable forms.
  // Reject NaN/Infinity (Number() coerces "" to 0 — guard for that too).
  if (text.length === 0) {
    throw new Error(`TOML parse error on line ${lineNo}: empty value`);
  }
  const n = Number(text);
  if (!Number.isFinite(n)) {
    throw new Error(`TOML parse error on line ${lineNo}: cannot parse value: ${text}`);
  }
  return n;
}
