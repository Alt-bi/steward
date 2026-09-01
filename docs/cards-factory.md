# Cards Factory — feature `farm`, page `/chat` (#stw-farm)

Goal: farm card drops like SteamLVLUP Card Factory — up to 32 games in a
stream — with nothing but the browser the user already logged into. GitHub
only until the user says otherwise.

## Where the interface lives (2026-08-31, final shape)

- **`/chat` page, panel tab «Фабрика карточек»** — the whole machine: badge
  scan (stats + checkbox list), queue, rotation (evict finished, promote next),
  auto-mode, drop log. It talks to the MAIN bridge through the local relay, so
  the claimed set and the socket live in the same tab. `#stw-farm` opens the
  tab straight onto this section (hashchange-aware).
- **`/my/badges` keeps no UI** — one button «Открыть фабрику карточек»
  (feature `cards`), and the popup button does the same. Two windows used to
  split the controls from the socket; the user asked for one window.
- Engine options ASF-бот/steam://run are gone: the holder CT was torn down and
  the chat client is proven (user-confirmed drop delta on 2.29.x). The old
  badges tab remains in git history if the client-launch mode is ever wanted.

## The engine (how the claim reaches Steam)

The chat page's own CM websocket carries `CMsgClientGamesPlayed` (EMsg 742).
Our encoder is byte-identical to a golden frame captured off a working Card
Factory run (`cm-play.test.ts` pins it). Steam credits the *web session* — no
server, no bot, no password; the only oracle for "dropped" is the badge page
counter («пересчитать» / the factory's own 5-min scan). Closing the chat tab
ends the claim; that is Steam's model, not our bug.

Rotation: every 2 min the factory rescans `/my/badges` (SSR pages, 150 rows),
`farmTick` (pure, `farm/engine.ts`, 11 tests) decides — counter zero on a
complete scan ⇒ finished (never revived), promote the next up to 32, swaps
ride `cm-play/swap` so the ~25 s keep-alive never idles. A partial scan can
never mark a game finished; an all-failed scan never ends the run.

## Reality captured 2026-08-31 (live probes, read-only)

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
  `start_playing` — the SSR wave removed the Start Playing control entirely.
  There is nothing in-page to automate for per-game play.
- The profile banner is NOT a receipt: while Card Factory farmed the same
  account, the public profile stayed «Currently Online». Only badge counters
  move. A «Steam NOT seeing the game» verdict from the banner is false.
- Card Factory's own 742 frame (captured through our ring while it ran)
  carries the account's ordinary web sessionid — their «server» only encodes
  bytes. This is what proved the browser-only path was real.
