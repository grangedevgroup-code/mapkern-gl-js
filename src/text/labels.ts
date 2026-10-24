import type { Transform } from "../camera/transform.ts";
import type { GL } from "../render/gl.ts";
import type { VectorBucket, VectorTile } from "../sources/vector.ts";
import type { RGBA } from "../style/color.ts";
import type { EvalContext, GeometryType } from "../style/expression.ts";
import type { StyleLayer } from "../style/layer.ts";
import type { RenderPiece, TileManager } from "../tiles/manager.ts";
import type { Tile } from "../tiles/tile.ts";
import type { FontSpec, GlyphMetrics } from "./glyphs.ts";
import { cssFamily, GLYPH_SIZE, GlyphAtlas, needsWholeShaping, SDF_RADIUS, splitGraphemes } from "./glyphs.ts";
import { textShader } from "./shader.ts";

export interface SymbolLayerInput {
  layer: StyleLayer;
  manager: TileManager<VectorTile>;
}

interface Glyph {
  m: GlyphMetrics;
  x: number;
  y: number;
}

interface Laid {
  glyphs: Glyph[];
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

interface Label {
  key: string;
  dedupe: string;
  layer: StyleLayer;
  text: string;
  line: boolean;
  wx: number;
  wy: number;
  path: Float64Array | null;
  anchorDist: number;
  laid: Laid;
  scale: number;
  color: RGBA;
  halo: RGBA;
  haloWidth: number;
  opacity: number;
  target: number;
  seen: number;
  tile: Tile<VectorTile>;
  revision: number;
  bucket: VectorBucket;
  feature: number;
  boxes: number[];
}

export interface LabelHit {
  layer: StyleLayer;
  tile: Tile<VectorTile>;
  bucket: VectorBucket;
  feature: number;
}

const FADE_MS = 180;
const PLACE_INTERVAL = 120;
const STRIDE = 36;
const GEOMETRY: Record<number, GeometryType> = { 0: "Unknown", 1: "Point", 2: "LineString", 3: "Polygon" };

class CollisionGrid {
  private readonly cell = 32;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: number[][];
  private readonly boxes: number[] = [];

  constructor(width: number, height: number) {
    this.cols = Math.max(1, Math.ceil(width / this.cell));
    this.rows = Math.max(1, Math.ceil(height / this.cell));
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
  }

  hits(x0: number, y0: number, x1: number, y1: number): boolean {
    const c0 = Math.max(0, Math.floor(x0 / this.cell));
    const c1 = Math.min(this.cols - 1, Math.floor(x1 / this.cell));
    const r0 = Math.max(0, Math.floor(y0 / this.cell));
    const r1 = Math.min(this.rows - 1, Math.floor(y1 / this.cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (const i of this.cells[r * this.cols + c]!) {
          const b = this.boxes;
          if (x0 < b[i + 2]! && x1 > b[i]! && y0 < b[i + 3]! && y1 > b[i + 1]!) return true;
        }
      }
    }
    return false;
  }

