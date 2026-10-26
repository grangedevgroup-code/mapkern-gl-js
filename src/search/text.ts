export function table<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, entries);
}

const SHORT: Record<string, string> = table({
  street: "st",
  avenue: "ave",
  av: "ave",
  road: "rd",
  boulevard: "blvd",
  drive: "dr",
  lane: "ln",
  court: "ct",
  place: "pl",
  highway: "hwy",
  parkway: "pkwy",
  terrace: "ter",
  circle: "cir",
  square: "sq",
  trail: "trl",
  loop: "lp",
  way: "way",
  expressway: "expy",
  freeway: "fwy",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  northeast: "ne",
  northwest: "nw",
  southeast: "se",
  southwest: "sw",
  mount: "mt",
  fort: "ft",
  first: "1st",
  second: "2nd",
  third: "3rd",
  fourth: "4th",
  fifth: "5th",
  sixth: "6th",
  seventh: "7th",
  eighth: "8th",
  ninth: "9th",
  tenth: "10th",
});

const LONG = new Map<string, string[]>();
for (const [long, short] of Object.entries(SHORT)) {
  const list = LONG.get(short);
  if (list) list.push(long);
  else LONG.set(short, [long]);
}

const MARKS = /\p{M}+/gu;
const APOSTROPHES = /['’ʼ]/g;
const SEPARATORS = /[^\p{L}\p{N}]+/u;

export function tokenize(text: string): string[] {
  const plain = text.normalize("NFKD").replace(MARKS, "").replace(APOSTROPHES, "").toLowerCase();
  const out: string[] = [];
  for (const word of plain.split(SEPARATORS)) {
    if (!word) continue;
    out.push(SHORT[word] ?? word);
  }
  return out;
}

export function expandPrefix(prefix: string): string[] {
  const out: string[] = [];
  for (const [long, short] of Object.entries(SHORT)) {
    if (long.length > prefix.length && long.startsWith(prefix)) out.push(short);
  }
  return out;
}

export function longForms(token: string): readonly string[] {
  return LONG.get(token) ?? [];
}

export function isNumber(token: string): boolean {
  const c = token.charCodeAt(0);
  return c >= 48 && c <= 57;
}

let rows = [new Int32Array(64), new Int32Array(64), new Int32Array(64)];

export function withinEdits(a: string, b: string, limit: number, length = b.length): number {
  const n = a.length;
  const m = Math.min(length, b.length);
  if (Math.abs(n - m) > limit) return -1;
  if (rows[0]!.length <= m) rows = [new Int32Array(m * 2), new Int32Array(m * 2), new Int32Array(m * 2)];
  let [prev, cur, before] = rows as [Int32Array, Int32Array, Int32Array];
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let best = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cb = b.charCodeAt(j - 1);
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (ca === cb ? 0 : 1));
      if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb)
        v = Math.min(v, before[j - 2]! + 1);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > limit) return -1;
    const t = before;
    before = prev;
    prev = cur;
    cur = t;
  }
  return prev[m]! <= limit ? prev[m]! : -1;
}

const SYNONYMS: Record<string, string[]> = table({
  cafe: ["coffee"],
  fuel: ["gas", "petrol", "gas station"],
  fast_food: ["burger", "takeout"],
  supermarket: ["grocery", "groceries"],
  pharmacy: ["drugstore", "chemist"],
  atm: ["cash"],
  bar: ["pub"],
  pub: ["bar"],
  toilets: ["restroom", "bathroom", "wc"],
  hospital: ["er", "emergency"],
  charging_station: ["ev", "charger", "charging"],
  parking: ["car park"],
  hotel: ["lodging"],
  motel: ["lodging"],
  library: ["books"],
  doctors: ["doctor", "clinic"],
  clinic: ["doctor"],
  dentist: ["dental"],
  bank: ["atm"],
  post_office: ["post", "mail"],
  aerodrome: ["airport"],
});

export function categoryWords(category: string): string[] {
  const value = category.slice(category.indexOf("=") + 1);
  return [...new Set(tokenize([value.replace(/_/g, " "), ...(SYNONYMS[value] ?? [])].join(" ")))];
}
