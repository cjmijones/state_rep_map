# State Rep Maps

State Rep Maps is a local browser atlas of state legislative districts in the
50 states. It shows current represented boundaries, then joins each district
to current officeholders, party, email, phone, and an official profile link
when the roster provides one.

## First release

- MapLibre renders compact PMTiles archives in a normal browser.
- Senate and House layers can be switched without reloading the page.
- Hover identifies the district, and selection highlights immediately while
  officeholder details load. The ocean background is light blue.
- Nebraska is represented as one nonpartisan legislative chamber.
- Multi-member parent districts remain visible and identify individual
  subdistrict seats in the detail panel.
- District geometry comes from the Census Bureau's 2026 legislative-area
  GeoPackage. Michigan Senate and Minnesota chambers use the 2024 plan while
  those legislators remain in office; Mississippi uses the newer plan after
  its 2025 redistricting elections.

## Run the local demo

```bash
cd state-rep-map-visualizationo
npm install
npm run dev
```

Open <http://localhost:3000>. The generated `public/data` and
`public/archives` directories are included for the demo build.
Open <http://localhost:3000/congress> for the 50-state U.S. House and Senate
view. House shapes follow the 119th Congress representation plan; the Senate
map uses state boundaries. Its People, Recorded votes, and Agenda tabs use
dated official House and Senate snapshots. Full current-session floor vote
history loads only when the votes tab opens; the agenda tab shows published
floor and committee notices.
Washington state districts also have a clearly labeled sample of official
2026 bill roll calls and committee agendas. The sample is not a full archive.
An Elections tab now shows Washington's 2024 U.S. House general-election
results for all ten districts, with an official source link. Other states and
Senate election results are not yet populated.

## Deploy on Render

The root [Render Blueprint](render.yaml) defines a free Node web service for
the Next.js app. After pushing the prepared commit to GitHub, create a Render
Blueprint from this repository. The service builds from
`state-rep-map-visualizationo`, starts Next.js on Render's assigned port, and
checks `/api/health` before receiving traffic. The API route that serves
PMTiles byte ranges requires a web service; a static export will not serve
this map as currently built.

The four `public/archives/*.pmtiles` files and the `public/data` snapshots
must be committed. The older `public/tiles` tree is ignored; it contains many
loose generated tiles that the current app never requests. Data refreshes
still run locally: regenerate a snapshot, commit it, and push to trigger a new
Render deploy. The free service has an ephemeral filesystem and spins down
when idle, so in-place updates on the service would not persist.

## Refresh the data

The build uses the Census legislative GeoPackage and the Open States people
repository. Download the Census file from the [Census mapping files page](https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-geopackage-file.html),
then clone the roster repository:

```bash
mkdir -p state-rep-backend/data/source
curl -L 'https://www2.census.gov/geo/tiger/TGRGPKG26/tlgpkg_2026_us_legislative.gpkg.zip' \
  -o state-rep-backend/data/source/tlgpkg_2026_us_legislative.gpkg.zip
unzip -o state-rep-backend/data/source/tlgpkg_2026_us_legislative.gpkg.zip \
  -d state-rep-backend/data/source
git clone https://github.com/openstates/people.git state-rep-backend/data/source/openstates-people
```

Install the backend package with Poetry, or use an environment that provides
the dependencies in `state-rep-backend/pyproject.toml`:

```bash
cd state-rep-backend
poetry install
poetry run python -m state_rep_map_builder.build_demo_data \
  --census-gpkg data/source/tlgpkg_2026_us_legislative.gpkg \
  --people-root data/source/openstates-people \
  --output-dir ../state-rep-map-visualizationo/public/data \
  --as-of 2026-09-19
poetry run python -m state_rep_map_builder.validate_demo_data \
  --data-dir ../state-rep-map-visualizationo/public/data
poetry run python -m state_rep_map_builder.build_map_archives \
  --census-gpkg data/source/tlgpkg_2026_us_legislative.gpkg \
  --output-dir ../state-rep-map-visualizationo/public/archives
```

`match-report.json` records districts that need review. The pipeline uses
Open States as the normalized national roster, retains official profile links,
and labels records missing an official link instead of presenting them as
verified.

### Refresh the Congress view

The federal builder needs `ogr2ogr` and `tippecanoe`. From
`state-rep-backend`, run:

```bash
python -m state_rep_map_builder.build_federal_archives \
  --output-dir ../state-rep-map-visualizationo/public/archives \
  --manifest ../state-rep-map-visualizationo/public/data/federal-geography.json
python -m state_rep_map_builder.refresh_federal_data \
  --geography ../state-rep-map-visualizationo/public/data/federal-geography.json \
  --output ../state-rep-map-visualizationo/public/data/federal.json
python -m state_rep_map_builder.refresh_federal_votes \
  --output-dir ../state-rep-map-visualizationo/public/data
python -m state_rep_map_builder.refresh_federal_agendas \
  --output ../state-rep-map-visualizationo/public/data/federal-agendas.json
python -m state_rep_map_builder.refresh_washington_legislature \
  --roster ../state-rep-map-visualizationo/public/data/WA.json \
  --output ../state-rep-map-visualizationo/public/data/wa-legislature-pilot.json
python -m state_rep_map_builder.build_state_source_inventory \
  --data-dir ../state-rep-map-visualizationo/public/data \
  --output ../docs/data/state-legislative-source-inventory.json
python -m state_rep_map_builder.scan_state_source_links \
  --inventory ../docs/data/state-legislative-source-inventory.json \
  --output ../docs/data/state-legislative-link-scan.json
python -m state_rep_map_builder.build_wa_house_elections \
  --geography ../state-rep-map-visualizationo/public/data/federal-geography.json \
  --output ../state-rep-map-visualizationo/public/data/wa-house-2024.json
```

The boundary build uses the Census 2025 119th Congressional District file
and 2025 state file, filters to the 50 states, and checks for 435 House seats
and 50 states. The roster refresh joins the Clerk's House member data and
Senate member/contact XML by official IDs, then fetches the newest 10 House
and Senate recorded rolls. It stores the official source URLs, retrieval
times, source hashes, and roster publication dates. If any source or join
fails, the existing `federal.json` remains available. Refresh the roster and
votes as needed; the separate full-session vote job reuses validated rolls,
rechecks the five newest, retries transient errors, and resumes from a local
checkpoint after interruption. The agenda job fetches current official feeds.
The Washington job selects up to 30 passed bills per chamber in its declared
date window, so its empty member result never means “did not vote.” Rebuild boundary tiles only when the current representation
plan changes. This pipeline is pinned to the 119th Congress and must be
reviewed before changing its Congress/session defaults.
The [50-state source inventory](docs/data/state-legislative-source-inventory.json)
lists profile-domain leads for all 99 state chambers and marks feed coverage
unverified until a chamber source is checked. Washington is the only working
state importer so far. The [link scan](docs/data/state-legislative-link-scan.json)
checks those site roots for possible vote and agenda links; its candidates
still require document-level verification before they count as coverage.
The Washington election importer reads the Secretary of State's historical
CSV and checks that its ten House contests match the 119th district GEOIDs.
It retains the source hash and writes a separate snapshot, so election data
loads only when the Washington Elections tab is opened.

## Checks

```bash
cd state-rep-map-visualizationo
npm run lint
npx tsc --noEmit
npm run build
```

With the local demo running, check map interaction performance and selection:

```bash
npx playwright install chromium
npm run test:map
npm run test:congress
```

To check federal House fill coverage against the state layer at the same map
zoom, run `node scripts/check-congress-coverage.mjs`. Set
`COVERAGE_ALL_STATES=1` to check every state or `COVERAGE_STATE=WA` to inspect
one. This detects inland missing fills; a screenshot or location is still
needed to diagnose coastal seams, waterways, or problems specific to a remote
preview.

Use `BASE_URL` for a different local server and
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` for an existing Chromium installation.
The check reports time for the map to finish rendering after district changes;
its default median budget is 150 ms (`MAP_HOVER_BUDGET_MS` overrides it for
slower test machines). It also checks that hovering does not reload vector
tiles and that delayed roster responses cannot overwrite newer selections.

District highlights use MapLibre feature state keyed by the Census GEOID,
including leading zeros. Keep highlighting in paint expressions: changing a
layer filter on each district crossing causes MapLibre to reprocess loaded
tiles. Pointer hit tests run at most once per animation frame, and roster
requests share a cached promise per state.

The older per-state MBTiles and PBF exporter remain in the backend for
reference. The browser demo uses the two generated PMTiles archives instead.

For the remaining state roll-call, election-history, upcoming-election, and
polling work, see the [voting and federal feature plan](docs/research/feature-plan.md).
