import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://127.0.0.1:3200";
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

try {
  await page.goto(`${base}/congress`, { waitUntil: "domcontentloaded" });
  await page.getByText("Snapshot:").waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.querySelector(".map-status") === null);
  await page.waitForFunction(() => {
    const root = document.querySelector("main");
    let fiber = root?.[Object.keys(root).find((key) => key.startsWith("__reactFiber"))];
    while (fiber) {
      let hook = fiber.memoizedState;
      while (hook) {
        const candidate = hook.memoizedState?.current;
        if (candidate?.getCanvas && candidate?.getStyle) {
          window.__congressMap = candidate;
          return candidate.loaded() && candidate.areTilesLoaded();
        }
        hook = hook.next;
      }
      fiber = fiber.return;
    }
    return false;
  });
  const mapPoint = await page.evaluate(() => {
    const map = window.__congressMap;
    for (let y = 120; y < 700; y += 30) {
      for (let x = 80; x < 950; x += 30) {
        const feature = map.queryRenderedFeatures([x, y], { layers: ["federal-house-fill"] })[0];
        if (feature?.properties?.GEOID && feature?.properties?.STATEFP) {
          const canvas = map.getCanvas().getBoundingClientRect();
          return { x: canvas.x + x, y: canvas.y + y, geoid: String(feature.properties.GEOID) };
        }
      }
    }
    return null;
  });
  assert.ok(mapPoint, "Congress House shapes did not render in the map viewport");
  await page.mouse.click(mapPoint.x, mapPoint.y);
  await page.waitForFunction((geoid) => document.querySelector("#federal-district")?.value === geoid, mapPoint.geoid);
  const houseTile = await page.request.get(`${base}/api/archives/federal-house.pmtiles`, { headers: { Range: "bytes=0-126" } });
  assert.equal(houseTile.status(), 206);
  assert.equal((await houseTile.body()).subarray(0, 7).toString(), "PMTiles");

  await page.selectOption("#federal-state", "FL");
  await page.selectOption("#federal-district", "1220");
  await page.getByText("Vacancy due to the resignation").waitFor();
  await page.selectOption("#federal-district", "1201");
  await page.getByRole("tab", { name: "Recorded votes" }).click();
  await page.getByText(/recorded rolls for the current officeholder/).waitFor();
  assert.equal(await page.locator(".vote-card").count(), 20);
  await page.getByText("Official roll call ↗").first().waitFor();
  await page.getByRole("button", { name: "Show 20 more votes" }).click();
  assert.equal(await page.locator(".vote-card").count(), 40);
  await page.getByRole("tab", { name: "Agenda" }).click();
  await page.getByText("Chamber-wide official notices.").waitFor();
  await page.getByText("Official notice ↗").first().waitFor();

  await page.selectOption("#federal-state", "WA");
  await page.selectOption("#federal-district", "5303");
  await page.getByRole("tab", { name: "Elections" }).click();
  await page.getByText("Marie Gluesenkamp Perez").waitFor();
  assert.equal(await page.locator(".election-candidate").count(), 3);
  await page.getByText("119th Congress district plan").waitFor();

  await page.getByRole("button", { name: "U.S. Senate" }).click();
  await page.selectOption("#federal-state", "CA");
  await page.waitForFunction(() => !window.__congressMap.isMoving() && window.__congressMap.areTilesLoaded());
  const senatePoint = await page.evaluate(() => {
    const map = window.__congressMap;
    for (let y = 140; y < 700; y += 30) {
      for (let x = 80; x < 950; x += 30) {
        const feature = map.queryRenderedFeatures([x, y], { layers: ["federal-senate-fill"] })[0];
        if (feature?.properties?.STATEFP === "06") {
          const canvas = map.getCanvas().getBoundingClientRect();
          return { x: canvas.x + x, y: canvas.y + y };
        }
      }
    }
    return null;
  });
  assert.ok(senatePoint, "California Senate state shape did not render");
  await page.mouse.click(senatePoint.x, senatePoint.y);
  await page.waitForFunction(() => document.querySelector("#federal-district")?.value === "06");
  await page.selectOption("#federal-district", "06");
  assert.equal(await page.locator(".member-card").count(), 2);
  await page.getByRole("tab", { name: "Recorded votes" }).click();
  await page.getByText(/recorded rolls for the current officeholders/).waitFor();
  assert.equal(await page.locator(".vote-card").count(), 20);
  assert.equal(await page.locator(".vote-card").first().locator(".vote-position").count(), 2);
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
  const senateTile = await page.request.get(`${base}/api/archives/federal-senate.pmtiles`, { headers: { Range: "bytes=0-126" } });
  assert.equal(senateTile.status(), 206);
  assert.equal((await senateTile.body()).subarray(0, 7).toString(), "PMTiles");

  await page.getByRole("link", { name: "State legislatures" }).click();
  await page.getByRole("heading", { name: "Choose a district" }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Congress browser check passed: map archives, vacancy, House/Senate votes, Washington 2024 election results, state navigation");
} finally {
  await browser.close();
}
