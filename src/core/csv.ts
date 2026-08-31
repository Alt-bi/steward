/**
 * CSV the user can actually open in Excel.
 *
 * Two decisions carry this file. First, a UTF-8 BOM: without it Excel assumes
 * the local codepage and Russian names arrive as mojibake — a "working" export
 * that is useless. Second, quoting is not optional: item names carry commas
 * ("AK-47 | Redline (Field-Tested), Minimal Wear") and the delimiter has to
 * survive them.
 */

/** Written as char codes: every escape sequence in this file has to survive
 * the build pipeline, and a raw CR/LF inside a literal does not. */
const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);
const BOM = String.fromCharCode(0xfeff);

/** RFC 4180 quoting: quotes double up, and anything smelly gets wrapped. */
export function csvCell(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = typeof v === "number" ? String(v) : v;
  if (/[",;]/.test(s) || s.includes(CR) || s.includes(NL)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function csvRow(cells: readonly (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

export function csvDoc(
  header: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[]
): string {
  const lines = [csvRow(header), ...rows.map(csvRow)];
  return BOM + lines.join(CR + NL) + CR + NL;
}


/** Hands one finished document to the browser as a download. */

export function downloadCsv(filename: string, doc: string): void {

  const blob = new Blob([doc], { type: "text/csv;charset=utf-8" });

  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");

  a.href = url;

  a.download = filename;

  a.click();

  /** Revoking now can kill the download mid-flight in some engines. */

  setTimeout(() => URL.revokeObjectURL(url), 30_000);

}

