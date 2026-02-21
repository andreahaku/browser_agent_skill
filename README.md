# Browser Agent

Chrome automation CLI for AI agents via the DevTools Protocol. Zero dependencies -- uses raw WebSocket CDP, runs on Bun.

## Features

- **26 commands** covering navigation, page reading, interaction, output, and browser state
- **Zero dependencies** -- raw WebSocket CDP, no Playwright or Puppeteer
- **Bun-native** -- fast startup, single-file build
- **AI-agent friendly** -- deterministic CLI interface, structured output, fuzzy text matching
- **Claude Code skill included** -- drop-in skill folder for Claude Code integration

## Requirements

- [Bun](https://bun.sh/) >= 1.0
- Google Chrome or Chromium
- macOS or Linux

## Quick Start

```bash
# Clone the repo
git clone https://github.com/andreahaku/browser_agent_skill.git
cd browser_agent_skill

# Start Chrome with remote debugging
bash scripts/start-chrome.sh --kill-existing

# Run commands
bun run dist/browser.js list
bun run dist/browser.js open "https://example.com"
bun run dist/browser.js content 0
bun run dist/browser.js screenshot 0 -o /tmp/example.png
```

## Install as Claude Code Skill

A prebuilt skill is included in the `skill/` folder. Copy it to your Claude Code skills directory:

```bash
cp -r skill/browser-agent ~/.claude/skills/
```

Claude Code will automatically detect and use the skill when you ask it to browse websites, take screenshots, fill forms, scrape content, etc.

## Commands

### Tab and Navigation

| Command | Description |
|---|---|
| `list` | List all open tabs with index, title, and URL |
| `open URL` | Navigate tab 0 to URL. Flags: `--new-tab`, `--tab N` |
| `close N` | Close tab at index N. Use `close all` for all tabs |
| `back [tab]` | Go back in browser history |
| `forward [tab]` | Go forward in browser history |
| `reload [tab]` | Reload the page. Use `--hard` to bypass cache |

### Reading Pages

| Command | Description |
|---|---|
| `content [tab]` | Get visible text content of a page |
| `html [tab]` | Get raw HTML source |
| `elements [tab]` | List interactive elements with clickable indices. `--json` for structured output |
| `search "query"` | Full-text search across all open tabs |
| `eval [tab] "js"` | Execute JavaScript in page context and print result. Alias: `js` |

### Interacting with Pages

| Command | Description |
|---|---|
| `click [tab] INDEX` | Click element by index (from `elements` output) |
| `click [tab] "text"` | Click element by visible text (fuzzy match) |
| `type [tab] "text"` | Clear and type into first editable field. `--selector "css"` for specific field, `--append` to not clear |
| `keypress [tab] KEY` | Press a keyboard key. `--selector "css"` to focus element first |
| `select [tab] "value" --selector "css"` | Choose dropdown option by value or visible text |
| `hover [tab] INDEX\|"text"` | Hover over an element. Also accepts `--selector "css"` |
| `scroll [tab] DIRECTION` | Scroll: `up`, `down`, `top`, `bottom`, `left`, `right`, pixel value, or CSS selector |
| `upload [tab] filepath` | Upload file to file input. `--selector "css"` for specific input |
| `wait [tab] "selector-or-expr"` | Wait for CSS selector or JS expression. `--timeout ms` (default 10s) |

### Output

| Command | Description |
|---|---|
| `screenshot [tab]` | Full-page screenshot. `-o path` to set output. `--viewport-only` for visible area |
| `pdf [tab]` | Save page as PDF. `-o path` to set output. `--landscape` for landscape |

### Browser State

| Command | Description |
|---|---|
| `cookies get [tab]` | List all cookies for current page |
| `cookies set name=value --domain X` | Set a cookie. Optional: `--path`, `--httpOnly`, `--secure` |
| `cookies delete name` | Delete a cookie by name |
| `cookies clear` | Delete all browser cookies |
| `storage get [key] [tab]` | Read localStorage. Omit key to list all. `--session` for sessionStorage |
| `storage set key value` | Write to localStorage. `--session` for sessionStorage |
| `storage delete key` | Remove a key. `--session` for sessionStorage |
| `storage clear` | Clear all storage. `--session` for sessionStorage |
| `console [tab] --duration ms` | Capture console output for N ms (default 5000) |
| `network [tab] --duration ms` | Monitor network requests for N ms. `--filter "str"` to filter by URL |
| `emulate DEVICE` | Emulate a device preset or custom resolution. `emulate reset` to clear |

### Device Presets

| Preset | Resolution | DPR | Mobile |
|---|---|---|---|
| `iphone-14` | 390x844 | 3x | Yes |
| `iphone-15-pro` | 393x852 | 3x | Yes |
| `ipad` | 820x1180 | 2x | Yes |
| `pixel-7` | 412x915 | 2.625x | Yes |
| `desktop-hd` | 1920x1080 | 1x | No |
| `desktop-4k` | 3840x2160 | 2x | No |

### Key Names for keypress

`Enter`, `Tab`, `Escape`/`Esc`, `Space`, `Backspace`, `Delete`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp`, `PageDown`, `F1`-`F12`, or any single character.

## Global Flags

| Flag | Description | Default |
|---|---|---|
| `--timeout-ms N` | Command timeout in milliseconds | 10000 |
| `--cdp-url URL` | Override CDP connection URL | `http://127.0.0.1:9222` |

## Examples

### Extract text from a page

```bash
bun run dist/browser.js open "https://example.com"
bun run dist/browser.js content 0
```

### Run JavaScript on a page

```bash
bun run dist/browser.js eval 0 "document.querySelectorAll('a').length"
bun run dist/browser.js eval 0 "Array.from(document.querySelectorAll('h2')).map(h => h.textContent)"
```

### Fill and submit a form

```bash
bun run dist/browser.js type 0 "user@email.com" --selector "#email"
bun run dist/browser.js type 0 "mypassword" --selector "#password"
bun run dist/browser.js click 0 "Sign in"
bun run dist/browser.js wait 0 ".dashboard" --timeout 5000
bun run dist/browser.js screenshot 0 -o /tmp/after-login.png
```

### Select dropdown and press Enter

```bash
bun run dist/browser.js select 0 "United States" --selector "#country"
bun run dist/browser.js keypress 0 Enter
```

### Save page as PDF

```bash
bun run dist/browser.js pdf 0 -o /tmp/article.pdf
```

### Emulate mobile device

```bash
bun run dist/browser.js emulate iphone-14
bun run dist/browser.js reload 0
bun run dist/browser.js screenshot 0 -o /tmp/mobile-view.png
bun run dist/browser.js emulate reset
```

### Debug: cookies, storage, console, network

```bash
bun run dist/browser.js cookies get 0
bun run dist/browser.js storage get 0
bun run dist/browser.js console 0 --duration 3000
bun run dist/browser.js network 0 --duration 3000 --filter "api"
```

### Get a YouTube transcript

```bash
bun run dist/browser.js open "https://www.youtube.com/watch?v=VIDEO_ID"
bun run dist/browser.js elements 0
bun run dist/browser.js click 0 "...more"
bun run dist/browser.js click 0 "Show transcript"
sleep 2
bun run dist/browser.js content 0
```

### Scroll through a long page

```bash
bun run dist/browser.js scroll 0 down
bun run dist/browser.js scroll 0 "#footer"
bun run dist/browser.js scroll 0 top
```

## Chrome Launcher

```bash
bash scripts/start-chrome.sh [--kill-existing] [--port N]
```

Starts Chrome with `--remote-debugging-port` on port 9222 (default). Use `--kill-existing` to stop any process on the port first. Use `--port N` for a custom port.

Environment variables: `CHROME_BIN`, `CHROME_DEBUG_PORT`, `CHROME_PROFILE_DIR`.

## Building from Source

```bash
bun build src/browser.js --outfile dist/browser.js --target bun
```

## Troubleshooting

**Connection refused**: Chrome isn't running with remote debugging. Run `bash scripts/start-chrome.sh --kill-existing`.

**No page found**: No tabs open or wrong index. Run `list` to check. Open a tab with `open "about:blank" --new-tab`.

**Click fails**: Text doesn't match or page changed. Re-run `elements` and try by index instead.

**Content incomplete**: Page still loading. Use `wait 0 "selector"` or add `sleep 2`.

**eval returns undefined**: Expression doesn't return a value. Wrap in `(() => { return result; })()` or extract `.textContent`.

## Architecture

- **Zero dependencies** -- the entire CLI is a single Bun-bundled JavaScript file
- **Raw WebSocket CDP** -- connects directly to Chrome's DevTools Protocol, no browser driver libraries
- **CDP domains used**: Runtime, Page, Network, DOM, Input, Emulation
- **Single-file build**: `src/browser.js` -> `dist/browser.js` (60KB)

## License

MIT
