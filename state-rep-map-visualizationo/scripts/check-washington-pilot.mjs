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
  await page.getByText("Upcoming committee meetings").waitFor();
  await page.locator(".upcoming-meetings").getByText("Official agenda ↗").first().waitFor();
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const today = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const dates = await page.locator(".upcoming-meetings .agenda-card time").allTextContents();
  assert.ok(dates.length > 0 && dates.every((value) => value.slice(0, 10) >= today), "Upcoming meetings must not include past dates");
  assert.equal(await page.locator(".agenda-history").evaluate((element) => element.open), false);
  await page.locator(".agenda-history summary").click();
  assert.ok(await page.locator(".agenda-history .agenda-card").count() > 0);
  await page.getByText("Next regular session:").waitFor();
  assert.deepEqual(errors, []);
  console.log("Washington pilot browser check passed: verified member votes and official committee agenda");
} finally {
  await browser.close();
}
