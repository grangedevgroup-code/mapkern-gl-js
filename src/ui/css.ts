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
  pointer-events: none;
}
.maplet-top-left { top: 0; left: 0; flex-direction: column; align-items: flex-start; }
.maplet-top-right { top: 0; right: 0; flex-direction: column; align-items: flex-end; }
.maplet-bottom-left { bottom: 0; left: 0; flex-direction: column-reverse; align-items: flex-start; }
.maplet-bottom-right { bottom: 0; right: 0; flex-direction: column-reverse; align-items: flex-end; margin: 0; }
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
  max-width: calc(100% - 20px);
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
  pointer-events: none;
  will-change: transform;
}
.maplet-popup-content {
  pointer-events: auto;
  position: relative;
  max-width: 280px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--maplet-control-bg, #ffffff);
  box-shadow: 0 2px 12px rgba(16, 25, 29, 0.18);
}
.maplet-marker {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  will-change: transform;
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
  const adoptable = "adoptedStyleSheets" in doc && typeof CSSStyleSheet !== "undefined" && "replaceSync" in CSSStyleSheet.prototype;
  if (adoptable) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      doc.adoptedStyleSheets = [sheet, ...doc.adoptedStyleSheets];
      return;
    } catch {
      injected = true;
    }
  }
  const style = doc.createElement("style");
  style.setAttribute("data-maplet", "");
  style.textContent = CSS;
  doc.head.appendChild(style);
}
