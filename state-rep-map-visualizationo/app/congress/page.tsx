"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import maplibregl, { type Map as MapLibreMap, type MapGeoJSONFeature } from "maplibre-gl";
import { Protocol } from "pmtiles";
import statesJson from "../../public/data/states.json";

type Chamber = "house" | "senate";
type Tab = "people" | "votes" | "agenda" | "elections";
type Member = { id: string; lisId?: string; name: string; party: string; phone: string; officialUrl: string; seatClass?: string };
type District = { geoid: string; state: string; stateName: string; code: string; name: string; members: Member[]; vacancyNote?: string };
type Roll = { roll: number; date: string; question: string; result: string; document: string; description: string; voteType: string; sourceUrl: string; positions: Record<string, string> };
type Snapshot = { generatedAt: string; congress: number; boundaryYear: number; rosterAsOf: Record<Chamber, string>; house: District[]; senate: District[]; votes: Record<Chamber, Roll[]> };
type VoteSnapshot = { generatedAt: string; chamber: Chamber; congress: number; session: number; rollCount: number; rolls: Roll[] };
type AgendaItem = { id: string; chamber: Chamber; kind: "floor" | "committee"; date: string; time: string; title: string; document: string; status: string; updatedAt: string; sourceUrl: string; room?: string };
type AgendaSnapshot = { generatedAt: string; items: AgendaItem[]; coverage: Record<Chamber, string[]>; changes: { id: string; change: "added" | "updated" | "removed" }[] };
type ElectionCandidate = { name: string; party: string; votes: number; percentage: number };
type ElectionContest = { geoid: string; district: string; electionDate: string; stage: string; boundaryPlanId: string; totalVotes: number; candidates: ElectionCandidate[] };
type ElectionSnapshot = { generatedAt: string; coverage: string; boundaryPlanId: string; source: { exportPageUrl: string; fetchedAt: string | null }; status: string; contests: ElectionContest[] };
type StateInfo = { code: string; name: string; fips: string; bounds: [number, number, number, number]; upperDistricts: number; lowerDistricts: number };

const states = (statesJson as StateInfo[]).sort((a, b) => a.name.localeCompare(b.name));
const stateByFips = new Map(states.map((state) => [state.fips, state]));
const sourceName = (chamber: Chamber) => `federal-${chamber}`;
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

function featureState(map: MapLibreMap, chamber: Chamber, geoid: string, key: "hover" | "selected", value: boolean) {
  if (geoid) map.setFeatureState({ source: sourceName(chamber), sourceLayer: sourceName(chamber), id: geoid }, { [key]: value });
}

function addFederalLayers(map: MapLibreMap, origin: string) {
  for (const chamber of ["house", "senate"] as const) {
    const name = sourceName(chamber);
    const visibility = chamber === "house" ? "visible" : "none";
    map.addSource(name, { type: "vector", url: `pmtiles://${origin}/api/archives/${name}.pmtiles`, minzoom: 3, maxzoom: 11, promoteId: "GEOID" });
    map.addLayer({ id: `${name}-fill`, type: "fill", source: name, "source-layer": name, layout: { visibility }, paint: {
      "fill-color": ["case", ["boolean", ["feature-state", "selected"], false], "#efbd62", chamber === "house" ? "#d4a16b" : "#83b2a0"],
      "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.9, 0.72],
    } });
    map.addLayer({ id: `${name}-line`, type: "line", source: name, "source-layer": name, layout: { visibility }, paint: {
      "line-color": "#355461", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.45, 9, 1.2],
    } });
    map.addLayer({ id: `${name}-highlight`, type: "line", source: name, "source-layer": name, layout: { visibility }, paint: {
      "line-color": ["case", ["boolean", ["feature-state", "hover"], false], "#f5d487", "#8a6329"],
      "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 2.4, 2.2],
      "line-opacity": ["case", ["any", ["boolean", ["feature-state", "hover"], false], ["boolean", ["feature-state", "selected"], false]], 1, 0],
    } });
  }
}

