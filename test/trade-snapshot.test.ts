import "./support/env";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { postedToPage, postFromPage } from "./support/env";

import {
  currentTrade,
  onTradeSnapshot,
  requestTrade,
  tradeItemKeys,
  TRADE_FROM_PAGE,
} from "../src/steam/trade";

/** Shaped exactly like what the MAIN-world trade bridge posts. */
function bridgePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: TRADE_FROM_PAGE,
    version: 3,
    present: true,
    yours: [
      {
        appid: 730,
        contextid: "2",
        assetid: "100",
        name: "Chroma Case",
        hash: "Chroma Case",
        amount: 1,
        marketable: true,
        tradable: true,
        described: true,
      },
    ],
    theirs: [
      {
        appid: 730,
        contextid: "2",
        assetid: "200",
        name: "Gamma Case",
        hash: "Gamma Case",
        amount: 2,
        marketable: true,
        tradable: true,
        described: true,
      },
    ],
    ...overrides,
  };
}

describe("trade snapshot intake", () => {
  it("normalises what the bridge posts and notifies listeners", () => {
    let seen = 0;
    const stop = onTradeSnapshot(() => {
      seen += 1;
    });

    postFromPage(bridgePayload());
    const snapshot = currentTrade();

    assert.ok(snapshot);
    assert.equal(snapshot.present, true);
    assert.equal(snapshot.version, 3);
    assert.equal(snapshot.yours.length, 1);
    assert.equal(snapshot.theirs[0]!.amount, 2);
    assert.ok(seen >= 1);
    stop();
  });

  it("ignores messages that are not from the trade bridge", () => {
    postFromPage(bridgePayload());
    const before = currentTrade()?.version;
    postFromPage({ source: "something-else", version: 99, present: true, yours: [], theirs: [] });
    assert.equal(currentTrade()?.version, before, "foreign messages must not overwrite state");
  });

  it("counts items whose description the page had not loaded", () => {
    postFromPage(
      bridgePayload({
        theirs: [
          { appid: 730, contextid: "2", assetid: "300", hash: "", name: "", described: false },
          { appid: 730, contextid: "2", assetid: "301", hash: "Case", name: "Case", described: true },
        ],
      })
    );
    assert.equal(currentTrade()?.undescribed, 1);
  });

  it("skips entries with no assetid at all", () => {
    postFromPage(bridgePayload({ theirs: [{ appid: 730, hash: "Ghost" }] }));
    assert.equal(currentTrade()?.theirs.length, 0);
  });

  it("treats missing flags as permissive rather than as restrictions", () => {
    postFromPage(
      bridgePayload({
        theirs: [{ appid: 730, contextid: "2", assetid: "400", hash: "Case", described: true }],
      })
    );
    const item = currentTrade()!.theirs[0]!;
    assert.equal(item.marketable, true);
    assert.equal(item.tradable, true);
    assert.equal(item.amount, 1, "a missing amount is one copy");
  });

  it("respects an explicit false flag", () => {
    postFromPage(
      bridgePayload({
        theirs: [
          {
            appid: 730,
            contextid: "2",
            assetid: "401",
            hash: "Bound",
            marketable: false,
            described: true,
          },
        ],
      })
    );
    assert.equal(currentTrade()!.theirs[0]!.marketable, false);
  });

  it("hands a late listener the snapshot it missed", () => {
    postFromPage(bridgePayload());
    let received: unknown = null;
    const stop = onTradeSnapshot((snapshot) => {
      received = snapshot;
    });
    assert.ok(received, "subscribing after the fact must not lose the current offer");
    stop();
  });

  it("stops notifying after unsubscribing", () => {
    let seen = 0;
    const stop = onTradeSnapshot(() => {
      seen += 1;
    });
    const baseline = seen;
    stop();
    postFromPage(bridgePayload({ version: 44 }));
    assert.equal(seen, baseline);
  });
});

describe("tradeItemKeys", () => {
  it("collects one entry per unique item across both sides", () => {
    postFromPage(
      bridgePayload({
        yours: [
          { appid: 730, contextid: "2", assetid: "1", hash: "Case", name: "Case", described: true },
          { appid: 730, contextid: "2", assetid: "2", hash: "Case", name: "Case", described: true },
        ],
        theirs: [
          { appid: 730, contextid: "2", assetid: "3", hash: "Knife", name: "Knife", described: true },
        ],
      })
    );
    const keys = tradeItemKeys(currentTrade()!);
    assert.equal(keys.size, 2, "two copies of one item are one lookup");
    assert.ok(keys.has("730\tCase"));
    assert.ok(keys.has("730\tKnife"));
  });

  it("leaves out items with no hash, which cannot be priced", () => {
    postFromPage(
      bridgePayload({
        yours: [],
        theirs: [{ appid: 730, contextid: "2", assetid: "9", hash: "", described: false }],
      })
    );
    assert.equal(tradeItemKeys(currentTrade()!).size, 0);
  });
});

describe("requestTrade", () => {
  it("asks the page world for a fresh snapshot", () => {
    const before = postedToPage.length;
    requestTrade();
    const sent = postedToPage[before] as { source?: string; type?: string } | undefined;
    assert.equal(sent?.type, "request-trade");
  });
});
