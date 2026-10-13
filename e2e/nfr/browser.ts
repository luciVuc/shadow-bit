// Standalone-browser harness for the a11y and responsive suites.
//
// Why not just use the Electron window?
//
// 1. The renderer ships `script-src 'self'`, so Playwright cannot inject
//    axe-core inline. Serving the page over http and loading axe from the
//    same origin satisfies 'self' without weakening the production CSP.
// 2. The Electron window enforces `minWidth: 640`, so the XS (320px) and
//    SM (480px) breakpoints are physically unreachable there. The responsive
//    suite still verifies the real window clamps at 640 — see
//    nfr.responsive.test.ts.
//
// The DOM and CSS served here are the real files, byte-for-byte. Only the
// preload bridge is stubbed, because there is no main process behind a plain
// Chromium tab. Everything the tests assert — semantics, ARIA, keyboard
// behaviour, layout — is production code.

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const RENDERER_DIR = path.resolve(__dirname, "../../src/gui/renderer");
const AXE_SRC = require.resolve("axe-core/axe.min.js");

export interface BrowserHarness {
  browser: Browser;
  page: Page;
  /** Reload the page (call after setting stub overrides). */
  reload(): Promise<void>;
  /** Override one bridge method for subsequent calls. */
  setOverride(name: string, fn: (...args: unknown[]) => unknown): Promise<void>;
  /** Run axe with the given tag set; returns simplified violations. */
  runAxe(tags: string[]): Promise<AxeViolation[]>;
  /** Switch tabs and wait for the panel to become active. */
  switchTab(name: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  tags: string[];
  nodes: { target: string[]; failureSummary: string }[];
}

/** Start a static server for the renderer plus axe and the bridge stub. */
export async function launchBrowserHarness(): Promise<BrowserHarness> {
  const axe = fs.readFileSync(AXE_SRC, "utf8");
  const stub = fs.readFileSync(path.join(__dirname, "stub-bridge.js"), "utf8");

  const indexHtml = fs
    .readFileSync(path.join(RENDERER_DIR, "index.html"), "utf8")
    // Load the stub first so window.shadowbit exists before renderer.js runs.
    // Same-origin, so 'self' in script-src is satisfied.
    .replace(
      '<script src="renderer.js"></script>',
      '<script src="/__stub.js"></script>\n    <script src="renderer.js"></script>',
    );

  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const send = (body: string | Buffer, type: string) => {
      res.writeHead(200, { "content-type": type });
      res.end(body);
    };
    if (url === "/" || url === "/index.html") {
      send(indexHtml, "text/html; charset=utf-8");
    } else if (url === "/__stub.js") {
      send(stub, "text/javascript; charset=utf-8");
    } else if (url === "/__axe.js") {
      send(axe, "text/javascript; charset=utf-8");
    } else if (url === "/renderer.js") {
      send(
        fs.readFileSync(path.join(RENDERER_DIR, "renderer.js")),
        "text/javascript; charset=utf-8",
      );
    } else if (url === "/styles.css") {
      send(
        fs.readFileSync(path.join(RENDERER_DIR, "styles.css")),
        "text/css; charset=utf-8",
      );
    } else {
      res.writeHead(404).end("not found");
    }
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });

  let axeLoaded = false;
  const harness: BrowserHarness = {
    browser,
    page,

    async reload() {
      await page.goto(`http://127.0.0.1:${port}/`, {
        waitUntil: "domcontentloaded",
      });
      axeLoaded = false;
    },

    async setOverride(name, fn) {
      await page.evaluate(
        ([n, f]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__sbStub.set({ [n as string]: f as any });
        },
        [name, fn.toString()] as [string, string],
      );
    },

    async runAxe(tags) {
      if (!axeLoaded) {
        // Same-origin <script src> satisfies the page's script-src 'self'.
        await page.addScriptTag({ url: "/__axe.js" });
        await page.waitForFunction(
          () => typeof (window as any).axe !== "undefined",
          {
            timeout: 15_000,
          },
        );
        axeLoaded = true;
      }
      const results = (await page.evaluate(async (t: string[]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await (window as any).axe.run(document, {
          runOnly: { type: "tag", values: t },
          resultTypes: ["violations"],
        });
        return r.violations.map((v: any) => ({
          id: v.id,
          impact: v.impact ?? null,
          help: v.help,
          tags: v.tags,
          nodes: v.nodes.map((n: any) => ({
            target: n.target,
            failureSummary: n.failureSummary ?? "",
          })),
        }));
      }, tags as string[])) as AxeViolation[];
      return results;
    },

    async switchTab(name) {
      await page.click(`[data-tab="${name}"]`);
      await page.waitForSelector(`#panel-${name}.active`, { timeout: 8_000 });
    },

    async dispose() {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  await harness.reload();
  return harness;
}
