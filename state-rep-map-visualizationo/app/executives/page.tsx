"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
import { Protocol } from "pmtiles";
import statesJson from "../../public/data/states.json";

type StateInfo = { code: string; name: string; fips: string; bounds: [number, number, number, number] };
type Governor = { state: string; stateName: string; fips: string; name: string; party: string; ngaUrl: string; officialUrl: string };
type Snapshot = { generatedAt: string; sources: { governors: string; officialSites: string; president: string }; governors: Governor[]; president: { name: string; officialUrl: string; contactUrl: string } };

const states = (statesJson as unknown as StateInfo[]).sort((a, b) => a.name.localeCompare(b.name));
const stateByFips = new Map(states.map((state) => [state.fips, state]));
const source = "federal-senate";
let protocolRegistered = false;

function fitOverview(map: MapLibreMap) {
  map.fitBounds([[-127, 23], [-65, 51]], { padding: 50, maxZoom: 3.65, duration: 700 });
}

function fitState(map: MapLibreMap, code: string) {
  const state = states.find((item) => item.code === code);
  if (!state) return fitOverview(map);
  if (code === "AK") return map.flyTo({ center: [-151, 63], zoom: 4 });
  if (code === "HI") return map.flyTo({ center: [-156.4, 20.7], zoom: 6 });
  const [west, south, east, north] = state.bounds;
  map.fitBounds([[west, south], [east, north]], { padding: 48, maxZoom: 8 });
}

function setFeatureFlag(map: MapLibreMap, fips: string, key: "hover" | "selected", value: boolean) {
  if (fips && map.getSource(source)) map.setFeatureState({ source, sourceLayer: source, id: fips }, { [key]: value });
}

function makePresidentMarker() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "president-marker";
  button.setAttribute("aria-label", "Show U.S. President");
  button.title = "U.S. President · The White House";
  button.innerHTML = `<svg viewBox="0 0 72 72" aria-hidden="true" focusable="false"><circle cx="36" cy="36" r="34" fill="#132f3a" stroke="#e7c779" stroke-width="3"/><circle cx="36" cy="36" r="28" fill="none" stroke="#e7c779" stroke-width="1"/><path d="M11 28 27 35 23 27 35 32 36 24 37 32 49 27 45 35 61 28 52 43 42 42 36 52 30 42 20 43Z" fill="#e7c779"/><path d="M32 24 39 20 39 27 44 29 38 31 35 28Z" fill="#f9ead0"/><path d="M30 40h12l-2 9-4 5-4-5Z" fill="#f9ead0"/><path d="M31 42h10M33 47h6" stroke="#a44b48" stroke-width="2"/><path d="M17 53h8M47 53h8" stroke="#e7c779" stroke-width="2"/></svg><span>U.S. President</span>`;
  return button;
}

