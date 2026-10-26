import type { FeatureCollection } from "../geo/geojson.ts";
import { bytesToGeoJSON, FormatError, objectToGeoJSON } from "./convert.ts";
import type { FeatureFormat } from "./feature-format.ts";

export interface ReadOptions {
  name?: string;
  format?: FeatureFormat;
}

export async function readFeatures(
  input: Blob | ArrayBuffer | ArrayBufferView | string,
  options: ReadOptions = {},
): Promise<FeatureCollection> {
  let bytes: Uint8Array;
  let name = options.name ?? "";
  if (typeof input === "string") bytes = new TextEncoder().encode(input);
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else {
    bytes = new Uint8Array(await input.arrayBuffer());
    if (!name && "name" in input && typeof input.name === "string") name = input.name;
  }
  const data = objectToGeoJSON(await bytesToGeoJSON(bytes, name, options.format));
  if (data && typeof data === "object" && (data as { type?: unknown }).type === "FeatureCollection") {
    return data as FeatureCollection;
  }
  if (data && typeof data === "object" && (data as { type?: unknown }).type === "Feature") {
    return { type: "FeatureCollection", features: [data as FeatureCollection["features"][number]] };
  }
  if (data && typeof data === "object" && typeof (data as { type?: unknown }).type === "string") {
    return {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: data as FeatureCollection["features"][number]["geometry"] },
      ],
    };
  }
  throw new FormatError("The file did not contain map features");
}
