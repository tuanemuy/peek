#!/usr/bin/env node
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { resolve } from "node:path";
import { cancel, intro, log, outro, spinner } from "@clack/prompts";
import { cli, define } from "gunshi";
import pc from "picocolors";
import { getContentType } from "./core/content-type.js";
import { logger } from "./lib/logger.js";
import { initMarkdown } from "./lib/markdown.js";
import { isNodeError } from "./lib/node-error.js";
import { resolveStyles } from "./lib/styles.js";
import type { ServerConfig } from "./server/index.js";
import { startServer } from "./server/index.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const command = define({
  name: "peek",
  description: "Preview Markdown and HTML files in the browser",
  args: {
    path: {
      type: "positional",
      description: "File or directory path to preview",
    },
    port: {
      type: "number",
      short: "p",
      default: 3000,
      description: "Server port",
    },
    host: {
      type: "string",
      short: "H",
      default: "localhost",
      description: "Bind hostname (use 0.0.0.0 for external access)",
    },
    css: {
      type: "string",
      short: "c",
      description: "Custom CSS file path",
    },
    open: {
      type: "boolean",
      default: true,
      negatable: true,
      description: "Open browser automatically",
    },
  },
  examples: `$ peek README.md
$ peek index.html
$ peek docs/
$ peek . --port 8080
$ peek README.md --css ./custom.css --no-open`,
  run: async (ctx) => {
    const { path: targetArg, port, host: hostname, css, open } = ctx.values;

    intro(pc.bgCyan(pc.black(" peek ")));

    const targetPath = targetArg || ".";
    const fullPath = resolve(targetPath);

    const pathStat = await stat(fullPath).catch((e: unknown) => {
      logger.error("Failed to stat path:", e);
      cancel(`Path not found: ${fullPath}`);
      return process.exit(1);
    });

    const mode = pathStat.isDirectory() ? "directory" : "file";
    const contentType = mode === "file" ? getContentType(fullPath) : null;

    if (mode === "file" && !contentType) {
      cancel("Only Markdown (.md) and HTML (.html, .htm) files are supported");
      process.exit(1);
    }

    if (
      Number.isNaN(port) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      cancel(`Invalid port number: ${port}`);
      process.exit(1);
    }

    const s = spinner();
    s.start("Initializing...");

    const isHtmlFileMode = mode === "file" && contentType === "html";

    if (isHtmlFileMode && css) {
      log.warn("--css option is ignored for HTML file preview");
    }

    if (!isHtmlFileMode) {
      await initMarkdown().catch((e: unknown) => {
        logger.error("Failed to initialize Markdown renderer:", e);
        s.stop("Failed to initialize");
        cancel("Failed to initialize Markdown renderer");
        return process.exit(1);
      });
    }

    let serverConfig: ServerConfig;

    if (isHtmlFileMode) {
      serverConfig = {
        targetPath: fullPath,
        mode: "file",
        port,
        hostname,
        contentType: "html",
      };
    } else {
      const styles = await resolveStyles(css).then((result) => {
        if (result.ok) return result.value;
        s.stop("Failed to resolve styles");
        const message =
          result.error.type === "file-not-found"
            ? `CSS file not found: ${result.error.path}`
            : `Failed to read CSS file: ${result.error.path}`;
        cancel(message);
        return process.exit(1);
      });

      serverConfig =
        mode === "file" && contentType && contentType !== "html"
          ? {
              targetPath: fullPath,
              mode: "file",
              port,
              hostname,
              styles,
              contentType,
            }
          : {
              targetPath: fullPath,
              mode: "directory",
              port,
              hostname,
              styles,
            };
    }

    const server = await startServer(serverConfig).catch((e: unknown) => {
      s.stop("Failed to start server");
      const message =
        isNodeError(e) && e.code === "EADDRINUSE"
          ? `Port ${port} is already in use`
          : "Failed to start server";
      cancel(message);
      return process.exit(1);
    });

    s.stop("Server started");

    const url = `http://${hostname}:${port}`;
    log.info(`${pc.green("Preview:")} ${pc.cyan(pc.underline(url))}`);
    log.info(`${pc.dim(`Mode: ${mode} | Path: ${fullPath}`)}`);

    if (open) {
      openBrowser(url);
    }

    outro(pc.dim("Press Ctrl+C to stop"));

    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals) => {
      if (shuttingDown) {
        console.error("\nForce exiting...");
        process.exit(1);
      }
      shuttingDown = true;
      console.log();
      // Logged after the blank line so it does not end up on the same line as
      // the terminal's `^C` echo. Tells us, if a hang is ever reported again,
      // whether the signal handler ran at all and which signal started it.
      logger.info(`Received ${signal}, shutting down...`);
      intro(pc.bgYellow(pc.black(" Shutting down... ")));
      try {
        await server.shutdown();
      } catch (e: unknown) {
        logger.error("Failed to shut down server:", e);
      }
      // `src/index.shutdown-process.test.ts` asserts on "Server stopped": it is
      // the only externally visible evidence that `shutdown()` settled (exit
      // code 0 alone does not prove it). Keep that substring if the wording
      // changes.
      outro(pc.green("Server stopped. Bye!"));
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  },
});

function openBrowser(url: string): void {
  const os = platform();
  let cmd: string;
  let args: string[];
  if (os === "darwin") {
    cmd = "open";
    args = [url];
  } else if (os === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  execFile(cmd, args, (err) => {
    if (err) {
      logger.error(`Failed to open browser: ${err.message}`);
    }
  });
}

await cli(process.argv.slice(2), command, {
  name: "peek",
  version: pkg.version,
  description: "Preview Markdown and HTML files in the browser",
});
