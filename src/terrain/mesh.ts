export const GRID = 64;

export interface TerrainMesh {
  vertices: Int16Array;
  indices: Uint16Array;
}

export function terrainMesh(n = GRID): TerrainMesh {
  const side = n + 1;
  const vertices: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vertices.push(i, j, 0, 0);
  const indices: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * side + i;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const skirt = (edge: number[]) => {
    const base = vertices.length / 4;
    for (const p of edge) vertices.push(vertices[p * 4]!, vertices[p * 4 + 1]!, 1, 0);
    for (let k = 0; k < edge.length - 1; k++) {
      const a = edge[k]!;
      const b = edge[k + 1]!;
      indices.push(a, base + k, b, b, base + k, base + k + 1);
    }
  };
  const range = Array.from({ length: side }, (_, k) => k);
  skirt(range.map((i) => i));
  skirt(range.map((i) => n * side + i));
  skirt(range.map((j) => j * side));
  skirt(range.map((j) => j * side + n));
  return { vertices: Int16Array.from(vertices), indices: Uint16Array.from(indices) };
}
