"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import maplibregl, { type Map as MapLibreMap, type MapGeoJSONFeature } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { addDistrictLayers, createDistrictInteractions, DISTRICT_LAYER_SUFFIXES, type Chamber, type DistrictTarget } from "./map-interactions";
import manifestJson from "../public/data/manifest.json";
import statesJson from "../public/data/states.json";

type Member = {
  id: string;
  name: string;
  party: string | null;
  email: string | null;
  phone: string | null;
  officialUrl: string | null;
  districtLabel: string;
  verification: "official-link-listed" | "needs-official-link";
};
type District = {
  state: string;
  stateName: string;
  chamber: Chamber;
  code: string;
  geoid: string;
  name: string;
  boundaryYear: number;
  members: Member[];
  matchType: "exact" | "parent-district" | "unmatched" | "unassigned-area";
};
type StateInfo = {
  code: string;
  name: string;
  fips: string;
  bounds: [number, number, number, number];
  upperDistricts: number;
  lowerDistricts: number;
};

const states = (statesJson as StateInfo[]).sort((a, b) => a.name.localeCompare(b.name));
const statesByFips = new Map(states.map((state) => [state.fips, state]));
const rosterDate = new Date(`${manifestJson.asOf}T00:00:00Z`).toLocaleDateString("en-US", {
  month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
});
let protocolRegistered = false;

function fitState(map: MapLibreMap, state: StateInfo) {
  if (state.code === "AK") {
    map.flyTo({ center: [-151, 63], zoom: 4 });
  } else if (state.code === "HI") {
    map.flyTo({ center: [-156.4, 20.7], zoom: 6 });
  } else {
    const [west, south, east, north] = state.bounds;
    map.fitBounds([[west, south], [east, north]], { padding: 48, maxZoom: 8 });
  }
}

function fitOverview(map: MapLibreMap, duration = 700) {
  map.fitBounds([[-127, 23], [-65, 51]], {
    padding: { top: 76, right: 50, bottom: 78, left: 50 },
    maxZoom: 3.65,
    duration,
  });
}

