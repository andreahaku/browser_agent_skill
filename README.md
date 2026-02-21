# Browser Agent (Bun)

A Bun-native CLI to let AI agents control Chrome over CDP (Chrome DevTools Protocol).

It supports:
- list tabs
- open URLs
- extract content
- click elements by text or index
- type into inputs
- upload files
- take screenshots
- inspect interactive elements
- search across all tabs
- close tabs
- autonomous `run "<task>"` loop

## Requirements

- Bun `>=1.0`
- Google Chrome (or Chromium)
- macOS or Linux

## Install

```bash
bun install
```

## Start Chrome in debug mode

```bash
bash scripts/start-chrome.sh --kill-existing
```

Default CDP endpoint:

```text
http://127.0.0.1:9222
```

## Usage

```bash
bun run dist/browser.js --help
```

### Command examples

```bash
bun run dist/browser.js list
bun run dist/browser.js open https://news.ycombinator.com --new-tab
bun run dist/browser.js content 0
bun run dist/browser.js elements 0
bun run dist/browser.js click 0 2
bun run dist/browser.js click 0 "Submit"
bun run dist/browser.js type 0 "hello world" --selector "textarea"
bun run dist/browser.js upload 0 ./assets/image.png
bun run dist/browser.js screenshot 0 -o ./shots/home.png
bun run dist/browser.js html 0
bun run dist/browser.js search "hacker news"
bun run dist/browser.js close all
bun run dist/browser.js run "Open Hacker News, click the first post, then stop"
```

## Global options

- `--cdp-url <url>` override CDP endpoint
- `--timeout-ms <n>` override connect timeout

Example:

```bash
bun run dist/browser.js list --cdp-url http://127.0.0.1:9333
```

## Autonomous `run`

`run` executes a multi-step browser task with an LLM planner.

```bash
export OPENAI_API_KEY=your_key_here
bun run dist/browser.js run "Go to x.com and draft a post saying hello world"
```

Useful options:

- `--model <name>` default: `gpt-4.1-mini`
- `--max-steps <n>` default: `12`
- `--tab <index>` start from a specific tab
- `--planner-timeout-ms <ms>` default: `60000`
- `--screenshot-dir <path>` where run screenshots are saved
- `--verbose` print planner notes
- `--dry-run` show planned actions without executing

## Troubleshooting CDP connect timeout

If `list` times out at websocket connect:

1. Fully quit all Chrome processes.
2. Start a fresh debug instance:
   `bash scripts/start-chrome.sh --kill-existing`
3. Verify endpoint:
   `curl http://127.0.0.1:9222/json/version`
4. Retry:
   `bun run dist/browser.js list`

If `9222` is busy, use a dedicated port:
`bash scripts/start-chrome.sh --port 9333 --kill-existing`
and then:
`bun run dist/browser.js list --cdp-url http://127.0.0.1:9333`

## Agent integration pattern

If your coding agent can execute shell commands, expose these as primitives:

- `list`
- `open <url>`
- `elements <tab>`
- `click <tab> <index|text>`
- `type <tab> <text>`
- `content <tab>`
- `screenshot <tab> -o <path>`

That gives the agent reliable browser control without virtual mouse automation.
