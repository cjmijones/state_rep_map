import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";

type Context = { params: Promise<{ archive: string }> };

async function serve(request: Request, context: Context, headOnly = false) {
  const { archive } = await context.params;
  if (!["upper.pmtiles", "lower.pmtiles", "federal-house.pmtiles", "federal-senate.pmtiles"].includes(archive)) {
    return new Response("Unknown archive", { status: 404 });
  }

  const filePath = path.join(process.cwd(), "public", "archives", archive);
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return new Response("District archive has not been generated", { status: 404 });
  }

  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type": "application/octet-stream",
    "Cache-Control": "public, max-age=3600",
  });
  const range = request.headers.get("range");
  if (!range) {
    headers.set("Content-Length", String(size));
    return new Response(headOnly ? null : new Uint8Array(await readFile(filePath)), {
      status: 200,
      headers,
    });
  }

  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || end < start) {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const length = end - start + 1;
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Content-Length", String(length));
  if (headOnly) return new Response(null, { status: 206, headers });

  const handle = await open(filePath, "r");
  try {
    const bytes = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(bytes, offset, length - offset, start + offset);
      if (bytesRead === 0) throw new Error("Unexpected end of district archive");
      offset += bytesRead;
    }
    return new Response(bytes, { status: 206, headers });
  } finally {
    await handle.close();
  }
}

export function GET(request: Request, context: Context) {
  return serve(request, context);
}

export function HEAD(request: Request, context: Context) {
  return serve(request, context, true);
}
