# tabby-connect-all

A Tabby plugin that **connects every restored session in the background on startup**, instead of waiting for you to click each tab.

> Tabby's built-in *Restore terminal tabs on app start* (`recoverTabs`) only rebuilds the tabs. The connection itself is made from the terminal frontend's `onFrontendReady()`, and an inactive tab never attaches its frontend — so with 10 saved sessions you click 10 times and watch 10 banners scroll by. This plugin does it all at once, before you look.

## Features

- After Tabby restores your tabs, every not-yet-connected **SSH / Telnet / Serial** session is connected concurrently
- Works with sessions inside split panes
- Output produced while a tab sits in the background is buffered by Tabby and flushed the moment you open the tab — **nothing is lost**, and you don't miss the login banner or prompt
- The tab header's activity marker (the 2 px line at the bottom of the tab) is lit up on the sessions that came up, so you can see at a glance which ones are live
- Configurable: delay, session types, initial PTY size, activity marker

## Installation

### From npm

```bash
cd "%APPDATA%\tabby\plugins"                              # Windows
# macOS: cd ~/Library/Application\ Support/tabby/plugins
# Linux: cd ~/.config/tabby/plugins
npm install tabby-connect-all
```

Then **restart Tabby completely**.

Alternatively: Tabby → Settings → Plugins → search `connect-all` → Install.

### From source

Copy this folder to `%APPDATA%\tabby\plugins\node_modules\tabby-connect-all` and restart Tabby. There is no build step — the plugin is plain CommonJS.

## Requirements

- Tabby 1.0.230+ (developed and tested against 1.0.231-nightly)
- *Restore terminal tabs on app start* enabled — Settings → Terminal → Startup. It is on by default.
- Credentials for the sessions must be available without prompting: store passwords and key passphrases in the Tabby Vault, or tick *Remember* on the passphrase prompt. Otherwise a background session stops at the password prompt, exactly as it would during a normal restore.

## Configuration

Optional. Defaults are in the table below; override them in `%APPDATA%\tabby\config.yaml` (macOS/Linux: `~/.config/tabby/config.yaml`).

```yaml
connectAll:
  enabled: true
  delayMs: 2000                  # wait after tab recovery before connecting
  types: [ssh, telnet, serial]   # add `local` to also pre-start local shells
  markActivity: true             # light up the tab's activity marker once connected
  initialSize:
    columns: 80
    rows: 24
```

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | Turn the startup pass off without uninstalling |
| `delayMs` | `2000` | Grace period after the tab recovery pass finishes |
| `types` | `[ssh, telnet, serial]` | Profile types to connect |
| `markActivity` | `true` | Call `displayActivity()` on tabs that connected |
| `initialSize` | `{columns: 80, rows: 24}` | PTY size used until the tab is opened and a real resize arrives |

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

The plugin is a plain CommonJS Angular module — no build step. Since there is no TypeScript compiler to emit `design:paramtypes`, the constructor metadata is declared by hand with `Reflect.defineMetadata` (plus the static `parameters` form). `xterm.open()` is deliberately never called: it has no re-entrancy guard, so attaching a frontend twice would append a second terminal element.

## Testing

```bash
npm test
```

The harness stubs `@angular/core`, `@angular/common` and `tabby-core` through `Module._load` and drives the module constructor with fake tabs. It asserts type filtering, split-pane flattening, concurrent start (measured spread of 0 ms), PTY size seeding, scrollback pre-write, the failure path, activity marking, and that exactly one `initializeSession()` call is swallowed on activation while a later reconnect still goes through.

## Limitations

- Startup only — tabs opened later behave normally.
- Sessions whose credentials are not stored will stop at the password prompt in the background.
- Very many sessions (dozens) will open that many connections at once; raise `delayMs` or narrow `types` if your network or bastion does not like it.

## License

MIT
