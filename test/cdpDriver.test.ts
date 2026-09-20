/**
 * Contract tests for the parts of the CDP drivers that are pure JavaScript.
 *
 * `scripts/cdp-drive.mjs`, `cdp-annotate.mjs`, `cdp-panel.mjs` and
 * `cdp-scenario.mjs` are executables, not modules: they export nothing and run
 * `await main()` when they are loaded, which fetches
 * `http://127.0.0.1:<port>/json/list` and calls `exit(1)` when no dev build is
 * listening — importing one would take the whole `node --test` run down. The
 * declarations below are therefore loaded from the script text by
 * `test/scriptSource.ts`.
 *
 * What is covered without a browser: the `Runtime.evaluate` request the driver
 * builds, the JSON protocol it uses to move a page value back in process, the
 * error envelope, and the DevTools target discovery (driven by an injected
 * `fetch`). The DOM helpers themselves are only checked as injected source:
 * they must expand without leftover interpolation and still declare the
 * helpers the command wrappers call. Anything that needs a live DOM is out of
 * scope by construction.
 *
 * Recommended follow-up (deliberately not applied here, the scripts are under
 * review): add `export` to `evaluate` and `pageTarget` and drop the harness.
 *
 * Runs on the built-in node:test runner, no extra framework:
 *   npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadDeclarations } from "./scriptSource.ts";

/** The tracked CDP drivers; all four share the same client and evaluate code. */
const DRIVERS = ["cdp-drive.mjs", "cdp-annotate.mjs", "cdp-panel.mjs", "cdp-scenario.mjs"] as const;

const PORT = 9333;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

type EvaluateParams = { expression: string; returnByValue?: boolean; awaitPromise?: boolean };
type CdpFrame = Record<string, unknown>;
type FakeClient = {
  calls: Array<{ method: string; params: EvaluateParams }>;
  send: (method: string, params: EvaluateParams) => Promise<CdpFrame>;
};
type Evaluate = (client: FakeClient, expression: string) => Promise<unknown>;
type PageTarget = () => Promise<{ type?: unknown; webSocketDebuggerUrl?: unknown }>;
type Connect = (url: string) => {
  ready: Promise<void>;
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
};
type ListResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
type FakeFetch = ((url: string) => Promise<ListResponse>) & { urls: string[] };

/** A client that answers with one fixed protocol frame. */
function replyClient(frame: CdpFrame): FakeClient {
  const calls: FakeClient["calls"] = [];
  return {
    calls,
    async send(method, params) {
      calls.push({ method, params });
      return frame;
    },
  };
}

/**
 * A client that behaves like the page side of the protocol: it runs the exact
 * wrapper expression the driver built and returns the JSON text the way
 * `Runtime.evaluate` with `returnByValue` would. Running the wrapper in process
 * also proves it stays free of `document` / `window`, which is what allows the
 * page to evaluate it at all.
 */
function pageClient(): FakeClient {
  const calls: FakeClient["calls"] = [];
  return {
    calls,
    async send(method, params) {
      calls.push({ method, params });
      return { result: { value: new Function(`return (${params.expression});`)() } };
    },
  };
}

/** A stand-in for `fetch` that records the DevTools list URLs it is asked for. */
function fakeFetch(targets: unknown[], options: { ok?: boolean; status?: number } = {}): FakeFetch {
  const urls: string[] = [];
  const implementation = async (url: string): Promise<ListResponse> => {
    urls.push(url);
    return { ok: options.ok ?? true, status: options.status ?? 200, json: async () => targets };
  };
  return Object.assign(implementation, { urls });
}

type Listener = (event: { data?: string }) => void;
type SentFrame = { id?: number; method?: string; params?: unknown };
type FakeSocket = {
  url: string;
  sent: SentFrame[];
  closed: boolean;
  emit: (type: string, event?: { data?: string }) => void;
  reply: (frame: Record<string, unknown>) => void;
};

/**
 * A stand-in for the page debug socket: it records the frames the client sends
 * and lets the test emit protocol messages back. `once` is ignored — the tests
 * emit each socket event at most once.
 */
