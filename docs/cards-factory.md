# Cards Factory — feature `farm`, page `/chat` (#stw-farm)

Goal: farm card drops like SteamLVLUP Card Factory — up to 32 games in a
stream — with nothing but the browser the user already logged into. GitHub
only until the user says otherwise.

## Where the interface lives (2026-09-01, final shape)

- **`/chat` page, panel tab «Фабрика карточек»** — the whole machine, and it
  has no settings. Three counters (в игре · ждут очереди · дропов осталось),
  four buttons (Старт · Стоп · Пересчитать · Забрать себе), the scan bar, the
  socket line, the list of games that still owe cards — bench first, each with
  its cards-collected count and a «в игре» tag — and the drop log. It talks to the
  MAIN bridge through the local relay, so the claimed set and the socket live
  in the same tab. `#stw-farm` opens the tab straight onto this section
  (hashchange-aware).
- **There is no queue, no tick-list, no auto switch and no forever-ban.** They
  shipped in 2.30.x and were deleted in 2.32.0: four independent ways to narrow
  the farm meant four ways to reach an empty intersection, and twice the user
  ended up with a fully working factory that had excluded every game it could
  farm. The rule now is one line — everything Steam still owes cards for.
- **`/my/badges` keeps no UI** — one button «Открыть фабрику карточек»
  (feature `cards`), and the popup button does the same. Two windows used to
  split the controls from the socket; the user asked for one window.
- Engine options ASF-бот/steam://run are gone: the holder CT was torn down and
  the chat client is proven (user-confirmed drop delta on 2.29.x). The old
  badges tab remains in git history if the client-launch mode is ever wanted.

## How the socket is found (2026-09-01)

Two paths, and the second one is the floor:

1. `g_FriendsUIApp.m_CMInterface.m_Socket` — Steam's own field. Fast, and a
   private name with no contract: when it is renamed the farm dies silently.
2. **`WebSocket.prototype.send` is patched** at `document_start`, before the
   chat builds its socket. Every outgoing frame is run through
   `readFrameHeader`: whichever socket sends a parseable CMsgProtoBufHeader
   *is* the CM socket, and that header carries the account's steamid and CM
   session id. The chat's own ~9 s heartbeat therefore hands us both ids
   without reading one Steam symbol.

   Replacing `window.WebSocket` with a Proxy was written first and reverted the
   same day: a swapped global constructor under a page whose entire job is that
   socket can break the chat itself, and a broken chat is indistinguishable
   from a broken farm. Patching the prototype method is invisible to anything
   the page can ask about itself, and it catches sockets built before us.

The same sniffer is why `m_Session.m_nSessionID` is no longer load-bearing, and
why a reconnect (Steam rebuilds the socket on every hiccup) is re-claimed
within two seconds rather than at the next keep-alive.

## Why the bench fills before the scan finishes

The badges walk is paced by the shared net gate to a few pages a minute, so a
full library takes one to two minutes. The factory used to decide the whole
bench from that finished walk, which meant «Старт» was followed by minutes of a
switched-on factory claiming nothing — reported as «начало фармить только
спустя 1-2 минуты», and, worse, painted red («крутится, но чат не поставил ни
одной игры») for the whole wait.

`primeBench()` reads page one alone and claims the most-owed games off it
within seconds; the full walk then corrects the bench as usual. It costs one
extra page request and only runs when the bench is empty, so a working factory
never pays for it. Its companion is the status machine: an empty bench is
«запускаюсь» until a scan has actually completed in this tab, and only then can
it be an error. A red line the user cannot act on is worse than no line.

The walk also reports itself now (`BadgeScanProgress`, twice per page — before
the fetch and after the parse) and the panel draws a bar from it. A minute of
honest rate-limited waiting looked exactly like a hang, which is how it was
reported.

## Who knows what is claimed

`chrome.storage` holds the factory's **intent**; the MAIN bridge holds the
**fact**, and page memory dies on every reload — an F5, an Edge sleep, an
extension update (updates reload every Steam tab by design). The rotation asks
the bridge (`cm-play/state`) and compares against the appids on the wire.
Comparing the new bench against the stored one was the 2.30.x silent death:
they always matched after a reload, the swap was skipped, and the panel
reported «идёт: в игре 8» over a socket carrying nothing. An unanswered bridge
counts as *nothing claimed*, never as *no change*.

## The engine (how the claim reaches Steam)

The chat page's own CM websocket carries `CMsgClientGamesPlayed` (EMsg 742).
Our encoder is byte-identical to a golden frame captured off a working Card
Factory run (`cm-play.test.ts` pins it). Steam credits the *web session* — no
server, no bot, no password; the only oracle for "dropped" is the badge page
counter («пересчитать» / the factory's own 5-min scan). Closing the chat tab
ends the claim; that is Steam's model, not our bug.

Rotation: every 2 min the factory rescans `/my/badges` (SSR pages, 150 rows),
`farmTick` (pure, `farm/engine.ts`, 11 tests) decides — counter zero on a
complete scan ⇒ finished (never revived), the bench keeps its seats and
everything else owed joins it up to 32, swaps
ride `cm-play/swap` so the ~25 s keep-alive never idles. A partial scan can
never mark a game finished; an all-failed scan never ends the run. A page that
parsed to **zero rows is not a complete scan** unless Steam's own footer says
zero badges — otherwise moved markup reads as «every game finished at once»
and retires the whole farm.

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
