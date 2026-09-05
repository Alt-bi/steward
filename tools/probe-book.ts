/**
 * Which endpoint still answers, measured from the page the panel runs on.
 *
 * The scan reports «Steam дважды прислал веб-страницу вместо данных книги
 * лотов» after three requests. Three is nowhere near a throttle, so either the
 * request shape is wrong for this context or Steam is redirecting it — and
 * those need opposite fixes. `fetch` follows a 302 silently, so a redirect and
 * a refusal arrive as the same HTML; this prints `redirected` and the final URL
 * alongside the status, which is the difference.
 *
 * Six read-only requests, ~1.2 s apart. Nothing is bought, moved or cancelled.
 *
 *   npm run probe  →  .probe/book.js  →  paste into the Edge console on
 *                     https://steamcommunity.com/market/
 */

import { hoverBlobOnPage, listingsFromDom } from "../src/steam/mylistings";
import { projectAssets } from "../src/page/project";
import type { SteamAssetIndex } from "../src/core/types";

interface Attempt {
  что: string;
  status: number | string;
  редирект: string;
  тип: string;
  ответ: string;
}

const HOSTS = [
  "tabContentsMyActiveMarketListingsRows",
  "tabContentsMyActiveMarketListingsTable",
  "tabContentsMyListings",
];

function wallet(): { currency: number; country: string } {
  const raw = (window as unknown as { g_rgWalletInfo?: Record<string, unknown> }).g_rgWalletInfo;
  const currency = Number(raw?.wallet_currency) || 5;
  const country = String(raw?.wallet_country ?? "RU");
  return { currency, country };
}

