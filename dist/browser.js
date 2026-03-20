#!/usr/bin/env bun
// @bun

// src/browser.js
import fs from "fs/promises";
import path from "path";
var PORT = process.env.CHROME_DEBUG_PORT || "9222";
var BASE_URL = process.env.BROWSER_AGENT_CDP_URL || `http://127.0.0.1:${PORT}`;
var TIMEOUT = Number(process.env.BROWSER_AGENT_TIMEOUT_MS || 1e4);
function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}
function normalizeUrl(raw) {
  const s = raw.trim();
  if (!s)
    die("URL cannot be empty.");
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(s) ? s : `https://${s}`;
}

class CDP {
  #ws;
  #nextId = 1;
  #pending = new Map;
  #timeout;
  static async connect(wsUrl, timeout = TIMEOUT) {
    const client = new CDP;
    client.#timeout = timeout;
    await new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(wsUrl);
      client.#ws = ws;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.close();
          reject(new Error(`Connection timeout: ${wsUrl}`));
        }
      }, timeout);
      ws.onopen = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`WebSocket error: ${wsUrl}`));
        }
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
          if (msg.id != null) {
            const p = client.#pending.get(msg.id);
            if (p) {
              clearTimeout(p.timer);
              client.#pending.delete(msg.id);
              if (msg.error) {
                p.reject(new Error(msg.error.message || `CDP error ${msg.error.code}`));
              } else {
                p.resolve(msg.result);
              }
            }
          }
        } catch {}
      };
      ws.onclose = () => {
        for (const { reject: rej, timer: t } of client.#pending.values()) {
          clearTimeout(t);
          rej(new Error("Connection closed"));
        }
        client.#pending.clear();
      };
    });
    return client;
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("Not connected"));
      }
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, this.#timeout);
      this.#pending.set(id, { resolve, reject, timer });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    this.#ws?.close();
  }
}
async function fetchJSON(url, timeout = 5000) {
  const ctrl = new AbortController;
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok)
      throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
async function getPages(baseUrl = BASE_URL) {
  try {
    const targets = await fetchJSON(`${baseUrl}/json/list`);
    return targets.filter((t) => t.type === "page" && !t.url.startsWith("chrome://") && !t.url.startsWith("devtools://"));
  } catch {
    die(`Could not connect to Chrome at ${baseUrl}.
Make sure Chrome is running with: bash scripts/start-chrome.sh`);
  }
}
async function getBrowserWsUrl(baseUrl = BASE_URL) {
  const version = await fetchJSON(`${baseUrl}/json/version`);
  return version.webSocketDebuggerUrl;
}
function resolveTabIndex(pages, tabArg) {
  const index = Number(tabArg ?? "0");
  if (!Number.isInteger(index) || index < 0)
    die(`Invalid tab index: ${tabArg}`);
  if (index >= pages.length)
    die(`Tab ${index} out of range (0-${Math.max(0, pages.length - 1)}).`);
  return index;
}
async function connectPage(baseUrl, tabIndex, timeout = TIMEOUT) {
  const pages = await getPages(baseUrl);
  if (pages.length === 0)
    die("No tabs open in Chrome.");
  const idx = resolveTabIndex(pages, tabIndex);
  const target = pages[idx];
  const client = await CDP.connect(target.webSocketDebuggerUrl, timeout);
  return { client, target, idx, pages };
}
async function withPage(baseUrl, tabIndex, timeout, fn) {
  const conn = await connectPage(baseUrl, tabIndex, timeout);
  try {
    return await fn(conn);
  } finally {
    conn.client.close();
  }
}
async function withBrowser(baseUrl, timeout, fn) {
  const wsUrl = await getBrowserWsUrl(baseUrl);
  const client = await CDP.connect(wsUrl, timeout);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}
