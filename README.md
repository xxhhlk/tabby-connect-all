# tabby-connect-all

A Tabby plugin that **connects every restored session in the background on startup**, instead of waiting for you to click each tab.

> Tabby's built-in *Restore terminal tabs on app start* (`recoverTabs`) only rebuilds the tabs. The connection itself is made from the terminal frontend's `onFrontendReady()`, and an inactive tab never attaches its frontend — so with 10 saved sessions you click 10 times and watch 10 banners scroll by. This plugin does it all at once, before you look.

## Features

- After Tabby restores your tabs, every not-yet-connected **SSH / Telnet / Serial** session is connected concurrently
- Works with sessions inside split panes
- Output produced while a tab sits in the background is buffered by Tabby and flushed the moment you open the tab — **nothing is lost**, and you don't miss the login banner or prompt
- The tab header's activity marker (the 2 px line at the bottom of the tab) is lit up on the sessions that came up, so you can see at a glance which ones are live
- Configurable from the GUI (**Settings → Connect All**) or from the config file: delay, session types, initial PTY size, activity marker

## Installation

### From npm

```bash
cd "%APPDATA%\tabby\plugins"                              # Windows
# macOS: cd ~/Library/Application\ Support/tabby/plugins
# Linux: cd ~/.config/tabby/plugins
npm install tabby-connect-all
```

Then **restart Tabby completely**.

Alternatively: Tabby → Settings → Plugins → **Available** → search `connect-all` → *Get*.

> **Two reasons the in-app search may look empty.**
>
> 1. **It is already installed.** The Available tab hides every plugin that is already present: `ngb-panel(*ngIf='!isAlreadyInstalled(plugin))` in `pluginsSettingsTab.component.pug`. If you installed it with the `npm install` command above, look under the **Installed** tab instead — that is where it lives.
> 2. **npm's search index has stopped picking up newly created packages.** Tabby's list comes from `https://registry.npmjs.com/-/v1/search?text=keywords:tabby-plugin%20<query>`, sorted by npm's `searchScore`. Measured on 2026-10-05, across all 162 packages with the `tabby-plugin` keyword, the only three with `searchScore: 0` were the only three created after 2026-09-26 — including this one. Every package created on or before 2026-09-26 scored 4.3–46. A zero score puts the entry at the bottom of the list, and npm search *re-ranks* rather than *filters*, so typing the exact name does not pull it out. Download counts are not the cause (`tabby-opencode-status` has 292 weekly downloads and still scores 0). Nothing is wrong with the package name or keywords — Tabby does receive the entry, just last. Until npm's index catches up, use the `npm install` command above.

### From source

Copy this folder to `%APPDATA%\tabby\plugins\node_modules\tabby-connect-all` and restart Tabby. There is no build step — the plugin is plain CommonJS.

## Requirements

- Tabby 1.0.230+ (developed and tested against 1.0.231-nightly)
- *Restore terminal tabs on app start* enabled — Settings → Terminal → Startup. It is on by default.
- Credentials for the sessions must be available without prompting: store passwords and key passphrases in the Tabby Vault, or tick *Remember* on the passphrase prompt. Otherwise a background session stops at the password prompt, exactly as it would during a normal restore.

## Configuration

Everything is editable in the GUI: **Settings → Connect All** (tab with a plug icon). The same values live under `connectAll` in the config file, so you can also edit them by hand.

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | Turn the startup pass off without uninstalling |
| `delayMs` | `2000` | Grace period after the tab recovery pass finishes |
| `types` | `[ssh, telnet, serial]` | Profile types to connect — tick `local` to also pre-start local shells |
| `markActivity` | `true` | Call `displayActivity()` on tabs that connected |
| `initialSize` | `{columns: 80, rows: 24}` | PTY size used until the tab is opened and a real resize arrives. Unit: **character cells** (columns × rows), not pixels |

Config file equivalent:

```yaml
connectAll:
  enabled: true
  delayMs: 2000
  types: [ssh, telnet, serial]
  markActivity: true
  initialSize:
    columns: 80
    rows: 24
```

### About `initialSize`

The values are a character grid — `columns × rows` in terminal cells, the same thing `stty size` reports. They are handed to the remote PTY (`tabby-ssh` calls `resizePTY({ columns, rows, pixHeight: 0, pixWidth: 0 })`, which is why the pixel fields are hardcoded to 0). Values are clamped on read: columns to 20–1000, rows to 5–500, anything non-numeric falls back to the default.

