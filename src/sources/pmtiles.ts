import type { Entry, Header } from "../formats/pmtiles.ts";
import {
  Compression,
  decodeDirectory,
  findEntry,
  PMTilesError,
  ROOT_LIMIT,
  readHeader,
  TileType,
  tileId,
} from "../formats/pmtiles.ts";
import { FetchFailure } from "../tiles/fetch.ts";
import type { ProtocolRequest, ProtocolResult } from "../tiles/protocols.ts";
import { addProtocol } from "../tiles/protocols.ts";

export interface RangeSource {
  readonly key: string;
  read(offset: number, length: number, signal: AbortSignal): Promise<{ data: Uint8Array; etag?: string | undefined }>;
}

export class HttpRangeSource implements RangeSource {
  readonly key: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly credentials: RequestCredentials | undefined;
  private whole: Promise<Uint8Array> | null = null;

  constructor(url: string, headers: Record<string, string> = {}, credentials?: RequestCredentials) {
    this.key = url;
    this.url = url;
    this.headers = headers;
    this.credentials = credentials;
  }

  async read(
    offset: number,
    length: number,
    signal: AbortSignal,
  ): Promise<{ data: Uint8Array; etag?: string | undefined }> {
    if (this.whole) {
      const all = await this.whole;
      return { data: all.subarray(offset, offset + length) };
    }
    const init: RequestInit = { signal, headers: { ...this.headers, range: `bytes=${offset}-${offset + length - 1}` } };
    if (this.credentials) init.credentials = this.credentials;
    let response: Response;
    try {
      response = await fetch(this.url, init);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new FetchFailure({ kind: "network", message: `Could not read ${this.url}`, retryable: true });
    }
    if (response.status === 416) {
      await response.body?.cancel().catch(() => undefined);
      return { data: new Uint8Array(0) };
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new FetchFailure({
        kind: "auth",
        status: response.status,
        message: `Access denied to ${this.url}`,
        retryable: false,
      });
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new FetchFailure({ kind: "http", status: 404, message: `${this.url} was not found`, retryable: false });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new FetchFailure({
        kind: "http",
        status: response.status,
        message: `HTTP ${response.status} for ${this.url}`,
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    const etag = response.headers.get("etag") ?? undefined;
    if (response.status === 200) {
      const size = Number(response.headers.get("content-length") ?? "0");
      if (size > 64 * 1024 * 1024) {
        await response.body?.cancel().catch(() => undefined);
        throw new FetchFailure({
          kind: "http",
          status: 200,
          message: `${this.url} is served without support for range requests`,
          retryable: false,
        });
      }
      this.whole = response.arrayBuffer().then((b) => new Uint8Array(b));
      const all = await this.whole;
      return { data: all.subarray(offset, offset + length), etag };
    }
    return { data: new Uint8Array(await response.arrayBuffer()), etag };
  }
}

export class BlobRangeSource implements RangeSource {
  readonly key: string;
  private readonly blob: Blob;

  constructor(blob: Blob, key: string) {
    this.blob = blob;
    this.key = key;
  }

  async read(offset: number, length: number): Promise<{ data: Uint8Array }> {
    return { data: new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer()) };
  }
}

export async function decompress(data: Uint8Array, compression: number): Promise<Uint8Array> {
  if (compression === Compression.none || compression === Compression.unknown) return data;
  const format = compression === Compression.gzip ? "gzip" : null;
  if (!format) throw new PMTilesError(`Compression type ${compression} is not supported in this browser`);
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class PMTilesArchive {
  readonly source: RangeSource;
  private headerPromise: Promise<{ header: Header; root: Entry[]; etag: string | undefined }> | null = null;
  private metadataPromise: Promise<Record<string, unknown>> | null = null;
  private readonly leaves = new Map<number, Promise<Entry[]>>();
  private readonly leafOrder: number[] = [];

  constructor(source: RangeSource) {
    this.source = source;
  }

  header(signal: AbortSignal = new AbortController().signal): Promise<Header> {
    return this.init(signal).then((r) => r.header);
  }

  async metadata(signal: AbortSignal = new AbortController().signal): Promise<Record<string, unknown>> {
    if (!this.metadataPromise) {
      this.metadataPromise = (async () => {
        const { header } = await this.init(signal);
        if (header.metadataLength === 0) return {};
        const { data } = await this.source.read(header.metadataOffset, header.metadataLength, signal);
        const text = new TextDecoder().decode(await decompress(data, header.internalCompression));
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      })();
      this.metadataPromise.catch(() => {
        this.metadataPromise = null;
      });
    }
    return this.metadataPromise;
  }

  async tile(z: number, x: number, y: number, signal: AbortSignal): Promise<Uint8Array | null> {
    const { header, root } = await this.init(signal);
    if (z < header.minZoom || z > header.maxZoom) return null;
    const id = tileId(z, x, y);
    let entries = root;
    for (let depth = 0; depth < 4; depth++) {
      const entry = findEntry(entries, id);
      if (!entry) return null;
      if (entry.runLength > 0) {
        const { data, etag } = await this.source.read(header.dataOffset + entry.offset, entry.length, signal);
        this.checkEtag(etag);
        return data;
      }
      entries = await this.leaf(header, entry, signal);
    }
    throw new PMTilesError("Directory nesting is too deep");
  }

  private etag: string | undefined;

  private checkEtag(etag: string | undefined): void {
    if (!etag || !this.etag || etag === this.etag) return;
    this.etag = undefined;
    this.headerPromise = null;
    this.metadataPromise = null;
    this.leaves.clear();
    this.leafOrder.length = 0;
    throw new FetchFailure({
      kind: "http",
      message: `${this.source.key} changed on the server; reloading its index`,
      retryable: true,
    });
  }

  private init(signal: AbortSignal) {
    if (!this.headerPromise) {
      this.headerPromise = (async () => {
        const { data, etag } = await this.source.read(0, ROOT_LIMIT, signal);
        const header = readHeader(data);
        let rootBytes: Uint8Array;
        if (header.rootOffset + header.rootLength <= data.length) {
          rootBytes = data.subarray(header.rootOffset, header.rootOffset + header.rootLength);
        } else {
          rootBytes = (await this.source.read(header.rootOffset, header.rootLength, signal)).data;
        }
        const root = decodeDirectory(await decompress(rootBytes, header.internalCompression));
        this.etag = etag;
        return { header, root, etag };
      })();
      this.headerPromise.catch(() => {
        this.headerPromise = null;
      });
    }
    return this.headerPromise;
  }

  private leaf(header: Header, entry: Entry, signal: AbortSignal): Promise<Entry[]> {
    const key = entry.offset;
    let promise = this.leaves.get(key);
    if (!promise) {
      promise = (async () => {
        const { data, etag } = await this.source.read(header.leafOffset + entry.offset, entry.length, signal);
        this.checkEtag(etag);
        return decodeDirectory(await decompress(data, header.internalCompression));
      })();
      promise.catch(() => this.leaves.delete(key));
      this.leaves.set(key, promise);
      this.leafOrder.push(key);
      if (this.leafOrder.length > 128) {
        const old = this.leafOrder.shift();
        if (old !== undefined) this.leaves.delete(old);
      }
    }
    return promise;
  }
}

const archives = new Map<string, PMTilesArchive>();

export function registerArchive(key: string, archive: PMTilesArchive): void {
  archives.set(key, archive);
}

function archiveFor(location: string, request: ProtocolRequest): PMTilesArchive {
  let archive = archives.get(location);
  if (!archive) {
    archive = new PMTilesArchive(new HttpRangeSource(location, request.headers, request.credentials));
    archives.set(location, archive);
    if (archives.size > 32) {
      const first = archives.keys().next().value;
      if (first !== undefined && first !== location) archives.delete(first);
    }
  }
  return archive;
}

const TILE_SUFFIX = /\/(\d+)\/(\d+)\/(\d+)(?:\.\w+)?$/;

export async function handlePmtiles(request: ProtocolRequest, signal: AbortSignal): Promise<ProtocolResult> {
  const rest = request.url.slice("pmtiles://".length);
  const m = TILE_SUFFIX.exec(rest);
  if (request.kind === "tile" && m) {
    const location = rest.slice(0, m.index);
    const archive = archiveFor(location, request);
    const data = await archive.tile(Number(m[1]), Number(m[2]), Number(m[3]), signal);
    return data && data.length > 0 ? data : null;
  }
  const archive = archiveFor(rest, request);
  const header = await archive.header(signal);
  const metadata = await archive.metadata(signal);
  const tileJson = {
    tilejson: "3.0.0",
    tiles: [`pmtiles://${rest}/{z}/{x}/{y}`],
    minzoom: header.minZoom,
    maxzoom: header.maxZoom,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    center: [header.centerLon, header.centerLat, header.centerZoom],
    format: tileFormat(header.tileType),
    ...metadata,
  } as Record<string, unknown>;
  tileJson.tiles = [`pmtiles://${rest}/{z}/{x}/{y}`];
  tileJson.minzoom = header.minZoom;
  tileJson.maxzoom = header.maxZoom;
  return { data: new TextEncoder().encode(JSON.stringify(tileJson)), contentType: "application/json" };
}

function tileFormat(type: number): string {
  switch (type) {
    case TileType.mvt:
      return "pbf";
    case TileType.png:
      return "png";
    case TileType.jpeg:
      return "jpg";
    case TileType.webp:
      return "webp";
    case TileType.avif:
      return "avif";
    default:
      return "unknown";
  }
}

let registered = false;

export function registerPmtilesProtocol(): void {
  if (registered) return;
  registered = true;
  addProtocol("pmtiles", handlePmtiles);
}