  insert(x0: number, y0: number, x1: number, y1: number): void {
    const i = this.boxes.length;
    this.boxes.push(x0, y0, x1, y1);
    const c0 = Math.max(0, Math.floor(x0 / this.cell));
    const c1 = Math.min(this.cols - 1, Math.floor(x1 / this.cell));
    const r0 = Math.max(0, Math.floor(y0 / this.cell));
    const r1 = Math.min(this.rows - 1, Math.floor(y1 / this.cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.cells[r * this.cols + c]!.push(i);
  }
}

export class LabelRenderer {
  readonly atlas = new GlyphAtlas();
  private readonly gl: GL;
  private labels = new Map<string, Label>();
  private lastPlacement = Number.NEGATIVE_INFINITY;
  private placedStructure = "";
  private placedCamera = -1;
  private texture: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private indexCapacity = 0;
  private vertexData = new ArrayBuffer(STRIDE * 4 * 256);
  private glyphCount = 0;
  private atlasGeneration = -1;
  private pendingGlyphs = false;
  visibleCount = 0;

  constructor(gl: GL) {
    this.gl = gl;
  }

  reset(): void {
    this.texture = null;
    this.vao = null;
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.indexCapacity = 0;
    this.atlasGeneration = -1;
    this.atlas.resized = true;
    this.atlas.dirty = null;
  }

  destroy(): void {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteBuffer(this.vertexBuffer);
    this.gl.deleteBuffer(this.indexBuffer);
    this.gl.deleteVertexArray(this.vao);
    this.reset();
    this.labels.clear();
  }

  update(
    transform: Transform,
    inputs: readonly SymbolLayerInput[],
    now: number,
    cameraVersion: number,
    pixelRatio: number,
  ): boolean {
    const parts: string[] = [];
    for (const { layer, manager } of inputs) {
      parts.push(`${layer.id}:${layer.revision}`);
      for (const piece of manager.pieces) {
        if (piece.tile.data?.buckets.has(layer.id))
          parts.push(`${piece.tile.key}/${piece.tile.revision}/${piece.wrap}`);
      }
    }
    const structure = parts.join(",");
    const structureChanged = structure !== this.placedStructure;
    const cameraChanged = cameraVersion !== this.placedCamera;
    if (structureChanged || this.pendingGlyphs || (cameraChanged && now - this.lastPlacement >= PLACE_INTERVAL)) {
      this.place(transform, inputs, now);
      this.placedStructure = structure;
      this.placedCamera = cameraVersion;
      this.lastPlacement = now;
    }
    let animating = cameraVersion !== this.placedCamera || this.pendingGlyphs;
    const dt = Math.min(100, Math.max(0, now - (this.lastFrame ?? now)));
    this.lastFrame = now;
    for (const [key, label] of this.labels) {
      if (label.opacity !== label.target) {
        const step = dt / FADE_MS;
        label.opacity =
          label.target > label.opacity
            ? Math.min(label.target, label.opacity + step)
            : Math.max(label.target, label.opacity - step);
        animating = true;
      }
      if (label.target === 0 && label.opacity <= 0) this.labels.delete(key);
    }
    this.build(transform, pixelRatio);
    return animating;
  }

  private lastFrame: number | undefined;

  hits(box: { x0: number; y0: number; x1: number; y1: number }, accept: (layer: StyleLayer) => boolean): LabelHit[] {
    const out: LabelHit[] = [];
    for (const label of this.labels.values()) {
      if (label.target !== 1 || label.opacity <= 0 || !accept(label.layer)) continue;
      if (label.tile.isEvicted || label.tile.revision !== label.revision) continue;
      const b = label.boxes;
      for (let i = 0; i < b.length; i += 4) {
        if (b[i]! <= box.x1 && b[i + 2]! >= box.x0 && b[i + 1]! <= box.y1 && b[i + 3]! >= box.y0) {
          out.push({ layer: label.layer, tile: label.tile, bucket: label.bucket, feature: label.feature });
          break;
        }
      }
    }
    return out;
  }

  draw(transform: Transform, pixelRatio: number): number {
    if (this.glyphCount === 0) return 0;
    const g = this.gl;
    const gl = g.gl;
    this.syncAtlas();
    const program = g.program(textShader);
    g.use(program);
    g.setBlend("premultiplied");
    g.setDepth(false, false);
    g.bindTexture(0, this.texture);
    gl.uniform1i(program.uniforms.get("u_atlas") ?? null, 0);
    gl.uniform2f(program.uniforms.get("u_viewport") ?? null, transform.width, transform.height);
    gl.uniform2f(program.uniforms.get("u_atlas_size") ?? null, this.atlas.width, this.atlas.height);
    gl.uniform1f(program.uniforms.get("u_pixel_ratio") ?? null, pixelRatio);
    gl.uniform1f(program.uniforms.get("u_radius") ?? null, SDF_RADIUS);
    gl.bindVertexArray(this.vao);
    for (const pass of [0, 1]) {
      gl.uniform1i(program.uniforms.get("u_pass") ?? null, pass);
      gl.drawElements(gl.TRIANGLES, this.glyphCount * 6, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
    return 2;
  }

  private syncAtlas(): void {
    const g = this.gl;
    const gl = g.gl;
    const atlas = this.atlas;
    if (!this.texture || atlas.resized || this.atlasGeneration !== atlas.generation) {
      if (!this.texture) this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, atlas.width, atlas.height, 0, gl.RED, gl.UNSIGNED_BYTE, atlas.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      atlas.resized = false;
      atlas.dirty = null;
      this.atlasGeneration = atlas.generation;
      return;
    }
    if (atlas.dirty) {
      const { y0, y1 } = atlas.dirty;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        y0,
        atlas.width,
        y1 - y0,
        gl.RED,
        gl.UNSIGNED_BYTE,
        atlas.data.subarray(y0 * atlas.width, y1 * atlas.width),
      );
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      atlas.dirty = null;
    }
  }

  private font(layer: StyleLayer): FontSpec {
    return {
      family: cssFamily(layer.fixed<string[]>("font")),
      weight: layer.fixed<string>("weight") === "bold" ? "700" : "400",
      italic: layer.fixed<boolean>("italic"),
    };
  }

  private layoutCache = new Map<string, Laid>();
  private layoutGeneration = -1;

  private layout(layer: StyleLayer, text: string, line: boolean, budget: { left: number }): Laid | null {
    if (this.layoutGeneration !== this.atlas.generation || this.layoutCache.size > 6000) {
      this.layoutCache.clear();
      this.layoutGeneration = this.atlas.generation;
    }
    const cacheKey = `${layer.id}#${layer.revision}#${line ? 1 : 0}#${text}`;
    const cached = this.layoutCache.get(cacheKey);
    if (cached) return cached;
    const laid = this.computeLayout(layer, text, line, budget);
    if (laid) this.layoutCache.set(cacheKey, laid);
    return laid;
  }

  private computeLayout(layer: StyleLayer, text: string, line: boolean, budget: { left: number }): Laid | null {
    const font = this.font(layer);
    const whole = needsWholeShaping(text);
    if (whole && line) return null;
    const units = whole ? [text] : splitGraphemes(text);
    const glyphs: Glyph[] = [];
    const spacing = layer.fixed<number>("letterSpacing") * GLYPH_SIZE;
    const metrics: (GlyphMetrics | null)[] = [];
    for (const u of units) {
      let m = this.atlas.get(font, u);
      if (m === undefined) {
        if (budget.left <= 0) {
          this.pendingGlyphs = true;
          return null;
        }
        budget.left--;
        m = this.atlas.rasterize(font, u);
      }
      metrics.push(m ?? null);
    }
    const lineHeight = GLYPH_SIZE * 1.2;
    const maxWidth = line ? Number.POSITIVE_INFINITY : layer.fixed<number>("maxWidth") * GLYPH_SIZE;
    const lines: { start: number; end: number; width: number }[] = [];
    let start = 0;
    let x = 0;
    let lastBreak = -1;
    let widthAtBreak = 0;
    for (let i = 0; i < units.length; i++) {
      const m = metrics[i];
      const advance = (m?.advance ?? 0) + spacing;
      if (units[i] === " ") {
        lastBreak = i;
        widthAtBreak = x;
      }
      if (x + advance > maxWidth && lastBreak > start) {
        lines.push({ start, end: lastBreak, width: widthAtBreak });
        start = lastBreak + 1;
        x = 0;
        for (let k = start; k <= i; k++) x += (metrics[k]?.advance ?? 0) + spacing;
        lastBreak = -1;
        continue;
      }
      x += advance;
    }
    lines.push({ start, end: units.length, width: x });
    let width = 0;
    for (const l of lines) width = Math.max(width, l.width);
    const height = lines.length * lineHeight;
    lines.forEach((l, row) => {
      let pen = (width - l.width) / 2;
      const baseline = row * lineHeight + GLYPH_SIZE * 0.9;
      for (let i = l.start; i < l.end; i++) {
        const m = metrics[i];
        if (m && m.width > 0) glyphs.push({ m, x: pen, y: baseline });
        pen += (m?.advance ?? 0) + spacing;
      }
    });
    const anchor = layer.fixed<string>("anchor");
    const [ox, oy] = layer.fixed<[number, number]>("offset");
    let offsetX = -width / 2;
    let offsetY = -height / 2;
    if (anchor === "top") offsetY = 0;
    else if (anchor === "bottom") offsetY = -height;
    else if (anchor === "left") offsetX = 0;
    else if (anchor === "right") offsetX = -width;
    offsetX += ox * GLYPH_SIZE;
    offsetY += oy * GLYPH_SIZE;
    return { glyphs, width, height, offsetX, offsetY };
  }

  private place(transform: Transform, inputs: readonly SymbolLayerInput[], now: number): void {
    const grid = new CollisionGrid(transform.width, transform.height);
    const placed = new Map<string, [number, number][]>();
    const visible = new Set<string>();
    const zoom = transform.zoom;
    const budget = { left: 40 };
    this.pendingGlyphs = false;
    const ws = transform.worldSize;
    const margin = 64;
    const shown = new Set<string>();
    for (const label of this.labels.values()) if (label.target === 1) shown.add(label.dedupe);
    for (let li = inputs.length - 1; li >= 0; li--) {
      const { layer, manager } = inputs[li]!;
      if (!layer.isVisible(zoom)) continue;
      const allowOverlap = layer.fixed<boolean>("allowOverlap");
      const padding = layer.fixed<number>("padding");
      const spacing = layer.fixed<number>("spacing");
      const ctx: EvalContext = { zoom };
      const items: {
        piece: RenderPiece<VectorTile>;
        bucket: VectorBucket;
        i: number;
        priority: number;
        was: number;
        order: number;
      }[] = [];
      let order = 0;
      for (const piece of manager.pieces) {
        const bucket = piece.tile.data?.buckets.get(layer.id);
        const labels = bucket?.labels;
        if (!bucket || !labels) continue;
        for (let i = 0; i < labels.count; i++) {
          const was = shown.has(`${layer.id}|${labels.texts[i]}`) ? 0 : 1;
          items.push({ piece, bucket, i, priority: labels.priority[i]!, was, order: order++ });
        }
      }
      items.sort((a, b) => b.priority - a.priority || a.was - b.was || a.order - b.order);
      const scratch: Record<string, unknown> = {};
      for (const { piece, bucket, i } of items) {
        const labels = bucket.labels!;
        const tile = piece.tile;
        const extent = bucket.extent;
        const n = 2 ** tile.z;
        const clip = piece.clip;
        const text = labels.texts[i]!;
        const isLine = labels.line[i] === 1;
        const anchors = labels.anchors.subarray(labels.anchorStart[i]!, labels.anchorStart[i + 1]!);
        const pathData = labels.paths.subarray(labels.pathStart[i]!, labels.pathStart[i + 1]!);
        const fi = labels.feature[i]!;
        const featureId = bucket.features.id(fi);
        const dedupeKey = `${layer.id}|${text}`;
        let featureReady = false;
        for (let a = 0; a < anchors.length; a += 3) {
          const tx = anchors[a]! / extent;
          const ty = anchors[a + 1]! / extent;
          if (tx < clip.x0 || tx >= clip.x1 || ty < clip.y0 || ty >= clip.y1) continue;
          const wx = piece.wrap + (tile.x + tx) / n;
          const wy = (tile.y + ty) / n;
          const p = transform.project(wx, wy);
          const depth = p.w / transform.cameraToCenterDistance;
          if (p.w <= 0 || depth > 2.2) continue;
          if (p.x < -margin || p.y < -margin || p.x > transform.width + margin || p.y > transform.height + margin)
            continue;
          const laid = this.layout(layer, text, isLine, budget);
          if (!laid) continue;
          if (!featureReady) {
            ctx.feature = {
              properties: bucket.features.fill(fi, scratch),
              id: featureId,
              geometryType: GEOMETRY[bucket.features.type(fi)] ?? "Unknown",
            };
            featureReady = true;
          }
          const size = layer.layoutValue<number>("size", ctx);
          const scale = (size / GLYPH_SIZE) * Math.max(0.7, Math.min(1, 1.3 - 0.3 * depth));
          const w = laid.width * scale;
          const h = laid.height * scale;
          const minDist = isLine ? Math.max(spacing, w * 1.5) : Math.max(80, w * 1.2);
          const prior = placed.get(dedupeKey);
          if (prior?.some(([x, y]) => Math.hypot(x - p.x, y - p.y) < minDist)) continue;
          let path: Float64Array | null = null;
          let boxes: number[];
          if (isLine && pathData.length >= 4) {
            path = new Float64Array(pathData.length);
            for (let k = 0; k < pathData.length; k += 2) {
              path[k] = piece.wrap + (tile.x + pathData[k]! / extent) / n;
              path[k + 1] = (tile.y + pathData[k + 1]! / extent) / n;
            }
            const quads = layoutAlongPath(transform, path, anchors[a + 2]! / extent / n, laid, scale);
            if (!quads) continue;
            boxes = [];
            for (const q of quads) {
              const half = (size * 0.6) / 2 + padding;
              boxes.push(q.cx - half, q.cy - half, q.cx + half, q.cy + half);
            }
          } else {
            const x0 = p.x + laid.offsetX * scale - padding;
            const y0 = p.y + laid.offsetY * scale - padding;
            boxes = [x0, y0, x0 + w + padding * 2, y0 + h + padding * 2];
          }
          if (!allowOverlap) {
            let hit = false;
            for (let i = 0; i < boxes.length; i += 4) {
              if (grid.hits(boxes[i]!, boxes[i + 1]!, boxes[i + 2]!, boxes[i + 3]!)) {
                hit = true;
                break;
              }
            }
            if (hit) continue;
          }
          for (let i = 0; i < boxes.length; i += 4) grid.insert(boxes[i]!, boxes[i + 1]!, boxes[i + 2]!, boxes[i + 3]!);
          if (prior) prior.push([p.x, p.y]);
          else placed.set(dedupeKey, [[p.x, p.y]]);
          const key = `${dedupeKey}|${featureId ?? ""}|${Math.round((wx * ws) / 4)}|${Math.round((wy * ws) / 4)}`;
          visible.add(key);
          const existing = this.labels.get(key);
          const color = layer.paintValue<RGBA>("color", ctx);
          const halo = layer.paintValue<RGBA>("haloColor", ctx);
          const haloWidth = layer.paintValue<number>("haloWidth", ctx);
          const opacity = layer.paintValue<number>("opacity", ctx);
          if (existing) {
            existing.wx = wx;
            existing.wy = wy;
            existing.path = path;
            existing.anchorDist = anchors[a + 2]! / extent / n;
            existing.laid = laid;
            existing.scale = scale;
            existing.color = withOpacity(color, opacity);
            existing.halo = withOpacity(halo, opacity);
            existing.haloWidth = haloWidth;
            existing.target = 1;
            existing.seen = now;
            existing.tile = tile;
            existing.revision = tile.revision;
            existing.bucket = bucket;
            existing.feature = fi;
            existing.boxes = boxes;
          } else {
            this.labels.set(key, {
              key,
              dedupe: dedupeKey,
              layer,
              text,
              line: isLine,
              wx,
              wy,
              path,
              anchorDist: anchors[a + 2]! / extent / n,
              laid,
              scale,
              color: withOpacity(color, opacity),
              halo: withOpacity(halo, opacity),
              haloWidth,
              opacity: 0,
              target: 1,
              seen: now,
              tile,
              revision: tile.revision,
              bucket,
              feature: fi,
              boxes,
            });
          }
          if (!isLine) break;
        }
      }
    }
    for (const [key, label] of this.labels) {
      if (!visible.has(key)) label.target = 0;
    }
  }

  private build(transform: Transform, pixelRatio: number): void {
    let glyphs = 0;
    for (const label of this.labels.values()) if (label.opacity > 0) glyphs += label.laid.glyphs.length;
    const needed = glyphs * 4 * STRIDE;
    if (this.vertexData.byteLength < needed)
      this.vertexData = new ArrayBuffer(Math.max(needed, this.vertexData.byteLength * 2));
    const f32 = new Float32Array(this.vertexData);
    const u16 = new Uint16Array(this.vertexData);
    const u8 = new Uint8Array(this.vertexData);
    let v = 0;
    let visible = 0;
    const put = (x: number, y: number, u: number, w: number, label: Label) => {
      const o = v * STRIDE;
      f32[o / 4] = x;
      f32[o / 4 + 1] = y;
      u16[o / 2 + 4] = u;
      u16[o / 2 + 5] = w;
      const c = label.color;
      const h = label.halo;
      u8[o + 12] = c[0] * c[3] * 255;
      u8[o + 13] = c[1] * c[3] * 255;
      u8[o + 14] = c[2] * c[3] * 255;
      u8[o + 15] = c[3] * 255;
      u8[o + 16] = h[0] * h[3] * 255;
      u8[o + 17] = h[1] * h[3] * 255;
      u8[o + 18] = h[2] * h[3] * 255;
      u8[o + 19] = h[3] * 255;
      f32[o / 4 + 5] = label.opacity;
      f32[o / 4 + 6] = label.scale;
      f32[o / 4 + 7] = label.haloWidth;
      f32[o / 4 + 8] = 0;
      v++;
    };
    for (const label of this.labels.values()) {
      if (label.opacity <= 0) continue;
      const s = label.scale;
      if (label.line && label.path) {
        const quads = layoutAlongPath(transform, label.path, label.anchorDist, label.laid, s);
        if (!quads) continue;
        visible++;
        for (const q of quads) {
          const m = q.glyph.m;
          const cos = Math.cos(q.angle);
          const sin = Math.sin(q.angle);
          const x0 = (m.left - q.advance / 2) * s;
          const x1 = x0 + m.width * s;
          const y0 = (m.top + GLYPH_SIZE * 0.32) * s;
          const y1 = y0 + m.height * s;
          const corners = [
            [x0, y0, m.x, m.y],
            [x1, y0, m.x + m.width, m.y],
            [x1, y1, m.x + m.width, m.y + m.height],
            [x0, y1, m.x, m.y + m.height],
          ] as const;
          for (const [dx, dy, u, w] of corners)
            put(q.cx + dx * cos - dy * sin, q.cy + dx * sin + dy * cos, u, w, label);
        }
        continue;
      }
      const p = transform.project(label.wx, label.wy);
      if (p.w <= 0) continue;
      visible++;
      const ax = Math.round((p.x + label.laid.offsetX * s) * pixelRatio) / pixelRatio;
      const ay = Math.round((p.y + label.laid.offsetY * s) * pixelRatio) / pixelRatio;
      for (const glyph of label.laid.glyphs) {
        const m = glyph.m;
        const x0 = ax + (glyph.x + m.left) * s;
        const y0 = ay + (glyph.y + m.top) * s;
        const x1 = x0 + m.width * s;
        const y1 = y0 + m.height * s;
        put(x0, y0, m.x, m.y, label);
        put(x1, y0, m.x + m.width, m.y, label);
        put(x1, y1, m.x + m.width, m.y + m.height, label);
        put(x0, y1, m.x, m.y + m.height, label);
      }
    }
    this.visibleCount = visible;
    this.glyphCount = v / 4;
    this.upload();
  }

  private upload(): void {
    const g = this.gl;
    const gl = g.gl;
    if (g.isLost) return;
    if (!this.vao) {
      this.vao = gl.createVertexArray();
      this.vertexBuffer = gl.createBuffer();
      this.indexBuffer = gl.createBuffer();
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.UNSIGNED_SHORT, false, STRIDE, 8);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, STRIDE, 12);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, STRIDE, 16);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 4, gl.FLOAT, false, STRIDE, 20);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.bindVertexArray(null);
    }
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(this.vertexData, 0, this.glyphCount * 4 * STRIDE), gl.DYNAMIC_DRAW);
    if (this.glyphCount > this.indexCapacity) {
      const capacity = Math.max(1024, this.glyphCount * 2);
      const indices = new Uint32Array(capacity * 6);
      for (let i = 0; i < capacity; i++) {
        const b = i * 4;
        indices.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      this.indexCapacity = capacity;
    }
    gl.bindVertexArray(null);
  }
}

