export interface StyleImage {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly pixelRatio: number;
  readonly sdf: boolean;
  readonly sprite: boolean;
}

export interface ImageRect {
  readonly x: number;
  readonly y: number;
  readonly image: StyleImage;
}

export interface RawImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

const GUTTER = 1;
const MAX_SIZE = 4096;

export class ImageAtlas {
  width = 256;
  height = 256;
  data = new Uint8Array(256 * 256 * 4);
  generation = 0;
  version = 0;
  dirty: { y0: number; y1: number } | null = null;
  private readonly images = new Map<string, StyleImage>();
  private readonly rects = new Map<string, ImageRect>();
  private shelves: { y: number; height: number; x: number }[] = [];
  private bottom = 0;
  private stale = false;

  has(id: string): boolean {
    return this.images.has(id);
  }

  image(id: string): StyleImage | undefined {
    return this.images.get(id);
  }

  list(): string[] {
    return [...this.images.keys()];
  }

  get size(): number {
    return this.images.size;
  }

  add(image: StyleImage): void {
    const before = this.images.get(image.id);
    this.images.set(image.id, image);
    this.version++;
    const rect = this.rects.get(image.id);
    if (before && rect && before.width === image.width && before.height === image.height) {
      const next = { x: rect.x, y: rect.y, image };
      this.rects.set(image.id, next);
      this.copy(next);
      return;
    }
    if (before) this.stale = true;
  }

  remove(id: string): boolean {
    if (!this.images.delete(id)) return false;
    this.rects.delete(id);
    this.stale = true;
    this.version++;
    return true;
  }

  clearSprites(): void {
    let removed = false;
    for (const [id, image] of this.images) {
      if (!image.sprite) continue;
      this.images.delete(id);
      this.rects.delete(id);
      removed = true;
    }
    if (!removed) return;
    this.stale = true;
    this.version++;
  }

  get(id: string): ImageRect | undefined {
    if (this.stale) this.repack();
    const rect = this.rects.get(id);
    if (rect) return rect;
    const image = this.images.get(id);
    if (!image) return undefined;
    return this.place(image);
  }

  private place(image: StyleImage): ImageRect | undefined {
    const w = image.width + GUTTER * 2;
    const h = image.height + GUTTER * 2;
    if (w > MAX_SIZE || h > MAX_SIZE) return undefined;
    for (;;) {
      const spot = this.find(w, h);
      if (spot) {
        const rect = { x: spot[0] + GUTTER, y: spot[1] + GUTTER, image };
        this.rects.set(image.id, rect);
        this.copy(rect);
        return rect;
      }
      if (this.width >= MAX_SIZE && this.height >= MAX_SIZE) return undefined;
      this.grow();
    }
  }

  private find(w: number, h: number): [number, number] | null {
    let best: { y: number; height: number; x: number } | null = null;
    for (const shelf of this.shelves) {
      if (shelf.height < h || shelf.height > h * 1.5 + 4 || shelf.x + w > this.width) continue;
      if (!best || shelf.height < best.height) best = shelf;
    }
    if (best) {
      const x = best.x;
      best.x += w;
      return [x, best.y];
    }
    if (this.bottom + h > this.height || w > this.width) return null;
    const shelf = { y: this.bottom, height: h, x: w };
    this.shelves.push(shelf);
    this.bottom += h;
    return [0, shelf.y];
  }

  private grow(): void {
    if (this.width <= this.height) this.width = Math.min(MAX_SIZE, this.width * 2);
    else this.height = Math.min(MAX_SIZE, this.height * 2);
    this.repack();
  }

  private repack(): void {
    this.stale = false;
    this.data = new Uint8Array(this.width * this.height * 4);
    this.shelves = [];
    this.bottom = 0;
    this.generation++;
    this.dirty = null;
    const placed = [...this.rects.keys()];
    this.rects.clear();
    const order = placed
      .map((id) => this.images.get(id))
      .filter((image): image is StyleImage => image !== undefined)
      .sort((a, b) => b.height - a.height);
    for (const image of order) {
      const w = image.width + GUTTER * 2;
      const h = image.height + GUTTER * 2;
      const spot = this.find(w, h);
      if (!spot) {
        if (this.width >= MAX_SIZE && this.height >= MAX_SIZE) continue;
        if (this.width <= this.height) this.width = Math.min(MAX_SIZE, this.width * 2);
        else this.height = Math.min(MAX_SIZE, this.height * 2);
        this.repack();
        return;
      }
      const rect = { x: spot[0] + GUTTER, y: spot[1] + GUTTER, image };
      this.rects.set(image.id, rect);
      this.copy(rect, false);
    }
  }

  private copy(rect: ImageRect, mark = true): void {
    const { image } = rect;
    const stride = this.width * 4;
    const x0 = rect.x - GUTTER;
    const y0 = rect.y - GUTTER;
    const w = image.width;
    const h = image.height;
    for (let row = -GUTTER; row < h + GUTTER; row++) {
      const sy = Math.min(h - 1, Math.max(0, row));
      for (let col = -GUTTER; col < w + GUTTER; col++) {
        const sx = Math.min(w - 1, Math.max(0, col));
        const from = (sy * w + sx) * 4;
        const to = (rect.y + row) * stride + (rect.x + col) * 4;
        const inside = row >= 0 && row < h && col >= 0 && col < w;
        this.data[to] = inside ? image.data[from]! : 0;
        this.data[to + 1] = inside ? image.data[from + 1]! : 0;
        this.data[to + 2] = inside ? image.data[from + 2]! : 0;
        this.data[to + 3] = inside ? image.data[from + 3]! : 0;
      }
    }
    if (!mark) return;
    const y1 = y0 + h + GUTTER * 2;
    this.dirty = this.dirty ? { y0: Math.min(this.dirty.y0, y0), y1: Math.max(this.dirty.y1, y1) } : { y0, y1 };
    void x0;
  }
}

export function premultiplied(raw: RawImage): Uint8Array {
  const { width, height, data } = raw;
  if (data.length !== width * height * 4) {
    throw new RangeError(
      `image data holds ${data.length} bytes, expected ${width * height * 4} for ${width}x${height}`,
    );
  }
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    out[i] = Math.round((data[i]! * a) / 255);
    out[i + 1] = Math.round((data[i + 1]! * a) / 255);
    out[i + 2] = Math.round((data[i + 2]! * a) / 255);
    out[i + 3] = a;
  }
  return out;
}
