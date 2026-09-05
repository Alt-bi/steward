import "./support/env";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { reports, resetEnv, setAcquire, setSteam } from "./support/env";

import {
  decodeJson,
  fetchJson,
  fetchJsonRetry,
  isSteamRateLimitBody,
  markupNote,
  SteamError,
} from "../src/steam/net";

const BAN_HTML = `<!DOCTYPE html>
<html><body>
Sorry!<br>
You've made too many requests recently.
Please wait and try your request again later.
</body></html>`;

describe("isSteamRateLimitBody", () => {
  it("catches the English sorry-page Steam serves as HTTP 200", () => {
    assert.equal(isSteamRateLimitBody(BAN_HTML), true);
  });

  it("catches the Russian wording too", () => {
    assert.equal(isSteamRateLimitBody("Вы сделали слишком много запросов. Подождите."), true);
  });

  it("catches the market's actual Russian copy, which omits «сделали»", () => {
    /** Verbatim phrasing from the RU marketsorry page. The old regex needed
     *  «сделали» and read this as innocent markup instead of a soft ban. */
    assert.equal(
      isSteamRateLimitBody(
        "<html><body>Слишком много запросов с вашего IP-адреса в последнее время.<br>Подождите и повторите попытку позже.</body></html>"
      ),
      true
    );
    assert.equal(isSteamRateLimitBody("Превышена частота запросов. Повторите позже."), true);
  });

  it("does not treat a normal HTML inventory page as a ban", () => {
    assert.equal(isSteamRateLimitBody("<!DOCTYPE html><html><title>Steam Community Market</title>"), false);
  });
});

describe("markupNote", () => {
  it("names an unexpected page by its own title", () => {
    assert.equal(
      markupNote('<!DOCTYPE html><html><head><title>Страница входа Steam</title></head><body>…</body>'),
      "Страница входа Steam"
    );
  });

  it("falls back to visible text when the page has no title", () => {
    const note = markupNote(
      "<html><body><script>var x=1;</script><style>.a{}</style><h1>Do not browse</h1><p>robot check</p></body>"
    );
    assert.equal(note, "Do not browse robot check");
  });

  it("clips a long title to one readable line", () => {
    const note = markupNote(`<html><title>${"д".repeat(200)}</title>`);
    assert.ok(note.length <= 81 && note.endsWith("…"), note.slice(-5));
  });
});

const MARKET_HOME =
  "<!DOCTYPE html><html><head><title>Сообщество Steam :: Торговая площадка</title></head><body></body></html>";

describe("fetchJson rate-limit detection", () => {
  beforeEach(async () => {
    await resetEnv();
    setAcquire(() => ({ ok: true as const }));
  });

  it("reports an HTML 200 ban as rate_limited, not not_json", async () => {
    setSteam(() => ({ status: 200, body: BAN_HTML }));
    await assert.rejects(
      () => fetchJson("https://steamcommunity.com/market/priceoverview/?x=1", { kind: "price" }),
      (err: unknown) => err instanceof SteamError && err.kind === "rate_limited"
    );
    assert.equal(reports.some((r) => r.outcome === "rate_limited"), true);
  });

  it("files a web page where JSON belongs as this endpoint refusing, not as a ban", async () => {
    /**
     * Both are markup and they need opposite blast radii. Steam's sorry-page is
     * the IP being metered: everything stops. The market homepage arriving from
     * one action endpoint is that endpoint refusing — and reporting it as a ban
     * switched off `priceoverview` and `search`, which is what the run falls
     * back on when the listing book dies. The thrown error stays `not_json`,
     * because the caller reads the page's own title off it.
     */
    setSteam(() => ({ status: 200, body: MARKET_HOME }));
    await assert.rejects(
      () => fetchJson("https://steamcommunity.com/market/actions?q=QueryListingsForItem", { kind: "listings" }),
      (err: unknown) => err instanceof SteamError && err.kind === "not_json"
    );
    assert.equal(reports.some((r) => r.outcome === "wrong_shape"), true);
    assert.equal(reports.some((r) => r.outcome === "rate_limited"), false);
  });

  it("names a redirect as a redirect instead of leaving it to look like a refusal", async () => {
    /**
     * `fetch` follows a 302 in silence, so «Steam прислал веб-страницу» covers
     * both «this endpoint refuses us» and «this endpoint is not at that address
     * for this session». Only the second is fixed by changing the request.
     */
    setSteam(() => ({ status: 200, body: MARKET_HOME, url: "https://steamcommunity.com/market/", redirected: true }));
    await assert.rejects(
      () => fetchJson("https://steamcommunity.com/market/actions?q=QueryListingsForItem", { kind: "listings" }),
      (err: unknown) => {
        assert.ok(err instanceof SteamError);
        assert.match(String(err.note), /перенаправлено на \/market\//);
        return true;
      }
    );
  });

  it("does not retry a 429", async () => {
    let hits = 0;
    setSteam(() => {
      hits += 1;
      return { status: 429, body: "", headers: { "Retry-After": "1" } };
    });
    await assert.rejects(
      () => fetchJsonRetry("https://steamcommunity.com/inventory/1/730/2", { kind: "inventory" }, 3),
      (err: unknown) => err instanceof SteamError && err.kind === "rate_limited"
    );
    assert.equal(hits, 1, "retrying a ban is how a 30s pause becomes hours");
  });
});

describe("decodeJson", () => {
  it("strips the anti-hijacking junk Steam puts in front of some payloads", () => {
    assert.deepEqual(decodeJson('for (;;);{"success":1}'), { success: 1 });
    assert.deepEqual(decodeJson(')]}\',\n{"success":1}'), { success: 1 });
    assert.deepEqual(decodeJson('\uFEFF{"success":1}'), { success: 1 });
  });

  it("leaves a top-level array whole", () => {
    /**
     * Looking for `{` alone sliced the opening bracket off and turned a perfectly
     * good answer into `bad_json` — a failure the user would read as Steam being
     * broken. Nothing we call answers with an array today; the junk-stripper must
     * not be the reason the first one that does looks like a refusal.
     */
    assert.deepEqual(decodeJson('[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(decodeJson('for (;;);[{"a":1}]'), [{ a: 1 }]);
  });

  it("still refuses a body that is not JSON at all", () => {
    assert.throws(() => decodeJson("<html>nope</html>"));
  });
});
