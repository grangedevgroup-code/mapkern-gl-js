import type { Transform } from "../camera/transform.ts";
import type { GL } from "../render/gl.ts";
import { ImageAtlas } from "../render/images.ts";
import type { VectorBucket, VectorTile } from "../sources/vector.ts";
import type { RGBA } from "../style/color.ts";
import type { EvalContext, GeometryType } from "../style/expression.ts";
import type { StateLookup } from "../style/feature-state.ts";
import type { StyleLayer } from "../style/layer.ts";
import type { RenderPiece, TileManager } from "../tiles/manager.ts";
import type { Tile } from "../tiles/tile.ts";
import type { Anchor } from "../ui/anchor.ts";
import { anchorOffsets, anchorShift } from "../ui/anchor.ts";
import type { FontSpec, GlyphMetrics } from "./glyphs.ts";
import { cssFamily, GLYPH_SIZE, GlyphAtlas, needsWholeShaping, SDF_RADIUS, splitGraphemes } from "./glyphs.ts";
import { ICON_SDF_RADIUS, iconShader } from "./icon-shader.ts";
import { textShader } from "./shader.ts";

export interface SymbolLayerInput {
  layer: StyleLayer;
  manager: TileManager<VectorTile>;
  states: StateLookup | null;
}

interface Glyph {
  m: GlyphMetrics;
  x: number;
  y: number;
  line: number;
}

interface Laid {
  glyphs: Glyph[];
  width: number;
  height: number;
  lines: number[];
}

interface TextPlacement {
  anchor: Anchor;
  offsetX: number;
  offsetY: number;
  justify: number;
  boxes: number[];
}

interface IconPart {
  id: string;
  width: number;
  height: number;
  left: number;
  top: number;
  size: number;
  rotate: number;
  alignMap: boolean;
  alongLine: boolean;
  segment: number;
  color: RGBA;
  halo: RGBA;
  haloWidth: number;
  opacity: number;
  sdf: boolean;
  pixelRatio: number;
}

interface IconStyle {
  size: number;
  rotate: number;
  color: RGBA;
  halo: RGBA;
  haloWidth: number;
  opacity: number;
}

const EMPTY_LAID: Laid = { glyphs: [], width: 0, height: 0, lines: [] };
const JUSTIFY: Record<string, number> = { left: 0, center: 0.5, right: 1 };
const DEG = Math.PI / 180;

export interface LabelTerrain {
  height(x: number, y: number): number;
  hidden(x: number, y: number, z: number): boolean;
}

