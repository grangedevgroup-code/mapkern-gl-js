export interface DebugTile {
  corners: readonly (readonly [number, number])[];
  label: string;
}

export interface DebugFrame {
  width: number;
  height: number;
  pixelRatio: number;
  tiles: readonly DebugTile[];
  boxes: readonly (readonly number[])[];
  padding: { top: number; right: number; bottom: number; left: number } | null;
  center: readonly [number, number] | null;
}

export class DebugOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;

  constructor(parent: HTMLElement) {
    const canvas = parent.ownerDocument.createElement("canvas");
    canvas.className = "mapkern-debug";
    canvas.setAttribute("aria-hidden", "true");
    parent.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
  }

  draw(frame: DebugFrame): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { width, height, pixelRatio } = frame;
    const w = Math.max(1, Math.round(width * pixelRatio));
    const h = Math.max(1, Math.round(height * pixelRatio));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 1;
    ctx.font = "11px system-ui, sans-serif";
    ctx.strokeStyle = "rgba(217, 71, 63, 0.9)";
    ctx.fillStyle = "rgba(217, 71, 63, 0.95)";
    for (const tile of frame.tiles) {
      ctx.beginPath();
      for (let i = 0; i < tile.corners.length; i++) {
        const [x, y] = tile.corners[i]!;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      const [x, y] = tile.corners[0]!;
      if (x > -200 && y > -20 && x < width && y < height) ctx.fillText(tile.label, x + 4, y + 13);
    }
    ctx.strokeStyle = "rgba(47, 111, 219, 0.85)";
    for (const box of frame.boxes) {
      for (let i = 0; i + 3 < box.length; i += 4)
        ctx.strokeRect(box[i]!, box[i + 1]!, box[i + 2]! - box[i]!, box[i + 3]! - box[i + 1]!);
    }
    const pad = frame.padding;
    if (pad) {
      ctx.strokeStyle = "rgba(124, 207, 107, 0.95)";
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(pad.left, pad.top, width - pad.left - pad.right, height - pad.top - pad.bottom);
      ctx.setLineDash([]);
      if (frame.center) {
        const [cx, cy] = frame.center;
        ctx.beginPath();
        ctx.moveTo(cx - 8, cy);
        ctx.lineTo(cx + 8, cy);
        ctx.moveTo(cx, cy - 8);
        ctx.lineTo(cx, cy + 8);
        ctx.stroke();
      }
    }
  }

  destroy(): void {
    this.canvas.remove();
  }
}
