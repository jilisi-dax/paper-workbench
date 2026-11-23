"use strict";

class FloatingWindow {
  constructor(panel, handle, storageKey) {
    this.panel = panel;
    this.storageKey = storageKey;
    this.preference = this.loadPreference();
    handle.addEventListener("pointerdown", (event) => {
      if (!event.target.closest("button")) this.begin(event, "move");
    });
    for (const edge of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      const grip = document.createElement("div");
      grip.className = "float-grip";
      grip.dataset.edge = edge;
      grip.setAttribute("aria-hidden", "true");
      panel.append(grip);
      grip.addEventListener("pointerdown", (event) => this.begin(event, edge));
    }
    panel.addEventListener("pointermove", (event) => this.move(event));
    panel.addEventListener("lostpointercapture", (event) => {
      if (this.gesture?.pointer !== event.pointerId) return;
      this.gesture = null;
      this.savePreference();
    });
    window.addEventListener("resize", () => this.layout());
  }

  loadPreference() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.storageKey));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) return saved;
    } catch {
      // The panel can still be moved in the current session if storage is unavailable.
    }
    return {};
  }

  savePreference() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.preference));
    } catch {
      // Geometry remains available in memory.
    }
  }

  show() {
    this.panel.hidden = false;
    this.preference.open = true;
    this.layout();
    this.savePreference();
  }

  hide() {
    this.panel.hidden = true;
    this.preference.open = false;
    this.savePreference();
  }

  limits() {
    const right = document.documentElement.clientWidth - 6;
    const bottom = window.innerHeight - 6;
    return {
      margin: 6, right, bottom,
      minWidth: Math.min(290, right - 6),
      minHeight: Math.min(300, bottom - 6)
    };
  }

  layout() {
    if (this.panel.hidden) return;
    const {margin, right, bottom, minWidth, minHeight} = this.limits();
    const saved = this.preference;
    const width = this.clamp(Number.isFinite(saved.width) ? saved.width : 420, minWidth, right - margin);
    const height = this.clamp(Number.isFinite(saved.height) ? saved.height : 540, minHeight, bottom - margin);
    const x = this.clamp(Number.isFinite(saved.x) ? saved.x : 12, margin, right - width);
    const y = this.clamp(Number.isFinite(saved.y) ? saved.y : bottom - height - 50, margin, bottom - height);
    Object.assign(this.panel.style, {left: x + "px", top: y + "px", width: width + "px", height: height + "px"});
  }

  clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  begin(event, direction) {
    if (event.button !== 0 || this.gesture) return;
    event.preventDefault();
    this.panel.setPointerCapture(event.pointerId);
    this.gesture = {
      pointer: event.pointerId, direction, x: event.clientX, y: event.clientY,
      box: this.panel.getBoundingClientRect()
    };
  }

  move(event) {
    const gesture = this.gesture;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    const {direction, box} = gesture;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    const {margin, right, bottom, minWidth, minHeight} = this.limits();
    let left = box.left;
    let top = box.top;
    let width = box.width;
    let height = box.height;
    if (direction === "move") {
      left = this.clamp(box.left + dx, margin, right - width);
      top = this.clamp(box.top + dy, margin, bottom - height);
    } else {
      if (direction.includes("w")) left = this.clamp(box.left + dx, margin, box.right - minWidth);
      if (direction.includes("n")) top = this.clamp(box.top + dy, margin, box.bottom - minHeight);
      const edgeX = direction.includes("e") ? this.clamp(box.right + dx, box.left + minWidth, right) : box.right;
      const edgeY = direction.includes("s") ? this.clamp(box.bottom + dy, box.top + minHeight, bottom) : box.bottom;
      width = edgeX - left;
      height = edgeY - top;
    }
    Object.assign(this.preference, {x: left, y: top, width, height});
    this.layout();
  }
}

