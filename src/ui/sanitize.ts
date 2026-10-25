export function safeLinkFragment(doc: Document, html: string): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  appendSafe(doc, fragment, parsed.body, 0);
  return fragment;
}

function appendSafe(doc: Document, target: Node, source: Node, depth: number): void {
  if (depth > 8) return;
  for (const node of Array.from(source.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      target.appendChild(doc.createTextNode(node.textContent ?? ""));
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (el.tagName === "A") {
        const href = el.getAttribute("href") ?? "";
        if (/^https?:\/\//i.test(href)) {
          const a = doc.createElement("a");
          a.href = href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          appendSafe(doc, a, el, depth + 1);
          target.appendChild(a);
          continue;
        }
      }
      if (el.tagName !== "SCRIPT" && el.tagName !== "STYLE") appendSafe(doc, target, el, depth + 1);
    }
  }
}

const HTML_TAGS = new Set([
  "A",
  "ABBR",
  "B",
  "BLOCKQUOTE",
  "BR",
  "CAPTION",
  "CODE",
  "DD",
  "DEL",
  "DIV",
  "DL",
  "DT",
  "EM",
  "FIGCAPTION",
  "FIGURE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "I",
  "IMG",
  "INS",
  "KBD",
  "LI",
  "MARK",
  "OL",
  "P",
  "PRE",
  "Q",
  "S",
  "SMALL",
  "SPAN",
  "STRONG",
  "SUB",
  "SUP",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TIME",
  "TR",
  "U",
  "UL",
]);

const DROPPED_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "FRAMESET"]);

const SHARED_ATTRIBUTES = ["title", "class", "lang", "dir"];

const TAG_ATTRIBUTES: Record<string, string[]> = {
  IMG: ["alt", "width", "height"],
  TD: ["colspan", "rowspan"],
  TH: ["colspan", "rowspan", "scope"],
  OL: ["start", "reversed"],
  TIME: ["datetime"],
  Q: ["cite"],
};

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const IMAGE_PROTOCOLS = new Set(["http:", "https:"]);
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;

export function safeHtmlFragment(doc: Document, html: string): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  copySafe(doc, fragment, parsed.body, 0);
  return fragment;
}

function copySafe(doc: Document, target: Node, source: Node, depth: number): void {
  if (depth > 32) return;
  for (const node of Array.from(source.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      target.appendChild(doc.createTextNode(node.textContent ?? ""));
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (DROPPED_TAGS.has(tag)) continue;
    if (!HTML_TAGS.has(tag)) {
      copySafe(doc, target, el, depth + 1);
      continue;
    }
    const out = doc.createElement(tag.toLowerCase());
    for (const name of [...SHARED_ATTRIBUTES, ...(TAG_ATTRIBUTES[tag] ?? [])]) {
      const value = el.getAttribute(name);
      if (value !== null) out.setAttribute(name, value);
    }
    if (tag === "A") {
      const href = safeUrl(doc, el.getAttribute("href"), LINK_PROTOCOLS);
      if (href !== null) {
        out.setAttribute("href", href);
        if (el.getAttribute("target") === "_blank") out.setAttribute("target", "_blank");
        out.setAttribute("rel", "noopener noreferrer");
      }
    } else if (tag === "IMG") {
      const raw = el.getAttribute("src") ?? "";
      const src = DATA_IMAGE.test(raw) ? raw : safeUrl(doc, raw, IMAGE_PROTOCOLS);
      if (src === null) continue;
      out.setAttribute("src", src);
    }
    copySafe(doc, out, el, depth + 1);
    target.appendChild(out);
  }
}

function safeUrl(doc: Document, value: string | null, protocols: ReadonlySet<string>): string | null {
  if (value === null || value.trim() === "") return null;
  try {
    const url = new URL(value, doc.baseURI);
    return protocols.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function textOnly(html: string): string {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return parsed.body.textContent ?? "";
}
