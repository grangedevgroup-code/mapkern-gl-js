import type { Transform } from "../camera/transform.ts";
import type { GL } from "../render/gl.ts";
import type { ImageRect } from "../render/images.ts";
import { ImageAtlas } from "../render/images.ts";
import type { VectorBucket, VectorTile } from "../sources/vector.ts";
import type { RGBA } from "../style/color.ts";
import type { EvalContext, GeometryType } from "../style/expression.ts";
import type { StateLookup } from "../style/feature-state.ts";
import type { StyleLayer } from "../style/layer.ts";
import type { RenderPiece, TileManager } from "../tiles/manager.ts";
import type { Tile } from "../tiles/tile.ts";
import type { Anchor } from "../ui/anchor.ts";
import { anchorOffsets, anchorShift, isAnchor } from "../ui/anchor.ts";
import type { GlyphLoader } from "./glyph-server.ts";
import { fromServer, GlyphServer } from "./glyph-server.ts";
import type { FontSpec, GlyphMetrics } from "./glyphs.ts";
import {
  cssFamily,
  fontFromNames,
  GLYPH_SIZE,
  GlyphAtlas,
  needsWholeShaping,
  SDF_RADIUS,
  splitGraphemes,
} from "./glyphs.ts";
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
  slices: IconSlice[] | null;
  box: [number, number, number, number] | null;
}

interface IconSlice {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
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
  ground: boolean;
  size: number;
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
const PLACE_BUDGET = 3;
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
  private seenCamera = -1;
  private job: {
    steps: Generator<undefined, void, undefined>;
    structure: string;
    camera: number;
    layers: StyleLayer[];
  } | null = null;
  private texture: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private indexCapacity = 0;
  private vertexData = new ArrayBuffer(STRIDE * 4 * 256);
  private glyphCount = 0;
  private atlasGeneration = -1;
  private pendingGlyphs = false;
  private reflow = false;
  private server: GlyphServer | null = null;
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
    this.server?.destroy();
    this.server = null;
    this.gl.deleteTexture(this.texture);
    this.gl.deleteBuffer(this.vertexBuffer);
    this.gl.deleteBuffer(this.indexBuffer);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteTexture(this.iconTexture);
    this.gl.deleteBuffer(this.iconBuffer);
    this.gl.deleteVertexArray(this.iconVao);
    this.reset();
    this.labels.clear();
    this.job = null;
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
    const moving = cameraVersion !== this.seenCamera;
    this.seenCamera = cameraVersion;
    if (
      this.job &&
      (this.job.layers.length !== inputs.length || inputs.some((input, i) => input.layer !== this.job!.layers[i]))
    )
      this.job = null;
    if (
      !this.job &&
      (structure !== this.placedStructure ||
        this.pendingGlyphs ||
        this.reflow ||
        (cameraVersion !== this.placedCamera && now - this.lastPlacement >= PLACE_INTERVAL))
    ) {
      this.reflow = false;
      this.job = {
        steps: this.placement(transform.clone(), inputs, now, terrain),
        structure,
        camera: cameraVersion,
        layers: inputs.map((input) => input.layer),
      };
      this.lastPlacement = now;
    }
    const job = this.job;
    if (job) {
      const stop = moving ? performance.now() + PLACE_BUDGET : Number.POSITIVE_INFINITY;
      let done = false;
      for (;;) {
        if (job.steps.next().done) {
          done = true;
          break;
        }
        if (performance.now() >= stop) break;
      }
      if (done) {
        this.job = null;
        this.placedStructure = job.structure;
        this.placedCamera = job.camera;
      }
    }
    let animating = cameraVersion !== this.placedCamera || this.pendingGlyphs || this.job !== null;
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

  imageTexture(): WebGLTexture | null {
    this.syncIcons();
    return this.iconTexture;
  }