function formatSnapshot(date: string) {
  return new Date(date).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export default function CongressPage() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const hoverLabel = useRef<HTMLDivElement>(null);
  const chamberRef = useRef<Chamber>("house");
  const hovered = useRef<{ chamber: Chamber; geoid: string } | null>(null);
  const selectedRef = useRef<{ chamber: Chamber; geoid: string } | null>(null);
  const [data, setData] = useState<Snapshot | null>(null);
  const [dataError, setDataError] = useState("");
  const [mapError, setMapError] = useState("");
  const [mapReady, setMapReady] = useState(false);
  const [chamber, setChamber] = useState<Chamber>("house");
  const [selectedState, setSelectedState] = useState("");
  const [selectedGeoid, setSelectedGeoid] = useState("");
  const [tab, setTab] = useState<Tab>("people");
  const [elections, setElections] = useState<ElectionSnapshot | null>(null);
  const [electionError, setElectionError] = useState("");
  const [voteHistory, setVoteHistory] = useState<Partial<Record<Chamber, VoteSnapshot>>>({});
  const [voteError, setVoteError] = useState("");
  const [agenda, setAgenda] = useState<AgendaSnapshot | null>(null);
  const [agendaError, setAgendaError] = useState("");
  const [voteLimit, setVoteLimit] = useState(20);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/data/federal.json", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("The Congress data snapshot could not be loaded.");
      const snapshot = await response.json() as Snapshot;
      if (snapshot.house.length !== 435 || snapshot.senate.length !== 50) throw new Error("The Congress snapshot is incomplete.");
      setData(snapshot);
    }).catch((error) => { if (!controller.signal.aborted) setDataError(error instanceof Error ? error.message : "Congress data could not load."); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (tab !== "votes" || voteHistory[chamber]) return;
    const controller = new AbortController();
    fetch(`/data/federal-votes-${chamber}.json`, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Full roll-call history could not be loaded.");
      const snapshot = await response.json() as VoteSnapshot;
      if (snapshot.chamber !== chamber || snapshot.congress !== data?.congress || snapshot.rollCount !== snapshot.rolls.length) throw new Error("The roll-call snapshot is incomplete.");
      setVoteHistory((previous) => ({ ...previous, [chamber]: snapshot }));
      setVoteError("");
    }).catch((error) => { if (!controller.signal.aborted) setVoteError(error instanceof Error ? error.message : "Roll-call history could not load."); });
    return () => controller.abort();
  }, [tab, chamber, voteHistory, data]);

  useEffect(() => {
    if (tab !== "agenda" || agenda) return;
    const controller = new AbortController();
    fetch("/data/federal-agendas.json", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Congress schedules could not be loaded.");
      const snapshot = await response.json() as AgendaSnapshot;
      if (!Array.isArray(snapshot.items)) throw new Error("Congress schedule data is incomplete.");
      setAgenda(snapshot);
      setAgendaError("");
    }).catch((error) => { if (!controller.signal.aborted) setAgendaError(error instanceof Error ? error.message : "Congress schedules could not load."); });
    return () => controller.abort();
  }, [tab, agenda]);

  useEffect(() => {
    if (tab !== "elections" || chamber !== "house" || selectedState !== "WA" || elections) return;
    const controller = new AbortController();
    fetch("/data/wa-house-2024.json", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Washington election results could not be loaded.");
      const snapshot = await response.json() as ElectionSnapshot;
      if (snapshot.boundaryPlanId !== "US-CD119" || snapshot.contests.length !== 10) throw new Error("The Washington election snapshot is incomplete.");
      setElections(snapshot);
      setElectionError("");
    }).catch((error) => { if (!controller.signal.aborted) setElectionError(error instanceof Error ? error.message : "Election results could not load."); });
    return () => controller.abort();
  }, [tab, chamber, selectedState, elections]);

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
    let frame = 0;
    let pointer: maplibregl.Point | null = null;
    const clearHover = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      pointer = null;
      const old = hovered.current;
      if (old) featureState(map, old.chamber, old.geoid, "hover", false);
      hovered.current = null;
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
        const active = chamberRef.current;
        const feature = map.queryRenderedFeatures(pointer, { layers: [`${sourceName(active)}-fill`] })[0];
        const geoid = String(feature?.properties.GEOID || "");
        if (hovered.current?.chamber === active && hovered.current.geoid === geoid) return;
        const old = hovered.current;
        if (old) featureState(map, old.chamber, old.geoid, "hover", false);
        hovered.current = geoid ? { chamber: active, geoid } : null;
        if (geoid) featureState(map, active, geoid, "hover", true);
        map.getCanvas().style.cursor = geoid ? "pointer" : "";
        if (hoverLabel.current) {
          hoverLabel.current.hidden = !geoid;
          hoverLabel.current.textContent = geoid ? `${stateByFips.get(String(feature.properties.STATEFP || ""))?.name || ""} · ${active === "senate" ? "U.S. Senate" : feature.properties.NAMELSAD || `District ${geoid.slice(2)}`}` : "";
        }
      });
    };
    const onClick = (event: maplibregl.MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
      const feature = event.features?.[0];
      const geoid = String(feature?.properties.GEOID || "");
      const state = stateByFips.get(String(feature?.properties.STATEFP || ""));
      if (!geoid || !state) return;
      setSelectedState(state.code);
      setSelectedGeoid(geoid);
      setTab("people");
      setVoteLimit(20);
    };
    map.on("load", () => { addFederalLayers(map, window.location.origin); fitOverview(map); setMapReady(true); });
    map.on("error", (event) => setMapError(event.error?.message || "The map could not load its district data."));
    map.on("mousemove", onMove);
    map.on("movestart", clearHover);
    map.getCanvasContainer().addEventListener("mouseleave", clearHover);
    map.on("click", "federal-house-fill", onClick);
    map.on("click", "federal-senate-fill", onClick);
    return () => {
      clearHover();
      map.getCanvasContainer().removeEventListener("mouseleave", clearHover);
      mapRef.current = null;
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    for (const mode of ["house", "senate"] as const) {
      for (const suffix of ["fill", "line", "highlight"]) {
        map.setLayoutProperty(`${sourceName(mode)}-${suffix}`, "visibility", mode === chamber ? "visible" : "none");
      }
    }
  }, [chamber, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const old = selectedRef.current;
    if (old?.chamber === chamber && old.geoid === selectedGeoid) return;
    if (old) featureState(map, old.chamber, old.geoid, "selected", false);
    selectedRef.current = selectedGeoid ? { chamber, geoid: selectedGeoid } : null;
    if (selectedGeoid) featureState(map, chamber, selectedGeoid, "selected", true);
  }, [chamber, selectedGeoid, mapReady]);

  const records = useMemo(() => data?.[chamber] || [], [data, chamber]);
  const visible = useMemo(() => records.filter((item) => item.state === selectedState), [records, selectedState]);
  const selected = records.find((item) => item.geoid === selectedGeoid);
  const rolls = voteHistory[chamber]?.rolls || data?.votes[chamber] || [];
  const memberRolls = selected ? rolls.filter((roll) => selected.members.some((member) => Object.hasOwn(roll.positions, chamber === "house" ? member.id : member.lisId || ""))) : [];
  const chamberAgenda = agenda?.items.filter((item) => item.chamber === chamber) || [];
  const upcomingAgenda = chamberAgenda.filter((item) => item.date >= new Date().toISOString().slice(0, 10));
  const shownAgenda = upcomingAgenda.length ? upcomingAgenda.slice(0, 20) : chamberAgenda.slice(-8).reverse();
  const agendaChanges = new Map(agenda?.changes.map((change) => [change.id, change.change]) || []);
  const election = elections?.contests.find((item) => item.geoid === selectedGeoid);
  const selectState = (code: string) => {
    setSelectedState(code);
    setSelectedGeoid("");
    setVoteLimit(20);
    if (mapRef.current) fitState(mapRef.current, code);
  };
  const selectChamber = (next: Chamber) => {
    chamberRef.current = next;
    setChamber(next);
    setSelectedGeoid("");
    setTab("people");
    setVoteError("");
    setVoteLimit(20);
  };

  return <main className="atlas-shell congress-shell">
    <header className="atlas-header">
      <div className="brand-lockup"><span className="brand-mark" aria-hidden="true"><span /></span><div><p className="eyebrow">A civic district atlas</p><h1>Statehouse Atlas</h1></div></div>
      <nav className="scope-nav" aria-label="Choose map scope"><Link href="/">State legislatures</Link><Link href="/congress" aria-current="page">U.S. Congress</Link><Link href="/executives">U.S. Executives</Link></nav>
      <div className="header-context"><span>50 states</span><i />119th Congress</div>
    </header>
    <div className="atlas-body">
      <aside className="atlas-sidebar" aria-label="Congress map controls and details">
        <div className="sidebar-scroll">
          <section className="selector-section" aria-label="Choose a chamber and state">
            <p className="section-kicker">Explore Congress</p>
            <div className="segmented-control" role="group" aria-label="Federal chamber">
              <button type="button" className={chamber === "house" ? "active" : ""} aria-pressed={chamber === "house"} onClick={() => selectChamber("house")}>U.S. House</button>
              <button type="button" className={chamber === "senate" ? "active" : ""} aria-pressed={chamber === "senate"} onClick={() => selectChamber("senate")}>U.S. Senate</button>
            </div>
            <label className="field-label" htmlFor="federal-state">State</label>
            <select id="federal-state" value={selectedState} onChange={(event) => selectState(event.target.value)}>
              <option value="">All 50 states</option>{states.map((state) => <option key={state.code} value={state.code}>{state.name}</option>)}
            </select>
            {selectedState && <><label className="field-label" htmlFor="federal-district">{chamber === "house" ? "Congressional district" : "Senate delegation"}</label>
              <select id="federal-district" value={selectedGeoid} onChange={(event) => { setSelectedGeoid(event.target.value); setTab("people"); setVoteLimit(20); }}>
                <option value="">Choose {chamber === "house" ? "a district" : "a state"}</option>
                {visible.map((item) => <option key={item.geoid} value={item.geoid}>{item.name}</option>)}
              </select></>}
            <p className="selector-hint"><span className="hint-arrow">↳</span> Select an area on the map or use the state and district lists.</p>
          </section>
          {dataError && <p className="data-error" role="alert">{dataError}</p>}
          <section className="detail-section" aria-live="polite">
            {selected && data ? <>
              <p className="section-kicker">Selected {chamber === "house" ? "district" : "state"}<span className="selected-dot" /></p>
              <div className="district-heading"><div><p className="district-location">{selected.stateName} / {chamber === "house" ? "U.S. House" : "U.S. Senate"}</p><h2>{selected.name}</h2></div><span className="district-code">{selected.state}{chamber === "house" ? selected.code : ""}</span></div>
              <div className="district-meta"><span>{chamber === "house" ? `119th Congress boundary · ${data.boundaryYear}` : `State boundary · ${data.boundaryYear}`}</span></div>
              <div className="detail-tabs" role="tablist" aria-label="Congress details">
                <button type="button" role="tab" aria-selected={tab === "people"} onClick={() => setTab("people")}>People</button>
                <button type="button" role="tab" aria-selected={tab === "votes"} onClick={() => setTab("votes")}>Recorded votes</button>
                <button type="button" role="tab" aria-selected={tab === "agenda"} onClick={() => setTab("agenda")}>Agenda</button>
                <button type="button" role="tab" aria-selected={tab === "elections"} onClick={() => setTab("elections")}>Elections</button>
              </div>
              {tab === "people" ? <div role="tabpanel" aria-label="People">
                {selected.members.length ? <div className="member-list"><p className="member-list-title">{selected.members.length === 1 ? "Current officeholder" : "Current officeholders"}</p>
                  {selected.members.map((member) => <article className="member-card" key={member.id}>
                    <div className="member-topline"><h3>{member.name}</h3><span className={`party-tag ${member.party.toLowerCase()}`}>{member.party}</span></div>
                    {member.seatClass && <p className="member-seat">{member.seatClass}</p>}
                    <div className="member-links"><a href={member.officialUrl} target="_blank" rel="noopener noreferrer">Official profile ↗</a>{member.phone && <a href={`tel:${member.phone.replace(/[^+\d]/g, "")}`}>{member.phone}</a>}</div>
                  </article>)}</div> : <p className="empty-detail">{selected.vacancyNote || "No current officeholder is listed in the official roster for this seat."}</p>}
              </div> : tab === "votes" ? <div role="tabpanel" aria-label="Recorded votes" className="vote-panel">
                <p className="vote-intro">{voteHistory[chamber] ? `${memberRolls.length} recorded rolls for the current officeholder${selected.members.length > 1 ? "s" : ""} in the ${voteHistory[chamber]?.congress}th Congress, session ${voteHistory[chamber]?.session}.` : `Loading full session history; showing ${rolls.length} recent rolls.`} A missing position means the member was absent from that roll&apos;s source; it is different from a recorded “Not Voting.”</p>
                {voteError && <p className="data-error" role="alert">{voteError} Recent rolls remain available below.</p>}
                {selected.members.length ? (voteHistory[chamber] ? memberRolls : rolls).slice(0, voteLimit).map((roll) => <article className="vote-card" key={roll.roll}>
                  <div className="vote-card-heading"><span>Roll {roll.roll}</span><time>{roll.date}</time></div>
                  <h3>{roll.description || roll.document || roll.question}</h3>
                  {(roll.description || roll.document) && <p className="vote-question">{roll.question}</p>}
                  <p className="vote-result">{roll.result}</p>
                  {selected.members.map((member) => <div className="vote-position" key={member.id}><span>{member.name}</span><strong>{roll.positions[chamber === "house" ? member.id : member.lisId || ""] || "Not listed"}</strong></div>)}
                  <a href={roll.sourceUrl} target="_blank" rel="noopener noreferrer">Official roll call ↗</a>
                </article>) : <p className="empty-detail">This seat is vacant in the current roster. Select a represented seat to see its members&apos; positions.</p>}
                {voteHistory[chamber] && memberRolls.length > voteLimit && <button className="show-more" type="button" onClick={() => setVoteLimit((value) => value + 20)}>Show 20 more votes</button>}
                {voteHistory[chamber] && <p className="vote-intro">Official source refreshed {formatSnapshot(voteHistory[chamber].generatedAt)}. Only recorded floor roll calls are included.</p>}
              </div> : tab === "agenda" ? <div role="tabpanel" aria-label="Agenda" className="agenda-panel">
                <p className="vote-intro">Chamber-wide official notices. Schedules can change; House floor items are measures that may be considered, while the Senate floor feed lists its next convening.</p>
                {agendaError && <p className="data-error" role="alert">{agendaError}</p>}
                {!agenda && !agendaError && <p role="status" className="vote-intro">Loading official schedules…</p>}
                {agenda && <><p className="member-list-title">{upcomingAgenda.length ? "Upcoming notices" : "Most recently published notices"} · {chamber === "house" ? "U.S. House" : "U.S. Senate"}</p>
                  {shownAgenda.length ? shownAgenda.map((item) => <article className="vote-card agenda-card" key={item.id}>
                    <div className="vote-card-heading"><span>{item.kind === "floor" ? "Floor" : "Committee"}</span><time>{item.date}{item.time ? ` · ${item.time}` : ""}</time></div>
                    <h3>{item.title}</h3>
                    {item.document && <p className="vote-question">{item.document}</p>}
                    <p className="vote-result">{item.status}{item.room ? ` · ${item.room}` : ""}</p>
                    {item.updatedAt && <p className="vote-question">Source updated: {item.updatedAt}{agendaChanges.has(item.id) ? ` · ${agendaChanges.get(item.id)} since the previous refresh` : ""}</p>}
                    <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">Official notice ↗</a>
                  </article>) : <p className="empty-detail">No notices are listed in the currently published official feeds.</p>}
                  <p className="vote-intro">Schedule snapshot: {formatSnapshot(agenda.generatedAt)}. {agenda.changes.length} added, updated, or removed notices since the previous refresh.</p></>}
              </div> : <div role="tabpanel" aria-label="Elections" className="election-panel">
                {chamber !== "house" || selected.state !== "WA" ? <p className="empty-detail">Election history is available for Washington&apos;s 2024 U.S. House races so far. Other states and Senate races are being added.</p>
                  : electionError ? <p className="data-error" role="alert">{electionError}</p>
                  : !elections ? <p role="status" className="vote-intro">Loading Washington election results…</p>
                  : election ? <>
                    <p className="member-list-title">November 5, 2024 · General election</p>
                    <p className="vote-intro">Results for Washington&apos;s {selected.name.toLowerCase()} in the 2024 election. The Census identifies the 119th district plan as the one in effect for that election cycle.</p>
                    <div className="election-candidates">
                      {election.candidates.map((candidate) => <div className="election-candidate" key={candidate.name}>
                        <div><strong>{candidate.name}</strong>{candidate.party && <span>{candidate.party}</span>}</div>
                        <div className="election-tally"><strong>{candidate.percentage}%</strong><span>{candidate.votes.toLocaleString()} votes</span></div>
                      </div>)}
                    </div>
                    <p className="election-total">{election.totalVotes.toLocaleString()} total votes · 119th Congress district plan</p>
                    <div className="member-links"><a href={elections.source.exportPageUrl} target="_blank" rel="noopener noreferrer">Official Washington results ↗</a></div>
                    <p className="vote-intro">Historical result from the Washington Secretary of State export. This panel does not show 2026 candidates or returns.</p>
                  </> : <p className="empty-detail">No 2024 Washington House result matched this district. Check the official state results.</p>}
              </div>}
            </> : <div className="detail-empty"><span className="detail-empty-symbol" aria-hidden="true">◎</span><h2>Choose {chamber === "house" ? "a district" : "a state"}</h2><p>{chamber === "house" ? "Each shape is a U.S. House district." : "Each shape is a state represented by two U.S. senators."} Select one to see its officeholders and recent recorded votes.</p></div>}
          </section>
        </div>
        <footer className="sidebar-footer"><span>{data ? `Snapshot: ${formatSnapshot(data.generatedAt)}` : "Loading Congress data…"}</span><span>{data ? `Official roster dates: House ${data.rosterAsOf.house}; Senate ${data.rosterAsOf.senate}` : ""}</span><span>Boundaries: <a href="https://www.census.gov/geographies/mapping-files/2025/geo/carto-boundary-file.html" target="_blank" rel="noopener noreferrer">U.S. Census Bureau</a></span></footer>
      </aside>
      <section className="map-panel" aria-label={`Interactive map of U.S. ${chamber === "house" ? "House districts" : "Senate delegations"}`}>
        <div className="map-topline"><span className="map-topline-dot" />{chamber === "house" ? "U.S. House districts" : "U.S. Senate · states"}{selectedState && <span className="map-topline-state">/ {states.find((state) => state.code === selectedState)?.name}</span>}</div>
        <div ref={container} className="map-container" />
        <div ref={hoverLabel} className="map-hover-label" hidden aria-hidden="true" />
        {!mapReady && !mapError && <div className="map-status">Loading Congress map…</div>}
        {mapError && <div className="map-status error" role="alert">Map data could not load. {mapError}</div>}
        <div className="map-legend"><span className={chamber === "house" ? "legend-swatch house" : "legend-swatch senate"} /><span>{chamber === "house" ? "House district" : "State delegation"}</span><span className="legend-divider" /><span className="legend-click">Select an area to explore</span></div>
        <div className="map-shortcuts" aria-label="Map shortcuts"><button type="button" onClick={() => selectState("")}>U.S. overview</button><button type="button" onClick={() => selectState("AK")}>Alaska</button><button type="button" onClick={() => selectState("HI")}>Hawaii</button></div>
      </section>
    </div>
  </main>;
}
