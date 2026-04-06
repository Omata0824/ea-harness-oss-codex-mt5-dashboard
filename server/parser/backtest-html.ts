import * as cheerio from "cheerio";
import { readTextWithEncoding } from "../mt5/tester.js";

function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}

export async function parseBacktestHtml(reportPath: string): Promise<Record<string, string>> {
  const html = await readTextWithEncoding(reportPath);
  const $ = cheerio.load(html);
  const result: Record<string, string> = {};

  $("tr").each((_index, row) => {
    const cells = $(row)
      .find("td")
      .map((_cellIndex, cell) => $(cell).text().trim())
      .get()
      .filter(Boolean);

    for (let index = 0; index + 1 < cells.length; index += 2) {
      const label = normalizeLabel(cells[index].replace(/:$/, ""));
      const value = cells[index + 1];

      if (!label || !value) {
        continue;
      }

      if (!(label in result)) {
        result[label] = value;
      }
    }
  });

  return result;
}
