"use strict";
// Geometry is captured once in content coordinates; scrolling does not invalidate the index.
window.installFileGestures = function ({ content, enabled, getSelection, onSelect, onMenu }) {
  const box = document.createElement("div");
  box.className = "selection-marquee"; box.hidden = true; document.body.append(box);
  let drag = null, frame = 0, suppress = false;
  const queue = () => { if (!frame) frame = requestAnimationFrame(draw); };
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  function draw() {
    frame = 0;
    const d = drag;
    if (!d?.items) return;
    const r = content.getBoundingClientRect();
    const top = r.top + d.header, bottom = r.top + content.clientHeight;
    const right = r.left + content.clientWidth;
    const pos = content.scrollTop;
    if (!d.ending) {
      const edge = d.y < top + 18 ? d.y - top - 18 : d.y > bottom - 18 ? d.y - bottom + 18 : 0;
      if (edge) content.scrollTop += clamp(Math.round(edge * .65), -32, 32);
    }
    const x2 = clamp(d.x, r.left, right) - r.left + content.scrollLeft;
    const y2 = clamp(d.y, top, bottom) - r.top + content.scrollTop;
    const x = Math.min(d.ax, x2), y = Math.min(d.ay, y2), endX = Math.max(d.ax, x2), endY = Math.max(d.ay, y2);
    const x1v = clamp(x + r.left - content.scrollLeft, r.left, right), y1v = clamp(y + r.top - content.scrollTop, top, bottom);
    Object.assign(box.style, { left: x1v + "px", top: y1v + "px", width: (clamp(endX + r.left - content.scrollLeft, r.left, right) - x1v) + "px", height: (clamp(endY + r.top - content.scrollTop, top, bottom) - y1v) + "px" });
    let lo = 0, hi = d.items.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (d.items[mid].bottom < y) lo = mid + 1; else hi = mid; }
    const next = new Set(d.add ? d.before : []);
    for (let i = lo; i < d.items.length && d.items[i].top <= endY; i++) {
      const item = d.items[i];
      if (item.right >= x && item.left <= endX) next.add(item.id);
    }
    const prev = getSelection();
    if (next.size !== prev.size || [...next].some(id => !prev.has(id))) onSelect(next, false);
    if (pos !== content.scrollTop) queue();
  }
  function finish(cancelled) {
    if (!drag) return;
    const d = drag;
    if (frame) cancelAnimationFrame(frame); frame = 0;
    if (d.items) {
      d.ending = true; if (!cancelled) draw();
      onSelect(cancelled ? d.before : getSelection(), true);
      suppress = true;
    }
    drag = null; box.hidden = true;
    if (content.hasPointerCapture(d.id)) content.releasePointerCapture(d.id);
  }
  content.addEventListener("pointerdown", event => {
    suppress = false;
    if (drag || !enabled() || event.button !== 0 || event.pointerType === "touch" || event.target.closest("input,button,thead,a")) return;
    const r = content.getBoundingClientRect();
    if (event.clientX >= r.left + content.clientWidth || event.clientY >= r.top + content.clientHeight) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, sx: event.clientX, sy: event.clientY, ax: event.clientX - r.left + content.scrollLeft, ay: event.clientY - r.top + content.scrollTop, before: new Set(getSelection()), add: event.ctrlKey || event.metaKey || event.shiftKey };
  });
  window.addEventListener("pointermove", event => {
    const d = drag;
    if (!d || d.id !== event.pointerId) return;
    if (!(event.buttons & 1)) { finish(true); return; }
    d.x = event.clientX; d.y = event.clientY;
    if (!d.items) {
      if (Math.hypot(d.x - d.sx, d.y - d.sy) < 5) return;
      const r = content.getBoundingClientRect();
      d.header = content.querySelector("thead")?.offsetHeight || 0;
      d.items = Array.from(content.querySelectorAll("[data-file-id]"), node => {
        const b = node.getBoundingClientRect();
        return { id: node.dataset.fileId, left: b.left - r.left + content.scrollLeft, right: b.right - r.left + content.scrollLeft, top: b.top - r.top + content.scrollTop, bottom: b.bottom - r.top + content.scrollTop };
      });
      content.setPointerCapture(d.id); box.hidden = false;
    }
    event.preventDefault(); queue();
  });
  window.addEventListener("pointerup", e => { if (drag?.id === e.pointerId) { drag.x = e.clientX; drag.y = e.clientY; finish(false); } });
  window.addEventListener("pointercancel", () => finish(true));
  content.addEventListener("lostpointercapture", () => finish(true));
  window.addEventListener("blur", () => finish(true));
  content.addEventListener("scroll", () => { if (drag?.items) queue(); }, { passive: true });
  window.addEventListener("keydown", e => { if (e.key === "Escape" && drag) { e.preventDefault(); finish(true); } });
  for (const type of ["click", "dblclick"]) content.addEventListener(type, e => { if (suppress && e.detail) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  content.addEventListener("dragstart", e => e.preventDefault());
  function context(node, x, y) {
    if (!getSelection().has(node.dataset.fileId)) onSelect(new Set([node.dataset.fileId]), true);
    onMenu(node, x, y);
  }
  content.addEventListener("contextmenu", e => {
    const node = e.target.closest("[data-file-id]");
    if (!node || !enabled()) return;
    e.preventDefault(); finish(true); context(node, e.clientX, e.clientY);
  });
  content.addEventListener("keydown", e => {
    const node = e.target.closest("[data-file-id]");
    if (node && (e.key === "ContextMenu" || e.shiftKey && e.key === "F10")) {
      e.preventDefault(); const r = node.getBoundingClientRect(); context(node, r.left + 24, r.top + 15);
    }
  });
  return () => finish(true);
};