function fakeWebSocket() {
  const sockets: FakeSocket[] = [];
  class FakeWebSocket {
    url: string;
    sent: SentFrame[] = [];
    closed = false;
    listeners: Record<string, Listener[]> = {};

    constructor(url: string) {
      this.url = url;
      sockets.push(this as unknown as FakeSocket);
    }

    addEventListener(type: string, listener: Listener): void {
      this.listeners[type] = [...(this.listeners[type] ?? []), listener];
    }

    send(data: string): void {
      this.sent.push(JSON.parse(data) as SentFrame);
    }

    close(): void {
      this.closed = true;
    }

    emit(type: string, event: { data?: string } = {}): void {
      for (const listener of this.listeners[type] ?? []) listener(event);
    }

    reply(frame: Record<string, unknown>): void {
      this.emit("message", { data: JSON.stringify(frame) });
    }
  }
  return { WebSocket: FakeWebSocket, sockets };
}

/** Load `pageTarget` with the port and the list response controlled by the test. */
function loadPageTarget(driver: string, fetch: FakeFetch): PageTarget {
  const names = driver === "cdp-drive.mjs" ? ["ENDPOINT", "pageTarget"] : ["pageTarget"];
  return loadDeclarations<{ pageTarget: PageTarget }>(driver, names, { PORT, fetch }).pageTarget;
}

/** Open a client on a fake socket; the driver connects on construction. */
function openSocketClient(driver: string) {
  const { WebSocket, sockets } = fakeWebSocket();
  const { connect } = loadDeclarations<{ connect: Connect }>(driver, ["connect"], { WebSocket });
  const client = connect("ws://127.0.0.1:9333/devtools/page/1");
  return { client, socket: sockets[0] };
}

/** Only `cdp-drive.mjs` reports the endpoint and the target count when it fails. */
const noTargetMessage = (driver: string): RegExp =>
  driver === "cdp-drive.mjs"
    ? new RegExp(`no page target on ${ENDPOINT.replace(/[.:/]/g, "\\$&")} \\(targets: 2\\)`)
    : /no CDP page target/;

