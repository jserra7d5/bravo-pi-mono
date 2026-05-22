import { SubagentError } from "./errors.js";

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "") return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => parseScalar(part));
  }
  if (value.includes("{") || value.includes("}")) {
    throw new SubagentError("INVALID_FRONTMATTER", "nested maps and complex YAML are not supported");
  }
  return value;
}

function parseIndentedObject(lines: string[], start: number, filename: string): { value: Record<string, unknown>; next: number } {
  const value: Record<string, unknown> = {};
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (!line.startsWith("  ") || line.startsWith("    ")) break;

    const objectMatch = line.match(/^  ([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!objectMatch) throw new SubagentError("INVALID_FRONTMATTER", `invalid nested frontmatter line in ${filename}: ${line}`);
    const [, objectKey, rawObjectValue = ""] = objectMatch;
    if (rawObjectValue.trim() !== "") {
      value[objectKey] = parseScalar(rawObjectValue);
      i++;
      continue;
    }

    const nested: Record<string, unknown> = {};
    i++;
    while (i < lines.length) {
      const nestedLine = lines[i];
      if (!nestedLine.trim()) {
        i++;
        continue;
      }
      if (!nestedLine.startsWith("    ")) break;
      const nestedMatch = nestedLine.match(/^    ([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
      if (!nestedMatch) throw new SubagentError("INVALID_FRONTMATTER", `invalid nested frontmatter line in ${filename}: ${nestedLine}`);
      const [, nestedKey, rawNestedValue = ""] = nestedMatch;
      if (rawNestedValue.trim() === "") {
        throw new SubagentError("INVALID_FRONTMATTER", `nested arrays and maps are not supported in ${filename}: ${nestedLine}`);
      }
      nested[nestedKey] = parseScalar(rawNestedValue);
      i++;
    }
    value[objectKey] = nested;
  }

  return { value, next: i };
}

export function parseFrontmatter(source: string, filename = "<memory>"): ParsedFrontmatter {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new SubagentError("INVALID_FRONTMATTER", `frontmatter must start with --- in ${filename}`);
  }
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) throw new SubagentError("INVALID_FRONTMATTER", `frontmatter must end with --- in ${filename}`);
  const header = normalized.slice(4, end);
  const afterMarker = normalized.slice(end + "\n---".length);
  const body = afterMarker.replace(/^\n/, "").trim();
  const data: Record<string, unknown> = {};
  const lines = header.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^\s/.test(line)) throw new SubagentError("INVALID_FRONTMATTER", `unexpected indentation in ${filename}: ${line}`);
    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) throw new SubagentError("INVALID_FRONTMATTER", `invalid frontmatter line in ${filename}: ${line}`);
    const [, key, rawValue = ""] = match;
    if (rawValue.trim() !== "") {
      data[key] = parseScalar(rawValue);
      continue;
    }

    if (i + 1 < lines.length && lines[i + 1].startsWith("  - ")) {
      const items: unknown[] = [];
      while (i + 1 < lines.length && lines[i + 1].startsWith("  - ")) {
        i++;
        const item = lines[i].slice("  - ".length);
        if (item.includes(":")) throw new SubagentError("INVALID_FRONTMATTER", `nested array objects are not supported in ${filename}`);
        items.push(parseScalar(item));
      }
      data[key] = items;
      continue;
    }

    if (i + 1 < lines.length && lines[i + 1].startsWith("  ")) {
      const parsed = parseIndentedObject(lines, i + 1, filename);
      data[key] = parsed.value;
      i = parsed.next - 1;
      continue;
    }

    data[key] = [];
  }

  return { data, body };
}
