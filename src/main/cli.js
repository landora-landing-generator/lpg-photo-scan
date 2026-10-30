"use strict";

// Developer harness: `[PROVIDER=…] API_KEY=… npm run scan -- site1.ru site2.ru`
// Runs the same scanner as the app, without the window, and prints JSON.

const { app } = require("electron");
const { scanSites } = require("./scanner");
const { parseDomains } = require("./domains");

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const hosts = parseDomains(process.argv.slice(2).join(" "));
  const creds = { provider: process.env.PROVIDER ?? "openrouter", apiKey: process.env.API_KEY };
  if (!hosts.length || !creds.apiKey) {
    console.error("usage: [PROVIDER=openrouter|polza|openai] API_KEY=… npm run scan -- <domain…>");
    app.exit(2);
    return;
  }
  const started = Date.now();
  try {
    await scanSites({
      hosts,
      creds,
      signal: new AbortController().signal,
      onProgress: ({ host, step }) => process.stderr.write(`${host}: ${step}\n`),
      onSite: (r) =>
        console.log(
          JSON.stringify({
            host: r.host,
            verdict: r.verdict,
            error: r.error,
            pages: r.pages,
            images: r.images,
            people: r.people.map((p) => p.url),
            unsure: r.unsure.map((p) => p.url),
            unchecked: r.unchecked,
          }),
        ),
    });
  } catch (e) {
    console.error(`STOP: ${e.message}`);
  }
  console.error(`done in ${Math.round((Date.now() - started) / 1000)}s`);
  app.exit(0);
});
app.on("window-all-closed", () => {});
