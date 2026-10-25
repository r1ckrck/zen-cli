# zen-cli

Control the [Zen browser](https://zen-browser.app) from the command line. List tabs across Spaces, read pages, click, type, fill forms, upload files, take screenshots. Built for Claude Code, and just as usable by hand.

## Requirements

- macOS or Windows
- Zen browser
- Node.js 22 or newer

## Install

```sh
npm install -g git+https://github.com/r1ckrck/zen-cli.git
zen-cli setup
```

`setup` prepares your Zen profile for remote control and installs the Claude Code skill. It's safe to run again.

## Quick start

```sh
zen-cli start                     # restart Zen with remote control on (asks first)
zen-cli tabs                      # tabs in the current Space
zen-cli open https://github.com   # open a page
zen-cli read                      # outline of the page, with numbered elements
zen-cli click e12                 # click element 12
zen-cli type e5 "hello" --enter   # type into element 5 and press Enter
```

Quit and reopen Zen to turn remote control off.

## Commands

### See

| Command | What it does |
|---|---|
| `zen-cli tabs [--all] [--space <name>]` | List tabs with their Space and folder |
| `zen-cli layout` | Show Spaces, Essentials, folders and pinned tabs |
| `zen-cli read [tab] [eN] [--full] [--find "text"]` | Outline of a page with numbered elements, one section, or matching elements |
| `zen-cli text [tab] [--max N]` | Readable text of a page |
| `zen-cli shot [tab] [eN]` | Screenshot of a page or element |

### Act

| Command | What it does |
|---|---|
| `zen-cli open <url> [--new] [--space <name>]` | Open a page, reusing a matching pinned tab |
| `zen-cli go <tab>` / `zen-cli close <tab>` | Switch to or close a tab (pinned tabs need `--force`) |
| `zen-cli back` / `forward` / `reload` | Navigate |
| `zen-cli click eN` | Click an element |
| `zen-cli type eN "text" [--enter]` | Type into a field |
| `zen-cli select eN "option"` | Choose from a dropdown |
| `zen-cli upload eN <file...>` | Attach files |
| `zen-cli press <key>` | Press a key, e.g. `Enter` or `Meta+L` |
| `zen-cli scroll down\|up\|left\|right [px]` | Scroll the page |
| `zen-cli dialog accept\|dismiss ["text"]` | Answer an alert, confirm, prompt or leave-page dialog |
| `zen-cli js "code" [eN]` | Run JavaScript in the page, optionally with an element |

Add `--read` to any action to see the page outline right after it.

### Manage

| Command | What it does |
|---|---|
| `zen-cli setup` | Prepare your profile and install the Claude Code skill |
| `zen-cli start [--restart]` | Start Zen with remote control on; `--restart` restarts an open Zen |
| `zen-cli status` | Check that everything is connected |
| `zen-cli guide` | Full usage guide |
| `zen-cli help` | Command list |

## Configuration

zen-cli finds Zen and your default profile on its own. To override:

| Setting | Flag | Environment variable | Default |
|---|---|---|---|
| Zen app | | `ZEN_CLI_APP` | Usual install location |
| Profile | `--profile <name\|path>` | `ZEN_CLI_PROFILE` | Zen's default profile |
| Port | `--port <n>` | `ZEN_CLI_PORT` | `9333` |

## Uninstall

```sh
npm uninstall -g zen-cli
```

Then delete `~/.claude/skills/zen-cli/` and the `zen-cli` lines in your Zen profile's `user.js`.

## Credits

Parts of the page reader and input handling come from [zenpilot](https://github.com/beSaif/zenpilot) (MIT).

## License

[MIT](LICENSE)
