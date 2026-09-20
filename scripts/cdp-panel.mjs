#!/usr/bin/env node

/**
 * Open the conversation work panel and exercise the built-in browser surface
 * (M4-01 / M4-02). Requires the CDP-enabled dev build.
 *
 * The work-bar tabs only exist in the DOM once the side panel is expanded, so
 * the panel toggle has to be found first. It is an icon-only button, hence the
 * name/title/svg heuristic below.
 *
 * Usage: node scripts/cdp-panel.mjs [url]
 */
import { argv, exit } from "node:process";

const PORT = Number(process.env.MUSE_CDP_PORT ?? 9222);
const TARGET_URL = argv[2] && !argv[2].startsWith("--") ? argv[2] : "https://example.com/";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function pageTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
  if (!page) throw new Error("no CDP page target");
  return page;
}

function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
  });
  socket.addEventListener("message", (event) => {
    let frame;
    try { frame = JSON.parse(typeof event.data === "string" ? event.data : ""); } catch { return; }
    if (frame.id === undefined) return;
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.error) entry.reject(new Error(`${entry.method}: ${frame.error.message}`));
    else entry.resolve(frame.result);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timed out`)); }, 30_000);
        pending.set(id, { resolve, reject, method, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { socket.close(); } catch { /* closed */ } },
  };
}

async function evaluate(client, expression) {
  const wrapped = `(() => { try { return JSON.stringify(${expression}); }
    catch (error) { return JSON.stringify({ __error: String((error && error.message) || error) }); } })()`;
  const result = await client.send("Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "eval failed");
  const parsed = JSON.parse(result.result?.value ?? "null");
  if (parsed && typeof parsed === "object" && "__error" in parsed) throw new Error(parsed.__error);
  return parsed;
}

const WORK_TABS = ["Content", "Review", "Terminal", "Files", "Browser", "Desktop", "Memory"];

const HELPERS = `
  const vis = (n) => n && n.offsetParent !== null;
  const nodes = (s) => [...document.querySelectorAll(s)].filter(vis);
  const text = (n) => ((n.innerText || n.getAttribute('aria-label') || n.getAttribute('title') || '').trim());
  const all = () => nodes('button, a, [role="button"], [role="tab"], summary');
  const workTabs = () => {
    const found = new Set();
    for (const n of nodes('[role="tab"], button')) {
      const t = text(n);
      if (${JSON.stringify(WORK_TABS)}.includes(t)) found.add(t);
    }
    return [...found];
  };
`;

async function main() {
  const target = await pageTarget();
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  const report = { schema: "muse-desktop.cdp-panel.v1", steps: {} };
  try {
    // 1. Open a conversation so the work bar can exist.
    report.steps.openConversation = await evaluate(client, `(() => {
      ${HELPERS}
      const hit = all().find((n) => /cdp dry run|Session 01a0/i.test(n.innerText || ''));
      if (!hit) return { opened: false };
      hit.click();
      return { opened: true, text: text(hit).slice(0, 40) };
    })()`);
    await sleep(2_000);

    // 2. Expand the side panel. The toggle is labelled in the DOM ("Hide work
    // panel" when open, "Show work panel" when closed), so target that label
    // first; the icon heuristic is only a fallback and deliberately excludes
    // buttons that already carry an accessible name, so it cannot fire an
    // unrelated action.
    report.steps.panelToggle = await evaluate(client, `(() => {
      ${HELPERS}
      const byLabel = nodes('button, a, [role="button"]').find((n) => /work panel|side panel|panel/i.test(text(n)));
      if (byLabel) {
        const wasOpen = /hide/i.test(text(byLabel));
        byLabel.click();
        return { toggled: true, via: 'label', label: text(byLabel), wasOpen };
      }
      const top = nodes('header, [class*=topbar], [class*=titlebar], [class*=app-bar], [class*=top-bar]')[0] || document.body;
      const candidates = [...top.querySelectorAll('button')].filter(vis).filter((n) => !text(n));
      const withSvg = candidates.filter((n) => n.querySelector('svg'));
      const pool = withSvg.length ? withSvg : candidates;
      const labels = pool.map((n) => (n.getAttribute('aria-label') || n.getAttribute('title') || n.getAttribute('data-testid') || '').slice(0, 30));
      const target = pool.find((n) => /panel|sidebar|aside|split|layout/i.test(n.outerHTML.slice(0, 400))) || pool[0];
      if (!target) return { toggled: false, candidateCount: 0 };
      target.click();
      return { toggled: true, candidateCount: pool.length, candidateLabels: labels };
    })()`);
    await sleep(2_500);
    report.steps.tabsAfterToggle = await evaluate(client, `(() => { ${HELPERS} return workTabs(); })()`);

    if (!report.steps.tabsAfterToggle.length) {
      // The toggle may have inverted an already-open panel. Try the labelled
      // control once more rather than clicking every nameless button in the
      // header, which could fire an unrelated action and skew the measurement.
      report.steps.retryToggle = await evaluate(client, `(() => {
        ${HELPERS}
        const byLabel = nodes('button, a, [role="button"]').find((n) => /work panel|side panel/i.test(text(n)));
        if (!byLabel) return { hit: false, reason: 'no labelled panel toggle' };
        byLabel.click();
        return { hit: true, label: text(byLabel) };
      })()`);
      await sleep(2_000);
      report.steps.tabsAfterRetry = await evaluate(client, `(() => { ${HELPERS} return workTabs(); })()`);
    }

    // 3. Click the Browser tab and inspect the surface.
    report.steps.browserTab = await evaluate(client, `(() => {
      ${HELPERS}
      const hit = all().find((n) => text(n) === 'Browser');
      if (!hit) return { clicked: false };
      hit.click();
      return { clicked: true };
    })()`);
    await sleep(2_500);
    report.steps.browserPanel = await evaluate(client, `(() => {
      ${HELPERS}
      const body = (document.body.innerText || '').replace(/\\s+/g, ' ');
      const inputs = nodes('input');
      return {
        inputs: inputs.map((n) => ({ type: n.type, ph: (n.placeholder || '').slice(0, 40), val: (n.value || '').slice(0, 50) })),
        iframes: nodes('iframe').map((f) => ({ src: (f.getAttribute('src') || '').slice(0, 60), sandbox: f.getAttribute('sandbox') })),
        hasOpenNative: /Open native/i.test(body),
        hasReload: /Reload/i.test(body),
        hasSaveSelectedLink: /Save selected link/i.test(body),
        hasObservePage: /Observe page/i.test(body),
        hasCaptureVisible: /Capture visible/i.test(body),
        hasAddPageContext: /Add page context/i.test(body),
        hasTabPlus: nodes('button').some((n) => text(n) === '+' || /new tab/i.test(text(n))),
        tail: body.slice(-260)
      };
    })()`);

    // 4. Navigate if a URL field is present.
    report.steps.navigate = await evaluate(client, `(() => {
      ${HELPERS}
      const field = nodes('input').find((n) => /url|address|adresse|search|recherche/i.test((n.placeholder || '') + n.type));
      if (!field) return { typed: false, reason: 'no url field' };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(field, ${JSON.stringify(TARGET_URL)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
      const form = field.closest('form');
      if (form) { try { form.requestSubmit(); return { typed: true, via: 'form' }; } catch { /* fall */ } }
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      return { typed: true, via: 'enter' };
    })()`);
    await sleep(6_000);
    report.steps.afterNavigate = await evaluate(client, `(() => {
      ${HELPERS}
      return {
        tabState: Object.keys(localStorage).filter((k) => k.startsWith('muse-desktop.browser.tabs'))
          .map((k) => ({ key: k.slice(0, 46), val: (localStorage.getItem(k) || '').slice(0, 220) })),
        iframes: nodes('iframe').map((f) => ({ src: (f.getAttribute('src') || '').slice(0, 70) })),
        bodyTail: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(-240)
      };
    })()`);
  } catch (error) {
    report.failure = String((error && error.message) || error).slice(0, 300);
  } finally {
    client.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => { process.stderr.write(`${(error && error.message) || error}\n`); exit(1); });
