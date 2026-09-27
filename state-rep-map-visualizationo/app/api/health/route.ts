import { stat } from "node:fs/promises";
import path from "node:path";

const requiredFiles = [
  "data/manifest.json",
  "data/federal.json",
  "data/executives.json",
  "data/wa-house-2024.json",
  "archives/upper.pmtiles",
  "archives/lower.pmtiles",
  "archives/federal-house.pmtiles",
  "archives/federal-senate.pmtiles",
];

export async function GET() {
  const present = await Promise.all(requiredFiles.map(async (file) => {
    try {
      return (await stat(path.join(process.cwd(), "public", file))).size > 0;
    } catch {
      return false;
    }
  }));
  return Response.json({ status: present.every(Boolean) ? "ok" : "missing-map-data" }, {
    status: present.every(Boolean) ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