async function waitForLoad(client, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await client.send("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true
      });
      const state = res?.result?.value;
      if (state === "complete" || state === "interactive")
        return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
}
var INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "textarea",
  "select",
  "[role='button']",
  "[role='link']",
  "[onclick]",
  "[tabindex]",
  "[contenteditable='true']",
  "[contenteditable='']",
  "summary"
].join(",");
function elementsScript() {
  return `(() => {
    const SELECTOR = ${JSON.stringify(INTERACTIVE_SELECTOR)};

    const normalize = v => (v || "").replace(/\\s+/g, " ").trim();

    const isVisible = el => {
      if (!(el instanceof HTMLElement)) return false;
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const isDisabled = el => el.matches(":disabled, [aria-disabled='true'], [inert]");

    const label = el => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        return normalize(el.value || el.placeholder || el.name || el.id || el.getAttribute("aria-label"));
      }
      return normalize(
        el.innerText || el.textContent || el.getAttribute("aria-label") ||
        el.getAttribute("title") || el.getAttribute("name") || el.id
      );
    };

    const selector = el => {
      if (el.id) return "#" + CSS.escape(el.id);
      const parts = [];
      let node = el, depth = 0;
      while (node && node instanceof HTMLElement && depth < 6) {
        let part = node.tagName.toLowerCase();
        if (node.classList.length > 0) part += "." + CSS.escape(node.classList.item(0));
        const siblings = node.parentElement
          ? Array.from(node.parentElement.children).filter(s => s.tagName === node.tagName) : [];
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
        parts.unshift(part);
        node = node.parentElement;
        depth++;
      }
      return parts.join(" > ");
    };

    const out = [];
    const seen = new Set();
    for (const raw of document.querySelectorAll(SELECTOR)) {
      if (!(raw instanceof HTMLElement) || !isVisible(raw) || isDisabled(raw)) continue;
      const sel = selector(raw);
      if (seen.has(sel)) continue;
      seen.add(sel);
      const lbl = label(raw) || "(no label)";
      out.push({
        index: out.length,
        tag: raw.tagName.toLowerCase(),
        type: raw.getAttribute("type") || "",
        role: raw.getAttribute("role") || "",
        label: lbl.length > 140 ? lbl.slice(0, 137) + "..." : lbl,
        selector: sel,
      });
      if (out.length >= 500) break;
    }
    return out;
  })()`;
}
function clickByIndexScript(targetIndex) {
  return `(() => {
    const SELECTOR = ${JSON.stringify(INTERACTIVE_SELECTOR)};
    const target = ${JSON.stringify(targetIndex)};

    const normalize = v => (v || "").replace(/\\s+/g, " ").trim();
    const isVisible = el => {
      if (!(el instanceof HTMLElement)) return false;
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const isDisabled = el => el.matches(":disabled, [aria-disabled='true'], [inert]");
    const labelFor = el => normalize(
      el.innerText || el.textContent || el.getAttribute("aria-label") ||
      el.getAttribute("title") || el.getAttribute("name") || el.getAttribute("value") || el.id
    );

    const nodes = Array.from(document.querySelectorAll(SELECTOR))
      .filter(n => n instanceof HTMLElement && isVisible(n) && !isDisabled(n));

    if (!Number.isInteger(target) || target < 0 || target >= nodes.length) {
      return { ok: false, reason: "Index " + target + " out of range (0-" + Math.max(0, nodes.length - 1) + ")." };
    }

    const el = nodes[target];
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    return { ok: true, label: labelFor(el) || "(no label)", tag: el.tagName.toLowerCase() };
  })()`;
}
function clickByTextScript(targetText) {
  return `(() => {
    const SELECTOR = ${JSON.stringify(INTERACTIVE_SELECTOR)};
    const needle = ${JSON.stringify(targetText.toLowerCase())};

    const normalize = v => (v || "").replace(/\\s+/g, " ").trim();
    const isVisible = el => {
      if (!(el instanceof HTMLElement)) return false;
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const isDisabled = el => el.matches(":disabled, [aria-disabled='true'], [inert]");
    const labelFor = el => normalize(
      el.innerText || el.textContent || el.getAttribute("aria-label") ||
      el.getAttribute("title") || el.getAttribute("name") || el.getAttribute("value") || el.id
    );

    const candidates = [];
    for (const node of document.querySelectorAll(SELECTOR)) {
      if (!(node instanceof HTMLElement) || !isVisible(node) || isDisabled(node)) continue;
      const lbl = labelFor(node);
      const hay = lbl.toLowerCase();
      if (!hay) continue;

      let score = Infinity;
      if (hay === needle) score = 0;
      else if (hay.startsWith(needle)) score = 1;
      else if (hay.includes(needle)) score = 2;

      if (score !== Infinity) {
        score += Math.min(200, hay.length) / 1000;
        candidates.push({ node, score, label: lbl });
      }
    }

    if (candidates.length === 0) {
      return { ok: false, reason: 'No clickable element matches "' + ${JSON.stringify(targetText)} + '".' };
    }

    candidates.sort((a, b) => a.score - b.score);
    const best = candidates[0];
    best.node.scrollIntoView({ block: "center", inline: "center" });
    best.node.click();
    return { ok: true, label: best.label || "(no label)", tag: best.node.tagName.toLowerCase() };
  })()`;
}
function fillScript(text, selectorStr) {
  return `(() => {
    const text = ${JSON.stringify(text)};
    const sel = ${JSON.stringify(selectorStr || "")};

    const editable = 'input:not([type=hidden]):not([disabled]), textarea:not([disabled]), [contenteditable=true], [contenteditable=""]';
    const el = sel ? document.querySelector(sel) : document.querySelector(editable);

    if (!el) return { ok: false, reason: sel ? "No element matched: " + sel : "No editable element found." };

    el.focus();

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
    } else {
      el.textContent = text;
    }

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  })()`;
}
function focusScript(selectorStr) {
  return `(() => {
    const sel = ${JSON.stringify(selectorStr || "")};
    const editable = 'input:not([type=hidden]):not([disabled]), textarea:not([disabled]), [contenteditable=true], [contenteditable=""]';
    const el = sel ? document.querySelector(sel) : document.querySelector(editable);
    if (!el) return { ok: false, reason: sel ? "No element matched: " + sel : "No editable element found." };
    el.focus();
    if ("value" in el) { const len = el.value.length; el.setSelectionRange(len, len); }
    return { ok: true };
  })()`;
}
function searchContentScript(needle) {
  return `(() => {
    const text = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
    if (!text) return null;
    const idx = text.toLowerCase().indexOf(${JSON.stringify(needle.toLowerCase())});
    if (idx === -1) return null;
    return text.slice(Math.max(0, idx - 80), Math.min(text.length, idx + 120));
  })()`;
}
function parseGlobalArgs(rawArgs) {
  const args = [];
  let cdpUrl = BASE_URL;
  let timeoutMs = TIMEOUT;
  for (let i = 0;i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === "--cdp-url") {
      cdpUrl = rawArgs[++i] || die("Missing --cdp-url value.");
      continue;
    }
    if (a.startsWith("--cdp-url=")) {
      cdpUrl = a.slice(10);
      continue;
    }
    if (a === "--timeout-ms") {
      timeoutMs = Number(rawArgs[++i]);
      continue;
    }
    if (a.startsWith("--timeout-ms=")) {
      timeoutMs = Number(a.slice(13));
      continue;
    }
    args.push(a);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    die("--timeout-ms must be a positive number.");
  return { args, cdpUrl, timeoutMs };
}
function takeFlag(args, names) {
  const idx = args.findIndex((a) => names.includes(a));
  if (idx === -1)
    return false;
  args.splice(idx, 1);
  return true;
}
function takeOption(args, names) {
  for (let i = 0;i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name) {
        const val = args[i + 1];
        if (!val)
          die(`Missing value for ${name}.`);
        args.splice(i, 2);
        return val;
      }
      if (args[i].startsWith(`${name}=`)) {
        const val = args[i].slice(name.length + 1);
        args.splice(i, 1);
        return val;
      }
    }
  }
  return;
}
function elementCenterScript(target) {
  const isNumeric = /^\d+$/.test(String(target).trim());
  if (isNumeric) {
    return `(() => {
      const SELECTOR = ${JSON.stringify(INTERACTIVE_SELECTOR)};
      const isVisible = el => {
        if (!(el instanceof HTMLElement)) return false;
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const isDisabled = el => el.matches(":disabled, [aria-disabled='true'], [inert]");
      const nodes = Array.from(document.querySelectorAll(SELECTOR))
        .filter(n => n instanceof HTMLElement && isVisible(n) && !isDisabled(n));
      const idx = ${JSON.stringify(Number(target))};
      if (idx < 0 || idx >= nodes.length) return null;
      const el = nodes[idx];
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`;
  }
  return `(() => {
    const SELECTOR = ${JSON.stringify(INTERACTIVE_SELECTOR)};
    const needle = ${JSON.stringify(String(target).toLowerCase())};
    const isVisible = el => {
      if (!(el instanceof HTMLElement)) return false;
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const isDisabled = el => el.matches(":disabled, [aria-disabled='true'], [inert]");
    const labelFor = el => (el.innerText || el.textContent || el.getAttribute("aria-label") ||
      el.getAttribute("title") || el.getAttribute("name") || el.getAttribute("value") || el.id || "").replace(/\\s+/g, " ").trim();
    let best = null, bestScore = Infinity;
    for (const node of document.querySelectorAll(SELECTOR)) {
      if (!(node instanceof HTMLElement) || !isVisible(node) || isDisabled(node)) continue;
      const hay = labelFor(node).toLowerCase();
      if (!hay) continue;
      let score = Infinity;
      if (hay === needle) score = 0;
      else if (hay.startsWith(needle)) score = 1;
      else if (hay.includes(needle)) score = 2;
      if (score < bestScore) { bestScore = score; best = node; }
    }
    if (!best) return null;
    best.scrollIntoView({ block: "center", inline: "center" });
    const r = best.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`;
}
var KEY_MAP = {
  enter: { key: "Enter", code: "Enter", keyCode: 13 },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  space: { key: " ", code: "Space", keyCode: 32 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  f1: { key: "F1", code: "F1", keyCode: 112 },
  f2: { key: "F2", code: "F2", keyCode: 113 },
  f3: { key: "F3", code: "F3", keyCode: 114 },
  f4: { key: "F4", code: "F4", keyCode: 115 },
  f5: { key: "F5", code: "F5", keyCode: 116 },
  f6: { key: "F6", code: "F6", keyCode: 117 },
  f7: { key: "F7", code: "F7", keyCode: 118 },
  f8: { key: "F8", code: "F8", keyCode: 119 },
  f9: { key: "F9", code: "F9", keyCode: 120 },
  f10: { key: "F10", code: "F10", keyCode: 121 },
  f11: { key: "F11", code: "F11", keyCode: 122 },
  f12: { key: "F12", code: "F12", keyCode: 123 }
};
async function cmdList(runtime) {
  const pages = await getPages(runtime.cdpUrl);
  if (pages.length === 0) {
    console.log("No open tabs.");
    return;
  }
  for (let i = 0;i < pages.length; i++) {
    console.log(`[${i}] ${pages[i].title || "(no title)"}`);
    console.log(`    ${pages[i].url}`);
  }
}
async function cmdOpen(runtime, commandArgs) {
  const args = [...commandArgs];
  const newTab = takeFlag(args, ["--new-tab", "-n"]);
  const parallel = takeFlag(args, ["--parallel", "-p"]);
  const tabTarget = takeOption(args, ["--tab", "-t"]);
  if (parallel) {
    const urls = args.filter((a) => !a.startsWith("-"));
    if (urls.length === 0)
      die("Usage: browser.js open <url1> <url2> ... --parallel");
    const results = await Promise.allSettled(urls.map(async (rawUrl2) => {
      const url2 = normalizeUrl(rawUrl2);
      const wsUrl = await getBrowserWsUrl(runtime.cdpUrl);
      const browser = await CDP.connect(wsUrl, runtime.timeoutMs);
      try {
        const { targetId } = await browser.send("Target.createTarget", { url: url2 });
        await new Promise((r) => setTimeout(r, 500));
        const pages = await getPages(runtime.cdpUrl);
        const page = pages.find((p) => p.id === targetId);
        if (page) {
          const client = await CDP.connect(page.webSocketDebuggerUrl, runtime.timeoutMs);
          try {
            await waitForLoad(client, runtime.timeoutMs);
            const titleRes = await client.send("Runtime.evaluate", {
              expression: "document.title || '(no title)'",
              returnByValue: true
            });
            return { idx: pages.indexOf(page), title: titleRes?.result?.value, url: page.url || url2 };
          } finally {
            client.close();
          }
        }
        return { idx: "?", title: "(loading...)", url: url2 };
      } finally {
        browser.close();
      }
    }));
    for (const r of results) {
      if (r.status === "fulfilled") {
        console.log(`[${r.value.idx}] ${r.value.title}`);
        console.log(`    ${r.value.url}`);
      } else {
        console.error(`Error: ${r.reason?.message || r.reason}`);
      }
    }
    console.log(`
Opened ${results.filter((r) => r.status === "fulfilled").length}/${urls.length} tabs in parallel.`);
    return;
  }
  const rawUrl = args[0];
  if (!rawUrl)
    die("Usage: browser.js open <url> [--new-tab] [--tab <index>] [--parallel]");
  if (newTab && tabTarget !== undefined)
    die("Use --new-tab or --tab, not both.");
  const url = normalizeUrl(rawUrl);
  if (newTab) {
    await withBrowser(runtime.cdpUrl, runtime.timeoutMs, async (browser) => {
      const { targetId } = await browser.send("Target.createTarget", { url });
      await new Promise((r) => setTimeout(r, 500));
      const pages = await getPages(runtime.cdpUrl);
      const page = pages.find((p) => p.id === targetId);
      const idx = page ? pages.indexOf(page) : "?";
      console.log(`Opened new tab ${idx}: ${page?.title || "(loading...)"}`);
      console.log(page?.url || url);
    });
  } else {
    const tabArg = tabTarget ?? "0";
    await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client, idx }) => {
      const nav = await client.send("Page.navigate", { url });
      if (nav.errorText)
        die(`Navigation error: ${nav.errorText}`);
      await waitForLoad(client, runtime.timeoutMs);
      const titleRes = await client.send("Runtime.evaluate", {
        expression: "document.title || '(no title)'",
        returnByValue: true
      });
      console.log(`Opened tab ${idx}: ${titleRes?.result?.value || "(no title)"}`);
      const urlRes = await client.send("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true
      });
      console.log(urlRes?.result?.value || url);
    });
  }
}
async function cmdContent(runtime, commandArgs) {
  const tabArg = commandArgs[0] ?? "0";
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client }) => {
    const res = await client.send("Runtime.evaluate", {
      expression: '(document.body?.innerText || "").trim()',
      returnByValue: true
    });
    console.log(res?.result?.value || "");
  });
}
async function cmdHtml(runtime, commandArgs) {
  const tabArg = commandArgs[0] ?? "0";
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client }) => {
    const res = await client.send("Runtime.evaluate", {
      expression: "document.documentElement.outerHTML",
      returnByValue: true
    });
    console.log(res?.result?.value || "");
  });
}
async function cmdElements(runtime, commandArgs) {
  const args = [...commandArgs];
  const asJson = takeFlag(args, ["--json"]);
  const tabArg = args[0] ?? "0";
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client }) => {
    const res = await client.send("Runtime.evaluate", {
      expression: elementsScript(),
      returnByValue: true
    });
    const elements = res?.result?.value || [];
    if (asJson) {
      console.log(JSON.stringify(elements, null, 2));
      return;
    }
    if (elements.length === 0) {
      console.log("No interactive elements found.");
      return;
    }
    for (const el of elements) {
      const type = el.type ? `:${el.type}` : "";
      const role = el.role ? ` role=${el.role}` : "";
      console.log(`[${el.index}] <${el.tag}${type}> "${el.label}"${role} ${el.selector}`);
    }
  });
}
async function cmdClick(runtime, commandArgs) {
  const args = [...commandArgs];
  if (args.length === 0)
    die("Usage: browser.js click [tab] <index|text>");
  let tabArg = "0";
  let target;
  if (args.length === 1) {
    target = args[0];
  } else {
    tabArg = args[0];
    target = args.slice(1).join(" ");
  }
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client, idx }) => {
    const isNumeric = /^\d+$/.test(target.trim());
    const script = isNumeric ? clickByIndexScript(Number(target)) : clickByTextScript(target);
    const res = await client.send("Runtime.evaluate", {
      expression: script,
      returnByValue: true
    });
    const result = res?.result?.value;
    if (!result?.ok)
      die(result?.reason || "Click failed.");
    await new Promise((r) => setTimeout(r, 500));
    let currentUrl;
    try {
      const urlRes = await client.send("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true
      });
      currentUrl = urlRes?.result?.value;
    } catch {
      currentUrl = "(page navigated)";
    }
    console.log(`Clicked tab ${idx}: <${result.tag}> "${result.label}"`);
    console.log(currentUrl || "");
  });
}
async function cmdType(runtime, commandArgs) {
  const args = [...commandArgs];
  const selector = takeOption(args, ["--selector", "-s"]);
  const append = takeFlag(args, ["--append"]);
  if (args.length === 0)
    die("Usage: browser.js type [tab] <text> [--selector <css>] [--append]");
  let tabArg = "0";
  let text;
  if (args.length === 1) {
    text = args[0];
  } else {
    tabArg = args[0];
    text = args.slice(1).join(" ");
  }
  if (!text)
    die("Text cannot be empty.");
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client, idx }) => {
    if (append) {
      const focusRes = await client.send("Runtime.evaluate", {
        expression: focusScript(selector),
        returnByValue: true
      });
      const focusResult = focusRes?.result?.value;
      if (!focusResult?.ok)
        die(focusResult?.reason || "Could not focus element.");
      await client.send("Input.insertText", { text });
    } else {
      const fillRes = await client.send("Runtime.evaluate", {
        expression: fillScript(text, selector),
        returnByValue: true
      });
      const fillResult = fillRes?.result?.value;
      if (!fillResult?.ok)
        die(fillResult?.reason || "Could not fill element.");
    }
    console.log(`Typed into tab ${idx}.`);
  });
}
async function cmdUpload(runtime, commandArgs) {
  const args = [...commandArgs];
  const selector = takeOption(args, ["--selector", "-s"]) || "input[type='file']";
  if (args.length === 0)
    die("Usage: browser.js upload [tab] <file> [--selector <css>]");
  let tabArg = "0";
  let filePath;
  if (args.length === 1) {
    filePath = args[0];
  } else {
    tabArg = args[0];
    filePath = args.slice(1).join(" ");
  }
  const resolvedFile = path.resolve(filePath);
  await fs.access(resolvedFile).catch(() => die(`File not found: ${resolvedFile}`));
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client, idx }) => {
    await client.send("DOM.enable");
    const { root } = await client.send("DOM.getDocument");
    const { nodeId } = await client.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector
    });
    if (!nodeId)
      die(`No upload input matched selector: ${selector}`);
    await client.send("DOM.setFileInputFiles", {
      nodeId,
      files: [resolvedFile]
    });
    console.log(`Uploaded file to tab ${idx}: ${resolvedFile}`);
  });
}
async function cmdScreenshot(runtime, commandArgs) {
  const args = [...commandArgs];
  const output = takeOption(args, ["--output", "-o"]);
  const fullPage = !takeFlag(args, ["--viewport-only"]);
  const tabArg = args[0] ?? "0";
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client, idx }) => {
    if (fullPage) {
      const dimRes = await client.send("Runtime.evaluate", {
        expression: `JSON.stringify({
          width: Math.max(document.documentElement.scrollWidth, window.innerWidth),
          height: Math.max(document.documentElement.scrollHeight, window.innerHeight),
          dpr: window.devicePixelRatio || 1
        })`,
        returnByValue: true
      });
      const dims = JSON.parse(dimRes?.result?.value || "{}");
      if (dims.width && dims.height) {
        await client.send("Emulation.setDeviceMetricsOverride", {
          width: dims.width,
          height: dims.height,
          deviceScaleFactor: dims.dpr,
          mobile: false
        });
      }
      const { data } = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true
      });
      await client.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      const name = output || `screenshot-tab${idx}-${Date.now()}.png`;
      const outPath = path.resolve(name);
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, Buffer.from(data, "base64"));
      console.log(outPath);
    } else {
      const { data } = await client.send("Page.captureScreenshot", { format: "png" });
      const name = output || `screenshot-tab${idx}-${Date.now()}.png`;
      const outPath = path.resolve(name);
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, Buffer.from(data, "base64"));
      console.log(outPath);
    }
  });
}
async function cmdSearch(runtime, commandArgs) {
  const query = commandArgs.join(" ").trim();
  if (!query)
    die("Usage: browser.js search <query>");
  const needle = query.toLowerCase();
  const pages = await getPages(runtime.cdpUrl);
  if (pages.length === 0) {
    console.log("No open tabs.");
    return;
  }
  const hits = [];
  for (let i = 0;i < pages.length; i++) {
    const page = pages[i];
    const title = page.title || "";
    const url = page.url || "";
    const titleMatch = title.toLowerCase().includes(needle);
    const urlMatch = url.toLowerCase().includes(needle);
    let snippet = null;
    try {
      const client = await CDP.connect(page.webSocketDebuggerUrl, runtime.timeoutMs);
      try {
        const res = await client.send("Runtime.evaluate", {
          expression: searchContentScript(needle),
          returnByValue: true
        });
        snippet = res?.result?.value || null;
      } finally {
        client.close();
      }
    } catch {}
    if (titleMatch || urlMatch || snippet) {
      hits.push({ index: i, title, url, titleMatch, urlMatch, snippet });
    }
  }
  if (hits.length === 0) {
    console.log(`No matches for "${query}".`);
    return;
  }
  for (const hit of hits) {
    const reasons = [];
    if (hit.titleMatch)
      reasons.push("title");
    if (hit.urlMatch)
      reasons.push("url");
    if (hit.snippet)
      reasons.push("content");
    console.log(`[${hit.index}] ${hit.title || "(no title)"}`);
    console.log(`    ${hit.url}`);
    console.log(`    match: ${reasons.join(", ")}`);
    if (hit.snippet)
      console.log(`    snippet: ${hit.snippet}`);
  }
}
async function cmdClose(runtime, commandArgs) {
  const target = commandArgs[0];
  if (!target)
    die("Usage: browser.js close <tab|all>");
  const pages = await getPages(runtime.cdpUrl);
  if (pages.length === 0) {
    console.log("No open tabs.");
    return;
  }
  await withBrowser(runtime.cdpUrl, runtime.timeoutMs, async (browser) => {
    if (target === "all") {
      let closed = 0;
      for (const page of pages) {
        await browser.send("Target.closeTarget", { targetId: page.id }).catch(() => {});
        closed++;
      }
      console.log(`Closed ${closed} tab(s).`);
      return;
    }
    const index = resolveTabIndex(pages, target);
    await browser.send("Target.closeTarget", { targetId: pages[index].id });
    console.log(`Closed tab ${index}.`);
  });
}
async function cmdEval(runtime, commandArgs) {
  const args = [...commandArgs];
  const tabArg = args.length > 1 ? args.shift() : "0";
  const expression = args.join(" ");
  if (!expression)
    die("Usage: browser.js eval [tab] <javascript>");
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client }) => {
    const res = await client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res?.exceptionDetails) {
      die(res.exceptionDetails.text || res.exceptionDetails.exception?.description || "Evaluation error");
    }
    const val = res?.result?.value;
    if (val !== undefined) {
      console.log(typeof val === "string" ? val : JSON.stringify(val, null, 2));
    } else if (res?.result?.description) {
      console.log(res.result.description);
    }
  });
}
async function cmdPdf(runtime, commandArgs) {
  const args = [...commandArgs];
  const output = takeOption(args, ["--output", "-o"]);
  const landscape = takeFlag(args, ["--landscape"]);
  const tabArg = args[0] ?? "0";
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client, idx }) => {
    const { data } = await client.send("Page.printToPDF", {
      landscape,
      printBackground: true,
      preferCSSPageSize: true
    });
    const name = output || `page-tab${idx}-${Date.now()}.pdf`;
    const outPath = path.resolve(name);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, Buffer.from(data, "base64"));
    console.log(outPath);
  });
}
async function cmdWait(runtime, commandArgs) {
  const args = [...commandArgs];
  const timeout = Number(takeOption(args, ["--timeout"]) ?? "10000");
  const tabArg = args.length > 1 ? args.shift() : "0";
  const selectorOrExpr = args.join(" ");
  if (!selectorOrExpr)
    die("Usage: browser.js wait [tab] <css-selector|js-expression> [--timeout ms]");
  const isSelector = /^[#.\[a-zA-Z]/.test(selectorOrExpr) && !selectorOrExpr.includes("(");
  const expression = isSelector ? `!!document.querySelector(${JSON.stringify(selectorOrExpr)})` : selectorOrExpr;
  await withPage(runtime.cdpUrl, tabArg, timeout, async ({ client }) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const res = await client.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true
        });
        if (res?.result?.value) {
          console.log(`Wait satisfied: ${selectorOrExpr}`);
          return;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    die(`Timeout waiting for: ${selectorOrExpr}`);
  });
}
async function cmdBack(runtime, commandArgs) {
  const tabArg = commandArgs[0] ?? "0";
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client, idx }) => {
    const { currentIndex, entries } = await client.send("Page.getNavigationHistory");
    if (currentIndex <= 0)
      die("No previous history entry.");
    await client.send("Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1].id });
    await waitForLoad(client, runtime.timeoutMs);
    const urlRes = await client.send("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true
    });
    console.log(`Back tab ${idx}: ${urlRes?.result?.value || ""}`);
  });
}
async function cmdForward(runtime, commandArgs) {
  const tabArg = commandArgs[0] ?? "0";
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client, idx }) => {
    const { currentIndex, entries } = await client.send("Page.getNavigationHistory");
    if (currentIndex >= entries.length - 1)
      die("No forward history entry.");
    await client.send("Page.navigateToHistoryEntry", { entryId: entries[currentIndex + 1].id });
    await waitForLoad(client, runtime.timeoutMs);
    const urlRes = await client.send("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true
    });
    console.log(`Forward tab ${idx}: ${urlRes?.result?.value || ""}`);
  });
}
async function cmdReload(runtime, commandArgs) {
  const args = [...commandArgs];
  const ignoreCache = takeFlag(args, ["--hard", "--no-cache"]);
  const tabArg = args[0] ?? "0";
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client, idx }) => {
    await client.send("Page.reload", { ignoreCache });
    await waitForLoad(client, runtime.timeoutMs);
    console.log(`Reloaded tab ${idx}${ignoreCache ? " (cache bypassed)" : ""}.`);
  });
}
async function cmdKeypress(runtime, commandArgs) {
  const args = [...commandArgs];
  const selector = takeOption(args, ["--selector", "-s"]);
  if (args.length === 0)
    die(`Usage: browser.js keypress [tab] <key> [--selector css]
Keys: Enter, Tab, Escape, Space, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12`);
  let tabArg = "0";
  let keyName;
  if (args.length === 1) {
    keyName = args[0];
  } else {
    tabArg = args[0];
    keyName = args.slice(1).join(" ");
  }
  const mapped = KEY_MAP[keyName.toLowerCase()];
  if (!mapped) {
    if (keyName.length === 1) {
      await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client, idx }) => {
        if (selector) {
          await client.send("Runtime.evaluate", {
            expression: focusScript(selector),
            returnByValue: true
          });
        }
        await client.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: keyName,
          text: keyName,
          unmodifiedText: keyName,
          windowsVirtualKeyCode: keyName.charCodeAt(0)
        });
        await client.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: keyName,
          windowsVirtualKeyCode: keyName.charCodeAt(0)
        });
        console.log(`Pressed "${keyName}" in tab ${idx}.`);
      });
      return;
    }
    die(`Unknown key: ${keyName}. Use: Enter, Tab, Escape, Space, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12, or a single character.`);
  }
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client, idx }) => {
    if (selector) {
      await client.send("Runtime.evaluate", {
        expression: focusScript(selector),
        returnByValue: true
      });
    }
    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.keyCode,
      nativeVirtualKeyCode: mapped.keyCode
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.keyCode,
      nativeVirtualKeyCode: mapped.keyCode
    });
    console.log(`Pressed "${mapped.key}" in tab ${idx}.`);
  });
}
async function cmdScroll(runtime, commandArgs) {
  const args = [...commandArgs];
  if (args.length === 0)
    die(`Usage: browser.js scroll [tab] <direction|selector|pixels>
Directions: up, down, top, bottom, left, right
Pixels: 500 (scroll down by N), -500 (scroll up by N)
Selector: #my-element (scroll element into view)`);
  let tabArg = "0";
  let target;
  if (args.length === 1) {
    target = args[0];
  } else {
    tabArg = args[0];
    target = args.slice(1).join(" ");
  }
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client, idx }) => {
    let expression;
    const lower = target.toLowerCase();
    if (lower === "top")
      expression = "window.scrollTo(0, 0); 'Scrolled to top'";
    else if (lower === "bottom")
      expression = "window.scrollTo(0, document.body.scrollHeight); 'Scrolled to bottom'";
    else if (lower === "up")
      expression = "window.scrollBy(0, -window.innerHeight * 0.8); 'Scrolled up'";
    else if (lower === "down")
      expression = "window.scrollBy(0, window.innerHeight * 0.8); 'Scrolled down'";
    else if (lower === "left")
      expression = "window.scrollBy(-window.innerWidth * 0.8, 0); 'Scrolled left'";
    else if (lower === "right")
      expression = "window.scrollBy(window.innerWidth * 0.8, 0); 'Scrolled right'";
    else if (/^-?\d+$/.test(target))
      expression = `window.scrollBy(0, ${target}); 'Scrolled by ${target}px'`;
    else {
      expression = `(() => {
        const el = document.querySelector(${JSON.stringify(target)});
        if (!el) return 'Element not found: ${target.replace(/'/g, "\\'")}';
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return 'Scrolled to: ' + (el.textContent || '').slice(0, 60).trim();
      })()`;
    }
    const res = await client.send("Runtime.evaluate", {
      expression,
      returnByValue: true
    });
    console.log(`Tab ${idx}: ${res?.result?.value || "Scrolled"}`);
  });
}
async function cmdSelect(runtime, commandArgs) {
  const args = [...commandArgs];
  const selector = takeOption(args, ["--selector", "-s"]);
  if (args.length === 0)
    die('Usage: browser.js select [tab] <value> --selector "css"');
  let tabArg = "0";
  let value;
  if (args.length === 1) {
    value = args[0];
  } else {
    tabArg = args[0];
    value = args.slice(1).join(" ");
  }
  const sel = selector || "select";
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client, idx }) => {
    const res = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el || el.tagName !== "SELECT") return { ok: false, reason: "No select element matched: ${sel.replace(/"/g, "\\\"")}" };
        const val = ${JSON.stringify(value)};
        // Try by value first, then by visible text
        let opt = Array.from(el.options).find(o => o.value === val);
        if (!opt) opt = Array.from(el.options).find(o => o.textContent.trim().toLowerCase() === val.toLowerCase());
        if (!opt) opt = Array.from(el.options).find(o => o.textContent.trim().toLowerCase().includes(val.toLowerCase()));
        if (!opt) return { ok: false, reason: "No option matches: " + val, options: Array.from(el.options).map(o => o.textContent.trim()).slice(0, 20) };
        el.value = opt.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, selected: opt.textContent.trim() };
      })()`,
      returnByValue: true
    });
    const result = res?.result?.value;
    if (!result?.ok) {
      let msg = result?.reason || "Select failed.";
      if (result?.options)
        msg += `
