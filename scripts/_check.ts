import { indexBlobs } from "../tools/tiles/osm-pbf.ts";

for (const file of process.argv.slice(2)) {
  const index = indexBlobs(file);
  console.log(
    file,
    index.blobs.length,
    index.damagedAt === null ? "ok" : `damaged at ${index.damagedAt} of ${index.fileSize}: ${index.damage}`,
  );
}
