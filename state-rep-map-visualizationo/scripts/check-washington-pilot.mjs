import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://127.0.0.1:3201";
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.selectOption("#state-select", "WA");
  await page.selectOption("#district-select", "53001");
  await page.getByRole("heading", { name: "Derek Stanford" }).waitFor();
  await page.getByRole("tab", { name: "Recorded votes" }).click();
  await page.getByText("60 selected bills").waitFor();
  await page.getByText("Official roll call ↗").first().waitFor();
  assert.ok(await page.locator(".vote-card").count() > 0);
  await page.getByRole("tab", { name: "Agenda" }).click();
  await page.getByText("Official agenda ↗").first().waitFor();
  assert.ok(await page.locator(".agenda-card").count() > 0);
  assert.deepEqual(errors, []);
  console.log("Washington pilot browser check passed: verified member votes and official committee agenda");
} finally {
  await browser.close();
}