Available options: ${result.options.join(", ")}`;
      die(msg);
    }
    console.log(`Selected "${result.selected}" in tab ${idx}.`);
  });
}
async function cmdHover(runtime, commandArgs) {
  const args = [...commandArgs];
  if (args.length === 0)
    die("Usage: browser.js hover [tab] <index|text|--selector css>");
  const selector = takeOption(args, ["--selector", "-s"]);
  let tabArg = "0";
  let target;
  if (selector) {
    tabArg = args[0] ?? "0";
  } else if (args.length === 1) {
    target = args[0];
  } else {
    tabArg = args[0];
    target = args.slice(1).join(" ");
  }
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client, idx }) => {
    let coords;
    if (selector) {
      const res = await client.send("Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          el.scrollIntoView({ block: "center", inline: "center" });
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`,
        returnByValue: true
      });
      coords = res?.result?.value;
    } else {
      const res = await client.send("Runtime.evaluate", {
        expression: elementCenterScript(target),
        returnByValue: true
      });
      coords = res?.result?.value;
    }
    if (!coords)
      die("Element not found for hover.");
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: coords.x,
      y: coords.y
    });
    await new Promise((r) => setTimeout(r, 300));
    console.log(`Hovered at (${Math.round(coords.x)}, ${Math.round(coords.y)}) in tab ${idx}.`);
  });
}
async function cmdCookies(runtime, commandArgs) {
  const args = [...commandArgs];
  const subcommand = args[0] || "get";
  if (subcommand === "get" || subcommand === "list") {
    const tabArg = args[1] ?? "0";
    await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client }) => {
      await client.send("Network.enable");
      const { cookies } = await client.send("Network.getCookies");
      if (cookies.length === 0) {
        console.log("No cookies.");
        return;
      }
      for (const c of cookies) {
        console.log(`${c.name}=${c.value}  (domain=${c.domain}, path=${c.path}, httpOnly=${c.httpOnly}, secure=${c.secure})`);
      }
    });
  } else if (subcommand === "set") {
    const domain = takeOption(args, ["--domain", "-d"]);
    const httpOnly = takeFlag(args, ["--httpOnly"]);
    const secure = takeFlag(args, ["--secure"]);
    const pathVal = takeOption(args, ["--path"]) || "/";
    const pair = args[1];
    if (!pair || !pair.includes("="))
      die("Usage: browser.js cookies set name=value --domain example.com [--path /] [--httpOnly] [--secure]");
    const [name, ...rest] = pair.split("=");
    const value = rest.join("=");
    await withPage(runtime.cdpUrl, "0", runtime.timeoutMs, async ({ client }) => {
      await client.send("Network.enable");
      const cookieDomain = domain || await (async () => {
        const res = await client.send("Runtime.evaluate", {
          expression: "location.hostname",
          returnByValue: true
        });
        return res?.result?.value;
      })();
      await client.send("Network.setCookie", {
        name,
        value,
        domain: cookieDomain,
        path: pathVal,
        httpOnly,
        secure
      });
      console.log(`Set cookie: ${name}=${value} (domain=${cookieDomain})`);
    });
  } else if (subcommand === "delete" || subcommand === "remove") {
    const name = args[1];
    if (!name)
      die("Usage: browser.js cookies delete <name>");
    await withPage(runtime.cdpUrl, "0", runtime.timeoutMs, async ({ client }) => {
      await client.send("Network.enable");
      const { cookies } = await client.send("Network.getCookies");
      const matching = cookies.filter((c) => c.name === name);
      if (matching.length === 0)
        die(`No cookie found with name: ${name}`);
      for (const c of matching) {
        await client.send("Network.deleteCookies", {
          name: c.name,
          domain: c.domain,
          path: c.path
        });
      }
      console.log(`Deleted ${matching.length} cookie(s) named "${name}".`);
    });
  } else if (subcommand === "clear") {
    const tabArg = args[1] ?? "0";
    await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client }) => {
      await client.send("Network.enable");
      await client.send("Network.clearBrowserCookies");
      console.log("All cookies cleared.");
    });
  } else {
    die("Usage: browser.js cookies <get|set|delete|clear>");
  }
}
async function cmdStorage(runtime, commandArgs) {
  const args = [...commandArgs];
  const type = takeFlag(args, ["--session"]) ? "sessionStorage" : "localStorage";
  const subcommand = args[0] || "get";
  if (subcommand === "get" || subcommand === "list") {
    const key = args[1];
    const tabArg = args[2] ?? (args[1] && !/^\d+$/.test(args[1]) ? "0" : args[1] || "0");
    const realTabArg = key && /^\d+$/.test(key) && !args[2] ? key : args[2] ?? "0";
    const realKey = key && !/^\d+$/.test(key) ? key : null;
    await withPage(runtime.cdpUrl, realKey ? args[2] ?? "0" : args[1] ?? "0", runtime.timeoutMs, async ({ client }) => {
      if (realKey) {
        const res = await client.send("Runtime.evaluate", {
          expression: `${type}.getItem(${JSON.stringify(realKey)})`,
          returnByValue: true
        });
        console.log(res?.result?.value ?? "null");
      } else {
        const res = await client.send("Runtime.evaluate", {
          expression: `JSON.stringify(Object.entries(${type}).reduce((o, [k, v]) => { o[k] = v.length > 200 ? v.slice(0, 200) + "..." : v; return o; }, {}), null, 2)`,
          returnByValue: true
        });
        console.log(res?.result?.value || "{}");
      }
    });
  } else if (subcommand === "set") {
    const key = args[1];
    const value = args.slice(2).join(" ");
    if (!key)
      die(`Usage: browser.js storage set <key> <value> [--session]`);
    await withPage(runtime.cdpUrl, "0", runtime.timeoutMs, async ({ client }) => {
      await client.send("Runtime.evaluate", {
        expression: `${type}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
        returnByValue: true
      });
      console.log(`Set ${type}: ${key}=${value.length > 100 ? value.slice(0, 100) + "..." : value}`);
    });
  } else if (subcommand === "delete" || subcommand === "remove") {
    const key = args[1];
    if (!key)
      die(`Usage: browser.js storage delete <key> [--session]`);
    await withPage(runtime.cdpUrl, "0", runtime.timeoutMs, async ({ client }) => {
      await client.send("Runtime.evaluate", {
        expression: `${type}.removeItem(${JSON.stringify(key)})`,
        returnByValue: true
      });
      console.log(`Deleted ${type} key: ${key}`);
    });
  } else if (subcommand === "clear") {
    await withPage(runtime.cdpUrl, "0", runtime.timeoutMs, async ({ client }) => {
      await client.send("Runtime.evaluate", {
        expression: `${type}.clear()`,
        returnByValue: true
      });
      console.log(`Cleared ${type}.`);
    });
  } else {
    die(`Usage: browser.js storage <get|set|delete|clear> [--session]`);
  }
}
async function cmdConsole(runtime, commandArgs) {
  const args = [...commandArgs];
  const duration = Number(takeOption(args, ["--duration", "-d"]) ?? "5000");
  const tabArg = args[0] ?? "0";
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client }) => {
    await client.send("Runtime.enable");
    const logs = [];
    const origOnMessage = client._onMessage;
    const origWs = client;
    const messageHandler = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
        if (msg.method === "Runtime.consoleAPICalled") {
          const entry = msg.params;
          const text = (entry.args || []).map((a) => a.value !== undefined ? String(a.value) : a.description || a.type).join(" ");
          logs.push(`[${entry.type}] ${text}`);
        }
      } catch {}
    };
    console.log(`Listening for console messages for ${duration}ms...`);
    await new Promise((r) => setTimeout(r, duration));
    const res = await client.send("Runtime.evaluate", {
      expression: `(() => {
        if (!window.__browserAgentConsoleLogs) return [];
        const logs = window.__browserAgentConsoleLogs.splice(0);
        return logs;
      })()`,
      returnByValue: true
    });
    await client.send("Runtime.evaluate", {
      expression: `(() => {
        if (window.__browserAgentConsoleInstalled) return;
        window.__browserAgentConsoleInstalled = true;
        window.__browserAgentConsoleLogs = [];
        const orig = {};
        for (const m of ['log', 'warn', 'error', 'info', 'debug']) {
          orig[m] = console[m];
          console[m] = function(...args) {
            window.__browserAgentConsoleLogs.push('[' + m + '] ' + args.map(String).join(' '));
            if (window.__browserAgentConsoleLogs.length > 500) window.__browserAgentConsoleLogs.shift();
            orig[m].apply(console, args);
          };
        }
      })()`,
      returnByValue: true
    });
    const stored = res?.result?.value || [];
    const all = [...stored.map(String), ...logs];
    if (all.length === 0) {
      console.log("No console messages captured.");
      console.log("Hint: Console interceptor is now installed. Run `console` again to capture new messages.");
    } else {
      for (const line of all)
        console.log(line);
    }
  });
}
async function cmdNetwork(runtime, commandArgs) {
  const args = [...commandArgs];
  const duration = Number(takeOption(args, ["--duration", "-d"]) ?? "5000");
  const filter = takeOption(args, ["--filter", "-f"]);
  const tabArg = args[0] ?? "0";
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs + duration, async ({ client }) => {
    await client.send("Network.enable");
    console.log(`Monitoring network for ${duration}ms${filter ? ` (filter: ${filter})` : ""}...`);
    const requests = [];
    const startTime = Date.now();
    await client.send("Runtime.evaluate", {
      expression: `(() => {
        window.__browserAgentNetworkLogs = [];
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.entryType === 'resource') {
              window.__browserAgentNetworkLogs.push({
                name: entry.name,
                type: entry.initiatorType,
                duration: Math.round(entry.duration),
                size: entry.transferSize || 0,
                status: entry.responseStatus || 0,
              });
            }
          }
        });
        observer.observe({ entryTypes: ['resource'] });
        window.__browserAgentNetworkObserver = observer;
      })()`,
      returnByValue: true
    });
    await new Promise((r) => setTimeout(r, duration));
    const res = await client.send("Runtime.evaluate", {
      expression: `(() => {
        if (window.__browserAgentNetworkObserver) {
          window.__browserAgentNetworkObserver.disconnect();
          delete window.__browserAgentNetworkObserver;
        }
        const logs = window.__browserAgentNetworkLogs || [];
        delete window.__browserAgentNetworkLogs;
        // Also get existing performance entries
        const existing = performance.getEntriesByType('resource').map(e => ({
          name: e.name,
          type: e.initiatorType,
          duration: Math.round(e.duration),
          size: e.transferSize || 0,
          status: e.responseStatus || 0,
        }));
        return [...existing, ...logs];
      })()`,
      returnByValue: true
    });
    let entries = res?.result?.value || [];
    const seen = new Set;
    entries = entries.filter((e) => {
      if (seen.has(e.name))
        return false;
      seen.add(e.name);
      return true;
    });
    if (filter) {
      const lower = filter.toLowerCase();
      entries = entries.filter((e) => e.name.toLowerCase().includes(lower) || e.type.toLowerCase().includes(lower));
    }
    if (entries.length === 0) {
      console.log("No network requests captured.");
      return;
    }
    for (const e of entries) {
      const sizeStr = e.size > 0 ? ` ${(e.size / 1024).toFixed(1)}KB` : "";
      const statusStr = e.status ? ` ${e.status}` : "";
      console.log(`[${e.type}]${statusStr} ${e.duration}ms${sizeStr} ${e.name}`);
    }
    console.log(`
Total: ${entries.length} request(s)`);
  });
}
async function cmdEmulate(runtime, commandArgs) {
  const args = [...commandArgs];
  if (args.length === 0 || args[0] === "reset") {
    const tabArg2 = args[1] ?? "0";
    await withPage(runtime.cdpUrl, tabArg2, runtime.timeoutMs, async ({ client }) => {
      await client.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      await client.send("Emulation.setUserAgentOverride", { userAgent: "" }).catch(() => {});
      console.log("Emulation reset.");
    });
    return;
  }
  const presets = {
    "iphone-14": { width: 390, height: 844, dpr: 3, mobile: true, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1" },
    "iphone-15-pro": { width: 393, height: 852, dpr: 3, mobile: true, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
    ipad: { width: 820, height: 1180, dpr: 2, mobile: true, ua: "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/604.1" },
    "pixel-7": { width: 412, height: 915, dpr: 2.625, mobile: true, ua: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36" },
    "desktop-hd": { width: 1920, height: 1080, dpr: 1, mobile: false, ua: "" },
    "desktop-4k": { width: 3840, height: 2160, dpr: 2, mobile: false, ua: "" }
  };
  const presetName = args[0].toLowerCase();
  const tabArg = args[1] ?? "0";
  if (presets[presetName]) {
    const p = presets[presetName];
    await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client }) => {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: p.width,
        height: p.height,
        deviceScaleFactor: p.dpr,
        mobile: p.mobile
      });
      if (p.ua) {
        await client.send("Emulation.setUserAgentOverride", { userAgent: p.ua });
      }
      console.log(`Emulating ${presetName}: ${p.width}x${p.height} @${p.dpr}x${p.mobile ? " (mobile)" : ""}`);
    });
    return;
  }
  const match = args[0].match(/^(\d+)x(\d+)$/);
  if (!match) {
    const names = Object.keys(presets).join(", ");
    die(`Unknown device: ${args[0]}.
Presets: ${names}
Custom: browser.js emulate 375x812 [--dpr 3] [--mobile] [--ua "..."]`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const dpr = Number(takeOption(args, ["--dpr"]) ?? "1");
  const mobile = takeFlag(args, ["--mobile"]);
  const ua = takeOption(args, ["--ua"]);
  await withPage(runtime.cdpUrl, tabArg, runtime.timeoutMs, async ({ client }) => {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: dpr,
      mobile
    });
    if (ua) {
      await client.send("Emulation.setUserAgentOverride", { userAgent: ua });
    }
    console.log(`Emulating ${width}x${height} @${dpr}x${mobile ? " (mobile)" : ""}`);
  });
}
async function cmdParallel(runtime, commandArgs) {
  const cmds = commandArgs.filter((a) => a.trim());
  if (cmds.length === 0) {
    die(`Usage: browser.js parallel "cmd1 [args]" "cmd2 [args]" ...
` + 'Example: parallel "content 0" "content 1" "screenshot 2 -o shot.png"');
  }
  const scriptPath = import.meta.filename;
  const globalArgs = [];
  if (runtime.cdpUrl !== BASE_URL)
    globalArgs.push("--cdp-url", runtime.cdpUrl);
  if (runtime.timeoutMs !== TIMEOUT)
    globalArgs.push("--timeout-ms", String(runtime.timeoutMs));
  const t0 = Date.now();
  const results = await Promise.allSettled(cmds.map(async (cmdStr) => {
    const parts = cmdStr.trim().split(/\s+/);
    const proc = Bun.spawn(["bun", scriptPath, ...globalArgs, ...parts], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    return { cmdStr, stdout: stdout.trim(), stderr: stderr.trim(), code };
  }));
  const elapsed = Date.now() - t0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      const { cmdStr, stdout, stderr, code } = r.value;
      console.log(`\u2500\u2500 ${cmdStr}${code !== 0 ? " [FAILED]" : ""} \u2500\u2500`);
      if (stdout)
        console.log(stdout);
      if (stderr)
        console.error(stderr);
    } else {
      console.log(`\u2500\u2500 (spawn error) \u2500\u2500`);
      console.error(r.reason?.message || String(r.reason));
    }
    console.log();
  }
  const ok = results.filter((r) => r.status === "fulfilled" && r.value.code === 0).length;
  console.log(`${ok}/${cmds.length} commands completed in ${elapsed}ms`);
}
var HELP = `
browser-agent \u2014 Chrome automation CLI via DevTools Protocol

Usage:
  browser.js <command> [options]

Tab & Navigation:
  list                               List open tabs.
  open <url> [--new-tab] [--tab N]   Open a URL.
  open <u1> <u2> ... --parallel      Open multiple URLs in new tabs concurrently.
  close <tab|all>                    Close tabs.
  back [tab]                         Go back in history.
  forward [tab]                      Go forward in history.
  reload [tab] [--hard]              Reload page.

Reading:
  content [tab]                      Print visible page text.
  html [tab]                         Print raw HTML.
  elements [tab] [--json]            List interactive elements.
  search <query>                     Search across tabs.
  eval [tab] <js>                    Execute JavaScript and print result.

Interaction:
  click [tab] <index|text>           Click an element.
  type [tab] <text> [--selector css] [--append]  Type text.
  keypress [tab] <key> [--selector css]          Press a key (Enter, Tab, Escape, etc).
  select [tab] <value> --selector <css>          Select dropdown option.
  hover [tab] <index|text|--selector css>        Hover over element.
  scroll [tab] <direction|selector|pixels>       Scroll the page.
  upload [tab] <file> [--selector css]           Upload a file.
  wait [tab] <selector|expr> [--timeout ms]      Wait for condition.

Output:
  screenshot [tab] [-o path] [--viewport-only]   Take a screenshot.
  pdf [tab] [-o path] [--landscape]              Save page as PDF.

Browser State:
  cookies <get|set|delete|clear>     Manage cookies.
  storage <get|set|delete|clear> [--session]     Local/session storage.
  console [tab] [--duration ms]      Capture console logs.
  network [tab] [--duration ms] [--filter str]   Monitor network requests.
  emulate <device|WxH|reset> [--dpr N] [--mobile]  Device emulation.

Parallel:
  parallel "cmd1" "cmd2" ...         Run multiple commands concurrently.
    Example: parallel "content 0" "content 1" "screenshot 2 -o s.png"

Global options:
  --cdp-url <url>    CDP endpoint (default: ${BASE_URL})
  --timeout-ms <n>   Timeout in ms (default: ${TIMEOUT})
  -h, --help         Show this help.

Devices for emulate:
  iphone-14, iphone-15-pro, ipad, pixel-7, desktop-hd, desktop-4k

Keys for keypress:
  Enter, Tab, Escape, Space, Backspace, Delete,
  ArrowUp, ArrowDown, ArrowLeft, ArrowRight,
  Home, End, PageUp, PageDown, F1-F12
`.trim();
async function main() {
  const parsed = parseGlobalArgs(process.argv.slice(2));
  const args = parsed.args;
  const command = args.shift();
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    return;
  }
  const runtime = { cdpUrl: parsed.cdpUrl, timeoutMs: parsed.timeoutMs };
  switch (command) {
    case "list":
      return cmdList(runtime);
    case "open":
      return cmdOpen(runtime, args);
    case "content":
      return cmdContent(runtime, args);
    case "elements":
      return cmdElements(runtime, args);
    case "click":
      return cmdClick(runtime, args);
    case "type":
      return cmdType(runtime, args);
    case "upload":
      return cmdUpload(runtime, args);
    case "screenshot":
      return cmdScreenshot(runtime, args);
    case "html":
      return cmdHtml(runtime, args);
    case "search":
      return cmdSearch(runtime, args);
    case "close":
      return cmdClose(runtime, args);
    case "eval":
    case "js":
      return cmdEval(runtime, args);
    case "pdf":
      return cmdPdf(runtime, args);
    case "wait":
      return cmdWait(runtime, args);
    case "back":
      return cmdBack(runtime, args);
    case "forward":
      return cmdForward(runtime, args);
    case "reload":
      return cmdReload(runtime, args);
    case "keypress":
    case "key":
      return cmdKeypress(runtime, args);
    case "scroll":
      return cmdScroll(runtime, args);
    case "select":
      return cmdSelect(runtime, args);
    case "hover":
      return cmdHover(runtime, args);
    case "cookies":
    case "cookie":
      return cmdCookies(runtime, args);
    case "storage":
      return cmdStorage(runtime, args);
    case "console":
      return cmdConsole(runtime, args);
    case "network":
    case "net":
      return cmdNetwork(runtime, args);
    case "emulate":
      return cmdEmulate(runtime, args);
    case "parallel":
      return cmdParallel(runtime, args);
    default:
      die(`Unknown command "${command}". Use --help for usage.`);
  }
}
main().catch((err) => {
  die(err instanceof Error ? err.stack || err.message : String(err));
});