/** Every item the page is selling — the same list the scan prices. */
function subjects(): { appid: number; hash: string }[] {
  const assets = projectAssets(
    (window as unknown as { g_rgAssets?: unknown }).g_rgAssets
  ) as SteamAssetIndex | null;
  const host = HOSTS.map((id) => document.getElementById(id)).find((n) => n) ?? document.body;
  const seen = new Set<string>();
  const out: { appid: number; hash: string }[] = [];
  for (const row of listingsFromDom(host, { assets, hovers: hoverBlobOnPage() })) {
    const key = `${row.appid}	${row.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ appid: row.appid, hash: row.hash });
  }
  return out;
}

/** The item the panel would have asked about first: one we are actually selling. */
function subject(): { appid: number; hash: string } | null {
  const assets = projectAssets(
    (window as unknown as { g_rgAssets?: unknown }).g_rgAssets
  ) as SteamAssetIndex | null;
  const host = HOSTS.map((id) => document.getElementById(id)).find((n) => n) ?? document.body;
  const rows = listingsFromDom(host, { assets, hovers: hoverBlobOnPage() });
  const row = rows[0];
  return row ? { appid: row.appid, hash: row.hash } : null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function attempt(what: string, url: string, init: RequestInit = {}): Promise<Attempt> {
  try {
    const res = await fetch(url, { credentials: "include", ...init });
    const text = await res.text();
    const type = res.headers.get("content-type") ?? "";
    /** Markup where JSON belongs — the first 90 characters say which page it is. */
    const looksHtml = /^\s*<(!DOCTYPE|html)/i.test(text);
    let answer: string;
    if (looksHtml) {
      const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() ?? "";
      answer = `HTML «${title}» (${text.length} симв.)`;
    } else {
      try {
        const data = JSON.parse(text) as Record<string, unknown>;
        const body = (data.data ?? data) as Record<string, unknown>;
        const rows = Array.isArray(body.listings) ? body.listings.length : null;
        const bits = [
          body.total_count != null ? `total_count=${String(body.total_count)}` : "",
          rows != null ? `listings=${rows}` : "",
          data.lowest_price != null ? `lowest_price=${String(data.lowest_price)}` : "",
          data.success != null ? `success=${String(data.success)}` : "",
        ].filter(Boolean);
        answer = `JSON ${bits.join(" ") || Object.keys(data).slice(0, 4).join(",")}`;
      } catch {
        answer = `не JSON: ${text.slice(0, 60)}`;
      }
    }
    return {
      что: what,
      status: res.status,
      редирект: res.redirected ? res.url.replace("https://steamcommunity.com", "") : "нет",
      тип: type.split(";")[0] ?? "",
      ответ: answer,
    };
  } catch (err) {
    return {
      что: what,
      status: "сеть",
      редирект: "—",
      тип: "—",
      ответ: err instanceof Error ? err.message : String(err),
    };
  }
}

async function run(): Promise<void> {
  const item = subject();
  if (!item) {
    console.log("Не вижу своих лотов на странице — открой https://steamcommunity.com/market/");
    return;
  }
  const { currency, country } = wallet();
  console.log(`%cSteward · зонд книги лотов · ${item.hash} (app ${item.appid})`, "font-weight:bold");

  const qp = encodeURIComponent(
    JSON.stringify([
      {
        appid: item.appid,
        strItemName: item.hash,
        filters: {},
        accessoryFilters: {},
        propertyFilters: {},
        start: 0,
      },
    ])
  );
  const actions = `https://steamcommunity.com/market/actions?q=QueryListingsForItem&qp=${qp}`;
  const hash = encodeURIComponent(item.hash);

  const out: Attempt[] = [];
  out.push(
    await attempt("actions + queryAction (как в расширении)", actions, {
      headers: { "x-valve-request-type": "queryAction" },
    })
  );
  await sleep(1200);
  out.push(await attempt("actions, без заголовков", actions));
  await sleep(1200);
  out.push(
    await attempt("actions + X-Requested-With", actions, {
      headers: { "X-Requested-With": "XMLHttpRequest" },
    })
  );
  await sleep(1200);
  out.push(
    await attempt(
      "классический /render/",
      `https://steamcommunity.com/market/listings/${item.appid}/${hash}/render/` +
        `?query=&start=0&count=10&currency=${currency}&language=russian&country=${country}`,
      { headers: { "X-Requested-With": "XMLHttpRequest" } }
    )
  );
  await sleep(1200);
  out.push(
    await attempt(
      "priceoverview",
      "https://steamcommunity.com/market/priceoverview/" +
        `?appid=${item.appid}&currency=${currency}&country=${country}&market_hash_name=${hash}`,
      { headers: { "X-Requested-With": "XMLHttpRequest" } }
    )
  );
  await sleep(1200);
  out.push(
    await attempt(
      "search/render (norender=1)",
      "https://steamcommunity.com/market/search/render/?norender=1" +
        `&appid=${item.appid}&start=0&count=10&currency=${currency}&country=${country}&query=${hash}`,
      { headers: { "X-Requested-With": "XMLHttpRequest" } }
    )
  );

  console.table(out);

  /**
   * And the endpoint the scan actually lives on now. «Посчитано: 1 из 10» is
   * either Steam declining nine times or nine names it does not answer to, and
   * the two look identical from inside the run: both arrive as «no price».
   */
  const items = subjects().slice(0, 5);
  const prices: Attempt[] = [];
  for (const one of items) {
    await sleep(1500);
    prices.push(
      await attempt(
        `priceoverview · ${one.hash}`,
        "https://steamcommunity.com/market/priceoverview/" +
          `?appid=${one.appid}&currency=${currency}&country=${country}` +
          `&market_hash_name=${encodeURIComponent(one.hash)}`,
        { headers: { "X-Requested-With": "XMLHttpRequest" } }
      )
    );
  }
  console.log(`%cПять предметов подряд через priceoverview (пауза 1.5 с)`, "font-weight:bold");
  console.table(prices);

  console.log("Скопируй строку ниже целиком:");
  console.log(JSON.stringify({ item, currency, country, attempts: out, prices }));
}

void run();
