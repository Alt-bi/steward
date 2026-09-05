/**
 * What a `/market/myhistory` row actually looks like on this account.
 *
 * The reader in `src/steam/myhistory.ts` is the one parser in the project
 * written without a measurement behind it. Its envelope is safe — it is the
 * `/market/mylistings` envelope, measured 2026-09-03 — but the rows are not:
 * the classification rests on «a sale has a counterparty and a listing does
 * not», and until this has been run that is a well-argued guess.
 *
 * So this prints, for one page of real history: how many rows Steam sent, what
 * each row's `+`/`-` cell holds, whether it links to a profile, what the reader
 * made of it, and the raw markup of the first row of every kind it found. If a
 * bucket comes back empty or `не разобрал` is not zero, the rule is wrong and
 * the markup below says how.
 *
 * ONE read-only request. Nothing is listed, cancelled, bought or sold.
 *
 *   npm run probe  →  .probe/history.js  →  paste into the Edge console on
 *                     https://steamcommunity.com/market/
 */

import { classifyRow, hasCounterparty, historyFromDom } from "../src/steam/myhistory";

const COUNT = 20;

interface RowReport {
  строка: string;
  знак: string;
  ссылкаНаПрофиль: boolean;
  вердикт: string;
  цена: number;
  датаДействия: string;
  название: string;
}

function text(node: Element | null): string {
  return String(node?.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

async function run(): Promise<void> {
  const url = `https://steamcommunity.com/market/myhistory/render/?query=&start=0&count=${COUNT}`;
  const res = await fetch(url, { credentials: "include" });
  const type = res.headers.get("content-type") ?? "";

  console.log("[history] статус", res.status, "тип", type, "редирект", res.redirected ? res.url : "нет");

  if (!type.includes("json")) {
    console.log("[history] это не JSON — вот начало ответа:");
    console.log((await res.text()).slice(0, 400));
    return;
  }

  const data = (await res.json()) as {
    success?: unknown;
    total_count?: number;
    pagesize?: unknown;
    results_html?: string;
    assets?: unknown;
    hovers?: string;
  };

  console.log("[history] конверт", {
    success: data.success,
    total_count: data.total_count,
    pagesize: data.pagesize,
    естьРазметка: Boolean(data.results_html),
    естьAssets: Boolean(data.assets),
    естьHovers: Boolean(data.hovers),
  });

  const doc = new DOMParser().parseFromString(String(data.results_html ?? ""), "text/html");
  const rows = [...doc.querySelectorAll('[id^="history_row_"]')];
  console.log("[history] строк в разметке:", rows.length);

  /** The id trap, measured: the cells inside a row borrow the row's own stem. */
  const nested = rows.filter((row) => !/^history_row_\d+_\d+$/.test(row.id));
  console.log("[history] из них вложенных, не строк:", nested.length, nested.slice(0, 4).map((n) => n.id));

  const report: RowReport[] = [];
  const sample = new Map<string, string>();

  for (const row of rows) {
    const sign = text(row.querySelector(".market_listing_gainorloss"));
    const partner = hasCounterparty(row as unknown as ParentNode);
    const verdict = classifyRow(sign, partner);
    const parsed = historyFromDom(row.parentElement as unknown as ParentNode).find(
      (event) => event.id === row.id
    );
    report.push({
      строка: row.id,
      знак: JSON.stringify(sign),
      ссылкаНаПрофиль: partner,
      вердикт: verdict,
      цена: parsed?.price ?? 0,
      датаДействия: parsed?.actedOn ?? "",
      название: parsed?.name ?? "",
    });
    if (!sample.has(verdict)) sample.set(verdict, row.outerHTML.slice(0, 900));
  }

  console.table(report);

  /**
   * The cell the whole classification rests on, printed whole.
   *
   * `outerHTML` above is clipped, and this is the one place where the answer
   * lives: a sale names the other side — a profile link, an avatar, a
   * `data-miniprofile` — and a listing has nobody to name. If every row here
   * looks the same, the rule is reading a page that does not distinguish them.
   */
  for (const row of rows.slice(0, 5)) {
    const cell = row.querySelector(".market_listing_whoactedwith");
    console.log(`[history] ${row.id} — кто на той стороне:`);
    console.log(cell ? cell.innerHTML.trim().slice(0, 600) : "нет ячейки .market_listing_whoactedwith");
  }

  const counted = report.reduce<Record<string, number>>((acc, r) => {
    acc[r.вердикт] = (acc[r.вердикт] ?? 0) + 1;
    return acc;
  }, {});
  console.log("[history] по видам:", counted);
  if (counted.unknown) {
    console.warn(
      "[history] есть строки, которые правило не объясняет — разметка ниже показывает, чем они отличаются"
    );
  }
  for (const [kind, html] of sample) {
    console.log(`[history] образец «${kind}»:`);
    console.log(html);
  }
}

void run().catch((err) => console.error("[history] упал", err));
