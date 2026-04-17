---
name: browser-agent
description: >
  Automate Chrome from the terminal via DevTools Protocol. Use when user asks to open a webpage,
  scrape a site, get a YouTube transcript, fill out a form, take a screenshot, click through a web UI,
  save as PDF, run JavaScript on a page, check cookies/storage, emulate mobile devices, or monitor network.
  Covers any browser interaction — navigating, clicking, typing, scrolling, extracting text, and more.
  Trigger phrases: "browse to", "open this URL", "screenshot this site", "scrape website",
  "extract transcript", "web automation", "emulate iPhone".
compatibility: Requires Bun runtime and Google Chrome installed. macOS or Linux.
metadata:
  version: 0.5.0
  category: browser-automation
  tags: [chrome, cdp, devtools, web-scraping, screenshots, browser, pdf, cookies, emulation, network]
---

# Browser Agent

Automate Chrome from the terminal using the DevTools Protocol. You are the AI agent driving the browser.

## Important: CLI Path and Runtime

The CLI and startup script are bundled inside this skill. All commands use this pattern:

```bash
bun ~/.claude/skills/browser-agent/scripts/browser.js COMMAND [ARGS]
```

## Step 1: Ensure Chrome Debug Session Is Active

Before running any browser command, check if Chrome is already listening on the debug port and start it if not:

```bash
curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1 || bash ~/.claude/skills/browser-agent/scripts/start-chrome.sh --kill-existing
```

Run this single command at the start of every browser task. It is a no-op if Chrome is already running, and starts it otherwise. Wait for "Chrome launched" confirmation if it starts Chrome.

## Step 2: Recon-First Pattern (preferred)

Instead of scanning after every action, **recon once, then execute multiple steps in sequence**:

1. **Navigate**: `open "https://example.com"`
2. **Recon**: run `elements` once to map all interactive indices + `content` for text context. Keep this map in mind.
3. **Plan**: decide the sequence of clicks/types/keypresses needed (e.g., "click search box → type query → press Enter → click result #3").
4. **Execute**: run the planned commands back-to-back without re-scanning between each.
5. **Re-recon only on DOM change**: after a navigation, page transition, modal open/close, or when a click visibly changes layout, run `elements` again. Small state changes (typing in an input, hovering) do NOT invalidate indices.
6. **Verify at the end**: `screenshot` or `content` once the flow completes.

Rule of thumb: if the URL did not change and no new major section appeared, the previous `elements` output is still valid. This matches how the "surf-agent" approach speeds up multi-step flows — one recon feeds many actions.

### When to fall back to Navigate-Observe-Act-Verify

Use the slower step-by-step loop when:
- The page is a heavy SPA where clicks swap large subtrees (re-recon each time).
- Indices keep failing (the DOM is unstable — re-scan before every action).
- You are debugging an unexpected failure.

CRITICAL: indices from `elements` are only valid against the snapshot they came from. If `click` by index fails, the DOM has shifted — re-run `elements` before retrying.

## Step 3: Leveraging Logged-In Sessions

This skill drives the user's real Chrome profile. That means **any site the user is already logged into works without API keys or OAuth**:

- Gmail, Google Sheets, Google Drive, Calendar — no API setup
- Discord, Slack, X/Twitter, LinkedIn — no developer tokens
- GitHub, internal dashboards, SaaS tools behind SSO — just navigate

Prefer browser automation over building API integrations when:
- The task is one-off or exploratory (research, recon, scraping)
- The user has a session and the API would require OAuth / billing / scopes
- The action is trivially scriptable in the UI (fill form, click button, read a panel)

Prefer APIs when:
- The task runs headless/scheduled (this skill is NOT headless)
- Volume is high enough that browser latency matters
- A proper audit trail / rate limit is needed

## Commands

### Tab and Navigation

- `list` -- list all open tabs
- `open URL` -- navigate tab 0 to URL. Use `--new-tab` for a new tab, `--tab N` for a specific tab.
- `open URL1 URL2 URL3 --parallel` -- open multiple URLs in new tabs concurrently. All tabs load at the same time.
- `close N` or `close all` -- close tabs
- `back [tab]` -- go back in browser history
- `forward [tab]` -- go forward in browser history
- `reload [tab]` -- reload the page. Use `--hard` to bypass cache.

### Reading Pages

- `content [tab]` -- get visible text content
- `html [tab]` -- get raw HTML source
- `elements [tab]` -- list interactive elements with clickable indices. Flags:
  - `--json` for structured output (includes the CSS `selector` field).
  - `--verbose` / `-v` to also print the CSS selector in text output (off by default to save tokens).
  - `--viewport-only` to show only elements currently visible in the viewport.
  - `--within "css-selector"` to restrict the listing to descendants of a scope element.
  - Indices are **absolute**: filters hide items but never renumber. `click N` stays consistent whether or not filters are active.
