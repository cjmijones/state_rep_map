import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${process.env.BASE_URL || "http://127.0.0.1:3200"}/congress`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const root = document.querySelector("main");
    let fiber = root?.[Object.keys(root).find((key) => key.startsWith("__reactFiber"))];
    while (fiber) {
      let hook = fiber.memoizedState;
      while (hook) {
        const map = hook.memoizedState?.current;
        if (map?.getCanvas && map?.getStyle) {
          window.__coverageMap = map;
          return map.getLayer("federal-house-fill") && !map.isMoving() && map.areTilesLoaded();
        }
        hook = hook.next;
      }
      fiber = fiber.return;
    }
    return false;
  });
  if (process.env.COVERAGE_STATE) {
    await page.selectOption("#federal-state", process.env.COVERAGE_STATE);
    await page.waitForFunction(() => !window.__coverageMap.isMoving() && window.__coverageMap.areTilesLoaded());
  }
  if (process.env.COVERAGE_CENTER) {
    const center = process.env.COVERAGE_CENTER.split(",").map(Number);
    const zoom = Number(process.env.COVERAGE_ZOOM || 8);
    await page.evaluate(({ center, zoom }) => window.__coverageMap.jumpTo({ center, zoom }), { center, zoom });
    await page.waitForFunction(() => !window.__coverageMap.isMoving() && window.__coverageMap.areTilesLoaded());
  }
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH });
  await page.evaluate(() => {
    const map = window.__coverageMap;
    for (const suffix of ["fill", "line", "highlight"]) map.setLayoutProperty(`federal-senate-${suffix}`, "visibility", "visible");
    map.setPaintProperty("federal-senate-fill", "fill-opacity", 0);
  });
  await page.waitForFunction(() => window.__coverageMap.areTilesLoaded());
  const sample = () => page.evaluate(() => {
    const map = window.__coverageMap;
    const width = map.getCanvas().width / devicePixelRatio;
    const height = map.getCanvas().height / devicePixelRatio;
    const missing = [];
    let land = 0;
    for (let y = 80; y < height - 70; y += 8) {
      for (let x = 60; x < width - 60; x += 8) {
        const point = [x, y];
        const senate = map.queryRenderedFeatures(point, { layers: ["federal-senate-fill"] })[0];
        if (!senate) continue;
        land++;
        const house = map.queryRenderedFeatures(point, { layers: ["federal-house-fill"] })[0];
        if (house) continue;
        const neighbors = [[x - 8, y], [x + 8, y], [x, y - 8], [x, y + 8]];
        if (!neighbors.every((p) => map.queryRenderedFeatures(p, { layers: ["federal-senate-fill"] }).length)) continue;
        const loc = map.unproject(point);
        missing.push({ state: senate.properties.STUSPS, lon: Number(loc.lng.toFixed(3)), lat: Number(loc.lat.toFixed(3)) });
      }
    }
    return { land, missing, zoom: map.getZoom() };
  });
  const codes = process.env.COVERAGE_ALL_STATES
    ? await page.locator("#federal-state option").evaluateAll((options) => options.map((option) => option.value).filter(Boolean))
    : [process.env.COVERAGE_STATE || "overview"];
  const findings = [];
  for (const code of codes) {
    if (code !== "overview" && code !== process.env.COVERAGE_STATE) {
      await page.selectOption("#federal-state", code);
      await page.waitForFunction(() => !window.__coverageMap.isMoving() && window.__coverageMap.areTilesLoaded());
    }
    const result = await sample();
    findings.push({ code, landSamples: result.land, interiorHouseGaps: result.missing.length, samples: result.missing.slice(0, 5), zoom: result.zoom });
  }
  console.log(JSON.stringify(findings, null, 2));
  assert.equal(findings.reduce((sum, item) => sum + item.interiorHouseGaps, 0), 0, "House fill has inland holes relative to the 50-state Senate fill");
} finally {
  await browser.close();
}
