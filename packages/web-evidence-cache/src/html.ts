import { parseHTML } from "linkedom";

const ALLOWED_TAGS = new Set([
  "article", "main", "section", "header", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "p",
  "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody", "tr", "th", "td",
  "dl", "dt", "dd", "figure", "figcaption", "a", "img", "time", "strong", "em", "br",
]);
const DROP_TAGS = new Set(["script", "style", "noscript", "iframe", "svg", "canvas", "form", "input", "button", "nav", "aside"]);
const ALLOWED_ATTRS = new Set(["href", "src", "alt", "title", "datetime", "id", "aria-label", "scope", "headers", "colspan", "rowspan", "data-source-id", "data-chunk-id"]);

export interface SemanticHtmlInput {
  html: string;
  sourceUrl: string;
  sourceId: string;
  title: string;
}

export function semanticHtml(input: SemanticHtmlInput): string {
  const { document } = parseHTML(`<!doctype html><html><body>${input.html}</body></html>`);
  const article = document.querySelector("article") ?? document.querySelector("main") ?? document.body;
  sanitizeChildren(article, input.sourceUrl);
  article.setAttribute("data-source-id", input.sourceId);
  if (!article.querySelector("h1") && input.title) {
    const h1 = document.createElement("h1");
    h1.textContent = input.title;
    article.insertBefore(h1, article.firstChild);
  }
  return `<article data-source-id="${escapeAttr(input.sourceId)}">${article.innerHTML.trim()}</article>\n`;
}

function sanitizeChildren(node: Element, baseUrl: string): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 8) {
      child.parentNode?.removeChild(child);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    const tag = element.tagName.toLowerCase();
    if (DROP_TAGS.has(tag) || isHidden(element) || isNoisy(element)) {
      element.parentNode?.removeChild(element);
      continue;
    }
    sanitizeChildren(element, baseUrl);
    if (!ALLOWED_TAGS.has(tag)) {
      unwrap(element);
      continue;
    }
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (!ALLOWED_ATTRS.has(name) || name.startsWith("on") || (name.startsWith("data-") && name !== "data-source-id" && name !== "data-chunk-id")) {
        element.removeAttribute(attr.name);
        continue;
      }
      if ((name === "href" || name === "src") && attr.value) {
        try {
          const resolved = new URL(attr.value, baseUrl);
          if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
            element.removeAttribute(attr.name);
          } else {
            element.setAttribute(attr.name, resolved.toString());
          }
        } catch {
          element.removeAttribute(attr.name);
        }
      }
    }
  }
}

function isHidden(element: Element): boolean {
  const hidden = element.getAttribute("hidden");
  const aria = element.getAttribute("aria-hidden");
  const style = element.getAttribute("style") ?? "";
  return hidden !== null || aria === "true" || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
}

function isNoisy(element: Element): boolean {
  const combined = `${element.getAttribute("class") ?? ""} ${element.getAttribute("id") ?? ""}`.toLowerCase();
  return /\b(ad|ads|advert|cookie|banner|sidebar|nav|newsletter|promo|tracking|hydration|__next|webpack)\b/.test(combined);
}

function unwrap(element: Element): void {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function htmlToText(html: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return (document.body?.textContent ?? document.textContent ?? "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim() + "\n";
}