- `search "query"` -- full-text search across all open tabs
- `eval [tab] "javascript"` -- execute arbitrary JavaScript and print the result. Alias: `js`.

### Interacting with Pages

- `click [tab] INDEX` -- click element by index from `elements` output
- `click [tab] "text"` -- click element by visible text (fuzzy match)
- `type [tab] "text" --selector "css"` -- type into an input field. Clears first unless `--append` is used.
- `keypress [tab] KEY` -- press a keyboard key. Keys: Enter, Tab, Escape, Space, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12. Add `--selector "css"` to focus an element first.
- `select [tab] "value" --selector "select.class"` -- choose a dropdown option by value or visible text
- `hover [tab] INDEX|"text"` -- hover over an element (triggers tooltips, menus). Also accepts `--selector "css"`.
- `scroll [tab] DIRECTION` -- scroll the page. Directions: `up`, `down`, `top`, `bottom`, `left`, `right`. Also accepts pixel values (`500`, `-500`) or a CSS selector to scroll into view.
- `upload [tab] filepath` -- upload a file. Add `--selector "css"` for a specific file input.
- `wait [tab] "selector-or-expression"` -- wait for a CSS selector to appear or a JS expression to be truthy. Add `--timeout ms` (default 10s).

### Output

- `screenshot [tab] -o /tmp/output.png` -- take a screenshot. Full-page by default, add `--viewport-only` for visible area only.
- `pdf [tab] -o /tmp/output.pdf` -- save the page as PDF. Add `--landscape` for landscape orientation.

### Browser State

- `cookies get [tab]` -- list all cookies for the current page
- `cookies set name=value --domain example.com` -- set a cookie. Optional: `--path`, `--httpOnly`, `--secure`.
- `cookies delete name` -- delete a cookie by name
- `cookies clear` -- delete all cookies
- `storage get [key] [tab]` -- read localStorage. Omit key to list all. Add `--session` for sessionStorage.
- `storage set key value` -- write to localStorage. Add `--session` for sessionStorage.
- `storage delete key` -- remove a key. Add `--session` for sessionStorage.
- `storage clear` -- clear all storage. Add `--session` for sessionStorage.
- `console [tab] --duration 5000` -- capture console.log/warn/error output for N milliseconds
- `network [tab] --duration 5000` -- monitor network requests for N milliseconds. Add `--filter "api"` to filter by URL.
- `emulate DEVICE` -- emulate a device. Presets: `iphone-14`, `iphone-15-pro`, `ipad`, `pixel-7`, `desktop-hd`, `desktop-4k`. Custom: `emulate 375x812 --dpr 3 --mobile`. Use `emulate reset` to clear.

### Parallel Execution

- `parallel "cmd1" "cmd2" "cmd3"` -- run multiple commands concurrently on different tabs. Each command runs in its own process for clean output isolation. Results are grouped by command.

Tab index defaults to 0 if omitted. Use `list` to see current tab indices.

For full command details with all flags, consult `references/commands.md`.

## Examples

### Parallel research: open 3 sites and extract text from all at once

```bash
# Open multiple sites in parallel
bun ~/.claude/skills/browser-agent/scripts/browser.js open "https://site1.com" "https://site2.com" "https://site3.com" --parallel
# Read all tabs at once
bun ~/.claude/skills/browser-agent/scripts/browser.js parallel "content 0" "content 1" "content 2"
```

### Extract text from a webpage

```bash
bun ~/.claude/skills/browser-agent/scripts/browser.js open "https://example.com"
bun ~/.claude/skills/browser-agent/scripts/browser.js content 0
```

### Run JavaScript on a page

```bash
bun ~/.claude/skills/browser-agent/scripts/browser.js eval 0 "document.querySelectorAll('a').length"
bun ~/.claude/skills/browser-agent/scripts/browser.js eval 0 "Array.from(document.querySelectorAll('h2')).map(h => h.textContent)"
```

### Fill and submit a form

```bash
bun ~/.claude/skills/browser-agent/scripts/browser.js type 0 "user@email.com" --selector "#email"
bun ~/.claude/skills/browser-agent/scripts/browser.js type 0 "mypassword" --selector "#password"
bun ~/.claude/skills/browser-agent/scripts/browser.js click 0 "Sign in"
bun ~/.claude/skills/browser-agent/scripts/browser.js wait 0 ".dashboard" --timeout 5000
bun ~/.claude/skills/browser-agent/scripts/browser.js screenshot 0 -o /tmp/after-login.png
```

### Select from a dropdown, press Enter

```bash
bun ~/.claude/skills/browser-agent/scripts/browser.js select 0 "United States" --selector "#country"
bun ~/.claude/skills/browser-agent/scripts/browser.js keypress 0 Enter
```

