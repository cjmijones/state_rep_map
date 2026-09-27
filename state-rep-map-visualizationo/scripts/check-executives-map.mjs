import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://127.0.0.1:3200";
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

try {
  await page.goto(`${base}/executives`, { waitUntil: "domcontentloaded" });
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
          window.__executivesMap = candidate;
          return candidate.loaded() && candidate.areTilesLoaded();
        }
        hook = hook.next;
      }
      fiber = fiber.return;
    }
    return false;
  });
  assert.equal(await page.locator("#executive-state option").count(), 51);
  const marker = page.getByRole("button", { name: "Show U.S. President" });
  assert.equal(await marker.isVisible(), true, "President seal is absent from national view");
  const markerBox = await marker.boundingBox();
  const canvasBox = await page.locator(".map-container").boundingBox();
  assert.ok(markerBox && canvasBox && markerBox.x > canvasBox.x + canvasBox.width / 2, "President seal is not offshore east of the map center");
  await marker.click();
  await page.getByRole("heading", { name: "Donald J. Trump" }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Official White House profile ↗" }).getAttribute("href"), "https://www.whitehouse.gov/administration/donald-j-trump/");

  await page.selectOption("#executive-state", "WA");
  await page.getByRole("heading", { name: "Bob Ferguson" }).waitFor();
  assert.equal(await page.locator(".party-tag").textContent(), "Democrat");
  await page.locator(".president-sidebar-button").click();
  await page.getByRole("heading", { name: "Donald J. Trump" }).waitFor();

  await page.getByRole("button", { name: "U.S. overview" }).click();
  await page.waitForFunction(() => !window.__executivesMap.isMoving() && window.__executivesMap.areTilesLoaded());
  const mapPoint = await page.evaluate(() => {
    const map = window.__executivesMap;
    const canvas = map.getCanvas().getBoundingClientRect();
    for (let y = 130; y < canvas.height - 120; y += 25) {
      for (let x = 80; x < canvas.width - 160; x += 25) {
        const feature = map.queryRenderedFeatures([x, y], { layers: ["governor-fill"] })[0];
        if (feature?.properties?.GEOID) return { x: canvas.x + x, y: canvas.y + y, fips: String(feature.properties.GEOID) };
      }
    }
    return null;
  });
  assert.ok(mapPoint, "State governor shapes did not render");
  await page.mouse.click(mapPoint.x, mapPoint.y);
  await page.waitForFunction(() => Boolean(document.querySelector("#executive-state")?.value && document.querySelector(".member-card")));
  assert.equal(await page.locator(".member-card").count(), 1);
  const tile = await page.request.get(`${base}/api/archives/federal-senate.pmtiles`, { headers: { Range: "bytes=0-126" } });
  assert.equal(tile.status(), 206);
  assert.equal((await tile.body()).subarray(0, 7).toString(), "PMTiles");
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(`${base}/executives`, { waitUntil: "domcontentloaded" });
  const mobileSeal = mobile.locator(".president-mobile-marker");
  await mobileSeal.waitFor();
  const mobileBox = await mobileSeal.boundingBox();
  assert.ok(mobileBox && mobileBox.x >= 0 && mobileBox.x + mobileBox.width <= 390, "Mobile president seal is outside the viewport");
  await mobileSeal.click();
  await mobile.getByRole("heading", { name: "Donald J. Trump" }).waitFor();
  await mobile.close();
  assert.deepEqual(errors, []);
  console.log("Executives browser check passed: 50 states, governor selection, desktop and mobile president seals, sidebar control, map archive");
} finally {
  await browser.close();
}
