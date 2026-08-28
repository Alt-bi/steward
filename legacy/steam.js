/* Steam Community Market API. Runs in the isolated content-script world. */

const SRP_DEFAULTS = {
  delayMs: 1200,
  undercutCents: 1,
  skipSelfUndercut: true,
  scanConcurrency: 3,
  scanGapMs: 150,
};

var srpPriceMem = {};
var srpPriceGate = { lastStart: 0, gapMs: 150 };
var srpNet = {
  cooldownUntil: 0,
  hits429: 0,
  hitsFalse: 0,
  ok: 0,
  consecutiveFalse: 0,
  log: [],
};

function srpNote(kind, detail) {
  var row = { t: new Date().toISOString(), kind: kind, detail: String(detail || "") };
  srpNet.log.push(row);
  if (srpNet.log.length > 80) srpNet.log.shift();
  try {
    console.warn("[Steam Reprice]", kind, detail || "");
    chrome.storage.local.set({
      srpNetLog: srpNet.log.slice(-40),
      srpNetHits: {
        hits429: srpNet.hits429,
        hitsFalse: srpNet.hitsFalse,
        ok: srpNet.ok,
      },
    });
  } catch (e) {}
}

function srpTripLimit(ms, why) {
  srpNet.hits429 += 1;
  var wait = ms || Math.min(12000, 3500 + 1500 * Math.min(srpNet.hits429, 5));
  srpNet.cooldownUntil = Math.max(srpNet.cooldownUntil, Date.now() + wait);
  srpPriceGate.gapMs = Math.min(700, Math.max(srpPriceGate.gapMs || 150, 250));
  srpNote("rate_limit", why + " wait=" + wait + "ms hits429=" + srpNet.hits429);
  return wait;
}

async function srpWaitGlobal(onWait) {
  while (Date.now() < srpNet.cooldownUntil) {
    var left = Math.ceil((srpNet.cooldownUntil - Date.now()) / 1000);
    if (onWait) onWait(left, srpNet.hits429);
    await srpSleep(250);
  }
}

var srpPage = {
  sessionid: null,
  steamid: null,
  wallet: null,
  language: "english",
  country: "RU",
  assets: null,
};

var srpLastLoadMeta = { total: 0, pages: 0, extracted: 0 };

function srpSleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function srpCookie(name) {
  var parts = document.cookie.split("; ");
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p.indexOf(name + "=") === 0) {
      return decodeURIComponent(p.slice(name.length + 1));
    }
  }
  return null;
}

function srpSessionId() {
  return srpPage.sessionid || srpCookie("sessionid") || "";
}

function srpCurrencyId() {
  if (srpPage.wallet && srpPage.wallet.wallet_currency) {
    return parseInt(srpPage.wallet.wallet_currency, 10);
  }
  return 5;
}

function srpCountry() {
  if (srpPage.country) return srpPage.country;
  var raw = srpCookie("steamCountry") || "";
  var cc = raw.split("|")[0].split("%7C")[0];
  return cc || "RU";
}

window.addEventListener("message", function (e) {
  if (e.source !== window) return;
  if (!e.data || e.data.source !== "steam-reprice-page") return;
  srpPage.sessionid = e.data.sessionid || srpPage.sessionid;
  srpPage.steamid = e.data.steamid || srpPage.steamid;
  srpPage.wallet = e.data.wallet || srpPage.wallet;
  srpPage.language = e.data.language || srpPage.language;
  srpPage.country = e.data.country || srpPage.country;
  srpPage.assets = e.data.assets || srpPage.assets;
  srpApplyWallet(srpPage.wallet);
});

function srpRequestPageInfo() {
  window.postMessage({ source: "steam-reprice-ext", type: "request-page" }, "*");
}

function srpAjaxHeaders(extra) {
  return Object.assign(
    {
      "X-Requested-With": "XMLHttpRequest",
      "X-Prototype-Version": "1.7",
      Accept: "application/json, text/javascript;q=0.9, */*;q=0.8",
    },
    extra || {}
  );
}

function srpDecodeJson(text) {
  text = String(text || "").replace(/^\uFEFF/, "");
  text = text.replace(/^\s*for \(;;\);\s*/, "").replace(/^\)\]\}'?,?\s*/, "");
  var brace = text.indexOf("{");
  if (brace > 0) text = text.slice(brace);
  return JSON.parse(text);
}

