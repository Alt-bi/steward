# Cards Factory — plan (feature `cards`, page `/my/badges`)

Goal: see which games still have card drops, then earn those drops like SteamLVLUP
Card Factory does — up to 32 games in a stream. GitHub only until the user says
otherwise.

## Reality captured 2026-08-31 (live probes, read-only, bot account)

- `/my/badges` is **SSR now**, like the market went in 2026. The old
  `ajaxallbadges?p=N` fragment endpoint answers with a full SSR page — there is
  no cheap AJAX path anymore. Pagination is plain `?p=N`, 150 rows per page,
  footer says `Showing 1-150 of 296 badges`.
- Row markup is legacy classes inside the SSR shell: `.badge_row_inner`,
  `.badge_title`, `.progress_info_bold` («4 card drops remaining» / «No card drops
  remaining»), `.badge_progress_info` («3 of 7 cards collected»). Foil badges are
  a separate row titled `… - Foil Badge` with no drop counter.
- **The appid is not in an href inside `.badge_row_inner`** — the
  `/gamecards/<appid>/` overlay anchor is its sibling. The dependable source is
  the row id `badge_gamebadge_<appid>_<badge_type>_<n>`.
- A gamecards page (`/id/<user>/gamecards/730/`) no longer carries
  `start_flash_session_button` / Start Playing — the browser-side
  «launch to earn drop» button is gone. Browser-emulated launching is dead;
  this decides phase 2.
- The probe counted 17 rows with drops remaining on the bot account; drop
  source («Drops earned by purchasing») shows on rows — F2P-without-purchase
  games can be filtered out before farming them.

## Phase 0 — scanner — SHIPPED in 2.26.0 (notes below)

`src/steam/badges.ts`:
- fetch `…/my/badges/?l=english&p=N` (fetchText, SSR page) until a page carries
  no rows or the footer total is covered; kind `badges` added to NetKind/LIMITS
  at a reading rate; cached for the page lifetime like wears.
- parse rows by the anchors above → `{ appid, name, dropsRemaining,
  cardsCollected, cardsTotal, foil, source }`; skip foil rows, skip
  «No card drops remaining».
- `test/fixtures/badges-page1.html` + a live-shapes test on the captured page —
  same rule as the other four fixtures: captured verbatim, recaptured not
  hand-edited. The repo is PUBLIC, so capture must redact first (profile
  names/URLs, steamID, avatars) — the capture script asserts nothing personal
  survives. Parsing itself is regex-over-text like `hoverRefs`, no DOM needed.

Success check: scanner finds the same 17-row list the probe found, in ≤2 requests.

## Phase 1 — «Карточки» section on /my/badges — SHIPPED in 2.26.0 (notes below)

- list unfinished sets with a checkbox per game, «N дропов», price of the set via
  the existing price pipeline (sum of cheapest cards) so farming sorts by money;
- select → «в очередь» (max 32); status counts what dropped since (rescan diff).

## Phase 2 — earning the drops (execution engine) — SHIPPED in 2.27.0

Shipped shape: mode select (steam://run / ASF-бот), `asf/exec` through the
worker (loopback host permission), `play` in 32-appid batches, `reset` to
stop, `тест` pings `status`. The engine itself (ASF install + login) stays
the user's step — docs below say how.

The drop is a **Steam-protocol** event (a playing session), not a web call. The
flash-session button is dead, so a content script cannot «launch» anything. Two
honest executors:

- **A. `steam://run/<appid>`** opened from the panel: the installed Steam client
  really launches the game and time accrues. Works today, zero infra. 32
  simultaneous games means 32 real processes — fine for a strong gaming PC, not
  for a laptop; Valve also caps how fast drops accrue.
- **B. ASF (ArchiSteamFarm)** — the real «32 games in a stream», same trick
  SteamLVLUP runs server-side: ASF farms via SteamKit2 without launching the
  games. Extension becomes the dispatcher: panel → background SW → `POST
  http://localhost:1242/Api/Command` with `{Command: "play <appids>"}`
  (host_permissions += `http://localhost:1242/*`; contract read from ASF
  sources, see `src/core/asf.ts`). If ASF is not running yet, step one is
  installing it (user's bot machine; login stays the user's).

Default build order ships 0+1 first (read-only, useful even with engine A); B
hooks in behind the same queue UI once ASF exists.

## Phase 3 — feedback loop

- rescan cadence (cheap: pages change only after drops land); diff «было 4 →
  стало 2»; badge-ready notice (crafting stays manual, burning cards is
  irreversible); cards-in-inventory via the existing 753 inventory path.

## Risks

- Valve SSR-waved badges once already; if the row classes churn again the
  fixtures fail loudly in tests, not silently in the panel.
- Drop accrual is time-based per game (hours–days); no tool beats that, Card
  Factory included — the UI must show ETA honestly.
- Farming tooling is ToS-grey; the bot exists by user's earlier decision, this
  feature only widens it. Engine B keeps the bot's credentials inside ASF, the
  extension never sees them.
