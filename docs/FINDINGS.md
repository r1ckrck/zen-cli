# Findings

Verified behaviour of Zen 1.23.4b, macOS, Node 24. Step 0 checks ran in throwaway profiles, except checks 5 and 10 in the real profile; build findings came from throwaway profiles and the local fixture.

## Step 0: protocol checks

## Results

| # | Check | Result |
|---|---|---|
| 1 | One BiDi session at a time | **Confirmed.** A second `session.new` fails with "Maximum number of active sessions". |
| 2 | Tab (context) ids per session | **Confirmed.** Ids change with every new session. |
| 3 | Session after a dropped socket | **Zombie confirmed.** Dropping the socket without `session.end` blocks all new sessions. Reattaching via `/session/<id>` is refused, so only a Zen restart clears it. |
| 4 | Element sharedId lifetime | **Per session.** A sharedId from one session fails with "no such node" in the next. |
| 5 | `--space` on a running Zen | **Works.** `zen --profile <path> --space Work <url>` opens the tab in Work and switches the window to Work. |
| 6 | Safety pref | **Required.** Without `remote.prefs.recommended = false`, Safe Browsing (malware and phishing) and the popup blocker are **off** while remote control runs, and dummy telemetry ids persist in `prefs.js`. With it, all stay on. A clean quit restores the safety prefs either way; a crash would not. |
| 7 | Remote-control indicator | **Present.** The browser window gets `remotecontrol="true"`, which Firefox shows as a striped address bar and robot icon. |
| 8 | Automation visible to sites | `navigator.webdriver` is `true`. Google's sign-in page loads with no warning on the first screen; later steps not tested (no sign-in). |
| 9 | `--remote-allow-system-access` | **Works.** `getTree` with `"moz:scope": "chrome"` returns the browser window, and scripts there read Zen's own state: Spaces, active Space, selected tab, and every tab with its Space, folder, pinned and Essential flags, including unloaded tabs. Without the flag, the same call is refused. |
| 10 | Activating an unloaded pinned tab | **Works** with system access: selecting the tab loads it (Thingiverse loaded and became the selected tab). Plain BiDi sees only loaded tabs: 1 of 75 at launch. |
| 11 | Claude Code sandbox | **No blocks.** A Unix socket in the OS temp dir and connections to `127.0.0.1` work from Claude Code's shell without prompts. |

## Other findings

- **Node's built-in WebSocket works.** The remote agent accepts it (it sends no Origin header), so zero dependencies holds.
- **Timings** on a warm session: connect 16 ms, `session.new` 4 ms, `getTree` 4 ms, script evaluate 8 ms, screenshot 35 ms. The 300 ms command budget has wide margin.
- **The session file on disk can lag behind Zen.** With Mozilla account sync on, Zen restored two pinned tabs at launch that weren't in `zen-sessions.jsonlz4` on disk. Live state from Zen is the source of truth; the file is only right while Zen is closed and synced.
- **`gBrowser.tabs` lists only the active Space** (plus Essentials). All tabs come from the tab elements in the window (`tab.tabbrowser-tab`).
- **Launch and quit:** starting the Zen binary with `--profile <path> --remote-debugging-port <port>` works; graceful quit through `NSRunningApplication.terminate` saves the session.
- **Not tested:** Windows. Windows code paths are built but not run on Windows in this build.

## Build findings

