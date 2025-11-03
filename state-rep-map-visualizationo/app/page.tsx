"use client";
import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";

export default function HomePage() {
  const mapContainer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mapContainer.current) return;

    const origin = typeof window !== "undefined" ? window.location.origin : "";

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          basemap: {
            type: "raster",
            tiles: ["https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"],
            tileSize: 256,
          },
          colorado_upper: {
            type: "vector",
            tiles: [`${origin}/tiles/colorado_upper/{z}/{x}/{y}.pbf`], // ✅ absolute URL
            minzoom: 4,
            maxzoom: 10,
          },
        },
        layers: [
          { id: "basemap", type: "raster", source: "basemap" },
          {
            id: "districts",
            type: "fill",
            source: "colorado_upper",
            "source-layer": "colorado_upper",
            paint: {
              "fill-color": "#ff6600",
              "fill-opacity": 0.55,
              "fill-outline-color": "#222",
            },
          },
        ],
      },
      center: [-105.5, 39.0],
      zoom: 6,
      minZoom: 3,
      maxZoom: 10,
      maxBounds: [
        [-180, 0],  // southwest corner (lon, lat)
        [-30, 75],  // northeast corner
      ],
    });

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });

    map.on("mousemove", "districts", (e) => {
      if (!e.features?.length) return;
      const props = e.features[0].properties;
      popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-family:sans-serif;font-size:13px;">
            <b>${props.NAMELSAD || "Unknown"}</b><br/>
            GEOID: ${props.GEOID || "?"}<br/>
            State: ${props.state_name || ""}
          </div>`
        )
        .addTo(map);
    });

    map.on("mouseleave", "districts", () => popup.remove());

    map.on("error", (e) => console.warn("MapLibre error:", e));

    return () => map.remove();
  }, []);

  return (
    <main style={{ height: "100vh", width: "100vw" }}>
      <div ref={mapContainer} style={{ height: "100%", width: "100%" }} />
    </main>
  );
}
