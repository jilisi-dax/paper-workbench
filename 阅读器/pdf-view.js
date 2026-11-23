"use strict";

const paperPdfRequests = new Map();
window.deliverPaperPdf = (digest, base64) => paperPdfRequests.get(digest)?.receive(base64);

function pdfBytes(version) {
  const digest = window.PAPER_PDF_FILES?.[version.file];
  if (!digest) return Promise.reject(new Error("请先同步论文目录。"));
  const existing = paperPdfRequests.get(digest);
  if (existing) return existing.result;
  const script = document.createElement("script");
  script.src = "cache/pdf-data/" + digest + ".js";
  const request = {};
  request.result = new Promise((resolve, reject) => {
    request.receive = (base64) => resolve(decodePdfBytes(base64));
    script.onerror = () => reject(new Error("找不到 PDF 离线缓存。请重新同步论文目录。"));
    script.onload = () => reject(new Error("PDF 离线缓存无法读取。"));
  }).finally(() => {
    paperPdfRequests.delete(digest);
    script.remove();
  });
  paperPdfRequests.set(digest, request);
  document.head.append(script);
  return request.result;
}

function decodePdfBytes(base64) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(base64);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

let pdfEnginePromise;
function pdfEngine() {
  if (!pdfEnginePromise) {
    pdfEnginePromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "阅读器/vendor/pdf-engine.js";
      script.onerror = () => reject(new Error("找不到本地 PDF.js 阅读组件。"));
      script.onload = async () => {
        script.remove();
        const sources = window.PDF_ENGINE_SOURCES;
        delete window.PDF_ENGINE_SOURCES;
        const moduleUrl = URL.createObjectURL(new Blob([sources.module], {type: "text/javascript"}));
        try {
          const engine = await import(moduleUrl);
          engine.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([sources.worker], {type: "text/javascript"}));
          resolve(engine);
        } catch (error) {
          reject(error);
        } finally {
          URL.revokeObjectURL(moduleUrl);
        }
      };
      document.head.append(script);
    });
  }
  return pdfEnginePromise;
}

class LocalPdfResources {
  async fetch({filename}) {
    const resource = window.PDF_ENGINE_RESOURCES[filename];
    if (!resource) throw new Error("PDF 资源未打包：" + filename);
    return decodePdfBytes(resource);
  }
}