| Area | Finding | Handling in zen-cli |
|---|---|---|
| Tabs in inactive Spaces | Zen keeps their browsers out of `gBrowser.browsers`, which also hides them from BiDi: they can't be read, clicked or screenshotted until their Space is active. | `chromeState` marks them `hidden`; commands on them say `go tN` switches Spaces first. `open --space` creates the tab there and reports that acting on it needs `go`. |
| Chrome tab → BiDi context | `NavigableManager.getIdForBrowser(tab.linkedBrowser)` (chrome scope) returns the BiDi context id of a tab's browser. | Used to map Zen's tabs to BiDi contexts. |
| Blank tabs in a Space | A tab added as `about:blank` turns into Zen's empty-tab placeholder (`zen-empty-tab`). | `open --space` adds the tab with the real URL. |
| Dialog events | `userPromptOpened` only covers dialogs opened during the current session, and never fires for `alertCheck`/`confirmCheck` (the variants with "don't allow this site to prompt again" that Firefox shows after repeated dialogs). BiDi's `handleUserPrompt` refuses those types. | With system access, open dialogs are read from each tab's `tabDialogBox` before every command and after every action, and answered by clicking the dialog's own buttons. Without system access, a repeated dialog can block the page; the timeout error says so. |
| Input while a dialog is open | `input.performActions` doesn't return until the dialog that the click opened is answered. | Actions race the input command against dialog detection and return as soon as a dialog appears. |
| Uploads | `input.setFiles` needs `dom.file.createInChild`, which the remote agent's recommended prefs normally set; `remote.prefs.recommended = false` leaves it off. | `upload` turns the pref on only around `setFiles`, then restores it. `status` reports it if it's ever left on. Needs system access. |
| macOS folder privacy | Uploading a file from Documents, Desktop or Downloads makes macOS ask whether Zen may access that folder. Until the user answers, Zen's main thread blocks and every command times out. | The guide tells Claude to prefer other folders or warn the user. |
| Welcome screen | Until Zen's welcome screen is dismissed, pages get a 0x0 viewport and pointer clicks land nowhere. | `setup` sets `zen.welcome-screen.seen` when the profile hasn't passed it; actions report a no-size page with that fix. |
| Large scrolls | Wheel input can stop short of large deltas. | `scroll` finishes the remainder with a direct scroll. |
| Helper memory | macOS RSS for any Node 24 process starts around 54 MB (shared libraries). The helper's physical footprint, which Activity Monitor shows, is about 23 MB versus 11 MB for an idle Node process. | The memory budget is measured as physical footprint. |
| Latency | Commands take 33–55 ms end to end, of which about 22 ms is Node startup. `read` on GitHub, BBC News and Wikipedia takes 54–120 ms. | Within the 300 ms and 1 s budgets. |
| Output size | Compact reads of heavy pages (GitHub, BBC News, Wikipedia) exceed 2,000 tokens uncapped. | Compact output is capped at 5,400 characters (about 1,500 tokens) with link targets shortened; truncation says how many lines were shown and how to narrow. |

## Fresh-agent test (step 6)

A Claude agent given only the skill completed three real tasks unaided in 12 commands: an add/remove-elements count, a login read off the page, and the first GitHub issue title. Its friction points shaped the final behaviour: `--full` shows labels up to four times longer, outlines keep result and error messages as `status` lines, `--find` ignores link targets unless the text looks like a path, `open` only reuses tabs zen-cli opened, and the guide says when refs stay valid.

## Design consequences

Reflected in [PLAN.md](PLAN.md).

1. **Use system access by default.** `zen-cli start` launches with `--remote-allow-system-access`. `tabs`, `go` and `open` use Zen's live state: all tabs across Spaces, unloaded pinned tabs, real selected tab, Space and folder per tab. This removes the active-tab heuristic and URL matching. `layout` reads live state while Zen runs and falls back to the session file when it's closed.
   - Cost: any local program that connects to the port can run privileged code in Zen (for example, read files the browser can read), not just control pages. The port stays bound to `127.0.0.1`.
   - Fallback: if Zen runs with the port but without system access, commands still work with the plain-BiDi limits.
2. **Zombie handling.** Only the helper ever owns the session. It ends the session on every exit path it can catch (normal exit, idle exit, SIGINT, SIGTERM, uncaught errors). A killed `zen-cli` command can't leave a zombie because it never owns the session. If the helper itself is force-killed, `zen-cli start` and `zen-cli status` detect "Maximum number of active sessions" and offer a Zen restart.
3. **`open --space` without moving the user's view.** Zen's `--space` flag switches the window to that Space. With system access, zen-cli adds the tab to the Space directly instead, so the user's view stays put.
4. **Element refs** live only as long as the helper's session. Refs from before a helper restart fail cleanly and ask for a fresh read.
5. **`setup` must run before the first `start`.** The safety pref has to be in `user.js` before Zen launches with the port. `start` refuses to launch without it.
