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
type StateTab = "people" | "votes" | "agenda";
type WashingtonRoll = { id: string; chamber: Chamber; bill: string; date: string; motion: string; positions: Record<string, string>; sourceUrl: string };
type WashingtonMeeting = { id: string; chamber: Chamber | "joint" | "other"; committee: string; date: string; room: string; status: string; revisedAt: string; items: string[]; sourceUrl: string; xmlUrl: string };
type WashingtonSchedule = { asOfDate: string; refreshedAt: string; timeZone: string; regularSession: { lastAdjournedAt: string; sourceUrl: string }; nextRegularSession: { date: string; status: "tentative"; sourceUrl: string } | null; committeeScheduleUrl: string; upcomingMeetings: WashingtonMeeting[]; historicalMeetings: WashingtonMeeting[] };
type WashingtonPilot = { generatedAt: string; coverage: { description: string; billPassageDateRange: string[]; historicalAgendaDateRange: string[]; upcomingAgendaDateRange: string[]; selectedBills: string[] }; memberCrosswalk: Record<string, string>; rolls: WashingtonRoll[]; schedule: WashingtonSchedule };
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
function washingtonToday() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function displayDate(value: string) {
  return new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });
}
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
  const [stateTab, setStateTab] = useState<StateTab>("people");
  const [washington, setWashington] = useState<WashingtonPilot | null>(null);
  const [washingtonError, setWashingtonError] = useState("");
  const [stateVoteLimit, setStateVoteLimit] = useState(20);

  useEffect(() => {
    if (selectedState !== "WA" || stateTab === "people" || washington) return;
    const controller = new AbortController();
    fetch("/data/wa-legislature-pilot.json", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Washington legislative records could not be loaded.");
      const snapshot = await response.json() as WashingtonPilot;
      if (!Array.isArray(snapshot.rolls) || !Array.isArray(snapshot.schedule?.upcomingMeetings) || !Array.isArray(snapshot.schedule?.historicalMeetings)) throw new Error("Washington legislative records are incomplete.");
      setWashington(snapshot);
      setWashingtonError("");
    }).catch((error) => { if (!controller.signal.aborted) setWashingtonError(error instanceof Error ? error.message : "Washington legislative records could not load."); });
    return () => controller.abort();
  }, [selectedState, stateTab, washington]);

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
      setStateTab("people");
      setStateVoteLimit(20);
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
    setStateTab("people");
    setStateVoteLimit(20);
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
    setStateTab("people");
    setStateVoteLimit(20);
    selectDistrict(null);
    setDistrictSearch("");
  };

  const query = districtSearch.trim().toLocaleLowerCase();
  const washingtonMemberIds = selectedDistrict?.members.map((member) => washington?.memberCrosswalk[member.id]).filter((id): id is string => Boolean(id)) || [];
  const washingtonVotes = washington?.rolls.filter((roll) => roll.chamber === chamber && washingtonMemberIds.some((id) => Object.hasOwn(roll.positions, id))) || [];
  const todayInWashington = washingtonToday();
  const washingtonMeetings = washington?.schedule.upcomingMeetings.filter((meeting) => meeting.date.slice(0, 10) >= todayInWashington && (meeting.chamber === chamber || meeting.chamber === "joint")) || [];
  const washingtonPastMeetings = washington ? [...washington.schedule.historicalMeetings, ...washington.schedule.upcomingMeetings.filter((meeting) => meeting.date.slice(0, 10) < todayInWashington)]
    .filter((meeting) => meeting.chamber === chamber || meeting.chamber === "joint").sort((a, b) => b.date.localeCompare(a.date)) : [];
  const nextChamberMeeting = washingtonMeetings.find((meeting) => meeting.chamber === chamber && meeting.status !== "Cancelled");
  const washingtonMeetingCard = (meeting: WashingtonMeeting) => <article className="vote-card agenda-card" key={meeting.id}>
    <div className="vote-card-heading"><span>{meeting.chamber === "joint" ? "Joint committee" : chamber === "upper" ? "Senate committee" : "House committee"}</span><time>{meeting.date.replace("T", " · ")}</time></div>
    <h3>{meeting.committee || "Committee meeting"}</h3>
    {meeting.items.length > 0 && <p className="vote-question">{meeting.items[0]}{meeting.items.length > 1 ? ` · ${meeting.items.length} agenda items` : ""}</p>}
    <p className="vote-result">{meeting.status}{meeting.room ? ` · ${meeting.room}` : ""}</p>
    {meeting.revisedAt && <p className="vote-question">Revised: {meeting.revisedAt}</p>}
    <a href={meeting.sourceUrl} target="_blank" rel="noopener noreferrer">Official agenda ↗</a>
  </article>;
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
      <nav className="scope-nav" aria-label="Choose map scope"><Link href="/" aria-current="page">State legislatures</Link><Link href="/congress">U.S. Congress</Link><Link href="/executives">U.S. Executives</Link></nav>
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
                  {selectedDistrict.state === "WA" && <div className="detail-tabs" role="tablist" aria-label="Washington district details">
                    <button type="button" role="tab" aria-selected={stateTab === "people"} onClick={() => setStateTab("people")}>People</button>
                    <button type="button" role="tab" aria-selected={stateTab === "votes"} onClick={() => setStateTab("votes")}>Recorded votes</button>
                    <button type="button" role="tab" aria-selected={stateTab === "agenda"} onClick={() => setStateTab("agenda")}>Agenda</button>
                  </div>}
                  {stateTab === "people" && selectedDistrict.members.length ? (
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
                  ) : stateTab === "people" ? <p className="empty-detail">No current officeholder match has been confirmed for this district. Check the state legislature for the latest status.</p>
                    : <div role="tabpanel" aria-label={stateTab === "votes" ? "Recorded votes" : "Agenda"} className="vote-panel">
                      {stateTab === "votes" ? <p className="vote-intro">Washington pilot: {washington?.coverage.description || "loading official legislative records"}. It covers {washington?.coverage.selectedBills.length || 0} selected bills passed between {washington?.coverage.billPassageDateRange.join(" and ") || "the pilot dates"}. Individual votes come from the legislature&apos;s <a href="https://wslwebservices.leg.wa.gov/legislationservice.asmx?op=GetRollCalls" target="_blank" rel="noopener noreferrer">GetRollCalls XML service ↗</a>.</p>
                        : <p className="vote-intro">Upcoming House, Senate, and joint committee notices from Washington&apos;s official schedule. These are chamber-wide meetings, not meetings for this district alone.</p>}
                      {washingtonError && <p className="data-error" role="alert">{washingtonError}</p>}
                      {!washington && !washingtonError && <p role="status">Loading Washington records…</p>}
                      {washington && stateTab === "votes" && (washingtonVotes.length ? washingtonVotes.slice(0, stateVoteLimit).map((roll) => <article className="vote-card" key={roll.id}>
                        <div className="vote-card-heading"><span>{roll.bill}</span><time>{roll.date}</time></div>
                        <h3>{roll.motion}</h3>
                        {selectedDistrict.members.map((member) => <div className="vote-position" key={member.id}><span>{member.name}</span><strong>{washington.memberCrosswalk[member.id] ? roll.positions[washington.memberCrosswalk[member.id]] || "Not listed" : "ID unverified"}</strong></div>)}
                        <a href={roll.sourceUrl} target="_blank" rel="noopener noreferrer">Official roll call ↗</a>
                      </article>) : <p className="empty-detail">No individual votes for this district appear in the selected bill sample. This does not indicate the officeholder did not vote.</p>)}
                      {washington && stateTab === "votes" && washingtonVotes.length > stateVoteLimit && <button className="show-more" type="button" onClick={() => setStateVoteLimit((value) => value + 20)}>Show 20 more votes</button>}
                      {washington && stateTab === "agenda" && <>
                        <div className="session-summary">
                          <p className="member-list-title">Regular session</p>
                          <p>The 2026 regular session adjourned {displayDate(washington.schedule.regularSession.lastAdjournedAt)}. Interim committees can still meet.</p>
                          {washington.schedule.nextRegularSession && washington.schedule.nextRegularSession.date >= todayInWashington && <p>Next regular session: <strong>{displayDate(washington.schedule.nextRegularSession.date)}</strong> (tentative). <a href={washington.schedule.nextRegularSession.sourceUrl} target="_blank" rel="noopener noreferrer">Official session dates ↗</a></p>}
                          {nextChamberMeeting && <p>Next scheduled {chamber === "upper" ? "Senate" : "House"} committee meeting: <strong>{displayDate(nextChamberMeeting.date)}</strong>.</p>}
                        </div>
                        <section className="upcoming-meetings" aria-label="Upcoming committee meetings">
                          <p className="member-list-title">Upcoming committee meetings</p>
                          {washingtonMeetings.length ? washingtonMeetings.slice(0, 20).map(washingtonMeetingCard) : <p className="empty-detail">No upcoming {chamber === "upper" ? "Senate" : "House"} or joint committee meetings are listed in this snapshot. <a href={washington.schedule.committeeScheduleUrl} target="_blank" rel="noopener noreferrer">Check the live official schedule ↗</a></p>}
                        </section>
                        {washingtonPastMeetings.length > 0 && <details className="agenda-history"><summary>Past meeting sample · {washington.coverage.historicalAgendaDateRange.join(" to ")}</summary>{washingtonPastMeetings.slice(0, 8).map(washingtonMeetingCard)}</details>}
                        <p className="vote-intro">Schedule refreshed {new Date(washington.schedule.refreshedAt).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: washington.schedule.timeZone, timeZoneName: "short" })}. The legislature publishes <a href="https://wslwebservices.leg.wa.gov/committeemeetingservice.asmx?op=GetCommitteeMeetings" target="_blank" rel="noopener noreferrer">meeting XML ↗</a> and individual agenda items. This map displays a dated copy; <a href={washington.schedule.committeeScheduleUrl} target="_blank" rel="noopener noreferrer">check the live schedule ↗</a> for changes.</p>
                      </>}
                      {washington && <p className="vote-intro">Official Washington snapshot: {new Date(washington.generatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}.</p>}
                    </div>}
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
