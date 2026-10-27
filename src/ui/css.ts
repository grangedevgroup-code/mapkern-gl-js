export const CSS = `
.mapkern-map {
  position: relative;
  overflow: hidden;
  -webkit-tap-highlight-color: transparent;
  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--mapkern-ink, #10191d);
}
.mapkern-canvas-container {
  position: absolute;
  inset: 0;
  touch-action: none;
  outline: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.mapkern-canvas-container:focus-visible {
  box-shadow: inset 0 0 0 2px var(--mapkern-focus, #2f6fdb);
}
.mapkern-canvas {
  position: absolute;
  left: 0;
  top: 0;
}
.mapkern-map {
  --mapkern-margin: var(--mapkern-control-margin, 10px);
}
.mapkern-corner {
  position: absolute;
  z-index: 2;
  display: flex;
  gap: var(--mapkern-margin);
  margin: var(--mapkern-margin);
  max-width: calc(100% - 2 * var(--mapkern-margin));
  pointer-events: none;
}
.mapkern-top-left { top: 0; left: 0; flex-direction: column; align-items: flex-start; }
.mapkern-top-right { top: 0; right: 0; flex-direction: column; align-items: flex-end; }
.mapkern-bottom-left { bottom: 0; left: 0; flex-direction: column; align-items: flex-start; }
.mapkern-bottom-right { bottom: 0; right: 0; flex-direction: column; align-items: flex-end; }
.mapkern-bottom-right > .mapkern-attribution {
  margin: 0 calc(-1 * var(--mapkern-margin)) calc(-1 * var(--mapkern-margin)) 0;
  max-width: calc(100% + var(--mapkern-margin));
}
.mapkern-control {
  pointer-events: auto;
  background: var(--mapkern-control-bg, #ffffff);
  border-radius: 8px;
  box-shadow: 0 1px 2px rgba(16, 25, 29, 0.14), 0 2px 10px rgba(16, 25, 29, 0.08);
  overflow: hidden;
}
.mapkern-control button {
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
.mapkern-control button + button {
  border-top: 1px solid rgba(16, 25, 29, 0.08);
}
.mapkern-control button:hover:not(:disabled) {
  background: rgba(16, 25, 29, 0.06);
}
.mapkern-control button:focus-visible {
  outline: 2px solid var(--mapkern-focus, #2f6fdb);
  outline-offset: -2px;
}
.mapkern-control button:disabled {
  opacity: 0.35;
  cursor: default;
}
.mapkern-control svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  pointer-events: none;
}
.mapkern-compass svg {
  transition: transform 80ms linear;
}
.mapkern-basemaps {
  position: relative;
  overflow: visible;
}
.mapkern-basemaps > button {
  border-radius: 8px;
}
.mapkern-basemaps-menu {
  position: absolute;
  right: calc(100% + 8px);
  bottom: 0;
  display: none;
  flex-direction: column;
  min-width: 140px;
  padding: 4px;
  border-radius: 8px;
  background: var(--mapkern-control-bg, #ffffff);
  box-shadow: 0 1px 2px rgba(16, 25, 29, 0.14), 0 2px 10px rgba(16, 25, 29, 0.08);
}
.mapkern-basemaps.mapkern-open .mapkern-basemaps-menu {
  display: flex;
}
.mapkern-control .mapkern-basemaps-menu button {
  width: auto;
  height: 36px;
  justify-content: flex-start;
  padding: 0 12px;
  border-radius: 6px;
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
}
.mapkern-control .mapkern-basemaps-menu button + button {
  border-top: 0;
}
.mapkern-control .mapkern-basemaps-menu button[aria-checked="true"] {
  font-weight: 600;
  background: rgba(47, 111, 219, 0.12);
}
.mapkern-search {
  position: relative;
  overflow: visible;
}
.mapkern-search > button {
  border-radius: 8px;
}
.mapkern-control button[hidden] {
  display: none;
}
.mapkern-search.mapkern-search-picked > .mapkern-search-button {
  border-radius: 8px 8px 0 0;
}
.mapkern-search.mapkern-search-picked > .mapkern-search-dismiss {
  border-radius: 0 0 8px 8px;
}
.mapkern-search-field {
  position: relative;
}
.mapkern-control .mapkern-search-reset {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  border-radius: 0 8px 8px 0;
}
.mapkern-search-input::-webkit-search-cancel-button {
  -webkit-appearance: none;
  appearance: none;
}
.mapkern-search-panel {
  position: absolute;
  right: calc(100% + 8px);
  bottom: 0;
  display: none;
  flex-direction: column-reverse;
  gap: 6px;
  width: min(320px, calc(100vw - 4 * var(--mapkern-margin) - 40px));
}
.mapkern-search.mapkern-search-start .mapkern-search-panel {
  right: auto;
  left: calc(100% + 8px);
}
.mapkern-search.mapkern-search-down .mapkern-search-panel {
  top: 0;
  bottom: auto;
  flex-direction: column;
}
.mapkern-search.mapkern-expanded .mapkern-search-panel {
  display: flex;
}
.mapkern-search-input,
.mapkern-search-results {
  border-radius: 8px;
  background: var(--mapkern-control-bg, #ffffff);
  box-shadow: 0 1px 2px rgba(16, 25, 29, 0.14), 0 2px 10px rgba(16, 25, 29, 0.08);
}
.mapkern-search-input {
  display: block;
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  margin: 0;
  padding: 0 36px 0 12px;
  border: 0;
  color: inherit;
  font: inherit;
  font-size: 14px;
  outline: none;
}
.mapkern-search-input:focus-visible {
  box-shadow: inset 0 0 0 2px var(--mapkern-focus, #2f6fdb);
}
.mapkern-search-results {
  display: none;
  max-height: min(360px, 50vh);
  margin: 0;
  padding: 4px;
  overflow-y: auto;
  list-style: none;
}
.mapkern-search.mapkern-open .mapkern-search-results {
  display: block;
}
.mapkern-search-results li {
  display: flex;
  flex-direction: column;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.mapkern-search-results li[aria-selected="true"],
.mapkern-search-results li[role="option"]:hover {
  background: rgba(47, 111, 219, 0.12);
}
.mapkern-search-name {
  font-size: 14px;
  font-weight: 600;
}
.mapkern-search-context {
  font-size: 12px;
  opacity: 0.7;
}
.mapkern-search-results .mapkern-search-empty {
  cursor: default;
  opacity: 0.7;
}
.mapkern-control .mapkern-terrain-button {
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.mapkern-terrain-label {
  display: block;
  transition: transform 160ms ease;
}
.mapkern-tilted .mapkern-terrain-label {
  transform: perspective(24px) rotateX(28deg);
}
@media (pointer: coarse) {
  .mapkern-map {
    --mapkern-margin: var(--mapkern-control-margin, 16px);
  }
  .mapkern-control button {
    width: 44px;
    height: 44px;
  }
  .mapkern-control svg {
    width: 22px;
    height: 22px;
  }
  .mapkern-control .mapkern-basemaps-menu button {
    height: 44px;
    font-size: 15px;
  }
  .mapkern-control .mapkern-terrain-button {
    font-size: 14px;
  }
  .mapkern-search-input {
    height: 44px;
    padding-right: 48px;
    font-size: 16px;
  }
  .mapkern-scale {
    font-size: 12px;
    line-height: 18px;
  }
}
.mapkern-attribution {
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
.mapkern-attribution:empty {
  display: none;
}
.mapkern-attribution:hover,
.mapkern-attribution:focus-within {
  white-space: normal;
}
.mapkern-attribution a {
  color: inherit;
  text-decoration: none;
}
.mapkern-attribution a:hover,
.mapkern-attribution a:focus-visible {
  text-decoration: underline;
}
.mapkern-scale {
  pointer-events: none;
  font-size: 11px;
  line-height: 16px;
  color: #10191d;
  white-space: nowrap;
}
.mapkern-scale > div {
  box-sizing: border-box;
  padding: 0 6px;
  border: 2px solid rgba(16, 25, 29, 0.7);
  border-top: 0;
  background: rgba(255, 255, 255, 0.7);
}
.mapkern-scale-both {
  padding: 1px 6px 4px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.7);
}
.mapkern-scale-both > .mapkern-scale-label {
  padding: 0;
  border: 0;
  background: none;
}
.mapkern-scale-both > .mapkern-scale-line {
  height: 5px;
  margin-top: 1px;
  padding: 0;
  border-color: rgba(16, 25, 29, 0.85);
  background: none;
}
.mapkern-logo {
  pointer-events: none;
  line-height: 0;
  opacity: 0.6;
}
.mapkern-logo svg {
  display: block;
  width: 94px;
  height: 26px;
}
.mapkern-popup {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 3;
  display: flex;
  pointer-events: none;
  will-change: transform;
}
.mapkern-popup-content {
  pointer-events: auto;
  position: relative;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--mapkern-control-bg, #ffffff);
  box-shadow: 0 2px 12px rgba(16, 25, 29, 0.18);
  overflow-wrap: break-word;
}
.mapkern-popup-content.mapkern-popup-closable {
  padding-right: 30px;
}
.mapkern-popup-close {
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
.mapkern-popup-close:hover {
  background: rgba(16, 25, 29, 0.06);
}
.mapkern-popup-close:focus-visible {
  outline: 2px solid var(--mapkern-focus, #2f6fdb);
  outline-offset: -2px;
}
.mapkern-popup-tip {
  flex: none;
  width: 0;
  height: 0;
  border: 8px solid transparent;
  z-index: 1;
}
.mapkern-popup-anchor-top,
.mapkern-popup-anchor-top-left,
.mapkern-popup-anchor-top-right {
  flex-direction: column;
}
.mapkern-popup-anchor-bottom,
.mapkern-popup-anchor-bottom-left,
.mapkern-popup-anchor-bottom-right {
  flex-direction: column-reverse;
}
.mapkern-popup-anchor-left {
  flex-direction: row;
}
.mapkern-popup-anchor-right {
  flex-direction: row-reverse;
}
.mapkern-popup-anchor-center .mapkern-popup-tip {
  display: none;
}
.mapkern-popup-anchor-top .mapkern-popup-tip {
  align-self: center;
  border-top: none;
  border-bottom-color: var(--mapkern-control-bg, #ffffff);
}
.mapkern-popup-anchor-top-left .mapkern-popup-tip {
  align-self: flex-start;
  border-top: none;
  border-left: none;
  border-bottom-color: var(--mapkern-control-bg, #ffffff);
}
.mapkern-popup-anchor-top-right .mapkern-popup-tip {
  align-self: flex-end;
  border-top: none;
  border-right: none;
  border-bottom-color: var(--mapkern-control-bg, #ffffff);
}
.mapkern-popup-anchor-bottom .mapkern-popup-tip {
  align-self: center;
  border-bottom: none;
  border-top-color: var(--mapkern-control-bg, #ffffff);
}
.mapkern-popup-anchor-bottom-left .mapkern-popup-tip {
  align-self: flex-start;
  border-bottom: none;
  border-left: none;
  border-top-color: var(--mapkern-control-bg, #ffffff);
}
.mapkern-popup-anchor-bottom-right .mapkern-popup-tip {
  align-self: flex-end;
  border-bottom: none;
  border-right: none;
  border-top-color: var(--mapkern-control-bg, #ffffff);
}
.mapkern-popup-anchor-left .mapkern-popup-tip {
  align-self: center;
  border-left: none;
  border-right-color: var(--mapkern-control-bg, #ffffff);
}
.mapkern-popup-anchor-right .mapkern-popup-tip {
  align-self: center;
  border-right: none;
  border-left-color: var(--mapkern-control-bg, #ffffff);
}
.mapkern-popup-anchor-top-left .mapkern-popup-content {
  border-top-left-radius: 0;
}
.mapkern-popup-anchor-top-right .mapkern-popup-content {
  border-top-right-radius: 0;
}
.mapkern-popup-anchor-bottom-left .mapkern-popup-content {
  border-bottom-left-radius: 0;
}
.mapkern-popup-anchor-bottom-right .mapkern-popup-content {
  border-bottom-right-radius: 0;
}
.mapkern-debug {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}
.mapkern-cooperative {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(16, 25, 29, 0.5);
  color: #ffffff;
  font-size: 18px;
  text-align: center;
  pointer-events: none;
  opacity: 0;
  transition: opacity 200ms ease;
}
.mapkern-cooperative.mapkern-visible {
  opacity: 1;
}
.mapkern-pseudo-fullscreen {
  position: fixed !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  z-index: 99999;
}
.mapkern-geolocate-button.mapkern-waiting svg {
  animation: mapkern-pulse 1.2s ease-in-out infinite;
}
.mapkern-geolocate-button.mapkern-active {
  color: var(--mapkern-focus, #2f6fdb);
}
.mapkern-geolocate-button.mapkern-background {
  color: rgba(47, 111, 219, 0.55);
}
.mapkern-geolocate-button.mapkern-error {
  color: #d9473f;
}
.mapkern-user-location {
  width: 16px;
  height: 16px;
  box-sizing: border-box;
  border: 2px solid #ffffff;
  border-radius: 50%;
  background: var(--mapkern-focus, #2f6fdb);
  box-shadow: 0 0 0 1px rgba(16, 25, 29, 0.25), 0 1px 4px rgba(16, 25, 29, 0.35);
}
.mapkern-user-accuracy {
  box-sizing: border-box;
  border: 1px solid rgba(47, 111, 219, 0.35);
  border-radius: 50%;
  background: rgba(47, 111, 219, 0.14);
  pointer-events: none;
}
@keyframes mapkern-pulse {
  50% {
    opacity: 0.35;
  }
}
.mapkern-boxzoom {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2;
  box-sizing: border-box;
  border: 2px dashed var(--mapkern-focus, #2f6fdb);
  background: rgba(47, 111, 219, 0.12);
  pointer-events: none;
}
.mapkern-marker {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  will-change: transform;
}
.mapkern-marker[role="button"] {
  cursor: pointer;
}
.mapkern-marker:focus-visible {
  outline: 2px solid var(--mapkern-focus, #2f6fdb);
  outline-offset: 2px;
  border-radius: 4px;
}
.mapkern-marker-draggable {
  cursor: grab;
}
.mapkern-marker-dragging {
  cursor: grabbing;
}
.mapkern-marker-pin {
  line-height: 0;
}
.mapkern-marker-pin svg {
  display: block;
  overflow: visible;
  filter: drop-shadow(0 1px 2px rgba(16, 25, 29, 0.35));
}
@media (prefers-reduced-motion: reduce) {
  .mapkern-compass svg {
    transition: none;
  }
  .mapkern-geolocate-button.mapkern-waiting svg {
    animation: none;
  }
  .mapkern-cooperative {
    transition: none;
  }
}
`;

let injected = false;

export function injectStyles(doc: Document): void {
  if (injected || doc.querySelector("style[data-mapkern]")) return;
  injected = true;
  const adoptable =
    "adoptedStyleSheets" in doc && typeof CSSStyleSheet !== "undefined" && "replaceSync" in CSSStyleSheet.prototype;
  if (adoptable && adopt(doc)) return;
  const style = doc.createElement("style");
  style.setAttribute("data-mapkern", "");
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
