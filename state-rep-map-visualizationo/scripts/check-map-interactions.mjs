import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const HOVER_BUDGET_MS = Number(process.env.MAP_HOVER_BUDGET_MS || 150);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const stateCodeByFips = new Map(
  JSON.parse(fs.readFileSync(path.join(scriptDirectory, "../public/data/states.json"), "utf8"))
    .map((state) => [state.fips, state.code]),
);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function openMap(browser, { delayStateData = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText || "request failed"}`));

  const pendingResponses = new Map();
  const requestCounts = new Map();
  if (delayStateData) {
    await page.route(/\/data\/([A-Z]{2})\.json(?:\?.*)?$/, async (route) => {
      const code = route.request().url().match(/\/data\/([A-Z]{2})\.json/)?.[1];
      if (!code) return route.continue();
      const response = await route.fetch();
      requestCounts.set(code, (requestCounts.get(code) || 0) + 1);
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      pendingResponses.set(code, { gate, release, route, response });
      await gate;
      pendingResponses.delete(code);
      await route.fulfill({ response });
    });
  }

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".maplibregl-canvas");
  await page.waitForFunction(() => {
    const root = document.querySelector("main");
    if (!root) return false;
    // Private diagnostic seam: locate the app's MapLibre instance through React's ref hook.
    // This avoids adding test-only globals to production code.
    let fiber = root[Object.keys(root).find((key) => key.startsWith("__reactFiber"))];
    while (fiber) {
      let hook = fiber.memoizedState;
      while (hook) {
          const candidate = hook.memoizedState?.current;
          if (candidate?.getCanvas && candidate?.getStyle) {
            window.__perfMap = candidate;
            if (!window.__mapErrorListenerAttached) {
              window.__mapErrors ||= [];
              candidate.on("error", (event) => window.__mapErrors.push(event.error?.message || "MapLibre error"));
              window.__mapErrorListenerAttached = true;
            }
          return candidate.loaded() && candidate.getLayer("upper-fill");
        }
        hook = hook.next;
      }
      fiber = fiber.return;
    }
    return false;
  });
  await page.waitForFunction(() => window.__perfMap?.areTilesLoaded?.() && !window.__perfMap?.isMoving());
  await settleMap(page);
  return { page, errors, pendingResponses, requestCounts };
}

async function settleMap(page) {
  await page.evaluate(() => new Promise((resolve, reject) => {
    const map = window.__perfMap;
    const timeout = setTimeout(() => {
      map.off("idle", onIdle);
      reject(new Error("Map did not reach idle"));
    }, 5000);
    const onIdle = () => { clearTimeout(timeout); resolve(); };
    map.once("idle", onIdle);
    map.triggerRepaint();
  }));
}

async function getCandidates(page, chamber = "upper", count = 60) {
  return page.evaluate(({ wanted, activeChamber }) => {
    const map = window.__perfMap;
    const points = [];
    const seen = new Set();
    for (let y = 130; y < 720 && points.length < wanted; y += 45) {
      for (let x = 80; x < 1000 && points.length < wanted; x += 45) {
        const feature = map.queryRenderedFeatures([x, y], { layers: [`${activeChamber}-fill`] })[0];
        const geoid = String(feature?.properties?.GEOID || "");
        if (!feature || !geoid || seen.has(geoid)) continue;
        seen.add(geoid);
        points.push({
          x,
          y,
          geoid,
          statefp: String(feature.properties.STATEFP || ""),
          name: String(feature.properties.NAME || ""),
        });
      }
    }
    return points;
  }, { wanted: count, activeChamber: chamber });
}

async function hoverAt(page, point, chamber = "upper") {
  await settleMap(page);
  return page.evaluate(async ({ x, y, geoid, chamber: activeChamber }) => {
    const map = window.__perfMap;
    const id = String(geoid);
    const start = performance.now();
    const lngLat = map.unproject([x, y]);
    const idle = new Promise((resolve) => map.once("idle", resolve));
    const state = new Promise((resolve, reject) => {
      const started = performance.now();
      const check = () => {
        const current = map.getFeatureState({ source: `districts-${activeChamber}`, sourceLayer: activeChamber, id });
        if (current.hover === true) return resolve();
        if (performance.now() - started > 3000) return reject(new Error(`Hover state did not settle for ${id}`));
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    map.fire("mousemove", {
      point: map.project(lngLat),
      lngLat,
      originalEvent: new MouseEvent("mousemove"),
    });
    await Promise.all([state, idle]);
    return performance.now() - start;
  }, { ...point, chamber });
}

async function moveOnMap(page, point, action = "move") {
  const bounds = await page.locator(".maplibregl-canvas").boundingBox();
  assert.ok(bounds, "Map canvas should have a bounding box");
  const x = bounds.x + point.x;
  const y = bounds.y + point.y;
  if (action === "click") await page.mouse.click(x, y);
  else await page.mouse.move(x, y);
}

function releaseResponse(context, code) {
  const pending = context.pendingResponses.get(code);
  assert.ok(pending, `Expected a delayed /data/${code}.json request`);
  pending.release();
}

async function waitForFeatureState(page, target, key, value) {
  await page.waitForFunction(({ chamber, geoid, key: stateKey, value: expected }) => {
    const map = window.__perfMap;
    return map.getFeatureState({
      source: `districts-${chamber}`,
      sourceLayer: chamber,
      id: String(geoid),
    })[stateKey] === expected;
  }, { chamber: target.chamber, geoid: target.geoid, key, value }, { timeout: 3000 });
}

async function waitForDelayed(context, code) {
  const started = Date.now();
  while (!context.pendingResponses.has(code)) {
    if (Date.now() - started > 5000) throw new Error(`Timed out waiting for /data/${code}.json`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assertNoErrors(context, label) {
  const mapErrors = context.page.evaluate(() => window.__mapErrors || []);
  return mapErrors.then((captured) => {
    assert.deepEqual([...context.errors, ...captured], [], `${label}: browser or MapLibre errors`);
  });
}

async function benchmarkAndPointerRegressions(browser) {
  const context = await openMap(browser);
  try {
    const { page } = context;
    const points = await getCandidates(page);
    assert.ok(points.length >= 15, `Expected 15 distinct rendered districts, got ${points.length}`);

    const reloadCount = await page.evaluate(() => {
      let count = 0;
      for (const source of ["districts-upper", "districts-lower"]) {
        const cache = window.__perfMap.style.sourceCaches[source];
        if (!cache) continue;
        const reload = cache.reload.bind(cache);
        cache.reload = (...args) => { count++; return reload(...args); };
        cache.__interactionReloadCount = () => count;
      }
      window.__countTileReloads = () => count;
      return count;
    });
    assert.equal(reloadCount, 0);

    const timings = [];
    for (const point of points.slice(0, 15)) timings.push(await hoverAt(page, point));
    const medianMs = median(timings);
    const tileReloads = await page.evaluate(() => window.__countTileReloads());
    const finalHover = await page.evaluate((geoid) => window.__perfMap.getFeatureState({
      source: "districts-upper", sourceLayer: "upper", id: String(geoid),
    }).hover, points[14].geoid);

    console.log(`Hover benchmark: median ${medianMs.toFixed(1)} ms; samples ${timings.map((time) => time.toFixed(1)).join(", ")} ms; tile reloads ${tileReloads}.`);
    assert.equal(tileReloads, 0, "Hovering must not reload vector tiles");
    assert.equal(finalHover, true, "Feature state must identify the final hovered district");
    assert.ok(medianMs < HOVER_BUDGET_MS, `Hover median ${medianMs.toFixed(1)} ms exceeds MAP_HOVER_BUDGET_MS=${HOVER_BUDGET_MS}`);

    const point = points[0];
    const target = { chamber: "upper", geoid: point.geoid };
    await moveOnMap(page, point);
    await waitForFeatureState(page, target, "hover", true);
    await moveOnMap(page, point, "click");
    await waitForFeatureState(page, target, "selected", true);
    await page.mouse.move(20, 400);
    await waitForFeatureState(page, target, "hover", false);
    await waitForFeatureState(page, target, "selected", true);

    const second = points.find((candidate) => candidate.geoid !== point.geoid);
    await moveOnMap(page, second);
    await waitForFeatureState(page, { chamber: "upper", geoid: second.geoid }, "hover", true);
    await page.getByRole("button", { name: "House" }).click();
    await waitForFeatureState(page, { chamber: "upper", geoid: second.geoid }, "hover", false);
    await waitForFeatureState(page, target, "selected", false);

    await page.waitForFunction(() => {
      const map = window.__perfMap;
      return map.getLayoutProperty("lower-fill", "visibility") === "visible"
        && map.isSourceLoaded("districts-lower")
        && map.queryRenderedFeatures(undefined, { layers: ["lower-fill"] }).length > 0;
    });
    await settleMap(page);
    const lowerPoints = await getCandidates(page, "lower");
    assert.ok(lowerPoints.length > 0, "Expected rendered lower chamber districts");
    const lowerPoint = lowerPoints.find((candidate) => candidate.geoid === point.geoid);
    assert.ok(lowerPoint, `The selected upper-chamber GEOID ${point.geoid} should also exist in the lower source`);
    await moveOnMap(page, lowerPoint);
    await waitForFeatureState(page, { chamber: "lower", geoid: lowerPoint.geoid }, "hover", true);
    await waitForFeatureState(page, { chamber: "upper", geoid: lowerPoint.geoid }, "hover", false);
    await page.getByRole("button", { name: "Senate" }).click();
    await waitForFeatureState(page, { chamber: "lower", geoid: lowerPoint.geoid }, "hover", false);
    await assertNoErrors(context, "benchmark and pointer regressions");
  } finally {
    await context.page.close();
  }
}

async function delayedSelectionRegressions(browser) {
  // A delayed first-state fetch tests immediate feature feedback, promise dedupe,
  // and cancellation when the user changes chambers before the response arrives.
  const context = await openMap(browser, { delayStateData: true });
  try {
    const { page } = context;
    const points = await getCandidates(page);
    const first = points[0];
    const target = { chamber: "upper", geoid: first.geoid };
    const code = stateCodeByFips.get(first.statefp);
    assert.ok(code, `No state code for FIPS ${first.statefp}`);
    await moveOnMap(page, first, "click");
    await waitForDelayed(context, code);
    await waitForFeatureState(page, target, "selected", true);
    await page.waitForTimeout(100);
    assert.equal(context.requestCounts.get(code), 1, `Concurrent click and state load should share one request for ${code}`);

    await page.getByRole("button", { name: "House" }).click();
    await waitForFeatureState(page, target, "selected", false);
    releaseResponse(context, code);
    await page.getByRole("heading", { name: "Choose a district" }).waitFor();
    await page.waitForTimeout(100);
    assert.equal(await page.getByText("Loading district officeholders…").count(), 0);
    assert.equal(await page.locator(".district-heading h2").count(), 0, "Late response must not restore the old chamber's selection");
    await assertNoErrors(context, "delayed selection cancellation");
  } finally {
    for (const pending of context.pendingResponses.values()) pending.release();
    await context.page.close();
  }

  // Out-of-order responses from different states must leave the most recent map
  // click selected, even when the earlier state's response completes first.
  const race = await openMap(browser, { delayStateData: true });
  try {
    const { page } = race;
    const points = await getCandidates(page);
    let first;
    let second;
    for (const candidate of points) {
      if (!first) first = candidate;
      else if (candidate.statefp !== first.statefp) { second = candidate; break; }
    }
    assert.ok(second, "Need rendered districts from two states to check response ordering");
    const firstTarget = { chamber: "upper", geoid: first.geoid };
    const secondTarget = { chamber: "upper", geoid: second.geoid };
    const firstCode = stateCodeByFips.get(first.statefp);
    const secondCode = stateCodeByFips.get(second.statefp);
    assert.ok(firstCode && secondCode, "Both feature STATEFP values should map to state codes");

    await moveOnMap(page, first, "click");
    await waitForDelayed(race, firstCode);
    await moveOnMap(page, second, "click");
    await waitForDelayed(race, secondCode);
    await waitForFeatureState(page, secondTarget, "selected", true);
    await waitForFeatureState(page, firstTarget, "selected", false);

    releaseResponse(race, firstCode);
    await page.waitForTimeout(150);
    await waitForFeatureState(page, secondTarget, "selected", true);
    assert.equal(await page.getByText("Loading district officeholders…").count(), 1, "Earlier response must not finish the latest selection");

    releaseResponse(race, secondCode);
    await page.getByText("Loading district officeholders…").waitFor({ state: "detached" });
    await waitForFeatureState(page, secondTarget, "selected", true);
    assert.equal(race.requestCounts.get(firstCode), 1);
    assert.equal(race.requestCounts.get(secondCode), 1);
    await assertNoErrors(race, "out-of-order map selections");
  } finally {
    for (const pending of race.pendingResponses.values()) pending.release();
    await race.page.close();
  }
}

(async () => {
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
  });
  try {
    await benchmarkAndPointerRegressions(browser);
    await delayedSelectionRegressions(browser);
    console.log("Map interaction checks passed.");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