function withOpacity(c: RGBA, opacity: number): RGBA {
  return [c[0], c[1], c[2], c[3] * Math.max(0, Math.min(1, opacity))];
}

interface PathGlyph {
  glyph: Glyph;
  cx: number;
  cy: number;
  angle: number;
  advance: number;
}

function layoutAlongPath(
  transform: Transform,
  path: Float64Array,
  anchorDist: number,
  laid: Laid,
  scale: number,
): PathGlyph[] | null {
  const n = path.length / 2;
  if (n < 2) return null;
  let target = anchorDist;
  let anchorSeg = 0;
  let anchorT = 0;
  for (let i = 0; i < n - 1; i++) {
    const len = Math.hypot(path[i * 2 + 2]! - path[i * 2]!, path[i * 2 + 3]! - path[i * 2 + 1]!);
    if (target <= len || i === n - 2) {
      anchorSeg = i;
      anchorT = len > 0 ? Math.min(1, target / len) : 0;
      break;
    }
    target -= len;
  }
  const screen: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = transform.project(path[i * 2]!, path[i * 2 + 1]!);
    if (p.w <= 0) return null;
    screen.push(p.x, p.y);
  }
  const cum: number[] = [0];
  for (let i = 1; i < n; i++)
    cum.push(cum[i - 1]! + Math.hypot(screen[i * 2]! - screen[i * 2 - 2]!, screen[i * 2 + 1]! - screen[i * 2 - 1]!));
  const total = cum[n - 1]!;
  const anchorAt = cum[anchorSeg]! + (cum[anchorSeg + 1]! - cum[anchorSeg]!) * anchorT;
  const width = laid.width * scale;
  if (width > total) return null;
  let start = anchorAt - width / 2;
  if (start < 0) start = 0;
  if (start + width > total) start = total - width;
  const pointAt = (d: number): [number, number, number] => {
    let i = 0;
    while (i < n - 2 && cum[i + 1]! < d) i++;
    const seg = cum[i + 1]! - cum[i]!;
    const t = seg > 0 ? (d - cum[i]!) / seg : 0;
    const ax = screen[i * 2]!;
    const ay = screen[i * 2 + 1]!;
    const bx = screen[i * 2 + 2]!;
    const by = screen[i * 2 + 3]!;
    return [ax + (bx - ax) * t, ay + (by - ay) * t, Math.atan2(by - ay, bx - ax)];
  };
  const mid = pointAt(start + width / 2);
  const flip = Math.cos(mid[2]) < 0;
  const out: PathGlyph[] = [];
  let lastAngle = Number.NaN;
  for (const g of laid.glyphs) {
    const advance = g.m.advance;
    const along = (g.x + advance / 2) * scale;
    const d = flip ? start + width - along : start + along;
    const [cx, cy, a] = pointAt(d);
    const angle = flip ? a + Math.PI : a;
    if (!Number.isNaN(lastAngle)) {
      let diff = Math.abs(angle - lastAngle);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff > Math.PI / 4) return null;
    }
    lastAngle = angle;
    out.push({ glyph: g, cx, cy, angle, advance });
  }
  return out;
}