for (const driver of DRIVERS) {
  describe(`CDP driver ${driver}`, () => {
    const { evaluate } = loadDeclarations<{ evaluate: Evaluate }>(driver, ["evaluate"]);

    describe("evaluate protocol", () => {
      it("asks the page for a by-value, awaited Runtime.evaluate", async () => {
        const client = replyClient({ result: { value: "null" } });
        await evaluate(client, "1 + 1");
        assert.equal(client.calls.length, 1);
        assert.equal(client.calls[0].method, "Runtime.evaluate");
        assert.equal(client.calls[0].params.returnByValue, true);
        assert.equal(client.calls[0].params.awaitPromise, true);
      });

      it("wraps the caller expression in the JSON.stringify protocol", async () => {
        const client = replyClient({ result: { value: "null" } });
        await evaluate(client, "1 + 1");
        const wrapped = client.calls[0].params.expression;
        assert.ok(wrapped.includes("JSON.stringify(1 + 1)"), wrapped);
        // The wrapper must be a self-contained expression that yields the JSON
        // text of the page value.
        assert.equal(new Function(`return (${wrapped});`)(), "2");
      });

      it("round-trips structured page values", async () => {
        const page = pageClient();
        const value = { composer: { disabled: false }, queueKeys: ["a", "b"], size: 3 };
        assert.deepEqual(
          await evaluate(page, "({ composer: { disabled: false }, queueKeys: ['a', 'b'], size: 3 })"),
          value,
        );
        assert.equal(await evaluate(page, "'plain text'"), "plain text");
        assert.equal(await evaluate(page, "42"), 42);
        assert.equal(await evaluate(page, "null"), null);
      });

      it("resolves a page value that has no JSON form to null", async () => {
        // `JSON.stringify(undefined)` is undefined, so the page returns no
        // value at all and the driver must not invent one.
        assert.equal(await evaluate(pageClient(), "undefined"), null);
        assert.equal(await evaluate(replyClient({ result: {} }), "1 + 1"), null);
      });

      it("does not mistake a plain string payload for the error envelope", async () => {
        assert.equal(await evaluate(pageClient(), "'__error'"), "__error");
      });

      it("turns the page-side error envelope into a rejection", async () => {
        const client = replyClient({ result: { value: JSON.stringify({ __error: "page blew up" }) } });
        await assert.rejects(() => evaluate(client, "boom"), /page blew up/);
      });

      it("reports a page-side throw as a rejection, Error or not", async () => {
        await assert.rejects(
          () => evaluate(pageClient(), "(() => { throw new Error('host offline'); })()"),
          /host offline/,
        );
        await assert.rejects(
          () => evaluate(pageClient(), "(() => { throw 'plain failure'; })()"),
          /plain failure/,
        );
      });

      it("surfaces protocol exception details with the page description", async () => {
        const client = replyClient({
          exceptionDetails: { exception: { description: "ReferenceError: nope is not defined" } },
        });
        await assert.rejects(() => evaluate(client, "nope"), /ReferenceError: nope is not defined/);
      });

      it("falls back to a stable message when the description is missing", async () => {
        let message = "";
        await assert.rejects(
          () => evaluate(replyClient({ exceptionDetails: {} }), "nope"),
          (error: Error) => {
            message = error.message;
            return true;
          },
        );
        assert.match(message, /^eval(uation)? failed$/);
      });

      it("rejects a truncated page reply instead of returning a partial value", async () => {
        await assert.rejects(
          () => evaluate(replyClient({ result: { value: '{"composer":' } }), "({ composer: 1 })"),
          SyntaxError,
        );
      });
    });

    describe("page target discovery", () => {
      it("queries the DevTools list endpoint on the configured port", async () => {
        const fetch = fakeFetch([
          { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/1" },
        ]);
        const target = await loadPageTarget(driver, fetch)();
        assert.deepEqual(fetch.urls, [`${ENDPOINT}/json/list`]);
        assert.equal(target.webSocketDebuggerUrl, "ws://127.0.0.1:9333/devtools/page/1");
      });

      it("skips targets that are not a debuggable page", async () => {
        const fetch = fakeFetch([
          { type: "service_worker", webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/1" },
          { type: "page" },
          { type: "iframe", webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/frame" },
          { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/first" },
          { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/second" },
        ]);
        const target = await loadPageTarget(driver, fetch)();
        assert.equal(target.webSocketDebuggerUrl, "ws://127.0.0.1:9333/devtools/page/first");
      });

      it("fails with a diagnostic when no page target is exposed", async () => {
        const fetch = fakeFetch([
          { type: "service_worker", webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/1" },
          { type: "page" },
        ]);
        await assert.rejects(() => loadPageTarget(driver, fetch)(), noTargetMessage(driver));
      });

      if (driver === "cdp-drive.mjs") {
        it("reports an HTTP failure instead of parsing the body", async () => {
          const fetch = fakeFetch([], { ok: false, status: 503 });
          await assert.rejects(() => loadPageTarget(driver, fetch)(), /CDP list failed: HTTP 503/);
        });
      }
    });

    describe("socket client", () => {
      it("waits for the socket open event before reporting ready", async () => {
        const { client, socket } = openSocketClient(driver);
        assert.equal(socket.url, "ws://127.0.0.1:9333/devtools/page/1");
        let settled = false;
        void client.ready.then(() => {
          settled = true;
        });
        await Promise.resolve();
        assert.equal(settled, false, "ready must not resolve before the socket is open");
        socket.emit("open");
        await client.ready;
        assert.equal(settled, true);
      });

      it("numbers requests and correlates replies by id, in any order", async () => {
        const { client, socket } = openSocketClient(driver);
        const first = client.send("Runtime.evaluate", { expression: "1" });
        const second = client.send("DOM.getDocument", {});
        assert.deepEqual(socket.sent.map((frame) => frame.id), [1, 2]);
        assert.equal(socket.sent[0].method, "Runtime.evaluate");
        assert.deepEqual(socket.sent[0].params, { expression: "1" });
        socket.reply({ id: 2, result: { root: true } });
        socket.reply({ id: 1, result: { value: 1 } });
        assert.deepEqual(await second, { root: true });
        assert.deepEqual(await first, { value: 1 });
      });

      it("rejects only the request an error frame answers", async () => {
        const { client, socket } = openSocketClient(driver);
        const failing = client.send("Runtime.evaluate", { expression: "boom" });
        const surviving = client.send("Runtime.evaluate", { expression: "fine" });
        socket.reply({ id: 1, error: { message: "boom" } });
        await assert.rejects(() => failing, /Runtime\.evaluate: boom/);
        socket.reply({ id: 2, result: "fine" });
        assert.equal(await surviving, "fine");
      });

      it("ignores non-JSON frames, events and unknown ids", async () => {
        const { client, socket } = openSocketClient(driver);
        const request = client.send("Runtime.evaluate", { expression: "1" });
        socket.emit("message", { data: "not json" });
        socket.emit("message", {});
        socket.emit("message", { data: JSON.stringify({ method: "Page.loadEventFired", params: {} }) });
        socket.emit("message", { data: JSON.stringify({ id: 99, result: "stray" }) });
        socket.reply({ id: 1, result: "expected" });
        assert.equal(await request, "expected");
      });

      it("rejects ready when the socket cannot open", async () => {
        const { client, socket } = openSocketClient(driver);
        socket.emit("error");
        await assert.rejects(() => client.ready, /CDP socket error/);
      });

      it("closes the socket", async () => {
        const { client, socket } = openSocketClient(driver);
        assert.equal(socket.closed, false);
        client.close();
        assert.equal(socket.closed, true);
      });
    });
  });
}

/** The DOM helpers each driver interpolates into every page expression. */
const SNIPPETS = [
  { driver: "cdp-drive.mjs", constant: "PAGE_HELPERS", helpers: ["byText", "composer"], dependencies: [] },
  {
    driver: "cdp-annotate.mjs",
    constant: "HELPERS",
    helpers: ["vis", "nodes", "text", "clickText", "setInput"],
    dependencies: [],
  },
  {
    driver: "cdp-panel.mjs",
    constant: "HELPERS",
    helpers: ["vis", "nodes", "text", "all", "workTabs"],
    dependencies: ["WORK_TABS"],
  },
  {
    driver: "cdp-scenario.mjs",
    constant: "HELPERS",
    helpers: ["vis", "nodes", "labelled", "composer"],
    dependencies: [],
  },
] as const;

describe("injected page helpers", () => {
  for (const { driver, constant, helpers, dependencies } of SNIPPETS) {
    it(`expands the ${driver} snippet into self-contained source`, () => {
      const loaded = loadDeclarations<Record<string, string>>(driver, [...dependencies, constant]);
      const snippet = loaded[constant];
      assert.equal(typeof snippet, "string");
      assert.ok(snippet.length > 100, "a page helper snippet must not collapse to nothing");
      assert.equal(snippet.includes("${"), false, "every interpolation must be resolved before injection");
    });

    it(`still declares the helpers the ${driver} command wrappers call`, () => {
      const loaded = loadDeclarations<Record<string, string>>(driver, [...dependencies, constant]);
      const declared = new Function(`${loaded[constant]}\nreturn { ${helpers.join(", ")} };`)();
      for (const helper of helpers) {
        assert.equal(typeof declared[helper], "function", `${helper} must be declared by the snippet`);
      }
    });
  }

  it("keeps the panel tab list interpolated from the driver constant", () => {
    const { WORK_TABS, HELPERS } = loadDeclarations<{ WORK_TABS: string[]; HELPERS: string }>(
      "cdp-panel.mjs",
      ["WORK_TABS", "HELPERS"],
    );
    assert.ok(Array.isArray(WORK_TABS) && WORK_TABS.length > 0);
    assert.ok(
      HELPERS.includes(JSON.stringify(WORK_TABS)),
      "the injected snippet must embed the work-tab list instead of a stale copy",
    );
  });
});
