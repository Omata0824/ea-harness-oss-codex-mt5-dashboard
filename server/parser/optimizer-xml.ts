import { XMLParser } from "fast-xml-parser";
import { readTextWithEncoding } from "../mt5/tester.js";

interface XmlCell {
  Data?: unknown;
}

interface XmlRow {
  Cell?: XmlCell[] | XmlCell;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value ? [value] : [];
}

function readNodeText(node: unknown): string {
  if (node === null || node === undefined) {
    return "";
  }

  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    return String(node).trim();
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const value = readNodeText(item);
      if (value) {
        return value;
      }
    }
    return "";
  }

  if (typeof node === "object") {
    const textNode = (node as Record<string, unknown>)["#text"];
    if (textNode !== undefined) {
      return readNodeText(textNode);
    }

    for (const value of Object.values(node as Record<string, unknown>)) {
      const text = readNodeText(value);
      if (text) {
        return text;
      }
    }
  }

  return "";
}

function findRows(node: unknown): XmlRow[] {
  if (!node || typeof node !== "object") {
    return [];
  }

  if ("Row" in node) {
    return asArray((node as { Row?: XmlRow[] | XmlRow }).Row);
  }

  for (const value of Object.values(node)) {
    const rows = findRows(value);
    if (rows.length > 0) {
      return rows;
    }
  }

  return [];
}

export async function parseOptimizerXml(reportPath: string): Promise<Array<Record<string, string>>> {
  const xml = await readTextWithEncoding(reportPath);
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    removeNSPrefix: true,
  });
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const rows = findRows(parsed);
  if (rows.length === 0) {
    return [];
  }

  const header = asArray(rows[0].Cell).map((cell) => readNodeText(cell.Data));
  return rows
    .slice(1)
    .map((row) => {
      const cells = asArray(row.Cell).map((cell) => readNodeText(cell.Data));
      const item: Record<string, string> = {};
      header.forEach((key, index) => {
        if (key) {
          item[key] = cells[index] ?? "";
        }
      });
      return item;
    })
    .filter((row) => Object.keys(row).length > 0);
}