interface Label {
  key: string;
  dedupe: string;
  layer: StyleLayer;
  text: string;
  line: boolean;
  wx: number;
  wy: number;
  wz: number;
  path: Float64Array | null;
  heights: Float64Array | null;
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
  showText: boolean;
  icon: IconPart | null;
  anchor: Anchor;
  offsetX: number;
  offsetY: number;
  justify: number;
  rotate: number;
  haloBlur: number;
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
  readonly images = new ImageAtlas();
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
  private iconTexture: WebGLTexture | null = null;
  private iconVao: WebGLVertexArrayObject | null = null;
  private iconBuffer: WebGLBuffer | null = null;
  private iconData = new ArrayBuffer(STRIDE * 4 * 64);
  private iconCount = 0;
  private iconGeneration = -1;
  private readonly missing = new Set<string>();
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
    this.iconTexture = null;
    this.iconVao = null;
    this.iconBuffer = null;
    this.iconGeneration = -1;
  }

  destroy(): void {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteBuffer(this.vertexBuffer);
    this.gl.deleteBuffer(this.indexBuffer);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteTexture(this.iconTexture);
    this.gl.deleteBuffer(this.iconBuffer);
    this.gl.deleteVertexArray(this.iconVao);
    this.reset();
    this.labels.clear();
  }

  debugBoxes(): number[][] {
    const out: number[][] = [];
    for (const label of this.labels.values()) if (label.target === 1 && label.opacity > 0) out.push(label.boxes);
    return out;
  }

  takeMissing(): string[] {
    if (this.missing.size === 0) return [];
    const out = [...this.missing];
    this.missing.clear();
    return out;
  }

  update(
    transform: Transform,
    inputs: readonly SymbolLayerInput[],
    now: number,
    cameraVersion: number,
    pixelRatio: number,
    terrain: LabelTerrain | null = null,
  ): boolean {
    const parts: string[] = [`images:${this.images.version}`];
    for (const { layer, manager, states } of inputs) {
      parts.push(`${layer.id}:${layer.revision}:${layer.motion}:${states?.version ?? 0}`);
      for (const piece of manager.pieces) {
        if (piece.tile.data?.buckets.has(layer.id))
          parts.push(`${piece.tile.key}/${piece.tile.revision}/${piece.wrap}`);
      }
    }
    const structure = parts.join(",");
    const structureChanged = structure !== this.placedStructure;
    const cameraChanged = cameraVersion !== this.placedCamera;
    if (structureChanged || this.pendingGlyphs || (cameraChanged && now - this.lastPlacement >= PLACE_INTERVAL)) {
      this.place(transform, inputs, now, terrain);
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
    const icons = this.drawIcons(transform, pixelRatio);
    if (this.glyphCount === 0) return icons;
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
    return icons + 2;
  }

  private drawIcons(transform: Transform, pixelRatio: number): number {
    if (this.iconCount === 0) return 0;
    const g = this.gl;
    const gl = g.gl;
    this.syncIcons();
    const program = g.program(iconShader);
    g.use(program);
    g.setBlend("premultiplied");
    g.setDepth(false, false);
    g.bindTexture(0, this.iconTexture);
    gl.uniform1i(program.uniforms.get("u_atlas") ?? null, 0);
    gl.uniform2f(program.uniforms.get("u_viewport") ?? null, transform.width, transform.height);
    gl.uniform2f(program.uniforms.get("u_atlas_size") ?? null, this.images.width, this.images.height);
    gl.uniform1f(program.uniforms.get("u_pixel_ratio") ?? null, pixelRatio);
    gl.uniform1f(program.uniforms.get("u_radius") ?? null, ICON_SDF_RADIUS);
    gl.bindVertexArray(this.iconVao);
    for (const pass of [0, 1]) {
      gl.uniform1i(program.uniforms.get("u_pass") ?? null, pass);
      gl.drawElements(gl.TRIANGLES, this.iconCount * 6, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
    return 2;
  }

  private syncIcons(): void {
    const gl = this.gl.gl;
    const images = this.images;
    if (!this.iconTexture || this.iconGeneration !== images.generation) {
      if (!this.iconTexture) this.iconTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.iconTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, images.width, images.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, images.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.iconGeneration = images.generation;
      images.dirty = null;
      return;
    }
    if (images.dirty) {
      const { y0, y1 } = images.dirty;
      gl.bindTexture(gl.TEXTURE_2D, this.iconTexture);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        y0,
        images.width,
        y1 - y0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        images.data.subarray(y0 * images.width * 4, y1 * images.width * 4),
      );
      images.dirty = null;
    }
  }

  private iconPart(
    id: string,
    style: IconStyle,
    anchor: Anchor,
    offset: [number, number],
    alignMap: boolean,
    alongLine: boolean,
    segment: number,
    perspective: number,
  ): IconPart | null {
    const rect = this.images.get(id);
    if (!rect) {
      if (!this.images.has(id)) this.missing.add(id);
      return null;
    }
    const image = rect.image;
    const width = image.width / image.pixelRatio;
    const height = image.height / image.pixelRatio;
    const [sx, sy] = anchorShift(anchor);
    return {
      id,
      width,
      height,
      left: sx * width + offset[0],
      top: sy * height + offset[1],
      size: Math.max(0, style.size) * perspective,
      rotate: style.rotate * DEG,
      alignMap,
      alongLine,
      segment,
      color: style.color,
      halo: style.halo,
      haloWidth: style.haloWidth,
      opacity: style.opacity,
      sdf: image.sdf,
      pixelRatio: image.pixelRatio,
    };
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
    const lineHeight = GLYPH_SIZE * layer.fixed<number>("lineHeight");
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
      let pen = 0;
      const baseline = row * lineHeight + GLYPH_SIZE * 0.9 + (lineHeight - GLYPH_SIZE * 1.2) / 2;
      for (let i = l.start; i < l.end; i++) {
        const m = metrics[i];
        if (m && m.width > 0) glyphs.push({ m, x: pen, y: baseline, line: row });
        pen += (m?.advance ?? 0) + spacing;
      }
    });
    return { glyphs, width, height, lines: lines.map((l) => l.width) };
  }

  private textPlacement(
    layer: StyleLayer,
    laid: Laid,
    anchor: Anchor,
    scale: number,
    x: number,
    y: number,
    rotate: number,
    padding: number,
  ): TextPlacement {
    const variable = layer.fixed<Anchor[] | null>("variableAnchor");
    const radial = layer.fixed<number | null>("radialOffset");
    const [ox, oy] = layer.fixed<[number, number]>("offset");
    let dx = ox;
    let dy = oy;
    if (radial !== null) {
      [dx, dy] = anchorOffsets(radial)[anchor];
    } else if (variable) {
      const [sx, sy] = anchorShift(anchor);
      dx = sx === 0 ? Math.abs(ox) : sx === -1 ? -Math.abs(ox) : 0;
      dy = sy === 0 ? Math.abs(oy) : sy === -1 ? -Math.abs(oy) : 0;
    }
    const [sx, sy] = anchorShift(anchor);
    const offsetX = sx * laid.width + dx * GLYPH_SIZE;
    const offsetY = sy * laid.height + dy * GLYPH_SIZE;
    const mode = layer.fixed<string>("justify");
    const justify = mode === "auto" ? (sx === 0 ? 0 : sx === -1 ? 1 : 0.5) : (JUSTIFY[mode] ?? 0.5);
    const x0 = offsetX * scale;
    const y0 = offsetY * scale;
    const x1 = x0 + laid.width * scale;
    const y1 = y0 + laid.height * scale;
    let bx0 = x0;
    let by0 = y0;
    let bx1 = x1;
    let by1 = y1;
    if (rotate !== 0) {
      const cos = Math.cos(rotate);
      const sin = Math.sin(rotate);
      bx0 = Infinity;
      by0 = Infinity;
      bx1 = -Infinity;
      by1 = -Infinity;
      for (const [cx, cy] of [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ] as const) {
        const rx = cx * cos - cy * sin;
        const ry = cx * sin + cy * cos;
        bx0 = Math.min(bx0, rx);
        by0 = Math.min(by0, ry);
        bx1 = Math.max(bx1, rx);
        by1 = Math.max(by1, ry);
      }
    }
    return {
      anchor,
      offsetX,
      offsetY,
      justify,
      boxes: [x + bx0 - padding, y + by0 - padding, x + bx1 + padding, y + by1 + padding],
    };
  }

  private place(
    transform: Transform,
    inputs: readonly SymbolLayerInput[],
    now: number,
    terrain: LabelTerrain | null,
  ): void {
    const grid = new CollisionGrid(transform.width, transform.height);
    const placed = new Map<string, [number, number][]>();
    const visible = new Set<string>();
    const zoom = transform.zoom;
    const budget = { left: 40 };
    const images = this.images;
    const hasImage = (id: string) => images.has(id);
    this.pendingGlyphs = false;
    const ws = transform.worldSize;
    const margin = 64;
    const shown = new Set<string>();
    for (const label of this.labels.values()) if (label.target === 1) shown.add(label.dedupe);
    for (let li = inputs.length - 1; li >= 0; li--) {
      const { layer, manager, states } = inputs[li]!;
      if (!layer.isVisible(zoom)) continue;
      const allowOverlap = layer.fixed<boolean>("allowOverlap");
      const padding = layer.fixed<number>("padding");
      const spacing = layer.fixed<number>("spacing");
      const textOptional = layer.fixed<boolean>("optional");
      const iconAnchor = layer.fixed<Anchor>("iconAnchor");
      const iconOffset = layer.fixed<[number, number]>("iconOffset");
      const iconPadding = layer.fixed<number>("iconPadding");
      const iconAllowOverlap = layer.fixed<boolean>("iconAllowOverlap");
      const iconOptional = layer.fixed<boolean>("iconOptional");
      const alignment = layer.fixed<string>("iconRotationAlignment");
      const linePlacement = layer.fixed<string>("placement") !== "point";
      const alignMap = alignment === "map" || (alignment === "auto" && linePlacement);
      const ignoreText = layer.fixed<boolean>("ignorePlacement");
      const ignoreIcon = layer.fixed<boolean>("iconIgnorePlacement");
      const maxAngle = (layer.fixed<number>("maxAngle") * Math.PI) / 180;
      const keepUpright = layer.fixed<boolean>("keepUpright");
      const fixedAnchor = layer.fixed<Anchor>("anchor");
      const variable = layer.fixed<Anchor[] | null>("variableAnchor");
      const [textShiftX, textShiftY] = screenShift(
        layer.fixed<[number, number]>("translate"),
        layer.fixed<string>("translateAnchor"),
        transform.bearing,
      );
      const [iconShiftX, iconShiftY] = screenShift(
        layer.fixed<[number, number]>("iconTranslate"),
        layer.fixed<string>("iconTranslateAnchor"),
        transform.bearing,
      );
      const ctx: EvalContext = { zoom, images: hasImage };
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
          const was = shown.has(`${layer.id}|${labels.texts[i]}|${labels.icons?.[i] ?? ""}`) ? 0 : 1;
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
        const dedupeKey = `${layer.id}|${text}|${labels.icons?.[i] ?? ""}`;
        let featureReady = false;
        let iconId = "";
        let iconStyle: IconStyle | null = null;
        for (let a = 0; a < anchors.length; a += 3) {
          const tx = anchors[a]! / extent;
          const ty = anchors[a + 1]! / extent;
          if (tx < clip.x0 || tx >= clip.x1 || ty < clip.y0 || ty >= clip.y1) continue;
          const wx = piece.wrap + (tile.x + tx) / n;
          const wy = (tile.y + ty) / n;
          const wz = terrain ? terrain.height(wx, wy) : 0;
          const p = transform.project(wx, wy, wz * ws);
          const depth = p.w / transform.cameraToCenterDistance;
          if (p.w <= 0 || depth > 2.2) continue;
          if (p.x < -margin || p.y < -margin || p.x > transform.width + margin || p.y > transform.height + margin)
            continue;
          if (terrain?.hidden(wx, wy, wz)) continue;
          const laid = text ? this.layout(layer, text, isLine, budget) : EMPTY_LAID;
          if (!laid) continue;
          if (!featureReady) {
            ctx.feature = {
              properties: bucket.features.fill(fi, scratch),
              id: bucket.features.idValue(fi),
              geometryType: GEOMETRY[bucket.features.type(fi)] ?? "Unknown",
            };
            ctx.state = featureId !== undefined ? states?.get(featureId) : undefined;
            featureReady = true;
            const icon = layer.layoutValue<unknown>("icon", ctx);
            iconId = typeof icon === "string" ? icon : "";
            if (iconId) {
              iconStyle = {
                size: layer.layoutValue<number>("iconSize", ctx),
                rotate: layer.layoutValue<number>("iconRotate", ctx),
                color: layer.paintValue<RGBA>("iconColor", ctx),
                halo: layer.paintValue<RGBA>("iconHaloColor", ctx),
                haloWidth: layer.paintValue<number>("iconHaloWidth", ctx),
                opacity: layer.paintValue<number>("iconOpacity", ctx),
              };
            }
          }
          const perspective = Math.max(0.7, Math.min(1, 1.3 - 0.3 * depth));
          const anchorDist = anchors[a + 2]! / extent / n;
          const icon =
            iconId && iconStyle
              ? this.iconPart(
                  iconId,
                  iconStyle,
                  iconAnchor,
                  iconOffset,
                  alignMap,
                  isLine,
                  isLine ? segmentAt(pathData, anchors[a + 2]!) : 0,
                  perspective,
                )
              : null;
          if (!text && !icon) continue;
          const size = layer.layoutValue<number>("size", ctx);
          const scale = (size / GLYPH_SIZE) * perspective;
          const w = laid.width * scale;
          const rotate = isLine ? 0 : (layer.layoutValue<number>("rotate", ctx) * Math.PI) / 180;
          const minDist = isLine ? Math.max(spacing, w * 1.5) : Math.max(80, w * 1.2);
          const key = `${dedupeKey}|${featureId ?? ""}|${Math.round((wx * ws) / 4)}|${Math.round((wy * ws) / 4)}`;
          const existing = this.labels.get(key);
          const prior = text ? placed.get(dedupeKey) : undefined;
          if (prior?.some(([x, y]) => Math.hypot(x - p.x, y - p.y) < minDist)) continue;
          let path: Float64Array | null = null;
          let heights: Float64Array | null = null;
          let boxes: number[] = [];
          if (isLine && pathData.length >= 4) {
            path = new Float64Array(pathData.length);
            for (let k = 0; k < pathData.length; k += 2) {
              path[k] = piece.wrap + (tile.x + pathData[k]! / extent) / n;
              path[k + 1] = (tile.y + pathData[k + 1]! / extent) / n;
            }
            if (terrain) {
              heights = new Float64Array(path.length / 2);
              for (let k = 0; k < heights.length; k++) heights[k] = terrain.height(path[k * 2]!, path[k * 2 + 1]!);
            }
            if (text) {
              const quads = layoutAlongPath(transform, path, anchorDist, laid, scale, heights, maxAngle, keepUpright);
              if (!quads) continue;
              for (const q of quads) {
                const half = (size * 0.6) / 2 + padding;
                boxes.push(
                  q.cx + textShiftX - half,
                  q.cy + textShiftY - half,
                  q.cx + textShiftX + half,
                  q.cy + textShiftY + half,
                );
              }
            }
          }
          let chosen: TextPlacement | null = null;
          let textHit = false;
          if (text && !isLine) {
            const tries = variable && variable.length > 0 ? preferred(variable, existing?.anchor) : [fixedAnchor];
            for (const anchor of tries) {
              const candidate = this.textPlacement(
                layer,
                laid,
                anchor,
                scale,
                p.x + textShiftX,
                p.y + textShiftY,
                rotate,
                padding,
              );
              if (allowOverlap || !gridHits(grid, candidate.boxes)) {
                chosen = candidate;
                break;
              }
            }
            if (!chosen) {
              textHit = true;
              chosen = this.textPlacement(
                layer,
                laid,
                tries[0]!,
                scale,
                p.x + textShiftX,
                p.y + textShiftY,
                rotate,
                padding,
              );
            }
            boxes = chosen.boxes;
          } else if (text) {
            textHit = !allowOverlap && gridHits(grid, boxes);
          }
          const iconBox = icon
            ? iconBounds(transform, icon, p.x + iconShiftX, p.y + iconShiftY, path, heights, iconPadding)
            : null;
          let showText = text.length > 0;
          let showIcon = icon !== null;
          const iconHit = iconBox !== null && !iconAllowOverlap && gridHits(grid, iconBox);
          if (showText && showIcon) {
            if (textHit && iconHit) continue;
            if (textHit) {
              if (!textOptional) continue;
              showText = false;
            }
            if (iconHit) {
              if (!iconOptional) continue;
              showIcon = false;
            }
          } else if (textHit || iconHit) {
            continue;
          }
          if (!showText) boxes = [];
          if (showText && !ignoreText) {
            for (let i = 0; i < boxes.length; i += 4)
              grid.insert(boxes[i]!, boxes[i + 1]!, boxes[i + 2]!, boxes[i + 3]!);
          }
          if (showIcon && iconBox) {
            if (!ignoreIcon) grid.insert(iconBox[0]!, iconBox[1]!, iconBox[2]!, iconBox[3]!);
            boxes.push(...iconBox);
          }
          if (showText) {
            if (prior) prior.push([p.x, p.y]);
            else placed.set(dedupeKey, [[p.x, p.y]]);
          }
          visible.add(key);
          const color = layer.paintValue<RGBA>("color", ctx);
          const halo = layer.paintValue<RGBA>("haloColor", ctx);
          const haloWidth = layer.paintValue<number>("haloWidth", ctx);
          const haloBlur = Math.max(0, layer.paintValue<number>("haloBlur", ctx));
          const opacity = layer.paintValue<number>("opacity", ctx);
          const place = chosen ?? { anchor: fixedAnchor, offsetX: 0, offsetY: 0, justify: 0.5, boxes: [] };
          if (existing) {
            existing.wx = wx;
            existing.wy = wy;
            existing.wz = wz;
            existing.path = path;
            existing.heights = heights;
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
            existing.showText = showText;
            existing.icon = showIcon ? icon : null;
            existing.anchor = place.anchor;
            existing.offsetX = place.offsetX;
            existing.offsetY = place.offsetY;
            existing.justify = place.justify;
            existing.rotate = rotate;
            existing.haloBlur = haloBlur;
          } else {
            this.labels.set(key, {
              key,
              dedupe: dedupeKey,
              layer,
              text,
              line: isLine,
              wx,
              wy,
              wz,
              path,
              heights,
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
              showText,
              icon: showIcon ? icon : null,
              anchor: place.anchor,
              offsetX: place.offsetX,
              offsetY: place.offsetY,
              justify: place.justify,
              rotate,
              haloBlur,
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
    this.buildIcons(transform, pixelRatio);
    let glyphs = 0;
    for (const label of this.labels.values()) {
      if (label.opacity > 0 && label.showText) glyphs += label.laid.glyphs.length;
    }
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
      f32[o / 4 + 8] = label.haloBlur;
      v++;
    };
    for (const label of this.labels.values()) {
      if (label.opacity <= 0 || !label.showText) continue;
      const s = label.scale;
      if (label.line && label.path) {
        const quads = layoutAlongPath(transform, label.path, label.anchorDist, label.laid, s, label.heights);
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
      const p = transform.project(label.wx, label.wy, label.wz * transform.worldSize);
      if (p.w <= 0) continue;
      visible++;
      const layer = label.layer;
      const [shiftX, shiftY] = screenShift(
        layer.fixed<[number, number]>("translate"),
        layer.fixed<string>("translateAnchor"),
        transform.bearing,
      );
      const laid = label.laid;
      const originX = p.x + shiftX;
      const originY = p.y + shiftY;
      const rotate = label.rotate;
      const cos = Math.cos(rotate);
      const sin = Math.sin(rotate);
      const ax = rotate === 0 ? Math.round((originX + label.offsetX * s) * pixelRatio) / pixelRatio : 0;
      const ay = rotate === 0 ? Math.round((originY + label.offsetY * s) * pixelRatio) / pixelRatio : 0;
      for (const glyph of laid.glyphs) {
        const m = glyph.m;
        const gx = glyph.x + (laid.width - (laid.lines[glyph.line] ?? laid.width)) * label.justify;
        const lx0 = (gx + m.left) * s;
        const ly0 = (glyph.y + m.top) * s;
        const lx1 = lx0 + m.width * s;
        const ly1 = ly0 + m.height * s;
        if (rotate === 0) {
          put(ax + lx0, ay + ly0, m.x, m.y, label);
          put(ax + lx1, ay + ly0, m.x + m.width, m.y, label);
          put(ax + lx1, ay + ly1, m.x + m.width, m.y + m.height, label);
          put(ax + lx0, ay + ly1, m.x, m.y + m.height, label);
          continue;
        }
        const bx = label.offsetX * s;
        const by = label.offsetY * s;
        for (const [cx, cy, u, w] of [
          [lx0, ly0, m.x, m.y],
          [lx1, ly0, m.x + m.width, m.y],
          [lx1, ly1, m.x + m.width, m.y + m.height],
          [lx0, ly1, m.x, m.y + m.height],
        ] as const) {
          const x = bx + cx;
          const y = by + cy;
          put(originX + x * cos - y * sin, originY + x * sin + y * cos, u, w, label);
        }
      }
    }
    this.visibleCount = visible;
    this.glyphCount = v / 4;
    this.upload();
  }

  private buildIcons(transform: Transform, pixelRatio: number): void {
    let count = 0;
    for (const label of this.labels.values()) if (label.opacity > 0 && label.icon) count++;
    const needed = count * 4 * STRIDE;
    if (this.iconData.byteLength < needed)
      this.iconData = new ArrayBuffer(Math.max(needed, this.iconData.byteLength * 2));
    const f32 = new Float32Array(this.iconData);
    const u16 = new Uint16Array(this.iconData);
    const u8 = new Uint8Array(this.iconData);
    const ws = transform.worldSize;
    let v = 0;
    for (const label of this.labels.values()) {
      const icon = label.icon;
      if (!icon || label.opacity <= 0) continue;
      const rect = this.images.get(icon.id);
      if (!rect) continue;
      const p = transform.project(label.wx, label.wy, label.wz * ws);
      if (p.w <= 0) continue;
      const angle = iconAngle(transform, icon, label.path, label.heights);
      const s = icon.size;
      const x0 = icon.left * s;
      const y0 = icon.top * s;
      const x1 = x0 + icon.width * s;
      const y1 = y0 + icon.height * s;
      const u0 = rect.x;
      const v0 = rect.y;
      const u1 = rect.x + rect.image.width;
      const v1 = rect.y + rect.image.height;
      let px = p.x;
      let py = p.y;
      if (angle === 0) {
        px = Math.round((p.x + x0) * pixelRatio) / pixelRatio - x0;
        py = Math.round((p.y + y0) * pixelRatio) / pixelRatio - y0;
      }
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const c = icon.color;
      const h = icon.halo;
      const opacity = label.opacity * Math.max(0, Math.min(1, icon.opacity));
      for (const [dx, dy, u, w] of [
        [x0, y0, u0, v0],
        [x1, y0, u1, v0],
        [x1, y1, u1, v1],
        [x0, y1, u0, v1],
      ] as const) {
        const o = v * STRIDE;
        f32[o / 4] = px + dx * cos - dy * sin;
        f32[o / 4 + 1] = py + dx * sin + dy * cos;
        u16[o / 2 + 4] = u;
        u16[o / 2 + 5] = w;
        u8[o + 12] = c[0] * c[3] * 255;
        u8[o + 13] = c[1] * c[3] * 255;
        u8[o + 14] = c[2] * c[3] * 255;
        u8[o + 15] = c[3] * 255;
        u8[o + 16] = h[0] * h[3] * 255;
        u8[o + 17] = h[1] * h[3] * 255;
        u8[o + 18] = h[2] * h[3] * 255;
        u8[o + 19] = h[3] * 255;
        f32[o / 4 + 5] = opacity;
        f32[o / 4 + 6] = s / icon.pixelRatio;
        f32[o / 4 + 7] = icon.haloWidth;
        f32[o / 4 + 8] = icon.sdf ? 1 : 0;
        v++;
      }
    }
    this.iconCount = v / 4;
    this.uploadIcons();
  }

  private uploadIcons(): void {
    const g = this.gl;
    const gl = g.gl;
    if (g.isLost || this.iconCount === 0) return;
    this.ensureIndices(this.iconCount);
    if (!this.iconVao) {
      this.iconVao = gl.createVertexArray();
      this.iconBuffer = gl.createBuffer();
      gl.bindVertexArray(this.iconVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.iconBuffer);
      describeVertices(gl);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.bindVertexArray(null);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.iconBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(this.iconData, 0, this.iconCount * 4 * STRIDE), gl.DYNAMIC_DRAW);
  }

  private ensureIndices(quads: number): void {
    const gl = this.gl.gl;
    if (!this.indexBuffer) this.indexBuffer = gl.createBuffer();
    if (quads <= this.indexCapacity) return;
    const capacity = Math.max(1024, quads * 2);
    const indices = new Uint32Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      const b = i * 4;
      indices.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.indexCapacity = capacity;
  }

  private upload(): void {
    const g = this.gl;
    const gl = g.gl;
    if (g.isLost) return;
    this.ensureIndices(this.glyphCount);
    if (!this.vao) {
      this.vao = gl.createVertexArray();
      this.vertexBuffer = gl.createBuffer();
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      describeVertices(gl);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.bindVertexArray(null);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(this.vertexData, 0, this.glyphCount * 4 * STRIDE), gl.DYNAMIC_DRAW);
  }
}

function describeVertices(gl: WebGL2RenderingContext): void {
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
}

function preferred(anchors: readonly Anchor[], previous: Anchor | undefined): Anchor[] {
  if (!previous || !anchors.includes(previous) || anchors[0] === previous) return [...anchors];
  return [previous, ...anchors.filter((a) => a !== previous)];
}

function screenShift(translate: [number, number] | undefined, anchor: string, bearing: number): [number, number] {
  const [x, y] = translate ?? [0, 0];
  if ((x === 0 && y === 0) || anchor === "viewport" || bearing === 0) return [x, y];
  const b = (-bearing * Math.PI) / 180;
  const cos = Math.cos(b);
  const sin = Math.sin(b);
  return [x * cos - y * sin, x * sin + y * cos];
}

function gridHits(grid: CollisionGrid, boxes: readonly number[]): boolean {
  for (let i = 0; i < boxes.length; i += 4) {
    if (grid.hits(boxes[i]!, boxes[i + 1]!, boxes[i + 2]!, boxes[i + 3]!)) return true;
  }
  return false;
}

function segmentAt(path: Int32Array, distance: number): number {
  let remaining = distance;
  for (let i = 0; i + 3 < path.length; i += 2) {
    const len = Math.hypot(path[i + 2]! - path[i]!, path[i + 3]! - path[i + 1]!);
    if (remaining <= len) return i / 2;
    remaining -= len;
  }
  return Math.max(0, path.length / 2 - 2);
}

function iconAngle(
  transform: Transform,
  icon: IconPart,
  path: Float64Array | null,
  heights: Float64Array | null,
): number {
  if (icon.alongLine && icon.alignMap && path && path.length >= 4) {
    const i = Math.min(icon.segment, path.length / 2 - 2);
    const ws = transform.worldSize;
    const a = transform.project(path[i * 2]!, path[i * 2 + 1]!, (heights?.[i] ?? 0) * ws);
    const b = transform.project(path[i * 2 + 2]!, path[i * 2 + 3]!, (heights?.[i + 1] ?? 0) * ws);
    if (a.w > 0 && b.w > 0) return icon.rotate + Math.atan2(b.y - a.y, b.x - a.x);
  }
  if (icon.alignMap) return icon.rotate - transform.bearing * DEG;
  return icon.rotate;
}

function iconBounds(
  transform: Transform,
  icon: IconPart,
  x: number,
  y: number,
  path: Float64Array | null,
  heights: Float64Array | null,
  padding: number,
): number[] {
  const angle = iconAngle(transform, icon, path, heights);
  const s = icon.size;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [dx, dy] of [
    [icon.left, icon.top],
    [icon.left + icon.width, icon.top],
    [icon.left + icon.width, icon.top + icon.height],
    [icon.left, icon.top + icon.height],
  ] as const) {
    const px = x + (dx * cos - dy * sin) * s;
    const py = y + (dx * sin + dy * cos) * s;
    x0 = Math.min(x0, px);
    y0 = Math.min(y0, py);
    x1 = Math.max(x1, px);
    y1 = Math.max(y1, py);
  }
  return [x0 - padding, y0 - padding, x1 + padding, y1 + padding];
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
  heights: Float64Array | null,
  maxAngle = Math.PI / 4,
  keepUpright = true,
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
  const ws = transform.worldSize;
  const width = laid.width * scale;
  const project = (i: number): [number, number] | null => {
    const p = transform.project(path[i * 2]!, path[i * 2 + 1]!, (heights?.[i] ?? 0) * ws);
    return p.w > 0 ? [p.x, p.y] : null;
  };
  const first = project(anchorSeg);
  const second = project(anchorSeg + 1);
  if (!first || !second) return null;
  const before: [number, number][] = [first];
  const after: [number, number][] = [second];
  const span = Math.hypot(second[0] - first[0], second[1] - first[1]);
  let reach = span * anchorT;
  for (let i = anchorSeg - 1; i >= 0 && reach < width; i--) {
    const p = project(i);
    if (!p) break;
    const q = before[before.length - 1]!;
    reach += Math.hypot(p[0] - q[0], p[1] - q[1]);
    before.push(p);
  }
  reach = span * (1 - anchorT);
  for (let i = anchorSeg + 2; i < n && reach < width; i++) {
    const p = project(i);
    if (!p) break;
    const q = after[after.length - 1]!;
    reach += Math.hypot(p[0] - q[0], p[1] - q[1]);
    after.push(p);
  }
  const screen: number[] = [];
  for (let k = before.length - 1; k >= 0; k--) screen.push(before[k]![0], before[k]![1]);
  for (const p of after) screen.push(p[0], p[1]);
  const m = screen.length / 2;
  const local = before.length - 1;
  const cum: number[] = [0];
  for (let i = 1; i < m; i++)
    cum.push(cum[i - 1]! + Math.hypot(screen[i * 2]! - screen[i * 2 - 2]!, screen[i * 2 + 1]! - screen[i * 2 - 1]!));
  const total = cum[m - 1]!;
  const anchorAt = cum[local]! + (cum[local + 1]! - cum[local]!) * anchorT;
  if (width > total) return null;
  let start = anchorAt - width / 2;
  if (start < 0) start = 0;
  if (start + width > total) start = total - width;
  const pointAt = (d: number): [number, number, number] => {
    let i = 0;
    while (i < m - 2 && cum[i + 1]! < d) i++;
    const seg = cum[i + 1]! - cum[i]!;
    const t = seg > 0 ? (d - cum[i]!) / seg : 0;
    const ax = screen[i * 2]!;
    const ay = screen[i * 2 + 1]!;
    const bx = screen[i * 2 + 2]!;
    const by = screen[i * 2 + 3]!;
    return [ax + (bx - ax) * t, ay + (by - ay) * t, Math.atan2(by - ay, bx - ax)];
  };
  const mid = pointAt(start + width / 2);
  const flip = keepUpright && Math.cos(mid[2]) < 0;
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
      if (diff > maxAngle) return null;
    }
    lastAngle = angle;
    out.push({ glyph: g, cx, cy, angle, advance });
  }
  return out;
}
