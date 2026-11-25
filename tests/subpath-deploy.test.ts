/**
 * Sub-path deployment guard (issue #24 — 飞牛 / fnOS NAS).
 *
 * 飞牛 serves every app through a gateway prefix, e.g.
 * `https://nas.example.com/app/Harness/dsh/`. DSH itself assumes it owns the
 * origin root (`dsh-client-modules` builds `/plugins/...` bundle URLs), so such
 * a gateway rewrites the HTML it relays. It cannot rewrite a string inside our
 * bundle — which is why the panel used to request the origin-root
 * `/wechat/api/status`, 404 on every call, and still rendered a page that
 * looked like a logged-out install.
 *
 * The fix derives the prefix from the bundle's own URL (the loader's
 * `<script src>`, captured at evaluation time — see below) and lets the
 * operator override it per browser. The prefix math lives in one
 * `#region api-base` block with no DOM and no storage, so it is exercised here
 * for real instead of by string-matching.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const client = readFileSync(fileURLToPath(new URL("../src/client.js", import.meta.url)), "utf8");
const host = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

/** The pure `api-base` region, evaluated as plain script. */
function loadApiBase() {
  const start = client.indexOf("// #region api-base");
  const end = client.indexOf("// #endregion", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  // eslint-disable-next-line no-new-func -- the bundle is a script, not a module
  const factory = new Function(
    `${client.slice(start, end)}\nreturn { normalizeApiBase, apiBaseFromBundleUrl, pickApiBase };`,
  );
  return factory() as {
    normalizeApiBase(raw: unknown): string;
    apiBaseFromBundleUrl(url: unknown): string;
    pickApiBase(stored: unknown, bundleUrl: unknown): { base: string; source: string };
  };
}

const apiBase = loadApiBase();

describe("the mount prefix is read off the bundle URL", () => {
  it.each([
    // 飞牛: the app lives one or more segments below the origin root.
    ["https://nas.example.com/app/Harness/dsh/plugins/dsh-wechat/client.js?rev=abc", "/app/Harness/dsh"],
    // Any other gateway depth, including a deliberately odd one.
    ["https://nas.example.com/x/y/z/plugins/dsh-wechat/client.js?rev=1", "/x/y/z"],
    // The loader's batch shape carries the same prefix.
    ["https://nas.example.com/app/Harness/dsh/plugins/??dsh-wechat/client.js&rev=9", "/app/Harness/dsh"],
    // A normal install: the bundle owns the origin root.
    ["https://dsh.example.com/plugins/dsh-wechat/client.js?rev=1", ""],
    ["http://127.0.0.1:58121/plugins/dsh-wechat/client.js", ""],
    // Not a plugin bundle at all (a gateway that rewrote the script URL, an
    // HMR re-injection from elsewhere): no prefix can be inferred.
    ["https://nas.example.com/somewhere/else.js", ""],
    ["", ""],
  ])("%s → %s", (url, expected) => {
    expect(apiBase.apiBaseFromBundleUrl(url)).toBe(expected);
  });

  it("keeps a prefix that itself contains the /plugins/ tail", () => {
    expect(apiBase.apiBaseFromBundleUrl("https://h/a/plugins/b/plugins/x/client.js")).toBe("/a/plugins/b");
  });
});

describe("an operator-entered prefix is normalized to a path", () => {
  it.each([
    // What the issue reports people paste.
    ["https://nas.example.com/app/Harness/dsh/", "/app/Harness/dsh"],
    ["/app/Harness/dsh/", "/app/Harness/dsh"],
    ["app/Harness/dsh", "/app/Harness/dsh"],
    ["/app//Harness/", "/app/Harness"],
    ["/app/Harness/dsh?x=1#y", "/app/Harness/dsh"],
    // The root, spelled every way it gets spelled.
    ["", ""],
    ["   ", ""],
    ["/", ""],
    ["https://nas.example.com/", ""],
    // Junk cannot invent a prefix (and must not throw the panel away).
    ["http://", ""],
  ])("%s → %s", (raw, expected) => {
    expect(apiBase.normalizeApiBase(raw)).toBe(expected);
  });
});

describe("the manual override wins, the bundle URL is the fallback", () => {
  it("prefers a stored prefix over detection", () => {
    expect(apiBase.pickApiBase("/manual", "https://h/app/plugins/x/client.js")).toEqual({ base: "/manual", source: "manual" });
  });

  it("detects the prefix when nothing is stored", () => {
    expect(apiBase.pickApiBase("", "https://h/app/plugins/x/client.js")).toEqual({ base: "/app", source: "auto" });
  });

  it("falls back to the origin root", () => {
    expect(apiBase.pickApiBase("", "https://h/plugins/x/client.js")).toEqual({ base: "", source: "root" });
  });

  it("treats a blank or junk stored value as 'auto', not as a prefix", () => {
    expect(apiBase.pickApiBase("   ", "https://h/app/plugins/x/client.js")).toEqual({ base: "/app", source: "auto" });
  });
});

describe("every panel request goes through the prefix", () => {
  it("the API helper resolves its URL instead of hard-coding a root path", () => {
    expect(client).not.toContain('fetch("/wechat/api');
    expect(client).toContain("function apiUrl(path)");
    expect(client).toContain("fetch(apiUrl(path),");
    // One chokepoint: a second fetch anywhere would bypass the prefix again.
    expect(client.match(/fetch\(/g)?.length).toBe(1);
  });

  it("the QR image is fetched through the prefix too", () => {
    expect(client).toContain('assetUrl("/wechat/api/qr-image');
  });

  it("the bundle URL is captured while the script element still exists", () => {
    // The loader appends `<script src>` and removes it in its `load` handler,
    // which fires after execution; the factory runs later still. Capturing
    // inside the factory would therefore always read null.
    expect(client).toContain("document.currentScript");
    const captureAt = client.indexOf("document.currentScript");
    const loadAt = client.indexOf("window.__ModuleLoader__.load(");
    expect(captureAt).toBeGreaterThan(-1);
    expect(loadAt).toBeGreaterThan(captureAt);
  });

  it("the override is remembered per browser under one key", () => {
    expect(client).toContain('"dsh-wechat/api-base"');
    expect(client).toContain("window.localStorage");
    // Private mode / quota must degrade to "works until reload", not throw.
    expect(client).toContain("writeStore(API_BASE_KEY");
  });
});

describe("the 接口前缀 control lives in 连接与默认行为", () => {
  it("renders inside the connection group", () => {
    const groupStart = client.indexOf('id: "connection"');
    const groupEnd = client.indexOf('id: "delivery"');
    expect(groupStart).toBeGreaterThan(-1);
    expect(groupEnd).toBeGreaterThan(groupStart);
    expect(client.slice(groupStart, groupEnd)).toContain("renderApiBase()");
  });

  it("keeps one last-resort copy outside the groups", () => {
    // With a wrong prefix `/status` returns no config, `form` stays null and
    // EVERY group is skipped — including the one that holds the control. The
    // repair path therefore has to render outside them, from the same
    // definition (a second copy would drift into the unreachable one).
    const groupsAt = client.indexOf('form ? createElement("div", { className: "wx_groups" }');
    expect(groupsAt).toBeGreaterThan(-1);
    const before = client.slice(0, groupsAt);
    expect(before).toContain("linkError && !form");
    expect(before).toContain("renderApiBase()");
    expect(client.match(/renderApiBase\(\)/g)?.length).toBe(2);
  });

  it("opens itself when the API cannot be reached", () => {
    expect(client).toContain("接口不通");
    expect(client).toContain("if (linkError && !status) setBaseOpen(true);");
  });

  it("treats a non-plugin answer as unreachable instead of an empty install", () => {
    // A gateway 404 page is HTTP 200 + HTML: `json()` fails and the body is
    // `{}`. Without the `phase` check the card renders "未登录" over a dead API.
    expect(client).toContain('typeof body.phase !== "string"');
  });

  it("offers both the apply and the auto-detect action", () => {
    expect(client).toContain("applyApiBase(baseDraft)");
    expect(client).toContain('applyApiBase("")');
    expect(client).toContain("自动识别");
  });

  it("uses a class that the stylesheet defines", () => {
    expect(client).toContain("className: \"wx_base_input\"");
    expect(client).toContain(".wx_base_input{");
  });
});

describe("the standalone QR page derives its prefix from its own address", () => {  it("no longer hard-codes origin-root endpoints", () => {
    expect(host).not.toContain("fetch('/wechat/status')");
    expect(host).not.toContain("qr.src = '/wechat/api/qr-image");
    expect(host).toContain("API_BASE + '/wechat/status'");
    expect(host).toContain("API_BASE + '/wechat/api/qr-image");
  });

  it("strips exactly the /wechat/qr suffix it is served at", () => {
    // The page is an exact route, so this is deterministic — no heuristics.
    expect(host).toContain("var suffix = '/wechat/qr';");
    expect(host).toContain("var API_BASE = (function () {");
  });

  it("avoids a backslash regex inside the template literal", () => {
    // QR_PAGE is a TS template literal: `\/` there is an escape that silently
    // collapses to `/` and would ship a broken pattern to the browser.
    const pageStart = host.indexOf("const QR_PAGE = `");
    const pageEnd = host.indexOf("</html>`;", pageStart);
    expect(pageStart).toBeGreaterThan(-1);
    expect(pageEnd).toBeGreaterThan(pageStart);
    const page = host.slice(pageStart, pageEnd);
    expect(page).not.toMatch(/<script>[\s\S]*?\\\//);
  });
});

/**
 * End to end: run the shipped bundle exactly as the browser kernel does, render
 * the panel the way React does, and read the URL that actually goes out.
 * Correct prefix math that nothing calls would still 404 — this is the only
 * place the whole path (bundle URL → capture → resolve → fetch) is exercised.
 */
interface PanelHarness {
  /** Every URL the panel requested, in order. */
  requests: string[];
  /** Render (or re-render) the section and run the effects that pass registered. */
  render(): Promise<unknown>;
}

async function runPanel(options: {
  bundleUrl: string;
  /** Value already stored under `dsh-wechat/api-base`, if any. */
  stored?: string;
  /** What `/wechat/api/status` answers. Defaults to a healthy logged-in payload. */
  respond?: () => unknown;
}): Promise<PanelHarness> {
  const requests: string[] = [];
  const effects: Array<() => unknown> = [];
  const hooks: unknown[] = [];
  let slot = 0;

  // A positional-hook React stand-in: enough to render the section repeatedly
  // and run its effects, because the assertion is about the request, not the
  // markup. `useState(fn)` follows React's lazy-initializer rule — the component
  // passes `loadOpenGroups`/`loadHelpOpen` as functions, and storing the
  // function itself would make both truthy and fire requests a browser never
  // makes.
  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState: (init: unknown) => {
      const index = slot++;
      if (!(index in hooks)) hooks[index] = typeof init === "function" ? (init as () => unknown)() : init;
      return [hooks[index], (next: unknown) => {
        hooks[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks[index]) : next;
      }];
    },
    useRef: (init: unknown) => {
      const index = slot++;
      if (!(index in hooks)) hooks[index] = { current: init };
      return hooks[index];
    },
    useCallback: (fn: unknown) => {
      slot += 1;
      return fn;
    },
    useEffect: (fn: () => unknown) => {
      slot += 1;
      effects.push(fn);
    },
  };

  let panel: (() => unknown) | undefined;
  const fakeWindow = {
    __ModuleLoader__: {
      load: (spec: {
        factory: (require: (id: string) => unknown) => { apply: (ctx: unknown) => void };
      }) => {
        const mod = spec.factory(() => react);
        mod.apply({
          effect: (body: () => unknown) => {
            body();
          },
          slots: {
            inject: (_key: string, run: () => unknown) => {
              run();
            },
            register: (_definition: unknown, view: () => unknown) => {
              panel = view;
            },
          },
        });
      },
    },
    localStorage: {
      getItem: (key: string) => (options.stored !== undefined && key === "dsh-wechat/api-base"
        ? JSON.stringify(options.stored)
        : null),
      setItem: () => {},
    },
  };
  const fakeDocument = {
    currentScript: { src: options.bundleUrl },
    querySelector: () => null,
    createElement: () => ({ dataset: {} as Record<string, string> }),
    head: { appendChild: () => {} },
  };
  const respond = options.respond ?? (() => ({ phase: "logged-in", config: {} }));
  const fetchStub = (url: string) => {
    requests.push(url);
    return Promise.resolve({ ok: true, status: 200, json: async () => respond() });
  };

  // eslint-disable-next-line no-new-func -- the bundle is a script, not a module
  const run = new Function("window", "document", "fetch", "setInterval", "clearInterval", client);
  run(fakeWindow, fakeDocument, fetchStub, () => 0, () => {});

  return {
    requests,
    async render() {
      slot = 0;
      const tree = panel!();
      // React re-runs an effect only when its deps change; this stand-in runs
      // every effect of the pass. The two fetch effects are idempotent, and a
      // state change one pass causes is observed by the NEXT render — which is
      // also how React behaves after an async response lands.
      for (const effect of effects.splice(0)) effect();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return tree;
    },
  };
}

/** Whether any element in the rendered tree was created with this className. */
function usesClass(tree: unknown, className: string): boolean {
  if (Array.isArray(tree)) return tree.some((entry) => usesClass(entry, className));
  if (tree === null || typeof tree !== "object") return false;
  const node = tree as { props?: { className?: unknown }; children?: unknown[] };
  if (node.props?.className === className) return true;
  return (node.children ?? []).some((child) => usesClass(child, className));
}

describe("the rendered panel requests through the resolved prefix", () => {
  // The panel emits an origin-absolute PATH (the browser adds protocol + host),
  // so the gateway prefix has to be inside it — that is the whole bug.
  it("targets the gateway prefix on a 飞牛 deployment", async () => {
    const panel = await runPanel({ bundleUrl: "https://nas.example.com/app/Harness/dsh/plugins/dsh-wechat/client.js?rev=1" });
    await panel.render();
    expect(panel.requests).toEqual(["/app/Harness/dsh/wechat/api/status"]);
  });

  it("stays at the origin root on a normal install", async () => {
    const panel = await runPanel({ bundleUrl: "https://dsh.example.com/plugins/dsh-wechat/client.js?rev=1" });
    await panel.render();
    expect(panel.requests).toEqual(["/wechat/api/status"]);
  });

  it("obeys a manual override even when the bundle URL says otherwise", async () => {
    // The escape hatch for a gateway that rewrites the script URL itself.
    const panel = await runPanel({
      bundleUrl: "https://nas.example.com/plugins/dsh-wechat/client.js?rev=1",
      stored: "/app/Harness/dsh",
    });
    await panel.render();
    expect(panel.requests).toEqual(["/app/Harness/dsh/wechat/api/status"]);
  });
});

describe("a broken prefix is repairable from the panel itself", () => {
  it("opens the 接口前缀 editor when /status answers with non-plugin content", async () => {
    // What a wrong prefix actually looks like: a gateway or the GUI shell
    // answers 200 with HTML, so `json()` fails and the body is `{}` — no phase,
    // no error event, nothing that would otherwise surface as a failure.
    const panel = await runPanel({
      bundleUrl: "https://nas.example.com/plugins/dsh-wechat/client.js?rev=1",
      respond: () => ({}),
    });
    await panel.render(); // renders; refresh() settles with the empty body
    await panel.render(); // now linkError is set, and its effect opens the editor
    const tree = await panel.render(); // the editor is on screen
    expect(usesClass(tree, "wx_base_input")).toBe(true);
    expect(panel.requests[0]).toBe("/wechat/api/status");
  });

  it("does not open it while the host answers normally", async () => {
    const panel = await runPanel({ bundleUrl: "https://dsh.example.com/plugins/dsh-wechat/client.js?rev=1" });
    await panel.render();
    const tree = await panel.render();
    expect(usesClass(tree, "wx_base_input")).toBe(false);
  });
});
