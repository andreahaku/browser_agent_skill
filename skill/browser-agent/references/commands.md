# Browser Agent Command Reference

Full command details for every browser-agent CLI command.

## CLI Path

```bash
bun ~/.claude/skills/browser-agent/scripts/browser.js COMMAND [ARGS]
```

## Chrome Launcher

```bash
bash ~/.claude/skills/browser-agent/scripts/start-chrome.sh [--kill-existing] [--port N]
```

## Tab and Navigation

| Command | Description |
|---|---|
| `list` | List all open tabs with index, title, and URL |
| `open URL` | Navigate tab 0 to the given URL |
| `open URL --new-tab` | Open URL in a new tab |
| `open URL --tab N` | Navigate a specific tab to the URL |
| `close N` | Close tab at index N |
| `close all` | Close every open tab |
| `back [tab]` | Go back in browser history |
| `forward [tab]` | Go forward in browser history |
| `reload [tab]` | Reload the page |
| `reload [tab] --hard` | Reload bypassing cache |

## Reading Pages

| Command | Description |
|---|---|
| `content [tab]` | Get visible text content of a page |
| `html [tab]` | Get raw HTML source |
| `elements [tab]` | List interactive elements with clickable indices |
| `elements [tab] --json` | Same as above, but as structured JSON |
| `search "query"` | Full-text search across all open tabs |
| `eval [tab] "javascript"` | Execute JavaScript in the page context and print result |
| `js [tab] "javascript"` | Alias for `eval` |

## Interacting with Pages

| Command | Description |
|---|---|
| `click [tab] INDEX` | Click element by index (from `elements` output) |
| `click [tab] "text"` | Click element by visible text (fuzzy match) |
| `type [tab] "text"` | Clear and type into first editable field |
| `type [tab] "text" --selector "css"` | Type into a specific CSS-selected element |
| `type [tab] "text" --append` | Append text without clearing the field |
| `keypress [tab] KEY` | Press a keyboard key (see Key Names below) |
| `keypress [tab] KEY --selector "css"` | Focus element first, then press key |
| `select [tab] "value" --selector "css"` | Choose dropdown option by value or visible text |
| `hover [tab] INDEX` | Hover over element by index |
| `hover [tab] "text"` | Hover over element by visible text |
| `hover [tab] --selector "css"` | Hover over element by CSS selector |
| `scroll [tab] up/down/top/bottom/left/right` | Scroll by direction |
| `scroll [tab] N` | Scroll down by N pixels (negative for up) |
| `scroll [tab] "css-selector"` | Scroll element into view |
| `upload [tab] filepath` | Upload file to first file input |
| `upload [tab] filepath --selector "css"` | Upload to a specific file input |
| `wait [tab] "css-selector"` | Wait for selector to appear in DOM |
| `wait [tab] "js-expression"` | Wait for expression to be truthy |
| `wait [tab] ... --timeout ms` | Override wait timeout (default 10000) |

## Output

| Command | Description |
|---|---|
| `screenshot [tab]` | Full-page screenshot (auto-named PNG) |
| `screenshot [tab] -o path` | Screenshot saved to specific path |
| `screenshot [tab] --viewport-only` | Capture only the visible viewport |
| `pdf [tab]` | Save page as PDF (auto-named) |
| `pdf [tab] -o path` | PDF saved to specific path |
| `pdf [tab] --landscape` | PDF in landscape orientation |

## Browser State

| Command | Description |
|---|---|
| `cookies get [tab]` | List all cookies for current page |
| `cookies set name=value --domain X` | Set a cookie. Optional: `--path`, `--httpOnly`, `--secure` |
| `cookies delete name` | Delete cookie by name |
| `cookies clear` | Delete all browser cookies |
| `storage get [tab]` | List all localStorage key-value pairs |
| `storage get key [tab]` | Get specific localStorage value |
| `storage set key value` | Set localStorage value |
| `storage delete key` | Remove localStorage key |
| `storage clear` | Clear all localStorage |
| Add `--session` to any storage command | Use sessionStorage instead of localStorage |
| `console [tab] --duration ms` | Capture console output for N ms (default 5000) |
| `network [tab] --duration ms` | Monitor network requests for N ms (default 5000) |
| `network [tab] --filter "str"` | Filter network entries by URL substring |
| `emulate DEVICE` | Emulate a device preset |
| `emulate WxH --dpr N --mobile` | Custom device emulation |
| `emulate reset` | Clear device emulation |

## Device Presets

| Preset | Resolution | DPR | Mobile |
|---|---|---|---|
| `iphone-14` | 390x844 | 3x | Yes |
| `iphone-15-pro` | 393x852 | 3x | Yes |
| `ipad` | 820x1180 | 2x | Yes |
| `pixel-7` | 412x915 | 2.625x | Yes |
| `desktop-hd` | 1920x1080 | 1x | No |
| `desktop-4k` | 3840x2160 | 2x | No |

## Key Names for keypress

| Key | Aliases |
|---|---|
| `Enter` | |
| `Tab` | |
| `Escape` | `Esc` |
| `Space` | |
| `Backspace` | |
| `Delete` | |
| `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight` | |
| `Home`, `End` | |
| `PageUp`, `PageDown` | |
| `F1` through `F12` | |
| Any single character | e.g., `a`, `1`, `/` |

## Global Flags

| Flag | Description | Default |
|---|---|---|
| `--timeout-ms N` | Set command timeout in milliseconds | 10000 |
| `--cdp-url URL` | Override CDP connection URL | `http://127.0.0.1:9222` |

## Argument Details

**Tab index**: Defaults to 0 if omitted. Run `list` to see current indices. Indices shift when tabs are opened or closed.

**Click text matching**: Fuzzy matching in this priority order:
1. Exact match (case-insensitive)
2. Starts-with match
3. Contains match
4. On ties, shorter visible text wins

**Type behavior**: Without `--append`, the field is cleared first. Dispatches React-compatible `input`, `change`, and `keydown`/`keyup` events for framework compatibility.

**Screenshot sizing**: Full-page mode temporarily resizes the viewport to capture the entire scrollable area, then restores it. Use `--viewport-only` to skip resizing and capture only what is currently visible.

**Wait auto-detection**: If the argument starts with a CSS selector pattern (`#`, `.`, `[`, or a tag name without parentheses), it's treated as a CSS selector and checked with `document.querySelector()`. Otherwise it's evaluated as JavaScript and checked for truthiness.

**Select matching**: Tries to match by option `value` attribute first, then by visible text (case-insensitive exact match, then partial contains match). Shows available options on failure.
