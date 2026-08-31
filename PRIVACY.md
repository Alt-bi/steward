# Privacy policy

Steward is a browser extension. It has no account, no server, and no analytics.

## What Steward does

It runs on `steamcommunity.com` pages (inventory, Community Market, trade offers). It reads what the page already shows, talks to Steam's own endpoints using the session you already have in the browser, and draws a panel on top of those pages.

## What Steward does not do

- It does not send data to Steward authors or to any third party.
- It does not include ads, trackers, crash reporters, or telemetry.
- It does not require a Steward login.
- It does not collect float databases, browsing history, or inventories of other users except what Steam already puts on the page you opened.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Settings, the price cache, sale histories, the panel choices you made last (sort order, price level), the names of items Steam has already told us about, and the request-budget counters stay in your browser profile. |
| `https://steamcommunity.com/*` | Market prices, listings, inventory, and trade pages. Every network call Steward makes goes here. |

Nothing is uploaded. Clearing the extension's storage, or uninstalling it, removes everything it kept.

## Purchases and listings

A one-click buy or a bulk list talks only to Steam, the same way the stock Steam UI does. Steward never sees your password, Steam Guard secret, or wallet beyond what the page already exposes to scripts (`g_sessionID`, `g_rgWalletInfo`).

## Changes

If this policy ever changes, the change will land in this file in the public repository before a store release that needs it.
