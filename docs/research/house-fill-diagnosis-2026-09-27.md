# Federal House fill coverage check

Checked September 27, 2026 against the local built site. The House archive
contains 435 Census 119th Congress shapes; the state archive contains 50
Census 2025 shapes. Both are rendered as MapLibre fill layers.

Run the browser check from `state-rep-map-visualizationo` while the site is
running on port 3200 (or set `BASE_URL`):

```bash
COVERAGE_ALL_STATES=1 node scripts/check-congress-coverage.mjs
```

The check makes the state fill queryable behind the House layer, samples the
rendered viewport every 8 CSS pixels for each state, and flags points where
state land has no House fill while all four neighboring samples remain state
land. All 50 states returned **zero inland gaps**. Separate checks at zoom 9
around Washington, DC, Minneapolis, and central Florida also returned zero.
House and Senate shapes loaded and responded to map clicks in the browser
integration check.

This check does not cover sub-8-pixel seams, coastline differences shared by
both Census layers, or network/cache behavior in a remote preview. A state,
district, rough map location, or screenshot of a visible gap is needed to
target the next reproduction.