async function srpFetchJson(url, opts) {
  opts = opts || {};
  var headers = srpAjaxHeaders(opts.headers);
  var res = await fetch(
    url,
    Object.assign({ credentials: "include" }, opts, { headers: headers })
  );
  if (res.status === 429) {
    var err = new Error("rate_limited");
    err.status = 429;
    var ra = res.headers.get("Retry-After");
    err.retryAfter = ra ? parseInt(ra, 10) : 0;
    throw err;
  }
  if (res.status === 503 || res.status === 502) {
    var err503 = new Error("rate_limited");
    err503.status = res.status;
    throw err503;
  }
  var text = await res.text();
  if (/g_steamID\s*=\s*false/.test(text)) throw new Error("not_logged_in");
  if (/^\s*<!DOCTYPE/i.test(text) || /^\s*<html/i.test(text)) {
    throw new Error("not_json");
  }
  try {
    return srpDecodeJson(text);
  } catch (e) {
    throw new Error("bad_json");
  }
}

async function srpFetchJsonRetry(url, opts, tries) {
  tries = tries || 3;
  var last;
  for (var i = 0; i < tries; i++) {
    try {
      return await srpFetchJson(url, opts);
    } catch (e) {
      last = e;
      if (e.message === "not_logged_in") throw e;
      await srpSleep(e.status === 429 ? 8000 : 1500 * (i + 1));
    }
  }
  throw last;
}

function srpBuyerFromListing(info) {
  var price = info.converted_price != null ? info.converted_price : info.price;
  var fee = info.converted_fee != null ? info.converted_fee : info.fee;
  return (parseInt(price, 10) || 0) + (parseInt(fee, 10) || 0);
}

function srpLookupAsset(assets, appid, contextid, assetid) {
  if (!assets) return null;
  var byApp = assets[appid] || assets[String(appid)];
  if (!byApp) return null;
  var byCtx = byApp[contextid] || byApp[String(contextid)];
  if (!byCtx) return null;
  return byCtx[assetid] || byCtx[String(assetid)] || null;
}

function srpParseMoneyToCents(raw) {
  var s = String(raw || "").replace(/[^\d.,]/g, "");
  if (!s) return 0;
  if (s.indexOf(",") >= 0 && s.indexOf(".") >= 0) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (s.indexOf(",") >= 0) {
    s = s.replace(",", ".");
  }
  var n = parseFloat(s);
  return isFinite(n) ? Math.round(n * 100) : 0;
}

function srpParseHovers(hovers) {
  var map = {};
  var re = /CreateItemHoverFromContainer\(\s*[^,]+,\s*'mylisting_(\d+)[^']*',\s*(\d+),\s*'(\d+)',\s*'(\d+)'/g;
  var m;
  while ((m = re.exec(hovers || ""))) {
    map[m[1]] = { appid: Number(m[2]), contextid: String(m[3]), assetid: String(m[4]) };
  }
  return map;
}

