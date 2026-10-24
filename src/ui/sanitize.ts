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

export function textOnly(html: string): string {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return parsed.body.textContent ?? "";
}