class LocalPdfView {
  constructor(version, title, initialPage, onPage) {
    this.version = version;
    this.page = initialPage;
    this.onPage = onPage;
    this.zoom = 1;
    this.width = 0;
    this.sheets = [];
    this.jobs = new Map();
    this.node = document.createElement("section");
    this.node.className = "pdf-scroll";
    this.node.tabIndex = 0;
    this.node.setAttribute("aria-label", title);
    this.node.dataset.readerVersion = version.id;
    this.node.setAttribute("aria-busy", "true");
    this.status = document.createElement("p");
    this.status.className = "pdf-status";
    this.status.setAttribute("role", "status");
    this.status.textContent = "正在打开 PDF…";
    this.node.append(this.status);
    this.node.addEventListener("scroll", () => {
      cancelAnimationFrame(this.scrollFrame);
      this.scrollFrame = requestAnimationFrame(() => this.detectPage());
    }, {passive: true});
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.node);
    void this.open();
  }

  async open() {
    try {
      const [engine, data] = await Promise.all([pdfEngine(), pdfBytes(this.version)]);
      if (this.closed) return;
      this.engine = engine;
      // Pass a view-owned copy because the worker transfers its buffer.
      this.task = engine.getDocument({
        data: data.slice(), useWasm: false, useWorkerFetch: false, useSystemFonts: true,
        BinaryDataFactory: LocalPdfResources, cMapPacked: true, verbosity: 0
      });
      this.doc = await this.task.promise;
      const first = (await this.doc.getPage(1)).getViewport({scale: 1});
      if (this.closed) return;

      const stack = document.createElement("div");
      stack.className = "pdf-pages";
      const placeholder = first.width + " / " + first.height;
      stack.style.setProperty("--sheet-ratio", placeholder);
      this.sheets = Array.from({length: this.doc.numPages}, (_, index) => {
        const sheet = document.createElement("div");
        sheet.className = "pdf-sheet";
        sheet.dataset.page = index + 1;
        return sheet;
      });
      stack.append(...this.sheets);
      this.node.replaceChildren(stack);
      this.node.removeAttribute("aria-busy");
      this.intersection = new IntersectionObserver((entries) => {
        for (const {target, isIntersecting} of entries) {
          if (isIntersecting) this.paint(target);
          else this.release(target);
        }
      }, {root: this.node, rootMargin: "340px 0px"});
      this.resize();
      this.jump(this.page);
      this.sheets.forEach((sheet) => this.intersection.observe(sheet));
    } catch (error) {
      if (this.closed) return;
      console.error(error);
      this.node.removeAttribute("aria-busy");
      this.status.textContent = "无法在工作台内显示此 PDF。可在侧边「阅读」中单独打开原文件。";
    }
  }

  resize() {
    const width = Math.max(100, Math.min(1060, this.node.clientWidth - 18) * this.zoom);
    if (this.width === width) {
      this.updateTail();
      return;
    }
    this.width = width;
    this.node.style.setProperty("--sheet-width", width + "px");
    this.updateTail();
    this.jump(this.page);
    const active = [...this.jobs.keys()];
    for (const sheet of active) {
      this.release(sheet);
      this.paint(sheet);
    }
  }

  updateTail() {
    const last = this.sheets.at(-1);
    if (last) {
      const padding = Math.max(12, this.node.clientHeight - last.offsetHeight + 8);
      this.node.style.setProperty("--tail-space", padding + "px");
    }
  }

  setZoom(zoom) {
    this.zoom = zoom;
    this.resize();
  }

  jump(page) {
    this.page = this.doc ? Math.max(1, Math.min(page, this.doc.numPages)) : page;
    const sheet = this.sheets[this.page - 1];
    if (sheet) this.node.scrollTop = Math.max(0, sheet.offsetTop - 8);
  }

  detectPage() {
    if (!this.sheets.length || this.closed) return;
    const top = this.node.scrollTop + 48;
    const next = this.sheets.findIndex((sheet) => sheet.offsetTop > top);
    const page = next < 0 ? this.sheets.length : Math.max(1, next);
    if (page === this.page) return;
    this.page = page;
    this.onPage(page);
  }

  async paint(sheet) {
    if (this.closed || this.jobs.has(sheet)) return;
    const job = {};
    this.jobs.set(sheet, job);
    const current = () => !this.closed && this.jobs.get(sheet) === job;
    try {
      const pdfPage = await this.doc.getPage(Number(sheet.dataset.page));
      if (!current()) return;
      const base = pdfPage.getViewport({scale: 1});
      const viewport = pdfPage.getViewport({scale: this.width / base.width});
      sheet.style.setProperty("--sheet-ratio", base.width + " / " + base.height);
      if (sheet === this.sheets.at(-1)) this.updateTail();
      const scale = Math.min(window.devicePixelRatio || 1, 1.8);
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width * scale);
      canvas.height = Math.ceil(viewport.height * scale);
      canvas.setAttribute("aria-hidden", "true");
      const text = document.createElement("div");
      text.className = "textLayer";
      text.style.setProperty("--total-scale-factor", viewport.scale);
      sheet.replaceChildren(canvas, text);
      job.draw = pdfPage.render({canvas, viewport, transform: [scale, 0, 0, scale, 0, 0]});
      job.text = new this.engine.TextLayer({textContentSource: pdfPage.streamTextContent(), container: text, viewport});
      await Promise.all([job.draw.promise, job.text.render()]);
      if (current()) sheet.dataset.rendered = "true";
      if (this.version.translatedFrom && Number(sheet.dataset.page) <= this.version.translationPages && current()) {
        void this.addTranslationLink(pdfPage, viewport, sheet, current).catch(() => {});
      }
    } catch (error) {
      if (!current()) return;
      console.error(error);
      const failed = document.createElement("p");
      failed.className = "pdf-status";
      failed.textContent = "第 " + sheet.dataset.page + " 页暂时无法绘制。";
      sheet.replaceChildren(failed);
    }
  }

  async addTranslationLink(pdfPage, viewport, sheet, current) {
    const annotations = await pdfPage.getAnnotations();
    if (!current()) return;
    const annotation = annotations.find((item) => item.subtype === "Link" && Array.isArray(item.dest));
    if (!annotation) return;
    const [ref] = annotation.dest;
    const page = 1 + (Number.isInteger(ref) ? ref : await this.doc.getPageIndex(ref));
    if (!current()) return;
    const [left, bottom, right, top] = annotation.rect;
    const [a, b, c, d, e, f] = viewport.transform;
    const x0 = a * left + c * bottom + e;
    const y0 = b * left + d * bottom + f;
    const x1 = a * right + c * top + e;
    const y1 = b * right + d * top + f;
    const link = document.createElement("button");
    link.type = "button";
    link.className = "pdf-translation-link";
    link.setAttribute("aria-label", "查看本页原文及图表");
    link.style.left = Math.min(x0, x1) + "px";
    link.style.top = Math.min(y0, y1) + "px";
    link.style.width = Math.abs(x1 - x0) + "px";
    link.style.height = Math.abs(y1 - y0) + "px";
    link.addEventListener("click", () => {
      this.jump(page);
      this.onPage(page);
    });
    sheet.append(link);
  }

  release(sheet) {
    const job = this.jobs.get(sheet);
    if (!job) return;
    this.jobs.delete(sheet);
    job.draw?.cancel();
    job.text?.cancel();
    sheet.replaceChildren();
    delete sheet.dataset.rendered;
  }

  destroy() {
    this.closed = true;
    cancelAnimationFrame(this.scrollFrame);
    this.resizeObserver.disconnect();
    this.intersection?.disconnect();
    for (const sheet of this.jobs.keys()) this.release(sheet);
    void this.task?.destroy().catch(() => {});
    this.node.remove();
  }
}

