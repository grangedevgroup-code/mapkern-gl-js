export const CSS = `
.maplet-map {
  position: relative;
  overflow: hidden;
  -webkit-tap-highlight-color: transparent;
  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--maplet-ink, #10191d);
}
.maplet-canvas-container {
  position: absolute;
  inset: 0;
  touch-action: none;
  outline: none;
  user-select: none;
  -webkit-user-select: none;
}
.maplet-canvas-container:focus-visible {
  box-shadow: inset 0 0 0 2px var(--maplet-focus, #2f6fdb);
}
.maplet-canvas {
  position: absolute;
  left: 0;
  top: 0;
}
.maplet-corner {
  position: absolute;
  z-index: 2;
  display: flex;
  gap: 10px;
  margin: 10px;
  max-width: calc(100% - 20px);
  pointer-events: none;
}
.maplet-top-left { top: 0; left: 0; flex-direction: column; align-items: flex-start; }
.maplet-top-right { top: 0; right: 0; flex-direction: column; align-items: flex-end; }
.maplet-bottom-left { bottom: 0; left: 0; flex-direction: column-reverse; align-items: flex-start; }
.maplet-bottom-right { bottom: 0; right: 0; flex-direction: column-reverse; align-items: flex-end; margin: 0; max-width: 100%; }
.maplet-control {
  pointer-events: auto;
  background: var(--maplet-control-bg, #ffffff);
  border-radius: 8px;
  box-shadow: 0 1px 2px rgba(16, 25, 29, 0.14), 0 2px 10px rgba(16, 25, 29, 0.08);
  overflow: hidden;
}
.maplet-control button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.maplet-control button + button {
  border-top: 1px solid rgba(16, 25, 29, 0.08);
}
.maplet-control button:hover:not(:disabled) {
  background: rgba(16, 25, 29, 0.06);
}
.maplet-control button:focus-visible {
  outline: 2px solid var(--maplet-focus, #2f6fdb);
  outline-offset: -2px;
}
.maplet-control button:disabled {
  opacity: 0.35;
  cursor: default;
}
.maplet-control svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  pointer-events: none;
}
.maplet-compass svg {
  transition: transform 80ms linear;
}
.maplet-attribution {
  pointer-events: auto;
  box-sizing: border-box;
  max-width: 100%;
  padding: 2px 8px;
  border-radius: 6px 0 0 0;
  background: rgba(255, 255, 255, 0.8);
  font-size: 11px;
  line-height: 18px;
  color: rgba(16, 25, 29, 0.8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.maplet-attribution:empty {
  display: none;
}
.maplet-attribution:hover,
.maplet-attribution:focus-within {
  white-space: normal;
}
.maplet-attribution a {
  color: inherit;
  text-decoration: none;
}
.maplet-attribution a:hover,
.maplet-attribution a:focus-visible {
  text-decoration: underline;
}
.maplet-scale {
  pointer-events: none;
  padding: 0 6px;
  border: 2px solid rgba(16, 25, 29, 0.7);
  border-top: 0;
  background: rgba(255, 255, 255, 0.7);
  font-size: 11px;
  line-height: 16px;
  color: #10191d;
  box-sizing: border-box;
  white-space: nowrap;
}
.maplet-popup {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 3;
  display: flex;
  pointer-events: none;
  will-change: transform;
}
.maplet-popup-content {
  pointer-events: auto;
  position: relative;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--maplet-control-bg, #ffffff);
  box-shadow: 0 2px 12px rgba(16, 25, 29, 0.18);
  overflow-wrap: break-word;
}
.maplet-popup-content:has(> .maplet-popup-close) {
  padding-right: 30px;
}
.maplet-popup-close {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 24px;
  height: 24px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: 18px/24px system-ui, sans-serif;
  cursor: pointer;
}
.maplet-popup-close:hover {
  background: rgba(16, 25, 29, 0.06);
}
.maplet-popup-close:focus-visible {
  outline: 2px solid var(--maplet-focus, #2f6fdb);
  outline-offset: -2px;
}
.maplet-popup-tip {
  flex: none;
  width: 0;
  height: 0;
  border: 8px solid transparent;
  z-index: 1;
}
.maplet-popup-anchor-top,
.maplet-popup-anchor-top-left,
.maplet-popup-anchor-top-right {
  flex-direction: column;
}
.maplet-popup-anchor-bottom,
.maplet-popup-anchor-bottom-left,
.maplet-popup-anchor-bottom-right {
  flex-direction: column-reverse;
}
.maplet-popup-anchor-left {
  flex-direction: row;
}
.maplet-popup-anchor-right {
  flex-direction: row-reverse;
}
.maplet-popup-anchor-center .maplet-popup-tip {
  display: none;
}
.maplet-popup-anchor-top .maplet-popup-tip {
  align-self: center;
  border-top: none;
  border-bottom-color: var(--maplet-control-bg, #ffffff);
}
.maplet-popup-anchor-top-left .maplet-popup-tip {
  align-self: flex-start;
  border-top: none;
  border-left: none;
  border-bottom-color: var(--maplet-control-bg, #ffffff);
}
.maplet-popup-anchor-top-right .maplet-popup-tip {
  align-self: flex-end;
  border-top: none;
  border-right: none;
  border-bottom-color: var(--maplet-control-bg, #ffffff);
}
.maplet-popup-anchor-bottom .maplet-popup-tip {
  align-self: center;
  border-bottom: none;
  border-top-color: var(--maplet-control-bg, #ffffff);
}
.maplet-popup-anchor-bottom-left .maplet-popup-tip {
  align-self: flex-start;
  border-bottom: none;
  border-left: none;
  border-top-color: var(--maplet-control-bg, #ffffff);
}
.maplet-popup-anchor-bottom-right .maplet-popup-tip {
  align-self: flex-end;
  border-bottom: none;
  border-right: none;
  border-top-color: var(--maplet-control-bg, #ffffff);
}
.maplet-popup-anchor-left .maplet-popup-tip {
  align-self: center;
  border-left: none;
  border-right-color: var(--maplet-control-bg, #ffffff);
}
.maplet-popup-anchor-right .maplet-popup-tip {
  align-self: center;
  border-right: none;
  border-left-color: var(--maplet-control-bg, #ffffff);
}
.maplet-popup-anchor-top-left .maplet-popup-content {
  border-top-left-radius: 0;
}
.maplet-popup-anchor-top-right .maplet-popup-content {
  border-top-right-radius: 0;
}
.maplet-popup-anchor-bottom-left .maplet-popup-content {
  border-bottom-left-radius: 0;
}
.maplet-popup-anchor-bottom-right .maplet-popup-content {
  border-bottom-right-radius: 0;
}
.maplet-marker {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  will-change: transform;
}
.maplet-marker[role="button"] {
  cursor: pointer;
}
.maplet-marker:focus-visible {
  outline: 2px solid var(--maplet-focus, #2f6fdb);
  outline-offset: 2px;
  border-radius: 4px;
}
.maplet-marker-draggable {
  cursor: grab;
}
.maplet-marker-dragging {
  cursor: grabbing;
}
.maplet-marker-pin {
  line-height: 0;
}
.maplet-marker-pin svg {
  display: block;
  overflow: visible;
  filter: drop-shadow(0 1px 2px rgba(16, 25, 29, 0.35));
}
@media (prefers-reduced-motion: reduce) {
  .maplet-compass svg {
    transition: none;
  }
}
`;

let injected = false;

export function injectStyles(doc: Document): void {
  if (injected || doc.querySelector("style[data-maplet]")) return;
  injected = true;
  const adoptable =
    "adoptedStyleSheets" in doc && typeof CSSStyleSheet !== "undefined" && "replaceSync" in CSSStyleSheet.prototype;
  if (adoptable && adopt(doc)) return;
  const style = doc.createElement("style");
  style.setAttribute("data-maplet", "");
  style.textContent = CSS;
  doc.head.appendChild(style);
}

function adopt(doc: Document): boolean {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    doc.adoptedStyleSheets = [sheet, ...doc.adoptedStyleSheets];
    return true;
  } catch {
    return false;
  }
}