export default function HomePage() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const interactions = useRef<ReturnType<typeof createDistrictInteractions> | null>(null);
  const hoverLabel = useRef<HTMLDivElement>(null);
  const activeChamber = useRef<Chamber>("upper");
  const clearMapHover = useRef<(() => void) | null>(null);
  const selectionRequest = useRef(0);
  const rosterCache = useRef(new Map<string, Promise<District[]>>());
  const [chamber, setChamber] = useState<Chamber>("upper");
  const [selectedState, setSelectedState] = useState("");
  const [districtSearch, setDistrictSearch] = useState("");
  const [districts, setDistricts] = useState<District[]>([]);
  const [selectedDistrict, setSelectedDistrict] = useState<District | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<DistrictTarget | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState("");
  const [dataError, setDataError] = useState("");

  const loadState = useCallback(async (code: string): Promise<District[]> => {
    const cached = rosterCache.current.get(code);
    if (cached) return cached;
    // Cache the promise too: map clicks and the state picker share one request.
    const pending = fetch(`/data/${code}.json`).then(async (response) => {
      if (!response.ok) throw new Error(`The district records for ${code} could not be loaded.`);
      return (await response.json()) as District[];
    }).catch((error) => {
      rosterCache.current.delete(code);
      throw error;
    });
    rosterCache.current.set(code, pending);
    return pending;
  }, []);

  useEffect(() => {
    if (!container.current) return;
    if (!protocolRegistered) {
      const protocol = new Protocol();
      maplibregl.addProtocol("pmtiles", protocol.tile);
      protocolRegistered = true;
    }
    const origin = window.location.origin;
    const map = new maplibregl.Map({
      container: container.current,
      style: {
        version: 8,
        sources: {},
        layers: [{ id: "water", type: "background", paint: { "background-color": getComputedStyle(container.current).getPropertyValue("--map").trim() || "#d8ebf6" } }],
      },
      center: [-98.5, 39.2],
      zoom: 3.4,
      minZoom: 3,
      maxZoom: 11,
      maxBounds: [[-180, 0], [-30, 75]],
      attributionControl: false,
      // This map has no symbol labels to fade; avoid extra placement frames.
      fadeDuration: 0,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    let hoverFrame = 0;
    let pointer: maplibregl.Point | null = null;
    let hoveredKey = "";
    const clearHover = () => {
      cancelAnimationFrame(hoverFrame);
      hoverFrame = 0;
      pointer = null;
      hoveredKey = "";
      interactions.current?.clearHover();
      map.getCanvas().style.cursor = "";
      if (hoverLabel.current) hoverLabel.current.hidden = true;
    };
    clearMapHover.current = clearHover;

    const onPointerMove = (event: maplibregl.MapMouseEvent) => {
      if (!interactions.current || map.isMoving()) return;
      pointer = event.point;
      if (hoverFrame) return;
      // Hit-test once per frame, for the visible chamber only.
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        if (!pointer) return;
        const feature = map.queryRenderedFeatures(pointer, { layers: [`${activeChamber.current}-fill`] })[0];
        const geoid = String(feature?.properties.GEOID || "");
        const key = geoid ? `${activeChamber.current}:${geoid}` : "";
        if (key === hoveredKey) return;
        hoveredKey = key;
        interactions.current?.setHover(geoid ? { chamber: activeChamber.current, geoid } : null);
        map.getCanvas().style.cursor = geoid ? "pointer" : "";
        const label = hoverLabel.current;
        if (label) {
          label.hidden = !geoid;
          const hoveredState = statesByFips.get(String(feature?.properties.STATEFP || ""));
          label.textContent = geoid ? `${hoveredState?.name || ""} · ${feature.properties.NAMELSAD || feature.properties.NAME || `District ${geoid.slice(2)}`}` : "";
        }
      });
    };
    map.on("mousemove", onPointerMove);
    map.on("movestart", clearHover);
    map.getCanvasContainer().addEventListener("mouseleave", clearHover);

    map.on("load", () => {
      addDistrictLayers(map, origin);
      interactions.current = createDistrictInteractions(map);
      fitOverview(map, 0);
      setMapReady(true);
    });

    map.on("error", (event) => {
      setMapError(event.error?.message || "The map could not load its district data.");
    });

    let disposed = false;
    const onDistrictClick = async (event: maplibregl.MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const geoid = String(feature.properties.GEOID || "");
      const state = statesByFips.get(String(feature.properties.STATEFP || ""));
      if (!state || !geoid) return;
      const clickedChamber = feature.layer.id.startsWith("upper") ? "upper" : "lower";
      const target = { chamber: clickedChamber, geoid } as DistrictTarget;
      const request = ++selectionRequest.current;
      interactions.current?.select(target);
      setSelectedTarget(target);
      setSelectedDistrict(null);
      setDetailsLoading(true);
      setSelectedState(state.code);
      setDistrictSearch("");
      setDataError("");
      try {
        const records = await loadState(state.code);
        if (disposed || request !== selectionRequest.current) return;
        const record = records.find((item) => item.geoid === geoid && item.chamber === clickedChamber);
        setSelectedDistrict(record || null);
        setDataError(record ? "" : `No district record was found for ${geoid}.`);
      } catch (error) {
        if (!disposed && request === selectionRequest.current) setDataError(error instanceof Error ? error.message : "District details could not be loaded.");
      } finally {
        if (!disposed && request === selectionRequest.current) setDetailsLoading(false);
      }
    };
    map.on("click", "upper-fill", onDistrictClick);
    map.on("click", "lower-fill", onDistrictClick);

    return () => {
      disposed = true;
      clearHover();
      clearMapHover.current = null;
      map.getCanvasContainer().removeEventListener("mouseleave", clearHover);
      interactions.current?.destroy();
      interactions.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, [loadState]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    for (const sourceChamber of ["upper", "lower"] as const) {
      const visibility = chamber === sourceChamber ? "visible" : "none";
      for (const suffix of DISTRICT_LAYER_SUFFIXES) {
        map.setLayoutProperty(`${sourceChamber}-${suffix}`, "visibility", visibility);
      }
    }
  }, [chamber, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    interactions.current?.select(selectedTarget);
  }, [selectedTarget, mapReady]);

  useEffect(() => {
    if (!selectedState) return;
    let cancelled = false;
    loadState(selectedState).then((records) => {
      if (!cancelled) {
        setDistricts(records.filter((item) => item.chamber === chamber && item.matchType !== "unassigned-area"));
      }
    }).catch((error) => {
      if (!cancelled) setDataError(error instanceof Error ? error.message : "District details could not be loaded.");
    });
    return () => { cancelled = true; };
  }, [selectedState, chamber, loadState]);

  const state = useMemo(() => states.find((item) => item.code === selectedState), [selectedState]);
  const visibleDistricts = useMemo(() => districts.filter((item) => item.state === selectedState && item.chamber === chamber), [districts, selectedState, chamber]);
  const selectDistrict = (district: District | null) => {
    selectionRequest.current++;
    setDetailsLoading(false);
    setDataError("");
    setSelectedDistrict(district);
    setSelectedTarget(district ? { chamber: district.chamber, geoid: district.geoid } : null);
  };
  const selectState = (code: string) => {
    clearMapHover.current?.();
    setSelectedState(code);
    selectDistrict(null);
    setDistrictSearch("");
    if (!code) setDistricts([]);
    const map = mapRef.current;
    const nextState = states.find((item) => item.code === code);
    if (map && nextState) fitState(map, nextState);
    if (map && !nextState) fitOverview(map);
  };
  const selectChamber = (nextChamber: Chamber) => {
    clearMapHover.current?.();
    activeChamber.current = nextChamber;
    setChamber(nextChamber);
    selectDistrict(null);
    setDistrictSearch("");
  };

  const query = districtSearch.trim().toLocaleLowerCase();
  const searchResults = query
    ? visibleDistricts.filter((district) => {
        return district.name.toLocaleLowerCase().includes(query)
          || district.code.toLocaleLowerCase().includes(query)
          || district.members.some((member) => member.name.toLocaleLowerCase().includes(query));
      }).slice(0, 8)
    : [];

  return (
    <main className="atlas-shell">
      <header className="atlas-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <div><p className="eyebrow">A civic district atlas</p><h1>Statehouse Atlas</h1></div>
        </div>
        <nav className="scope-nav" aria-label="Choose map scope"><Link href="/" aria-current="page">State legislatures</Link><Link href="/congress">U.S. Congress</Link></nav>
        <div className="header-context"><span>50 states</span><i />{manifestJson.districts.toLocaleString()} districts</div>
      </header>

      <div className="atlas-body">
        <aside className="atlas-sidebar" aria-label="Map controls and district details">
          <div className="sidebar-scroll">
            <section className="selector-section" aria-label="Choose a legislature">
              <p className="section-kicker">Find your legislature</p>
              <div className="segmented-control" role="group" aria-label="Chamber">
                <button type="button" aria-pressed={chamber === "upper"} className={chamber === "upper" ? "active" : ""} onClick={() => selectChamber("upper")}>Senate</button>
                <button type="button" aria-pressed={chamber === "lower"} className={chamber === "lower" ? "active" : ""} onClick={() => selectChamber("lower")}>House</button>
              </div>
              <label className="field-label" htmlFor="state-select">State</label>
              <select id="state-select" value={selectedState} onChange={(event) => selectState(event.target.value)}>
                <option value="">All 50 states</option>
                {states.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
              </select>
              {state && (
                <>
                  <label className="field-label" htmlFor="district-search">Find a district or legislator</label>
                  <div className="search-wrap">
                    <span className="search-icon" aria-hidden="true" />
                    <input
                      id="district-search"
                      type="search"
                      value={districtSearch}
                      onChange={(event) => setDistrictSearch(event.target.value)}
                      placeholder="Name or district number"
                      autoComplete="off"
                    />
                    {districtSearch && <button type="button" className="clear-search" onClick={() => setDistrictSearch("")} aria-label="Clear search">×</button>}
                  </div>
                  {districtSearch.trim() && (
                    <div className="search-results" aria-label="Matching districts">
                      {searchResults.length ? searchResults.map((item) => (
                        <button
                          type="button"
                          aria-pressed={selectedDistrict?.geoid === item.geoid}
                          key={item.geoid}
                          onClick={() => selectDistrict(item)}
                        >
                          <span>{item.name}</span>
                          <small>{item.members.length ? item.members.map((member) => member.name).join(", ") : "No confirmed officeholder"}</small>
                        </button>
                      )) : <p>No matching districts or legislators.</p>}
                    </div>
                  )}
                  <label className="field-label" htmlFor="district-select">District</label>
                  <select id="district-select" value={selectedDistrict?.geoid || ""} onChange={(event) => selectDistrict(visibleDistricts.find((item) => item.geoid === event.target.value) || null)}>
                    <option value="">Choose a district</option>
                    {visibleDistricts.map((item) => <option key={`${item.chamber}-${item.geoid}`} value={item.geoid}>{item.name}</option>)}
                  </select>
                </>
              )}
              {state?.code === "NE" && chamber === "lower" && <p className="single-chamber-note">Nebraska has one legislative chamber. Choose Senate to see its districts and senators.</p>}
              <p className="selector-hint"><span className="hint-arrow">↳</span> Select a district on the map or use the lists above.</p>
            </section>

            {dataError && <p className="data-error" role="alert">{dataError}</p>}

            <section className="detail-section" aria-live="polite">
              {detailsLoading ? <p role="status">Loading district officeholders…</p> : selectedDistrict ? (
                <>
                  <p className="section-kicker">Selected district <span className="selected-dot" /></p>
                  <div className="district-heading"><div><p className="district-location">{selectedDistrict.stateName} / {chamber === "upper" ? "State Senate" : "State House"}</p><h2>{selectedDistrict.name}</h2></div><span className="district-code">{selectedDistrict.code}</span></div>
                  <div className="district-meta"><span>Boundary {selectedDistrict.boundaryYear}</span></div>
                  <details className="boundary-source"><summary>Boundary source and district ID</summary><p>U.S. Census Bureau · ID {selectedDistrict.geoid}</p></details>
                  {selectedDistrict.matchType === "parent-district" && <p className="match-note">This map shows the parent district. Some members serve a named subdistrict; use their official profile to confirm the exact area.</p>}
                  {selectedDistrict.members.length ? (
                    <div className="member-list">
                      <p className="member-list-title">{selectedDistrict.members.length === 1 ? "Current officeholder" : "Current officeholders"}</p>
                      {selectedDistrict.members.map((member) => (
                        <article className="member-card" key={member.id}>
                          <div className="member-topline"><h3>{member.name}</h3>{member.party && <span className={`party-tag ${member.party.toLowerCase()}`}>{member.party}</span>}</div>
                          {selectedDistrict.matchType === "parent-district" && <p className="member-seat">Seat {member.districtLabel}</p>}
                          <div className="member-links">
                            {member.officialUrl && <a href={member.officialUrl} target="_blank" rel="noopener noreferrer">Official profile ↗</a>}
                            {member.email && <a href={`mailto:${member.email}`}>Email</a>}
                            {member.phone && <a href={`tel:${member.phone.replace(/[^+\d]/g, "")}`}>{member.phone}</a>}
                          </div>
                          {member.verification === "needs-official-link" && <p className="verification-note">Official profile link needs review.</p>}
                        </article>
                      ))}
                    </div>
                  ) : <p className="empty-detail">No current officeholder match has been confirmed for this district. Check the state legislature for the latest status.</p>}
                </>
              ) : (
                <div className="detail-empty">
                  <span className="detail-empty-symbol" aria-hidden="true">◎</span>
                  <h2>Choose a district</h2>
                  <p>Each shape is a state legislative district. Select one to see the people who serve it.</p>
                </div>
              )}
            </section>
          </div>
          <footer className="sidebar-footer">
            <span>Roster snapshot: {rosterDate}</span>
            <span>Boundaries: <a href="https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-geopackage-file.html" target="_blank" rel="noopener noreferrer">U.S. Census Bureau</a> · <a href="https://github.com/openstates/people" target="_blank" rel="noopener noreferrer">Open States</a></span>
          </footer>
        </aside>

        <section className="map-panel" aria-label="Interactive map of state legislative districts">
          <div className="map-topline"><span className="map-topline-dot" />{chamber === "upper" ? "Senate districts" : "House districts"}{state && <span className="map-topline-state">/ {state.name}</span>}</div>
          <div ref={container} className="map-container" />
          <div ref={hoverLabel} className="map-hover-label" hidden aria-hidden="true" />
          {!mapReady && !mapError && <div className="map-status">Loading district map…</div>}
          {mapError && <div className="map-status error" role="alert">Map data could not load. {mapError}</div>}
          <div className="map-legend"><span className={chamber === "upper" ? "legend-swatch senate" : "legend-swatch house"} /><span>{chamber === "upper" ? "Senate" : "House"}</span><span className="legend-divider" /><span className="legend-click">Select a district to explore</span></div>
          <div className="map-shortcuts" aria-label="Map shortcuts">
            <button type="button" onClick={() => selectState("")}>U.S. overview</button>
            <button type="button" onClick={() => selectState("AK")}>Alaska</button>
            <button type="button" onClick={() => selectState("HI")}>Hawaii</button>
          </div>
        </section>
      </div>
    </main>
  );
}
