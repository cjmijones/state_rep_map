import type {
  FillLayerSpecification,
  LineLayerSpecification,
  Map as MapLibreMap,
} from "maplibre-gl";

export type Chamber = "upper" | "lower";

export type DistrictTarget = {
  chamber: Chamber;
  geoid: string;
};

export const DISTRICT_LAYER_SUFFIXES = ["fill", "line", "highlight"] as const;

type FeatureStateKey = "hover" | "selected";

function sameTarget(a: DistrictTarget | null, b: DistrictTarget | null): boolean {
  return a?.chamber === b?.chamber && a?.geoid === b?.geoid;
}

function featureTarget(target: DistrictTarget) {
  return {
    source: `districts-${target.chamber}`,
    sourceLayer: target.chamber,
    id: target.geoid,
  };
}

/** Add both chamber sources and their three visual layers. */
export function addDistrictLayers(map: MapLibreMap, origin: string): void {
  for (const chamber of ["upper", "lower"] as const) {
    const visible = chamber === "upper" ? "visible" : "none";
    const color = chamber === "upper" ? "#83b2a0" : "#d4a16b";

    map.addSource(`districts-${chamber}`, {
      type: "vector",
      url: `pmtiles://${origin}/api/archives/${chamber}.pmtiles`,
      minzoom: 3,
      maxzoom: 11,
      promoteId: "GEOID",
    });

    const source = {
      source: `districts-${chamber}`,
      "source-layer": chamber,
      layout: { visibility: visible },
    } as const;

    const fill: FillLayerSpecification = {
      ...source,
      id: `${chamber}-fill`,
      type: "fill",
      paint: {
        "fill-color": ["case", ["boolean", ["feature-state", "selected"], false], "#efbd62", color],
        "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.86, 0.7],
      },
    };
    const line: LineLayerSpecification = {
      ...source,
      id: `${chamber}-line`,
      type: "line",
      paint: {
        "line-color": "#355461",
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.35, 9, 1.15],
      },
    };
    const highlight: LineLayerSpecification = {
      ...source,
      id: `${chamber}-highlight`,
      type: "line",
      paint: {
        "line-color": [
          "case",
          ["boolean", ["feature-state", "hover"], false], "#f5d487",
          ["boolean", ["feature-state", "selected"], false], "#8a6329",
          "#8a6329",
        ],
        "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 2.4, 2.2],
        "line-opacity": [
          "case",
          ["boolean", ["feature-state", "hover"], false], 0.95,
          ["boolean", ["feature-state", "selected"], false], 1,
          0,
        ],
      },
    };

    map.addLayer(fill);
    map.addLayer(line);
    map.addLayer(highlight);
  }
}

/**
 * Owns hover and selection feature state while avoiding duplicate updates for
 * repeated pointer events over the same district.
 */
export function createDistrictInteractions(map: MapLibreMap) {
  let hovered: DistrictTarget | null = null;
  let selected: DistrictTarget | null = null;
  let destroyed = false;

  const update = (
    previous: DistrictTarget | null,
    next: DistrictTarget | null,
    key: FeatureStateKey,
  ): DistrictTarget | null => {
    if (sameTarget(previous, next)) return previous;
    if (previous) map.setFeatureState(featureTarget(previous), { [key]: false });
    if (next) map.setFeatureState(featureTarget(next), { [key]: true });
    return next;
  };

  return {
    setHover(target: DistrictTarget | null) {
      if (!destroyed) hovered = update(hovered, target, "hover");
    },
    select(target: DistrictTarget | null) {
      if (!destroyed) selected = update(selected, target, "selected");
    },
    clearHover() {
      if (!destroyed) hovered = update(hovered, null, "hover");
    },
    destroy() {
      if (destroyed) return;
      hovered = update(hovered, null, "hover");
      selected = update(selected, null, "selected");
      destroyed = true;
    },
  };
}