Two things follow from that:

- **It only applies while the tab is in the background.** The moment you open the tab, the frontend reports its real size and overwrites it (`baseTerminalTab.component.ts` subscribes to `frontend.resize$` and assigns `this.size`).
- **Scrollback written in the background keeps the wrapping it was printed with.** Terminal history is a character stream, not reflowable text, so a line that wrapped at 80 columns stays wrapped after you open the tab wider. If a background session prints long lines, set columns to at least your usual window width.

To see what a session is really using, run this **inside the session** (not in your local shell):

```bash
stty size          # prints "rows columns" — rows first, unlike this setting
tput cols; tput lines
echo "$COLUMNS x $LINES"   # bash/zsh keep these up to date after a resize
```

Note the order: `stty size` prints **rows first**, while the GUI asks for **columns first**.

### About the marker at the bottom of the tab

That line is `.activity-indicator` (`tabHeader.component.scss`: `bottom: 4px; left: 10px; right: 10px; height: 2px`, coloured `var(--bs-body-color)` at `opacity: .2`). It means *this tab has output you haven't looked at*.

Tabby only calls `displayActivity()` from the `binaryOutput$` subscription, and a background session's output is held in `BaseSession.initialDataBuffer` until `releaseInitialDataBuffer()` runs on the first `onFrontendReady()`. So a tab connected here would never light up on its own. The plugin calls `displayActivity()` directly once the connection is up — which is also semantically correct, because the session really has produced output you haven't seen.

It clears itself when you focus the tab (`AppService` calls `clearActivity()`), and can be cleared manually from the tab context menu. Set `markActivity: false` to opt out.

## How it works

After `config.ready$` and once `app.tabs` is populated, the plugin walks the tab list (flattening `SplitTabComponent` containers with `getAllTabs()`) and calls `initializeSession()` on every connectable session that isn't up yet, all in parallel via `Promise.allSettled()`.

Four things had to be handled, and they are the reason this plugin exists rather than being a one-liner:

| Problem | Handling |
|---|---|
| `tab.size` is `undefined` until the frontend emits its first resize, and `SSHTabComponent` reads `this.size.columns` *after* `await session.start()` — so the call throws once the shell channel is already open, Tabby retries with a second connection, and the first one leaks | Seed `tab.size` before connecting |
| Activating a tab runs `onFrontendReady()` → `initializeSession()` again, opening a **second** connection and orphaning the background one | Wrap the instance's `initializeSession` with a consume-once flag so the activation-time call is swallowed; manual *Reconnect* still works |
| `setupOneSession()` immediately writes `Connecting to <host>` to the frontend, while the saved scrollback is only appended later by `onFrontendReady()` — the terminal would show *Connecting → history → live output* | Write `savedState` into the frontend and clear it before connecting, restoring *history → Connecting → live output* |
| A tab connected in the background shows no activity marker, because the marker is driven by output that is still buffered | Call `tab.displayActivity()` after a successful connect |

The plugin is a plain CommonJS Angular module — no build step. Since there is no TypeScript compiler to emit `design:paramtypes`, the constructor metadata is declared by hand with `Reflect.defineMetadata` (plus the static `parameters` form). The settings tab is a component with an inline template declared in the plugin's own `NgModule`, which registers a `SettingsTabProvider` (`tabby-settings`) and a `ConfigProvider` (`tabby-core`) so the defaults show up in the config file. `xterm.open()` is deliberately never called: it has no re-entrancy guard, so attaching a frontend twice would append a second terminal element.

## Testing

```bash
npm test
```

The harness stubs `@angular/core`, `@angular/common` and `tabby-core` through `Module._load` and drives the module constructor with fake tabs. It asserts type filtering, split-pane flattening, concurrent start (measured spread of 0 ms), PTY size seeding and clamping, scrollback pre-write, the failure path, activity marking, and that exactly one `initializeSession()` call is swallowed on activation while a later reconnect still goes through.

## Limitations

- Startup only — tabs opened later behave normally.
- Sessions whose credentials are not stored will stop at the password prompt in the background.
- Very many sessions (dozens) will open that many connections at once; raise `delayMs` or narrow `types` if your network or bastion does not like it.

## License

MIT
