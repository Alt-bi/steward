import type { Cents } from "./types";

/**
 * Steam renders money in the wallet locale, so both "1 234,56" and "1,234.56"
 * show up — and the currency suffix can carry its own punctuation, as in the
 * Russian "1 234,56 pуб." whose trailing dot used to be mistaken for the decimal
 * separator and inflated every RUB price a hundredfold.
 *
 * The separator that matters is the last one followed by one or two digits;
 * anything else groups thousands. Assembled as integers, so no float drift.
 */
export function parseMoneyToCents(raw: unknown): Cents {
  const cleaned = String(raw ?? "")
    .replace(/[^\d.,]/g, "")
    .replace(/^[.,]+/, "")
    .replace(/[.,]+$/, "");
  if (!cleaned) return 0;

  const lastSep = Math.max(cleaned.lastIndexOf(","), cleaned.lastIndexOf("."));
  const tail = lastSep >= 0 ? cleaned.slice(lastSep + 1) : "";
  const isDecimal = tail.length === 1 || tail.length === 2;

  const whole = (isDecimal ? cleaned.slice(0, lastSep) : cleaned).replace(/[.,]/g, "");
  const frac = isDecimal ? tail.padEnd(2, "0") : "00";

  const cents = (Number.parseInt(whole || "0", 10) || 0) * 100 + (Number.parseInt(frac, 10) || 0);
  return Number.isFinite(cents) ? cents : 0;
}

const SYMBOLS: Record<number, { sign: string; before: boolean }> = {
  1: { sign: "$", before: true },
  2: { sign: "£", before: true },
  3: { sign: "€", before: false },
  5: { sign: "₽", before: false },
  6: { sign: "zł", before: false },
  7: { sign: "R$", before: true },
  9: { sign: "¥", before: true },
  12: { sign: "₴", before: false },
  24: { sign: "₸", before: false },
};

export function formatCents(cents: Cents | null | undefined, currencyId: number): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const n = cents / 100;
  const sym = SYMBOLS[currencyId];
  if (!sym) return n.toFixed(2);
  if (sym.before) return sym.sign + n.toFixed(2);
  return n.toFixed(2).replace(".", ",") + "\u00a0" + sym.sign;
}