export default function ExecutivesPage() {
  const container = useRef<HTMLDivElement>(null);
  const hoverLabel = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const hovered = useRef("");
  const selectedRef = useRef("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [dataError, setDataError] = useState("");
  const [mapError, setMapError] = useState("");
  const [mapReady, setMapReady] = useState(false);
  const [selection, setSelection] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/data/executives.json", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("The executives data snapshot could not be loaded.");
      const data = await response.json() as Snapshot;
      if (data.governors.length !== 50 || new Set(data.governors.map((item) => item.state)).size !== 50 || !data.president.name) {
        throw new Error("The executives snapshot is incomplete.");
      }
      setSnapshot(data);
    }).catch((error) => { if (!controller.signal.aborted) setDataError(error instanceof Error ? error.message : "Executives data could not load."); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!container.current) return;
    if (!protocolRegistered) {
      const protocol = new Protocol();
      maplibregl.addProtocol("pmtiles", protocol.tile);
      protocolRegistered = true;
    }
    const map = new maplibregl.Map({
      container: container.current,
      style: { version: 8, sources: {}, layers: [{ id: "water", type: "background", paint: { "background-color": "#d8ebf6" } }] },
      center: [-98.5, 39.2], zoom: 3.4, minZoom: 3, maxZoom: 11, maxBounds: [[-180, 0], [-30, 75]],
      attributionControl: false, fadeDuration: 0,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    const markerButton = makePresidentMarker();
    markerButton.addEventListener("click", () => setSelection("president"));
    const marker = new maplibregl.Marker({ element: markerButton, anchor: "center" }).setLngLat([-69.8, 38.3]).addTo(map);
    let frame = 0;
    let pointer: maplibregl.Point | null = null;
    const clearHover = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      pointer = null;
      if (hovered.current) setFeatureFlag(map, hovered.current, "hover", false);
      hovered.current = "";
      map.getCanvas().style.cursor = "";
      if (hoverLabel.current) hoverLabel.current.hidden = true;
    };
    const onMove = (event: maplibregl.MapMouseEvent) => {
      if (map.isMoving()) return;
      pointer = event.point;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!pointer) return;
        if (!map.getLayer("governor-fill")) {
          clearHover();
          return;
        }
        const feature = map.queryRenderedFeatures(pointer, { layers: ["governor-fill"] })[0];
        const fips = String(feature?.properties.GEOID || "");
        if (hovered.current === fips) return;
        if (hovered.current) setFeatureFlag(map, hovered.current, "hover", false);
        hovered.current = fips;
        if (fips) setFeatureFlag(map, fips, "hover", true);
        map.getCanvas().style.cursor = fips ? "pointer" : "";
        if (hoverLabel.current) {
          hoverLabel.current.hidden = !fips;
          hoverLabel.current.textContent = fips ? `${stateByFips.get(fips)?.name || "State"} · Governor` : "";
        }
      });
    };
    map.on("load", () => {
      map.addSource(source, { type: "vector", url: `pmtiles://${window.location.origin}/api/archives/${source}.pmtiles`, minzoom: 3, maxzoom: 11, promoteId: "GEOID" });
      map.addLayer({ id: "governor-fill", type: "fill", source, "source-layer": source, paint: {
        "fill-color": ["case", ["boolean", ["feature-state", "selected"], false], "#efbd62", "#83b2a0"],
        "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.9, 0.76],
      } });
      map.addLayer({ id: "governor-line", type: "line", source, "source-layer": source, paint: {
        "line-color": "#355461", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.55, 9, 1.3],
      } });
      map.addLayer({ id: "governor-highlight", type: "line", source, "source-layer": source, paint: {
        "line-color": ["case", ["boolean", ["feature-state", "hover"], false], "#f5d487", "#8a6329"],
        "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 2.4, 2.2],
        "line-opacity": ["case", ["any", ["boolean", ["feature-state", "hover"], false], ["boolean", ["feature-state", "selected"], false]], 1, 0],
      } });
      fitOverview(map);
      setMapReady(true);
    });
    map.on("error", (event) => setMapError(event.error?.message || "The map could not load its state data."));
    map.on("mousemove", onMove);
    map.on("movestart", clearHover);
    map.getCanvasContainer().addEventListener("mouseleave", clearHover);
    map.on("click", "governor-fill", (event) => {
      const fips = String(event.features?.[0]?.properties.GEOID || "");
      const state = stateByFips.get(fips);
      if (state) setSelection(state.code);
    });
    return () => {
      clearHover();
      map.getCanvasContainer().removeEventListener("mouseleave", clearHover);
      marker.remove();
      mapRef.current = null;
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const next = states.find((state) => state.code === selection)?.fips || "";
    if (selectedRef.current === next) return;
    if (selectedRef.current) setFeatureFlag(map, selectedRef.current, "selected", false);
    selectedRef.current = next;
    if (next) setFeatureFlag(map, next, "selected", true);
  }, [selection, mapReady]);

  const selectState = (code: string) => {
    setSelection(code);
    if (mapRef.current) fitState(mapRef.current, code);
  };
  const governor = snapshot?.governors.find((item) => item.state === selection);
  const president = selection === "president" ? snapshot?.president : null;
  const selectedStateName = states.find((state) => state.code === selection)?.name;

  return <main className="atlas-shell executives-shell">
    <header className="atlas-header">
      <div className="brand-lockup"><span className="brand-mark" aria-hidden="true"><span /></span><div><p className="eyebrow">A civic district atlas</p><h1>Statehouse Atlas</h1></div></div>
      <nav className="scope-nav" aria-label="Choose map scope"><Link href="/">State legislatures</Link><Link href="/congress">U.S. Congress</Link><Link href="/executives" aria-current="page">U.S. Executives</Link></nav>
      <div className="header-context"><span>50 states</span><i />Executive offices</div>
    </header>
    <div className="atlas-body">
      <aside className="atlas-sidebar" aria-label="Executives map controls and details">
        <div className="sidebar-scroll">
          <section className="selector-section" aria-label="Choose a governor or president">
            <p className="section-kicker">Explore executives</p>
            <label className="field-label" htmlFor="executive-state">State governor</label>
            <select id="executive-state" value={selection === "president" ? "" : selection} onChange={(event) => selectState(event.target.value)}>
              <option value="">All 50 states</option>{states.map((state) => <option key={state.code} value={state.code}>{state.name}</option>)}
            </select>
            <button type="button" className="president-sidebar-button" aria-pressed={selection === "president"} onClick={() => setSelection("president")}><span aria-hidden="true">★</span> U.S. President <span aria-hidden="true">↗</span></button>
            <p className="selector-hint"><span className="hint-arrow">↳</span> Select a state on the map, choose one above, or open the president seal offshore.</p>
          </section>
          {dataError && <p className="data-error" role="alert">{dataError}</p>}
          <section className="detail-section" aria-live="polite">
            {governor ? <>
              <p className="section-kicker">Selected state<span className="selected-dot" /></p>
              <div className="district-heading"><div><p className="district-location">{governor.stateName} / Executive</p><h2>Governor</h2></div><span className="district-code">{governor.state}</span></div>
              <div className="member-list"><p className="member-list-title">Current officeholder</p><article className="member-card">
                <div className="member-topline"><h3>{governor.name}</h3><span className={`party-tag ${governor.party.toLowerCase()}`}>{governor.party}</span></div>
                <div className="member-links"><a href={governor.officialUrl} target="_blank" rel="noopener noreferrer">Official governor site ↗</a><a href={governor.ngaUrl} target="_blank" rel="noopener noreferrer">NGA profile ↗</a></div>
              </article></div>
            </> : president ? <>
              <p className="section-kicker">Federal executive<span className="selected-dot" /></p>
              <div className="district-heading"><div><p className="district-location">The White House / Washington, DC</p><h2>U.S. President</h2></div></div>
              <div className="member-list"><p className="member-list-title">Current officeholder</p><article className="member-card">
                <div className="member-topline"><h3>{president.name}</h3></div>
                <div className="member-links"><a href={president.officialUrl} target="_blank" rel="noopener noreferrer">Official White House profile ↗</a><a href={president.contactUrl} target="_blank" rel="noopener noreferrer">Contact the White House ↗</a></div>
              </article></div>
            </> : <div className="detail-empty"><span className="detail-empty-symbol" aria-hidden="true">◎</span><h2>Choose an executive</h2><p>Each state shows its governor. The seal in the Atlantic opens the president&apos;s profile from the national view.</p></div>}
          </section>
        </div>
        <footer className="sidebar-footer"><span>{snapshot ? `Snapshot: ${new Date(snapshot.generatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}` : "Loading executives data…"}</span><span>Governors: <a href={snapshot?.sources.governors || "https://www.nga.org/governors/"} target="_blank" rel="noopener noreferrer">National Governors Association</a> · <a href={snapshot?.sources.officialSites || "https://www.usa.gov/state-governor"} target="_blank" rel="noopener noreferrer">USAGov official links</a></span><span>Boundaries: <a href="https://www.census.gov/geographies/mapping-files/2025/geo/carto-boundary-file.html" target="_blank" rel="noopener noreferrer">U.S. Census Bureau</a></span></footer>
      </aside>
      <section className="map-panel" aria-label="Interactive map of U.S. governors and the president">
        <div className="map-topline"><span className="map-topline-dot" />U.S. Executives{selectedStateName && <span className="map-topline-state">/ {selectedStateName}</span>}</div>
        <div ref={container} className="map-container" />
        <button type="button" className="president-mobile-marker" aria-label="Show U.S. President" onClick={() => setSelection("president")}>
          <svg viewBox="0 0 72 72" aria-hidden="true" focusable="false"><circle cx="36" cy="36" r="34" fill="#132f3a" stroke="#e7c779" strokeWidth="3"/><circle cx="36" cy="36" r="28" fill="none" stroke="#e7c779"/><path d="M11 28 27 35 23 27 35 32 36 24 37 32 49 27 45 35 61 28 52 43 42 42 36 52 30 42 20 43Z" fill="#e7c779"/><path d="M32 24 39 20 39 27 44 29 38 31 35 28Z" fill="#f9ead0"/><path d="M30 40h12l-2 9-4 5-4-5Z" fill="#f9ead0"/><path d="M31 42h10M33 47h6" stroke="#a44b48" strokeWidth="2"/></svg>
          <span>U.S. President</span>
        </button>
        <div ref={hoverLabel} className="map-hover-label" hidden aria-hidden="true" />
        {!mapReady && !mapError && <div className="map-status">Loading executives map…</div>}
        {mapError && <div className="map-status error" role="alert">Map data could not load. {mapError}</div>}
        <div className="map-legend"><span className="legend-swatch senate" /><span>State governor</span><span className="legend-divider" /><span className="legend-click">Select a state or the president seal</span></div>
        <div className="map-shortcuts" aria-label="Map shortcuts"><button type="button" onClick={() => selectState("")}>U.S. overview</button><button type="button" onClick={() => selectState("AK")}>Alaska</button><button type="button" onClick={() => selectState("HI")}>Hawaii</button></div>
      </section>
    </div>
  </main>;
}