### Save page as PDF

```bash
bun ~/.claude/skills/browser-agent/scripts/browser.js pdf 0 -o /tmp/article.pdf
```

### Emulate mobile and take screenshot

```bash
bun ~/.claude/skills/browser-agent/scripts/browser.js emulate iphone-14
bun ~/.claude/skills/browser-agent/scripts/browser.js reload 0
bun ~/.claude/skills/browser-agent/scripts/browser.js screenshot 0 -o /tmp/mobile-view.png
bun ~/.claude/skills/browser-agent/scripts/browser.js emulate reset
```

### Debug: check cookies, storage, console, network

```bash
bun ~/.claude/skills/browser-agent/scripts/browser.js cookies get 0
bun ~/.claude/skills/browser-agent/scripts/browser.js storage get 0
bun ~/.claude/skills/browser-agent/scripts/browser.js console 0 --duration 3000
bun ~/.claude/skills/browser-agent/scripts/browser.js network 0 --duration 3000 --filter "api"
```

### Get a YouTube video transcript

```bash
bun ~/.claude/skills/browser-agent/scripts/browser.js open "https://www.youtube.com/watch?v=VIDEO_ID"
bun ~/.claude/skills/browser-agent/scripts/browser.js elements 0
bun ~/.claude/skills/browser-agent/scripts/browser.js click 0 "Accept all"
bun ~/.claude/skills/browser-agent/scripts/browser.js click 0 "...more"
bun ~/.claude/skills/browser-agent/scripts/browser.js click 0 "Show transcript"
sleep 2
bun ~/.claude/skills/browser-agent/scripts/browser.js content 0
```

### Scroll through a long page

```bash
bun ~/.claude/skills/browser-agent/scripts/browser.js scroll 0 down
bun ~/.claude/skills/browser-agent/scripts/browser.js scroll 0 down
bun ~/.claude/skills/browser-agent/scripts/browser.js scroll 0 "#footer"
bun ~/.claude/skills/browser-agent/scripts/browser.js scroll 0 top
```

## Troubleshooting

### Error: Connection refused / Cannot connect

**Cause**: Chrome is not running with remote debugging enabled.

**Fix**:
1. Run `curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1 || bash ~/.claude/skills/browser-agent/scripts/start-chrome.sh --kill-existing`
2. Wait for "Chrome launched" confirmation
3. Retry the command

### Error: No page found / Target not found

**Cause**: No tabs are open or tab index is wrong.

**Fix**:
1. Run `list` to see all open tabs and their indices
2. Use the correct tab index in your command
3. If no tabs exist, run `open "about:blank" --new-tab`

### Click by text fails / Element not found

**Cause**: Text does not match any visible element, or the page changed since last `elements` call.

**Fix**:
1. Run `elements` to refresh the interactive element list
2. Try clicking by index instead: `click 0 INDEX_NUMBER`
3. The text match is fuzzy (exact match wins, then starts-with, then contains) -- try a shorter substring

### Page content appears incomplete or empty

**Cause**: Page has not finished loading, or content is rendered dynamically.

**Fix**:
1. Use `wait 0 "css-selector"` to wait for a specific element to appear
2. Add `sleep 2` before the next command as a fallback
3. For slow pages, use `--timeout-ms 30000`

### eval returns undefined

**Cause**: The expression doesn't return a value, or it returns a DOM node (not serializable).

**Fix**:
1. Wrap in a return expression: `eval 0 "(() => { ... return result; })()"`
2. For DOM nodes, extract the data you need: `eval 0 "document.querySelector('h1').textContent"`
3. Use `JSON.stringify()` for complex objects

## Key Behaviors

- `click` text matching is fuzzy: exact match wins, then starts-with, then contains. Shorter labels rank higher on ties.
- `type` without `--append` clears the field first and dispatches React-compatible input/change events.
- `screenshot` captures the full page by default (resizes viewport). Use `--viewport-only` for just the visible area.
- `eval` / `js` can run any JavaScript in the page context. Use for anything not covered by other commands.
- `wait` auto-detects CSS selectors vs JS expressions. Selectors check `document.querySelector()`, expressions check truthiness.
- `keypress` dispatches both keyDown and keyUp events via CDP Input domain.
- `select` matches by value first, then by visible text (case-insensitive, supports partial match).
- `emulate` persists until `emulate reset` is called. Reload the page after emulating for full effect.
- `console` installs an interceptor on first run. Subsequent runs capture messages logged since the interceptor was installed.
- `network` uses the Performance API to capture resource entries. Run it while triggering the action you want to monitor.
- Default timeout is 10 seconds. For slow pages use `--timeout-ms 30000`.
- Default CDP port is 9222. Override with `--cdp-url http://127.0.0.1:PORT`.