function srpParseListingDoc(root) {
  var map = {};
  if (!root) return map;
  var rows = root.querySelectorAll('.market_listing_row[id^="mylisting_"], [id^="mylisting_"]');
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var listingId = String(row.id || "").replace(/^mylisting_/, "").split("_")[0];
    if (!listingId) continue;
    var a =
      row.querySelector(".market_listing_item_name_link") ||
      row.querySelector('a[href*="/market/listings/"]');
    var href = a ? a.getAttribute("href") || "" : "";
    var m = href.match(/\/market\/listings\/(\d+)\/([^/?#]+)/);
    var priceCell = row.querySelector(".market_listing_price") || row;
    var priceText = (priceCell.innerText || priceCell.textContent || "").trim();
    var nums = priceText.match(/[0-9]+(?:[ \u00a0]?[0-9]{3})*(?:[.,][0-9]{1,2})?/g) || [];
    var buyer = nums.length ? srpParseMoneyToCents(nums[0]) : 0;
    var seller = nums.length > 1 ? srpParseMoneyToCents(nums[1]) : 0;
    var name = a ? (a.textContent || "").trim() : "";
    map[listingId] = {
      listingId: listingId,
      appid: m ? Number(m[1]) : null,
      hash: m ? decodeURIComponent(m[2]) : name,
      name: name,
      buyer: buyer,
      seller: seller,
    };
  }
  return map;
}

function srpParseNamesFromHtml(html) {
  if (!html) return {};
  var doc = new DOMParser().parseFromString("<div>" + html + "</div>", "text/html");
  return srpParseListingDoc(doc);
}

function srpResponseHasRows(data) {
  if (!data) return false;
  if (data.listinginfo && Object.keys(data.listinginfo).length) return true;
  if (data.results_html && /mylisting_/.test(data.results_html)) return true;
  var n = data.num_active_listings != null ? data.num_active_listings : data.total_count;
  if (data.success && n === 0) return true;
  return false;
}

function srpMergePageListings(data) {
  var info = data.listinginfo || {};
  var htmlMap = srpParseNamesFromHtml(data.results_html || "");
  var hovers = srpParseHovers(data.hovers || "");
  if (data.assets == null) data.assets = srpPage.assets || {};
  var ids = {};
  var k;
  for (k in info) ids[k] = true;
  for (k in htmlMap) ids[k] = true;
  for (k in hovers) ids[k] = true;

  var listings = [];
  for (k in ids) {
    if (!Object.prototype.hasOwnProperty.call(ids, k)) continue;
    var row = info[k] || {};
    var parsed = htmlMap[k] || {};
    var hover = hovers[k] || {};
    var assetRef = row.asset || {};
    var appid = assetRef.appid || hover.appid || parsed.appid;
    var contextid = assetRef.contextid || hover.contextid || "2";
    var assetid = assetRef.id || hover.assetid;
    var asset = srpLookupAsset(data.assets, appid, contextid, assetid) || {};
    var hash =
      asset.market_hash_name ||
      asset.market_name ||
      parsed.hash ||
      asset.name ||
      "";
    if (!hash || !appid) continue;
    var ourBuyer = row.price != null || row.converted_price != null
      ? srpBuyerFromListing(row)
      : parsed.buyer || 0;
    var ourSeller = parseInt(
      row.converted_price != null ? row.converted_price : row.price,
      10
    );
    if (!ourSeller) ourSeller = parsed.seller || 0;
    listings.push({
      listingId: String(row.listingid || k),
      appid: appid,
      contextid: String(contextid),
      assetid: assetid ? String(assetid) : "",
      amount: parseInt(assetRef.amount || asset.amount || 1, 10) || 1,
      name: asset.market_name || parsed.name || hash,
      hash: hash,
      ourBuyer: ourBuyer,
      ourSeller: ourSeller,
      publisherFeePercent: parseFloat(row.publisher_fee_percent) || 0.1,
    });
  }
  return listings;
}

async function srpFetchMyListingsPage(start, count) {
  var qs = "start=" + start + "&count=" + count;
  var urls = [
    "https://steamcommunity.com/market/mylistings?" + qs,
    "https://steamcommunity.com/market/mylistings/?" + qs,
    "https://steamcommunity.com/market/mylistings/render/?" + qs + "&query=",
  ];
  var last = null;
  for (var i = 0; i < urls.length; i++) {
    try {
      var data = await srpFetchJsonRetry(urls[i], {}, 2);
      if (srpResponseHasRows(data)) return data;
      last = new Error("mylistings_empty_payload");
    } catch (e) {
      last = e;
      if (e.message === "not_logged_in") throw e;
    }
  }
  throw last || new Error("mylistings_failed");
}

async function srpLoadMyListings(onProgress) {
  var start = 0;
  var count = 100;
  var listings = [];
  var seen = {};
  var total = null;
  var pages = 0;

  while (pages < 40) {
    var data = await srpFetchMyListingsPage(start, count);
    pages += 1;
    if (total == null) {
      total = data.total_count || data.num_active_listings || 0;
    }
    var batch = srpMergePageListings(data);
    for (var i = 0; i < batch.length; i++) {
      var L = batch[i];
      if (seen[L.listingId]) continue;
      seen[L.listingId] = true;
      listings.push(L);
    }
    if (onProgress) {
      onProgress({ loaded: listings.length, total: total || listings.length });
    }
    if (!batch.length) break;
    start += data.pagesize || batch.length || count;
    if (total && start >= total) break;
    await srpSleep(400);
  }

  if (!listings.length) {
    var host = document.getElementById("tabContentsMyListings") || document.body;
    listings = srpMergePageListings({
      results_html: host.innerHTML,
      hovers: document.documentElement.innerHTML,
      assets: srpPage.assets || {},
      listinginfo: {},
    });
  }
  srpLastLoadMeta = { total: total || 0, pages: pages, extracted: listings.length };
  return listings;
}

function srpPriceCacheKey(item) {
  return srpCurrencyId() + ":" + item.appid + "\t" + item.hash;
}

function srpPriceCacheGet(item) {
  var hit = srpPriceMem[srpPriceCacheKey(item)];
  if (!hit) return null;
  if (Date.now() - hit.ts > 120000) return null;
  return hit.cents;
}

function srpPriceCacheSet(item, cents) {
  srpPriceMem[srpPriceCacheKey(item)] = { cents: cents, ts: Date.now() };
}

async function srpAcquirePriceSlot() {
  var now = Date.now();
  var wait = (srpPriceGate.gapMs || 60) - (now - srpPriceGate.lastStart);
  if (wait > 0) await srpSleep(wait);
  srpPriceGate.lastStart = Date.now();
}

/** Light endpoint: one tiny JSON per unique item. Includes our own listings in lowest_price. */
async function srpPriceOverviewLow(item) {
  var cached = srpPriceCacheGet(item);
  if (cached != null) return cached;
  await srpAcquirePriceSlot();
  var url =
    "https://steamcommunity.com/market/priceoverview/" +
    "?appid=" +
    encodeURIComponent(item.appid) +
    "&currency=" +
    srpCurrencyId() +
    "&country=" +
    encodeURIComponent(srpCountry()) +
    "&market_hash_name=" +
    encodeURIComponent(item.hash);
  var data = await srpFetchJson(url);
  if (!data || data.success === false || !data.lowest_price) {
    var err = new Error("price_false");
    err.status = data && data.success === false ? 429 : 0;
    throw err;
  }
  var cents = srpParseMoneyToCents(data.lowest_price);
  if (cents < 1) throw new Error("price_empty");
  srpPriceCacheSet(item, cents);
  return cents;
}

async function srpFetchMarketLows(items, opts) {
  opts = opts || {};
  var conc = Math.max(1, Math.min(10, opts.concurrency || SRP_DEFAULTS.scanConcurrency));
  var abort = opts.abort || function () { return false; };
  var onProgress = opts.onProgress;
  var onWait = opts.onWait;
  srpPriceGate.gapMs = opts.gapMs || SRP_DEFAULTS.scanGapMs;
  srpNet.ok = 0;
  srpNet.hits429 = 0;
  srpNet.hitsFalse = 0;
  srpNet.consecutiveFalse = 0;
  var results = {};
  var next = 0;
  var done = 0;

  async function one(item) {
    if (abort()) throw new Error("stopped");
    await srpWaitGlobal(onWait);
    try {
      var cents = await srpPriceOverviewLow(item);
      srpNet.ok += 1;
      srpNet.consecutiveFalse = 0;
      return cents;
    } catch (e) {
      if (e.message === "not_logged_in" || e.message === "stopped") throw e;
      if (e.message === "rate_limited" || e.status === 429 || e.status === 503) {
        var waitMs = e.retryAfter ? e.retryAfter * 1000 : 0;
        srpTripLimit(waitMs, "HTTP " + (e.status || 429) + " " + item.name);
        await srpWaitGlobal(onWait);
        try {
          return await srpPriceOverviewLow(item);
        } catch (e2) {
          srpNote("give_up_after_429", item.name + " " + e2.message);
          return null;
        }
      }
      if (e.message === "price_false") {
        srpNet.hitsFalse += 1;
        srpNet.consecutiveFalse += 1;
        srpNote("price_false", item.name + " streak=" + srpNet.consecutiveFalse);
        if (srpNet.consecutiveFalse >= 3) {
          srpTripLimit(4000, "success:false streak x" + srpNet.consecutiveFalse);
          srpNet.consecutiveFalse = 0;
          await srpWaitGlobal(onWait);
        }
        return null;
      }
      srpNote("price_error", item.name + " " + e.message);
      return null;
    }
  }

  async function worker() {
    while (true) {
      if (abort()) throw new Error("stopped");
      var idx = next++;
      if (idx >= items.length) return;
      var item = items[idx];
      results[item.key] = await one(item);
      done += 1;
      if (onProgress) onProgress(done, items.length, item, srpNet);
    }
  }

  srpNote("scan_start", "items=" + items.length + " conc=" + conc);
  var n = Math.min(conc, items.length || 1);
  var pool = [];
  for (var w = 0; w < n; w++) pool.push(worker());
  await Promise.all(pool);
  srpNote("scan_done", "ok=" + srpNet.ok + " 429=" + srpNet.hits429 + " false=" + srpNet.hitsFalse);
  return results;
}

function srpOurLows(listings) {
  var map = {};
  for (var i = 0; i < listings.length; i++) {
    var L = listings[i];
    var key = L.appid + "\t" + L.hash;
    if (map[key] == null || L.ourBuyer < map[key]) map[key] = L.ourBuyer;
  }
  return map;
}

function srpPlan(listings, marketLowByKey, undercutCents) {
  var ourLow = srpOurLows(listings);
  var rows = [];
  for (var i = 0; i < listings.length; i++) {
    var L = listings[i];
    var key = L.appid + "\t" + L.hash;
    var marketLow = marketLowByKey[key];
    var mine = ourLow[key];
    var plan = {
      listingId: L.listingId,
      name: L.name,
      hash: L.hash,
      appid: L.appid,
      contextid: L.contextid,
      assetid: L.assetid,
      amount: L.amount,
      ourBuyer: L.ourBuyer,
      competitorBuyer: marketLow == null ? null : marketLow,
      targetBuyer: null,
      targetSeller: null,
      publisherFeePercent: L.publisherFeePercent,
      action: "skip",
      reason: "",
    };

    if (marketLow == null) {
      plan.reason = "нет цены рынка";
      rows.push(plan);
      continue;
    }
    if (L.ourBuyer <= marketLow) {
      plan.reason = "уже на минимуме или дешевле";
      rows.push(plan);
      continue;
    }
    if (marketLow >= mine) {
      plan.reason = "минимум наш — не режем себя";
      rows.push(plan);
      continue;
    }

    var targetBuyer = marketLow - undercutCents;
    if (targetBuyer < 1) {
      plan.reason = "нельзя ниже минимума Steam";
      rows.push(plan);
      continue;
    }
    var targetSeller = srpSellerForBuyer(targetBuyer, L.publisherFeePercent);
    if (targetSeller < 1) {
      plan.reason = "не собралась цена продавца";
      rows.push(plan);
      continue;
    }
    var actualBuyer = srpBuyerPrice(targetSeller, L.publisherFeePercent);
    if (actualBuyer >= L.ourBuyer) {
      plan.reason = "после комиссии цена не ниже текущей";
      rows.push(plan);
      continue;
    }

    plan.action = "reprice";
    plan.targetBuyer = actualBuyer;
    plan.targetSeller = targetSeller;
    plan.reason = "оверпрайс";
    rows.push(plan);
  }
  return rows;
}

async function srpRemoveListing(listingId) {
  var sessionid = srpSessionId();
  var res = await fetch("https://steamcommunity.com/market/removelisting/" + listingId, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: new URLSearchParams({ sessionid: sessionid }),
  });
  if (res.status === 429) throw new Error("rate_limited");
  if (!res.ok) throw new Error("remove_http_" + res.status);
  var text = (await res.text()).trim();
  if (!text) return;
  var json = JSON.parse(text);
  if (json && json.success === false) throw new Error("remove_failed");
}

async function srpSellItem(plan) {
  var sessionid = srpSessionId();
  var body = new URLSearchParams({
    sessionid: sessionid,
    appid: String(plan.appid),
    contextid: String(plan.contextid),
    assetid: String(plan.assetid),
    amount: String(plan.amount || 1),
    price: String(plan.targetSeller),
  });
  var res = await fetch("https://steamcommunity.com/market/sellitem/", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: body,
  });
  if (res.status === 429) throw new Error("rate_limited");
  var json = await res.json();
  if (!json || !json.success) {
    var msg = json && (json.message || json.error) ? String(json.message || json.error) : "sell_failed";
    throw new Error(msg);
  }
  return json;
}

async function srpApplyOne(plan, delayMs) {
  if (!plan.assetid) throw new Error("нет assetid — нельзя выставить снова");
  await srpRemoveListing(plan.listingId);
  await srpSleep(Math.max(900, delayMs));
  var json = await srpSellItem(plan);
  await srpSleep(delayMs);
  return json;
}
