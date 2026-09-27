// Observes peek's directory mode in a real browser, on Windows for #138
// (see workflow.yml). Env: APP (dist/index.mjs), FIXTURE and OUT (directories).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const { APP, FIXTURE, OUT } = process.env;
const BASE = "http://localhost:4738";
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

// Rewrites the files in place: removing the directory would end the watch.
function writeFixture() {
  const files = {
    "root.md":
      "# Root\n\nGo to [C](/view?path=a/b/c.md) and [S](/view?path=a/sibling/s.md).\n",
    "a/b/c.md": "# C file\n\n![pic](./pic.svg)\n\nVersion 1\n",
    "a/b/pic.svg":
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="teal"/></svg>',
    "a/sibling/s.md": "# S file\n",
    "a/page.html": "<h1>HTML page</h1>",
    "z/z.md": "# Z file\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    const path = join(FIXTURE, ...rel.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/tree`);
      if (res.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error("peek did not start");
}

const results = [];
async function step(name, expected, observeActual) {
  let actual;
  try {
    actual = await observeActual();
  } catch (e) {
    actual = { error: String(e).split("\n")[0] };
  }
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  results.push({ name, pass, expected, actual });
  console.log(
    `${pass ? "PASS" : "FAIL"} ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`,
  );
}

function sidebarState(page) {
  return page.evaluate(() => ({
    open: Object.fromEntries(
      [...document.querySelectorAll("#sidebar button[aria-expanded]")].map(
        (b) => [
          b.textContent.trim(),
          b.getAttribute("aria-expanded") === "true",
        ],
      ),
    ),
    active: [...document.querySelectorAll('#sidebar a[href^="/view"]')]
      .filter((a) => a.className.includes("text-sidebar-primary"))
      .map((a) => decodeURIComponent(a.getAttribute("href"))),
  }));
}

function pathQuery(page) {
  return new URL(page.url()).searchParams.get("path");
}

async function showSidebar(page, viewport) {
  if (viewport.name !== "mobile") return;
  const open = await page.evaluate(() =>
    document.body.hasAttribute("data-sidebar-open"),
  );
  if (!open) await page.click("#sidebar-toggle");
  await sleep(400);
}

const REVEALED_C = {
  open: { a: true, b: true, sibling: false, z: false },
  active: ["/view?path=a/b/c.md"],
};

async function observe(browser, viewport) {
  const v = viewport.name;
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  const page = await context.newPage();
  const shot = (name) =>
    page.screenshot({ path: join(OUT, `${v}-${name}.png`) });

  // AC10: an in-content /view?path= link reveals and highlights the file.
  await step(
    `${v} AC10 link to a/b/c.md`,
    { path: "a/b/c.md", sidebar: REVEALED_C },
    async () => {
      await page.goto(`${BASE}/view?path=root.md`);
      await page.evaluate(() => {
        window.__marker = "same-document";
        window.__fetches = [];
        const original = window.fetch;
        window.fetch = (...args) => {
          window.__fetches.push(String(args[0]));
          return original(...args);
        };
      });
      await page.click('main a[href="/view?path=a/b/c.md"]');
      await page.waitForSelector('main h1:has-text("C file")');
      await sleep(300);
      await showSidebar(page, viewport);
      await shot("ac10-link-to-c");
      return { path: pathQuery(page), sidebar: await sidebarState(page) };
    },
  );

  // AC11: editing the displayed file reloads its content in place.
  await step(
    `${v} AC11 edit displayed file`,
    { reloaded: true, marker: "same-document" },
    async () => {
      const version = `Version ${v}`;
      writeFileSync(
        join(FIXTURE, "a", "b", "c.md"),
        `# C file\n\n![pic](./pic.svg)\n\n${version}\n`,
      );
      const reloaded = await page
        .waitForFunction(
          (text) => document.querySelector("main").textContent.includes(text),
          version,
          { timeout: 10000 },
        )
        .then(
          () => true,
          () => false,
        );
      await shot("ac11-live-reload");
      return { reloaded, marker: await page.evaluate(() => window.__marker) };
    },
  );

  // AC11: editing another file reaches the page (the tree is refetched) but
  // does not refetch the displayed content.
  await step(
    `${v} AC11 edit another file`,
    { treeRefetched: true, contentFetches: [] },
    async () => {
      await page.evaluate(() => {
        window.__fetches = [];
      });
      writeFileSync(join(FIXTURE, "z", "z.md"), `# Z file ${v}\n`);
      await page
        .waitForFunction(() => window.__fetches.includes("/api/tree"), null, {
          timeout: 10000,
        })
        .catch(() => {});
      await sleep(1000);
      const fetches = await page.evaluate(() => window.__fetches);
      return {
        treeRefetched: fetches.includes("/api/tree"),
        contentFetches: fetches.filter((u) => u.startsWith("/api/content")),
      };
    },
  );

  // AC8: on Windows an old tree link with \ is redirected with 302 to the /
  // URL, which shows the file revealed. On POSIX `a\b\c.md` is a file name, is
  // not redirected, and does not exist in the fixture.
  if (process.platform !== "win32") {
    await step(
      `${v} AC8 a\\b\\c.md on POSIX`,
      { redirect: null, status: 404, path: "a\\b\\c.md" },
      async () => {
        const response = await page.goto(`${BASE}/view?path=a%5Cb%5Cc.md`);
        return {
          redirect: response?.request().redirectedFrom() ?? null,
          status: response?.status(),
          path: pathQuery(page),
        };
      },
    );
  } else {
    await step(
      `${v} AC8 old bookmark a\\b\\c.md`,
      {
        redirect: { from: "/view?path=a%5Cb%5Cc.md", status: 302 },
        path: "a/b/c.md",
        sidebar: REVEALED_C,
      },
      async () => {
        const response = await page.goto(`${BASE}/view?path=a%5Cb%5Cc.md`);
        const redirected = response?.request().redirectedFrom();
        const redirectResponse = await redirected?.response();
        await showSidebar(page, viewport);
        await shot("ac8-old-bookmark");
        return {
          redirect: redirected
            ? {
                from:
                  new URL(redirected.url()).pathname +
                  new URL(redirected.url()).search,
                status: redirectResponse?.status(),
              }
            : null,
          path: pathQuery(page),
          sidebar: await sidebarState(page),
        };
      },
    );
  }

  // AC12: / shows the first file with it revealed.
  await step(
    `${v} AC12 first file at /`,
    { h1: "C file", sidebar: REVEALED_C },
    async () => {
      await page.goto(`${BASE}/`);
      await showSidebar(page, viewport);
      return {
        h1: await page.textContent("main h1"),
        sidebar: await sidebarState(page),
      };
    },
  );

  // AC12: a sidebar link navigates and highlights.
  await step(
    `${v} AC12 sidebar link to z/z.md`,
    { path: "z/z.md", active: ["/view?path=z/z.md"] },
    async () => {
      await page.click('#sidebar button[aria-expanded]:has-text("z")');
      await page.click('#sidebar a:has-text("z.md")');
      await page.waitForSelector('main h1:has-text("Z file")');
      return {
        path: pathQuery(page),
        active: (await sidebarState(page)).active,
      };
    },
  );

  // AC12: an HTML file is framed from /__peek/raw/.
  await step(
    `${v} AC12 HTML view`,
    { src: "/__peek/raw/a/page.html", h1: "HTML page" },
    async () => {
      await page.goto(`${BASE}/view?path=a/page.html`);
      return {
        src: await page.getAttribute("main iframe", "src"),
        h1: await page.frameLocator("main iframe").locator("h1").textContent(),
      };
    },
  );

  // AC12: /<relative path> renders with its relative image.
  await step(
    `${v} AC12 /a/b/c.md with image`,
    { h1: "C file", imageLoaded: true },
    async () => {
      await page.goto(`${BASE}/a/b/c.md`);
      return {
        h1: await page.textContent("h1"),
        imageLoaded: await page.evaluate(() => {
          const img = document.querySelector(
            'img[src="/__peek/raw/a/b/pic.svg"]',
          );
          return Boolean(img?.complete && img.naturalWidth > 0);
        }),
      };
    },
  );

  // The sidebar resize handle (desktop only) still sets and saves the width.
  if (v === "desktop") {
    await step(
      `${v} sidebar resize`,
      { cssWidth: "400px", savedWidth: "400" },
      async () => {
        await page.goto(`${BASE}/view?path=root.md`);
        const box = await page.locator("#sidebar-resize").boundingBox();
        const y = box.y + box.height / 2;
        await page.mouse.move(box.x + box.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(300, y, { steps: 5 });
        await page.mouse.move(400, y, { steps: 5 });
        await page.mouse.up();
        return page.evaluate(() => ({
          cssWidth:
            document.documentElement.style.getPropertyValue("--sidebar-width"),
          savedWidth: localStorage.getItem("sidebar-width"),
        }));
      },
    );
  }

  await context.close();
}

mkdirSync(OUT, { recursive: true });
writeFixture();
const server = spawn(
  process.execPath,
  [APP, FIXTURE, "--port", "4738", "--no-open"],
  { stdio: "inherit" },
);
let failed = true;
try {
  await waitForServer();
  const browser = await chromium.launch();
  for (const viewport of VIEWPORTS) {
    writeFixture();
    await sleep(1000);
    await observe(browser, viewport);
  }
  await browser.close();
  failed = results.some((r) => !r.pass);
} finally {
  server.kill();
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
}
process.exit(failed ? 1 : 0);
