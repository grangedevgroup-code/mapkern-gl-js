export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

export function parseXml(source: string): XmlElement {
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = source.length;
  while (i < n) {
    const lt = source.indexOf("<", i);
    const top = stack[stack.length - 1]!;
    if (lt < 0) {
      top.text += decode(source.slice(i));
      break;
    }
    if (lt > i) top.text += decode(source.slice(i, lt));
    if (source.startsWith("<!--", lt)) {
      i = skipPast(source, "-->", lt + 4);
    } else if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      if (end < 0) throw new XmlError("Unclosed CDATA section");
      top.text += source.slice(lt + 9, end);
      i = end + 3;
    } else if (source.startsWith("<?", lt)) {
      i = skipPast(source, "?>", lt + 2);
    } else if (source.startsWith("<!", lt)) {
      i = skipDeclaration(source, lt + 2);
    } else if (source.charCodeAt(lt + 1) === 47) {
      const end = source.indexOf(">", lt + 2);
      if (end < 0) throw new XmlError("Unclosed end tag");
      const name = localName(source.slice(lt + 2, end).trim());
      let k = stack.length - 1;
      while (k > 0 && stack[k]!.name !== name) k--;
      if (k > 0) stack.length = k;
      i = end + 1;
    } else {
      const end = tagEnd(source, lt + 1);
      const selfClosing = source.charCodeAt(end - 1) === 47;
      const body = source.slice(lt + 1, selfClosing ? end - 1 : end);
      const element = parseTag(body);
      top.children.push(element);
      if (!selfClosing) stack.push(element);
      i = end + 1;
    }
  }
  return root;
}

function skipPast(source: string, token: string, from: number): number {
  const end = source.indexOf(token, from);
  return end < 0 ? source.length : end + token.length;
}

function skipDeclaration(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === 91) depth++;
    else if (c === 93) depth--;
    else if (c === 62 && depth <= 0) return i + 1;
  }
  return source.length;
}

function tagEnd(source: string, from: number): number {
  let quote = 0;
  for (let i = from; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62) {
      return i;
    }
  }
  throw new XmlError("Unclosed tag");
}

function parseTag(body: string): XmlElement {
  let i = 0;
  while (i < body.length && !isSpace(body.charCodeAt(i))) i++;
  const element: XmlElement = { name: localName(body.slice(0, i)), attrs: {}, children: [], text: "" };
  const attr = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  attr.lastIndex = i;
  for (let m = attr.exec(body); m; m = attr.exec(body)) {
    element.attrs[localName(m[1]!)] = decode(m[3] ?? m[4] ?? "");
  }
  return element;
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

function decode(text: string): string {
  if (text.indexOf("&") < 0) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity] ?? match;
  });
}

export function child(element: XmlElement | undefined, name: string): XmlElement | undefined {
  return element?.children.find((c) => c.name === name);
}

export function children(element: XmlElement | undefined, name: string): XmlElement[] {
  return element ? element.children.filter((c) => c.name === name) : [];
}

export function descendants(element: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of element.children) {
    if (c.name === name) out.push(c);
    else descendants(c, name, out);
  }
  return out;
}

export function textOf(element: XmlElement | undefined): string {
  if (!element) return "";
  let text = element.text;
  for (const c of element.children) text += textOf(c);
  return text.trim();
}