  markMissing(id: string): void {
    if (!this.images.has(id)) this.missing.add(id);
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
      slices: null,
      box: null,
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

  get glyphsLoading(): boolean {
    return this.server?.loading ?? false;
  }

  setGlyphs(template: string | null, load: GlyphLoader, arrived: () => void): void {
    if (this.server?.template === template) return;
    this.server?.destroy();
    this.server = template
      ? new GlyphServer(template, load, () => {
          this.reflow = true;
          arrived();
        })
      : null;
    this.layoutCache.clear();
    this.reflow = true;
  }

  private font(layer: StyleLayer, ctx: EvalContext): FontSpec {
    const value = layer.layoutValue<unknown>("font", ctx);
    const names =
      Array.isArray(value) && value.every((f) => typeof f === "string") ? (value as string[]) : ["sans-serif"];
    const layout = (layer.spec as { layout?: Record<string, unknown> }).layout ?? {};
    if (!this.server) {
      return {
        family: cssFamily(names),
        weight: layer.layoutValue<unknown>("weight", ctx) === "bold" ? "700" : "400",
        italic: layer.layoutValue<unknown>("italic", ctx) === true,
      };
    }
    const derived = fontFromNames(names);
    const bold = layout.weight !== undefined ? layer.layoutValue<unknown>("weight", ctx) === "bold" : derived.bold;
    const italic = layout.italic !== undefined ? layer.layoutValue<unknown>("italic", ctx) === true : derived.italic;
    return { family: cssFamily(derived.families), weight: bold ? "700" : "400", italic, stack: names.join(",") };
  }

  private layoutCache = new Map<string, Laid>();
  private layoutGeneration = -1;

  private layout(
    layer: StyleLayer,
    text: string,
    line: boolean,
    budget: { left: number },
    shape: TextShape,
  ): Laid | null {
    if (this.layoutGeneration !== this.atlas.generation || this.layoutCache.size > 6000) {
      this.layoutCache.clear();
      this.layoutGeneration = this.atlas.generation;
    }
    const { font } = shape;
    const cacheKey = `${layer.id}#${layer.revision}#${line ? 1 : 0}#${shape.letterSpacing}#${shape.lineHeight}#${shape.maxWidth}#${font.family}#${font.weight}#${font.italic}#${font.stack ?? ""}#${text}`;
    const cached = this.layoutCache.get(cacheKey);
    if (cached) return cached;
    const laid = this.computeLayout(line ? text.replace(/\n/g, " ") : text, line, budget, shape);
    if (laid) this.layoutCache.set(cacheKey, laid);
    return laid;
  }

  private computeLayout(text: string, line: boolean, budget: { left: number }, shape: TextShape): Laid | null {
    const font = shape.font;
    const whole = needsWholeShaping(text);
    if (whole && line) return null;
    const units = whole
      ? text.split("\n").flatMap((part, i) => (i === 0 ? [part] : ["\n", part]))
      : splitGraphemes(text);
    const glyphs: Glyph[] = [];
    const spacing = shape.letterSpacing * GLYPH_SIZE;
    const metrics: (GlyphMetrics | null)[] = [];
    for (const u of units) {
      if (u === "\n") {
        metrics.push(null);
        continue;
      }
      if (font.stack && this.server && !whole && fromServer(u)) {
        const glyph = this.server.glyph(font.stack, u.codePointAt(0)!);
        if (glyph === undefined) return null;
        if (glyph !== null) {
          metrics.push(this.atlas.server(font.stack, u, glyph));
          continue;
        }
      }
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
    const lineHeight = GLYPH_SIZE * shape.lineHeight;
    const maxWidth = line ? Number.POSITIVE_INFINITY : shape.maxWidth * GLYPH_SIZE;
    const lines: { start: number; end: number; width: number }[] = [];
    let start = 0;
    let x = 0;
    let lastBreak = -1;
    let widthAtBreak = 0;
    for (let i = 0; i < units.length; i++) {
      if (units[i] === "\n") {
        lines.push({ start, end: i, width: x });
        start = i + 1;
        x = 0;
        lastBreak = -1;
        continue;
      }
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
    laid: Laid,
    anchor: Anchor,
    scale: number,
    x: number,
    y: number,
    rotate: number,
    padding: number,
    style: TextStyle,
  ): TextPlacement {
    const { variable, radial } = style;
    const [ox, oy] = style.offset;
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
    const mode = style.justify;
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

  private *placement(
    transform: Transform,
    inputs: readonly SymbolLayerInput[],
    now: number,
    terrain: LabelTerrain | null,
  ): Generator<undefined, void, undefined> {
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
      const at: EvalContext = { zoom };
      const allowOverlap = layer.layoutValue<unknown>("allowOverlap", at) === true;
      const padding = numberOr(layer.layoutValue<unknown>("padding", at), 2);
      const spacing = numberOr(layer.layoutValue<unknown>("spacing", at), 250);
      const textOptional = layer.layoutValue<unknown>("optional", at) === true;
      const iconPadding = numberOr(layer.layoutValue<unknown>("iconPadding", at), 2);
      const iconAllowOverlap = layer.layoutValue<unknown>("iconAllowOverlap", at) === true;
      const iconOptional = layer.layoutValue<unknown>("iconOptional", at) === true;
      const alignment = layer.layoutValue<unknown>("iconRotationAlignment", at);
      const textAlignment = layer.layoutValue<unknown>("rotationAlignment", at);
      const textFit = layer.layoutValue<unknown>("iconTextFit", at);
      const fitPadding = layer.layoutValue<unknown>("iconTextFitPadding", at);
      const pitchAlignment = layer.layoutValue<unknown>("pitchAlignment", at);
      const ignoreText = layer.layoutValue<unknown>("ignorePlacement", at) === true;
      const ignoreIcon = layer.layoutValue<unknown>("iconIgnorePlacement", at) === true;
      const maxAngle = (numberOr(layer.layoutValue<unknown>("maxAngle", at), 45) * Math.PI) / 180;
      const keepUpright = layer.layoutValue<unknown>("keepUpright", at) !== false;
      const lineHeight = numberOr(layer.layoutValue<unknown>("lineHeight", at), 1.2);
      const variable = layer.fixed<Anchor[] | null>("variableAnchor");
      const [textShiftX, textShiftY] = screenShift(
        pairOr(layer.paintValue<unknown>("translate", at)),
        layer.fixed<string>("translateAnchor"),
        transform.bearing,
      );
      const [iconShiftX, iconShiftY] = screenShift(
        pairOr(layer.paintValue<unknown>("iconTranslate", at)),
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
        const alignMap = alignment === "map" || (alignment !== "viewport" && isLine);
        const followLine = isLine && textAlignment !== "viewport";
        const ground = followLine && pitchAlignment !== "viewport";
        let featureReady = false;
        let iconId = "";
        let iconStyle: IconStyle | null = null;
        let fixedAnchor: Anchor = "center";
        let iconAnchor: Anchor = "center";
        let iconOffset: [number, number] = [0, 0];
        let textStyle: TextStyle = { variable, radial: null, offset: [0, 0], justify: "center" };
        let shape: TextShape = { letterSpacing: 0, lineHeight, maxWidth: 10, font: this.font(layer, at) };
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
          if (!featureReady) {
            ctx.feature = {
              properties: bucket.features.fill(fi, scratch),
              id: bucket.features.idValue(fi),
              geometryType: GEOMETRY[bucket.features.type(fi)] ?? "Unknown",
            };
            ctx.state = featureId !== undefined ? states?.get(featureId) : undefined;
            featureReady = true;
            fixedAnchor = anchorOr(layer.layoutValue<unknown>("anchor", ctx));
            iconAnchor = anchorOr(layer.layoutValue<unknown>("iconAnchor", ctx));
            iconOffset = pairOr(layer.layoutValue<unknown>("iconOffset", ctx));
            const radial = layer.layoutValue<unknown>("radialOffset", ctx);
            const justify = layer.layoutValue<unknown>("justify", ctx);
            textStyle = {
              variable,
              radial: typeof radial === "number" && Number.isFinite(radial) ? radial : null,
              offset: pairOr(layer.layoutValue<unknown>("offset", ctx)),
              justify: typeof justify === "string" && justify in JUSTIFY_MODES ? justify : "center",
            };
            shape = {
              letterSpacing: numberOr(layer.layoutValue<unknown>("letterSpacing", ctx), 0),
              lineHeight,
              maxWidth: numberOr(layer.layoutValue<unknown>("maxWidth", ctx), 10),
              font: this.font(layer, ctx),
            };
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
          const laid = text ? this.layout(layer, text, followLine, budget, shape) : EMPTY_LAID;
          if (!laid) continue;
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
          const rotate = followLine ? 0 : (layer.layoutValue<number>("rotate", ctx) * Math.PI) / 180;
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
            if (text && followLine && ground) {
              const fits = layoutOnGround(
                transform,
                path,
                anchorDist,
                laid,
                size,
                heights,
                maxAngle,
                keepUpright,
                (_g, c) => {
                  boxes.push(
                    Math.min(c[0]!, c[2]!, c[4]!, c[6]!) + textShiftX - padding,
                    Math.min(c[1]!, c[3]!, c[5]!, c[7]!) + textShiftY - padding,
                    Math.max(c[0]!, c[2]!, c[4]!, c[6]!) + textShiftX + padding,
                    Math.max(c[1]!, c[3]!, c[5]!, c[7]!) + textShiftY + padding,
                  );
                },
              );
              if (!fits) continue;
            } else if (text && followLine) {
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
          if (text && !followLine) {
            const tries = variable && variable.length > 0 ? preferred(variable, existing?.anchor) : [fixedAnchor];
            for (const anchor of tries) {
              const candidate = this.textPlacement(
                laid,
                anchor,
                scale,
                p.x + textShiftX,
                p.y + textShiftY,
                rotate,
                padding,
                textStyle,
              );
              if (allowOverlap || !gridHits(grid, candidate.boxes)) {
                chosen = candidate;
                break;
              }
            }
            if (!chosen) {
              textHit = true;
              chosen = this.textPlacement(
                laid,
                tries[0]!,
                scale,
                p.x + textShiftX,
                p.y + textShiftY,
                rotate,
                padding,
                textStyle,
              );
            }
            boxes = chosen.boxes;
          } else if (text) {
            textHit = !allowOverlap && gridHits(grid, boxes);
          }
          if (icon && text && !followLine && (textFit === "width" || textFit === "height" || textFit === "both")) {
            const at = chosen ?? { offsetX: 0, offsetY: 0 };
            const rect = this.images.get(icon.id);
            if (rect) {
              fitIcon(
                icon,
                rect,
                textFit,
                quadOr(fitPadding),
                [
                  at.offsetX * scale,
                  at.offsetY * scale,
                  (at.offsetX + laid.width) * scale,
                  (at.offsetY + laid.height) * scale,
                ],
                [iconOffset[0] * icon.size, iconOffset[1] * icon.size],
              );
            }
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
            existing.line = followLine;
            existing.path = path;
            existing.heights = heights;
            existing.anchorDist = anchors[a + 2]! / extent / n;
            existing.laid = laid;
            existing.scale = scale;
            existing.ground = ground;
            existing.size = size;
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
              line: followLine,
              wx,
              wy,
              wz,
              path,
              heights,
              anchorDist: anchors[a + 2]! / extent / n,
              laid,
              scale,
              ground,
              size,
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
        yield;
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
    const put = (x: number, y: number, u: number, w: number, label: Label, scale = label.scale) => {
      const o = v * STRIDE;
      f32[o / 4] = x;
      f32[o / 4 + 1] = y;
      u16[o / 2 + 4] = Math.round(u * 4);
      u16[o / 2 + 5] = Math.round(w * 4);
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
      f32[o / 4 + 6] = scale;
      f32[o / 4 + 7] = label.haloWidth;
      f32[o / 4 + 8] = label.haloBlur;
      v++;
    };
    for (const label of this.labels.values()) {
      if (label.opacity <= 0 || !label.showText) continue;
      const s = label.scale;
      if (label.line && label.path && label.ground) {
        const mark = v;
        const fits = layoutOnGround(
          transform,
          label.path,
          label.anchorDist,
          label.laid,
          label.size,
          label.heights,
          Math.PI / 4,
          true,
          (glyph, c, scale) => {
            const m = glyph.m;
            put(c[0]!, c[1]!, m.x, m.y, label, scale);
            put(c[2]!, c[3]!, m.x + m.width, m.y, label, scale);
            put(c[4]!, c[5]!, m.x + m.width, m.y + m.height, label, scale);
            put(c[6]!, c[7]!, m.x, m.y + m.height, label, scale);
          },
        );
        if (fits) visible++;
        else v = mark;
        continue;
      }
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
        pairOr(layer.paintValue<unknown>("translate", { zoom: transform.zoom })),
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
    for (const label of this.labels.values()) {
      if (label.opacity > 0 && label.icon) count += label.icon.slices?.length ?? 1;
    }
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
      const corners: (readonly [number, number, number, number])[] = icon.slices
        ? icon.slices.flatMap((q) => [
            [q.x0, q.y0, q.u0, q.v0] as const,
            [q.x1, q.y0, q.u1, q.v0] as const,
            [q.x1, q.y1, q.u1, q.v1] as const,
            [q.x0, q.y1, q.u0, q.v1] as const,
          ])
        : [
            [x0, y0, u0, v0],
            [x1, y0, u1, v0],
            [x1, y1, u1, v1],
            [x0, y1, u0, v1],
          ];
      for (const [dx, dy, u, w] of corners) {
        const o = v * STRIDE;
        f32[o / 4] = px + dx * cos - dy * sin;
        f32[o / 4 + 1] = py + dx * sin + dy * cos;
        u16[o / 2 + 4] = Math.round(u * 4);
        u16[o / 2 + 5] = Math.round(w * 4);
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
  const s = icon.box ? 1 : icon.size;
  const [bx0, by0, bx1, by1] = icon.box ?? [icon.left, icon.top, icon.left + icon.width, icon.top + icon.height];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [dx, dy] of [
    [bx0, by0],
    [bx1, by0],
    [bx1, by1],
    [bx0, by1],
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

function fitIcon(
  icon: IconPart,
  rect: ImageRect,
  mode: string,
  padding: [number, number, number, number],
  text: [number, number, number, number],
  offset: [number, number],
): void {
  const image = rect.image;
  const ratio = image.pixelRatio;
  const content = image.content ?? [0, 0, image.width, image.height];
  const width = (image.width / ratio) * icon.size;
  const height = (image.height / ratio) * icon.size;
  const [tx0, ty0, tx1, ty1] = text;
  const fitX = mode === "width" || mode === "both";
  const fitY = mode === "height" || mode === "both";
  const xs = fitX
    ? fitAxis(
        image.width,
        ratio,
        icon.size,
        image.stretchX ?? [[0, image.width]],
        content[0],
        content[2],
        offset[0] + tx0 - padding[3],
        offset[0] + tx1 + padding[1],
      )
    : fitAxis(image.width, ratio, icon.size, [], 0, image.width, offset[0] + (tx0 + tx1 - width) / 2, 0);
  const ys = fitY
    ? fitAxis(
        image.height,
        ratio,
        icon.size,
        image.stretchY ?? [[0, image.height]],
        content[1],
        content[3],
        offset[1] + ty0 - padding[0],
        offset[1] + ty1 + padding[2],
      )
    : fitAxis(image.height, ratio, icon.size, [], 0, image.height, offset[1] + (ty0 + ty1 - height) / 2, 0);
  const slices: IconSlice[] = [];
  for (let i = 0; i + 1 < xs.pos.length; i++) {
    if (xs.tex[i + 1]! <= xs.tex[i]!) continue;
    for (let j = 0; j + 1 < ys.pos.length; j++) {
      if (ys.tex[j + 1]! <= ys.tex[j]!) continue;
      const insetX = xs.stretch[i] && xs.tex[i + 1]! - xs.tex[i]! > 1 ? 0.5 : 0;
      const insetY = ys.stretch[j] && ys.tex[j + 1]! - ys.tex[j]! > 1 ? 0.5 : 0;
      slices.push({
        x0: xs.pos[i]!,
        y0: ys.pos[j]!,
        x1: xs.pos[i + 1]!,
        y1: ys.pos[j + 1]!,
        u0: rect.x + xs.tex[i]! + insetX,
        v0: rect.y + ys.tex[j]! + insetY,
        u1: rect.x + xs.tex[i + 1]! - insetX,
        v1: rect.y + ys.tex[j + 1]! - insetY,
      });
    }
  }
  icon.slices = slices;
  icon.box = [xs.pos[0]!, ys.pos[0]!, xs.pos[xs.pos.length - 1]!, ys.pos[ys.pos.length - 1]!];
}

export function fitAxis(
  size: number,
  ratio: number,
  scale: number,
  zones: readonly (readonly [number, number])[],
  from: number,
  to: number,
  start: number,
  end: number,
): { pos: number[]; tex: number[]; stretch: boolean[] } {
  const natural = scale / ratio;
  if (zones.length === 0) {
    return { pos: [start, start + size * natural], tex: [0, size], stretch: [false] };
  }
  const stretched = (x: number) => {
    let sum = 0;
    for (const [a, b] of zones) sum += Math.max(0, Math.min(b, x) - a);
    return sum;
  };
  const inside = stretched(to) - stretched(from);
  const fixed = to - from - inside;
  const k = inside > 0 ? Math.max(0, (end - start - fixed * natural) / inside) : natural;
  const out = (x: number) => (x - stretched(x)) * natural + stretched(x) * k;
  const origin = start - out(from);
  const tex = [...new Set([0, size, ...zones.flat()])].sort((a, b) => a - b);
  const stretch = tex.slice(1).map((t, i) => zones.some(([a, b]) => a <= tex[i]! && t <= b) && k !== natural);
  return { pos: tex.map((t) => origin + out(t)), tex, stretch };
}

function quadOr(value: unknown): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => typeof n === "number")) return [0, 0, 0, 0];
  const [a, b, c, d] = value as [number, number, number, number];
  return [a, b, c, d];
}

function withOpacity(c: RGBA, opacity: number): RGBA {
  return [c[0], c[1], c[2], c[3] * Math.max(0, Math.min(1, opacity))];
}

let groundCum = new Float64Array(64);
let groundGlyphs = new Float64Array(256);
const groundPoint = new Float64Array(2);
const groundCorners = new Float64Array(8);
const groundJacobian = new Float64Array(6);

function layoutOnGround(
  transform: Transform,
  path: Float64Array,
  anchorDist: number,
  laid: Laid,
  size: number,
  heights: Float64Array | null,
  maxAngle: number,
  keepUpright: boolean,
  emit: (glyph: Glyph, corners: Float64Array, scale: number) => void,
): boolean {
  const n = path.length / 2;
  if (n < 2) return false;
  const ws = transform.worldSize;
  const unit = size / GLYPH_SIZE / ws;
  const width = laid.width * unit;
  if (groundCum.length < n) groundCum = new Float64Array(n * 2);
  const cum = groundCum;
  cum[0] = 0;
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1]! + Math.hypot(path[i * 2]! - path[i * 2 - 2]!, path[i * 2 + 1]! - path[i * 2 - 1]!);
  }
  const total = cum[n - 1]!;
  if (width > total) return false;
  let start = anchorDist - width / 2;
  if (start < 0) start = 0;
  if (start + width > total) start = total - width;
  let seg = 0;
  const locate = (d: number) => {
    while (seg < n - 2 && cum[seg + 1]! < d) seg++;
    while (seg > 0 && cum[seg]! > d) seg--;
  };
  const middle = start + width / 2;
  locate(middle);
  const mx = path[seg * 2]!;
  const my = path[seg * 2 + 1]!;
  const ma = Math.atan2(path[seg * 2 + 3]! - my, path[seg * 2 + 2]! - mx);
  const midZ = (heights?.[seg] ?? 0) * ws;
  if (transform.projectTo(groundPoint, mx, my, midZ) <= 0) return false;
  const x0s = groundPoint[0]!;
  if (transform.projectTo(groundPoint, mx + Math.cos(ma) * unit * 8, my + Math.sin(ma) * unit * 8, midZ) <= 0)
    return false;
  const flip = keepUpright && groundPoint[0]! < x0s;
  const glyphs = laid.glyphs;
  if (groundGlyphs.length < glyphs.length * 4) groundGlyphs = new Float64Array(glyphs.length * 8);
  const placed = groundGlyphs;
  let lastAngle = Number.NaN;
  for (let k = 0; k < glyphs.length; k++) {
    const g = glyphs[k]!;
    const along = (g.x + g.m.advance / 2) * unit;
    const d = flip ? start + width - along : start + along;
    locate(d);
    const segLength = cum[seg + 1]! - cum[seg]!;
    const t = segLength > 0 ? (d - cum[seg]!) / segLength : 0;
    const ax = path[seg * 2]!;
    const ay = path[seg * 2 + 1]!;
    const bx = path[seg * 2 + 2]!;
    const by = path[seg * 2 + 3]!;
    const za = heights?.[seg] ?? 0;
    const zb = heights?.[seg + 1] ?? 0;
    const a = Math.atan2(by - ay, bx - ax);
    const angle = flip ? a + Math.PI : a;
    if (!Number.isNaN(lastAngle)) {
      let diff = Math.abs(angle - lastAngle);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff > maxAngle) return false;
    }
    lastAngle = angle;
    placed[k * 4] = ax + (bx - ax) * t;
    placed[k * 4 + 1] = ay + (by - ay) * t;
    placed[k * 4 + 2] = (za + (zb - za) * t) * ws;
    placed[k * 4 + 3] = angle;
  }
  const frame = groundJacobian;
  for (let k = 0; k < glyphs.length; k++) {
    const g = glyphs[k]!;
    const m = g.m;
    const cx = placed[k * 4]!;
    const cy = placed[k * 4 + 1]!;
    const cz = placed[k * 4 + 2]!;
    const cos = Math.cos(placed[k * 4 + 3]!);
    const sin = Math.sin(placed[k * 4 + 3]!);
    if (transform.groundFrame(cx, cy, cz, frame) <= 0) return false;
    const sx = frame[0]!;
    const sy = frame[1]!;
    const jxx = frame[2]!;
    const jxy = frame[3]!;
    const jyx = frame[4]!;
    const jyy = frame[5]!;
    const x0 = (m.left - m.advance / 2) * unit;
    const x1 = x0 + m.width * unit;
    const y0 = (m.top + GLYPH_SIZE * 0.32) * unit;
    const y1 = y0 + m.height * unit;
    for (let c = 0; c < 4; c++) {
      const dx = c === 0 || c === 3 ? x0 : x1;
      const dy = c < 2 ? y0 : y1;
      const ox = dx * cos - dy * sin;
      const oy = dx * sin + dy * cos;
      groundCorners[c * 2] = sx + jxx * ox + jxy * oy;
      groundCorners[c * 2 + 1] = sy + jyx * ox + jyy * oy;
    }
    const tall = Math.hypot(groundCorners[6]! - groundCorners[0]!, groundCorners[7]! - groundCorners[1]!);
    emit(g, groundCorners, m.height > 0 ? tall / m.height : size / GLYPH_SIZE);
  }
  return true;
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

interface TextShape {
  letterSpacing: number;
  lineHeight: number;
  maxWidth: number;
  font: FontSpec;
}

interface TextStyle {
  variable: Anchor[] | null;
  radial: number | null;
  offset: [number, number];
  justify: string;
}

const JUSTIFY_MODES: Record<string, true> = { auto: true, left: true, center: true, right: true };

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pairOr(value: unknown): [number, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number"
    ? [value[0], value[1]]
    : [0, 0];
}

function anchorOr(value: unknown): Anchor {
  return typeof value === "string" && isAnchor(value) ? value : "center";
}
