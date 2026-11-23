"use strict";

const savedCatalog = window.PAPER_CATALOG;
const catalog = savedCatalog?.schemaVersion === 1 && Array.isArray(savedCatalog.papers) &&
  Array.isArray(savedCatalog.categories) ? savedCatalog : null;
const papers = catalog?.papers || [];
const categories = catalog?.categories || [];
const paperById = new Map(papers.map((paper) => [paper.id, paper]));
const categoryById = new Map(categories.map((category) => [category.id, category]));
const palette = ["#17826b", "#4575ae", "#a6683d", "#7965a7", "#64854d"];
const categoryColors = new Map(categories.map((category, index) => [category.id, palette[index % palette.length]]));
const cursorByVersion = new Map();
const pdfViews = new Map();
const state = {
  view: "library", category: "", selected: papers[0]?.id,
  edition: "", otherEdition: "", tocEdition: "", tab: "reading", railCategory: "", drafts: new Map()
};
const $ = (id) => document.getElementById(id);
const sortField = $("paper-sort-field");
const sortDirection = $("paper-sort-direction");
const sortStorageKey = "paper-workbench:sort:" + location.pathname;
const intakeTimeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short", hourCycle: "h23"
});
const citationFormat = new Intl.NumberFormat("zh-CN");
let records = [];
let database;
let loadError = "";
let toastTimer;
let backupBusy = false;
let renderedThoughtDraft;
let tipAnchor = null;
let introAnchor = null;
const paperIntro = $("paper-intro");
const thoughtWindow = new FloatingWindow($("thought-window"), $("thought-handle"),
  "paper-workbench:thought-window:" + location.pathname);

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((value) => value != null));
  return node;
}

function button(label, click, attrs = {}) {
  return h("button", {type: "button", onclick: click, ...attrs}, label);
}

function tell(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4800);
}

function report(error) {
  console.error(error);
  tell(error?.message || "操作失败，请重试。");
}

function paperTitle(paper) {
  return paper.title?.zh || paper.title?.en || paper.versions[0]?.file.split("/").pop() || "未命名论文";
}

function shortTitle(paper) {
  const title = paper.shortTitle?.trim();
  if (title) return title;
  const prefix = paperTitle(paper).split(/[:：]/, 1)[0];
  return Array.from(prefix).slice(0, 11).join("");
}

function paperMetadata(paper, linkImpact = false) {
  const addedAt = Date.parse(paper.addedAt);
  const impact = paper.impact;
  let citations;
  if (Number.isSafeInteger(impact?.citationCount) && impact.citationCount >= 0) {
    const url = linkImpact && /^W[0-9]+$/.test(impact.openAlexId) ? "https://openalex.org/" + impact.openAlexId : null;
    citations = h(url ? "a" : "span", {
      class: "citation-count", title: ["OpenAlex", impact.checkedOn].filter(Boolean).join(" · "),
      href: url, target: url ? "_blank" : null, rel: url ? "noopener" : null
    }, "被引 " + citationFormat.format(impact.citationCount) + " 次");
  }
  return h("span", {class: "publication"},
    paper.published ? h("time", {datetime: paper.published}, "发表 " + paper.published) : null,
    Number.isFinite(addedAt) ? h("time", {datetime: paper.addedAt}, "入库 " + intakeTimeFormat.format(addedAt)) : null,
    citations,
    paper.team ? h("span", {class: "team", title: paper.team}, paper.team) : null);
}

function versionLabel(version) {
  const lang = {zh: "中文译本", en: "英文原文"}[version.language] || version.language;
  return [lang, version.revision].filter(Boolean).join(" ");
}

function pdfUrl(version, page) {
  return "data/" + version.file.split("/").map(encodeURIComponent).join("/") + "#page=" + page;
}

function phraseMatch(value, query) {
  const words = value.normalize("NFKC").toLowerCase();
  return query.normalize("NFKC").toLowerCase().trim().split(/\s+/).every((term) => words.includes(term));
}

function empty(message) {
  return h("p", {class: "empty"}, message);
}

function categoryTag(paper) {
  const category = categoryById.get(paper.category);
  return h("span", {class: "category-tag", style: "--category-color:" + (categoryColors.get(category?.id) || "#738980")},
    category?.label || "未分类");
}

function papersIn(id, query = "") {
  const matches = papers.filter((paper) => inCategory(paper, id) &&
    phraseMatch([paper.id, paper.title?.zh, paper.title?.en, paper.shortTitle, paper.team, paper.published, paper.addedAt,
      paper.description?.zh, paper.description?.en, categoryById.get(paper.category)?.label,
      ...(paper.tags || []), ...paper.versions.flatMap((version) => [version.file, version.sourceFile])].join(" "), query));
  const field = sortField.value;
  const direction = sortDirection.value === "asc" ? 1 : -1;
  const value = field === "impact" ? (paper) => paper.impact?.citationCount : (paper) => Date.parse(paper[field]);
  return matches.sort((left, right) => {
    const a = value(left);
    const b = value(right);
    if (!Number.isFinite(a)) return Number.isFinite(b) ? 1 : 0;
    if (!Number.isFinite(b)) return -1;
    return (a - b) * direction;
  });
}

function restorePaperSort() {
  try {
    const saved = JSON.parse(localStorage.getItem(sortStorageKey));
    if ([...sortField.options].some((option) => option.value === saved?.field)) sortField.value = saved.field;
    if ([...sortDirection.options].some((option) => option.value === saved?.direction)) sortDirection.value = saved.direction;
  } catch {
    // The default controls also work with storage disabled.
  }
}

function changePaperSort() {
  try {
    localStorage.setItem(sortStorageKey, JSON.stringify({field: sortField.value, direction: sortDirection.value}));
  } catch {
    // Apply this session's sort even when storage is unavailable.
  }
  renderLibrary();
}

function inCategory(paper, id) {
  if (!id) return true;
  if (id === "uncategorized") return !categoryById.has(paper.category);
  return paper.category === id;
}

const categoryCounts = new Map([["", papers.length]]);
for (const paper of papers) {
  const id = categoryById.has(paper.category) ? paper.category : "uncategorized";
  categoryCounts.set(id, (categoryCounts.get(id) || 0) + 1);
}
const categoryGroups = [{id: "", label: "全部文献", shortLabel: "全部"}, ...categories];
if (categoryCounts.has("uncategorized")) {
  categoryGroups.push({id: "uncategorized", label: "未分类"});
}

function categoryButtons(active, choose, compact = false) {
  return categoryGroups.map(({id, label, shortLabel}) => {
    const count = categoryCounts.get(id) || 0;
    const item = button(h("i", {"aria-hidden": "true"}), () => choose(id), {
      class: "category", "data-category": id, "aria-pressed": id === active,
      "aria-label": compact ? label : null, title: compact ? label : null,
      style: "--category-color:" + (categoryColors.get(id) || "#538477")
    });
    item.append(h("span", {class: "category-label"}, compact ? shortLabel?.trim() || label : label));
    if (!compact) item.append(h("span", {class: "count"}, String(count)));
    return item;
  });
}

function paperCard(paper, choose, full) {
  const card = button(h("strong", {}, paperTitle(paper)), () => choose(paper),
    {class: "paper-card", "data-paper": paper.id, "aria-pressed": paper.id === state.selected});
  if (full && paper.title?.zh && paper.title?.en) {
    card.append(h("span", {class: "secondary", lang: "en"}, paper.title.en));
  }
  card.append(h("span", {class: "card-meta"}, paperMetadata(paper)));
  return card;
}

function renderLibrary() {
  $("categories").replaceChildren(...categoryButtons(state.category, (id) => {
    state.category = id;
    renderLibrary();
    $("categories").querySelector('[aria-pressed="true"]')?.focus({preventScroll: true});
  }));
  $("collection-title").textContent = categoryGroups.find((group) => group.id === state.category)?.label || "全部文献";
  const filtered = papersIn(state.category, $("paper-search").value);
  if (!filtered.some((paper) => paper.id === state.selected)) state.selected = filtered[0]?.id;
  $("collection-meta").textContent = filtered.length + " 篇论文";
  $("paper-list").replaceChildren(...filtered.map((paper) => paperCard(paper, (chosen) => {
    state.selected = chosen.id;
    updateSelectedCard();
    renderDetail(chosen);
    if (matchMedia("(max-width: 560px)").matches) $("paper-detail").scrollIntoView({block: "start"});
  }, true)));
  if (!filtered.length) {
    const message = !catalog ? "还没有可读取的目录。请运行「temp/同步论文目录.ps1」初始化或同步资料库。" :
      !papers.length && !state.category ? "资料库是空的。把新 PDF 放入 data/新论文临时区，按工作台说明入库后再同步目录。" :
      "当前筛选下没有论文。";
    $("paper-list").append(empty(message));
  }
  renderDetail(paperNow());
}

function updateSelectedCard() {
  for (const card of $("paper-list").children) {
    if (card.dataset.paper) card.setAttribute("aria-pressed", String(card.dataset.paper === state.selected));
  }
}

function renderDetail(paper) {
  const panel = $("paper-detail");
  if (panel.contains(introAnchor)) closePaperIntro();
  panel.replaceChildren();
  if (!paper) {
    panel.append(empty("选择一篇论文查看版本和摘要。"));
    return;
  }
  const head = h("div", {class: "detail-heading"}, categoryTag(paper), h("h2", {}, paperTitle(paper)));
  if (paper.title?.zh && paper.title?.en) head.append(h("p", {class: "muted", lang: "en"}, paper.title.en));
  head.append(paperMetadata(paper, true));
  const versions = h("div", {class: "editions"});
  for (const version of paper.versions) {
    const open = button(h("span", {}, versionLabel(version)), () => openReader(paper, version), {class: "edition"});
    if (version.pages) open.append(h("span", {}, version.pages + " 页"));
    versions.append(open);
  }
  if (pairedVersions(paper).length === 2) {
    versions.append(button("中英对照", () => openReader(paper, null, null, {compare: true}), {class: "edition"}));
  }
  panel.append(head, h("section", {}, paper.versions.length ? versions : empty("还没有 PDF 文件。")));
  panel.append(h("section", {class: "detail-section"}, paperSummary(paper)));
  if (paper.tags?.length) panel.append(h("section", {class: "detail-section"}, h("h3", {}, "标签"),
    h("div", {class: "tags"}, ...paper.tags.map((tag) => h("span", {class: "tag"}, tag)))));
  const related = activeNotes().filter((note) => note.paperId === paper.id);
  if (related.length) panel.append(h("section", {class: "detail-section"},
    h("h3", {}, "阅读笔记"), button("查看 " + related.length + " 条笔记", () => viewNote(related[0]), {class: "quiet"})));
}

function paperSummary(paper) {
  const description = paper.description?.zh || paper.description?.en;
  const label = h("span", {class: "summary-label"}, "内容简介");
  const body = h("span", {class: "summary-text"}, description || "待补充");
  const content = [label, body];
  if (!paper.overview?.length) return h("div", {class: "paper-summary"}, ...content);

  label.append(h("span", {class: "summary-arrow", "aria-hidden": "true"}, "‹"));
  return h("button", {
    type: "button", class: "paper-summary summary-trigger",
    popovertarget: "paper-intro", "aria-haspopup": "dialog", title: "查看详细内容介绍",
    onclick: (event) => {
      introAnchor = event.currentTarget;
      $("paper-intro-title").textContent = paperTitle(paper);
      $("paper-intro-sections").replaceChildren(...paper.overview.map(({title, text}) =>
        h("section", {}, h("h3", {}, title), h("p", {}, text))));
    }
  }, ...content);
}

function closePaperIntro() {
  if (paperIntro.matches(":popover-open")) paperIntro.hidePopover();
}

function positionPaperIntro() {
  if (!paperIntro.matches(":popover-open") || !introAnchor?.isConnected) return;
  const anchor = introAnchor.getBoundingClientRect();
  const gap = 12;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const availableLeft = anchor.left - gap * 2;
  const placeLeft = availableLeft >= 300;
  const width = Math.min(465, placeLeft ? availableLeft : viewportWidth - gap * 2);
  paperIntro.style.width = width + "px";
  paperIntro.style.left = (placeLeft ? anchor.left - gap - width : (viewportWidth - width) / 2) + "px";
  const height = paperIntro.offsetHeight;
  const top = !placeLeft && anchor.top - gap >= height ? anchor.top - gap - height : anchor.top;
  paperIntro.style.top = Math.max(gap, Math.min(top, viewportHeight - height - gap)) + "px";
}

function paperNow() {
  return paperById.get(state.selected);
}

function versionById(paper, id) {
  return paper?.versions.find((version) => version.id === id);
}

function pageInVersionLayout(version, page, layout) {
  if (!Number.isSafeInteger(page) || !version?.legacyPageMap || version.pageLayout === layout) return page;
  return version.legacyPageMap[page - 1] ?? page;
}

function noteInCurrentLayout(note) {
  const version = versionById(paperById.get(note.paperId), note.versionId);
  if (!version?.pageLayout || note.pageLayout === version.pageLayout || note.deleted) return note;
  return {...note, page: pageInVersionLayout(version, note.page, note.pageLayout), pageLayout: version.pageLayout};
}

function versionNow() {
  return versionById(paperNow(), state.edition);
}

function pairedVersions(paper, preferred, other) {
  return ["zh", "en"].map((language) =>
    [preferred, other].find((version) => version?.language === language) ||
    paper.versions.find((version) => version.language === language)
  ).filter(Boolean);
}

function readingVersions() {
  const paper = paperNow();
  const active = versionNow();
  return state.otherEdition ? pairedVersions(paper, active, versionById(paper, state.otherEdition)) :
    active ? [active] : [];
}

function cursorKey(paper, version) {
  return paper.id + "/" + version.id;
}

function pageFor(version) {
  return cursorByVersion.get(cursorKey(paperNow(), version)) || 1;
}

function validPage(version, page) {
  return version && Number.isSafeInteger(page) && page > 0 && (!version.pages || page <= version.pages);
}

function setPage(version, page) {
  if (validPage(version, page)) cursorByVersion.set(cursorKey(paperNow(), version), page);
}

function setDrawer(open, restoreFocus = true) {
  const wasOpen = !$("nav-drawer").hidden;
  $("toggle-nav").setAttribute("aria-expanded", String(open));
  $("nav-drawer").hidden = !open;
  $("nav-shade").hidden = !open;
  for (const region of [$("reader-nav"), $("pdf-pane"), $("reading-panel").parentElement]) region.inert = open;
  if (open) {
    renderDrawer();
    $("nav-search").focus();
  } else if (wasOpen && restoreFocus) $("toggle-nav").focus({preventScroll: true});
}

function chooseReadingPaper(paper) {
  if (paper.id === state.selected) {
    setDrawer(false);
    return;
  }
  const compare = Boolean(state.otherEdition);
  const version = paper.versions.find((candidate) => candidate.language === versionNow()?.language) || paper.versions[0];
  openReader(paper, version, null, {compare, tab: state.tab});
}

function renderReaderNav() {
  const choose = (id) => {
    state.railCategory = id;
    renderReaderNav();
    $("rail-categories").querySelector('[aria-pressed="true"]')?.focus({preventScroll: true});
  };
  $("rail-categories").replaceChildren(...categoryButtons(state.railCategory, choose, true));
  const items = papersIn(state.railCategory);
  $("rail-papers").replaceChildren(...items.map((paper) =>
    button(shortTitle(paper), () => chooseReadingPaper(paper), {
      class: "rail-paper", title: paperTitle(paper), "data-paper": paper.id,
      "aria-label": paperTitle(paper), "aria-current": paper.id === state.selected ? "page" : null
    })));
  $("rail-papers").querySelector('[aria-current="page"]')?.scrollIntoView({block: "nearest"});
}

function renderDrawer() {
  $("drawer-categories").replaceChildren(...categoryButtons(state.railCategory, (id) => {
    state.railCategory = id;
    renderReaderNav();
    renderDrawer();
    $("drawer-categories").querySelector('[aria-pressed="true"]')?.focus({preventScroll: true});
  }));
  const matches = papersIn(state.railCategory, $("nav-search").value);
  $("drawer-papers").replaceChildren(...matches.map((paper) => paperCard(paper, chooseReadingPaper, false)));
  if (!matches.length) $("drawer-papers").append(empty("当前筛选下没有论文。"));
}

function setView(view) {
  if (state.view !== view) {
    hidePaperNoteTip();
    closePaperIntro();
  }
  state.view = view;
  const reading = view === "reader";
  $("topbar").hidden = reading;
  $("library").hidden = view !== "library";
  $("reader").hidden = !reading;
  $("all-notes").hidden = view === "library" || reading;

  const backupHome = reading ? $("reader-backup-slot") : $("topbar");
  if ($("backup-tools").parentElement !== backupHome) {
    $("backup").open = false;
    backupHome.append($("backup-tools"));
  }
  for (const [id, active] of [["show-library", view === "library"], ["show-notes", !reading && view !== "library"]]) {
    if (active) $(id).setAttribute("aria-current", "page");
    else $(id).removeAttribute("aria-current");
  }
  if (!reading) {
    setDrawer(false, false);
    clearPdfs();
  }
  syncHash();
  if (view === "library") renderLibrary();
  if (view === "notes") renderAllNotes();
}

function syncHash() {
  let hash = "";
  if (state.view === "reader") {
    const active = versionNow();
    const params = new URLSearchParams({paper: state.selected, version: state.edition, page: active ? pageFor(active) : 1});
    if (active?.pageLayout) params.set("layout", active.pageLayout);
    const other = versionById(paperNow(), state.otherEdition);
    if (other) {
      params.set("compare", other.id);
      params.set("otherPage", pageFor(other));
      if (other.pageLayout) params.set("otherLayout", other.pageLayout);
    }
    if (state.tab !== "reading") params.set("tab", state.tab);
    hash = "#" + params;
  } else if (state.view === "notes") {
    hash = "#" + state.view;
  }
  history.replaceState(null, "", location.pathname + location.search + hash);
}

function openReader(paper, version, page, options = {}) {
  const previousPaper = state.selected;
  const fromDrawer = !$("nav-drawer").hidden;
  state.selected = paper.id;
  const active = version || paper.versions[0];
  state.edition = active?.id || "";
  const pair = options.compare ? pairedVersions(paper, active, options.other) : [];
  state.otherEdition = pair.length === 2 ? pair.find((item) => item.id !== state.edition)?.id || "" : "";
  state.tocEdition = state.edition;
  state.tab = ["notes", "toc"].includes(options.tab) ? options.tab : "reading";
  setPage(active, page);
  setPage(versionById(paper, state.otherEdition), options.otherPage);
  setDrawer(false, false);
  window.scrollTo(0, 0);
  setView("reader");
  if (!inCategory(paper, state.railCategory)) state.railCategory = "";
  if (previousPaper !== paper.id) clearPdfs();
  const title = $("reader-title");
  title.textContent = shortTitle(paper);
  title.title = paperTitle(paper);
  renderReaderNav();
  renderReading({scrollEnd: !options.noteId});
  if (fromDrawer) $("rail-papers").querySelector('[aria-current="page"]')?.focus({preventScroll: true});
  if (options.noteId) scrollToNote(options.noteId);
}

function scrollToNote(id) {
  const panel = $("reading-panel");
  const entry = Array.from(panel.querySelectorAll("[data-note]")).find((node) => node.dataset.note === id);
  entry?.scrollIntoView({block: "nearest"});
}

function toggleComparison() {
  const active = versionNow();
  const pair = pairedVersions(paperNow(), active);
  if (pair.length !== 2) return;
  state.otherEdition = state.otherEdition ? "" : pair.find((version) => version.id !== active?.id).id;
  if (!readingVersions().some((version) => version.id === state.tocEdition)) state.tocEdition = state.edition;
  renderReading();
}

function chooseVersion(version) {
  const other = readingVersions().find((candidate) => candidate.language !== version.language);
  if (state.otherEdition && other) state.otherEdition = other.id;
  state.edition = version.id;
  state.tocEdition = version.id;
  renderReading();
  $("reading-panel").querySelector('[data-version-choice][aria-pressed="true"]')?.focus({preventScroll: true});
}

function renderReading(options) {
  const active = Boolean(state.otherEdition);
  const compare = $("compare");
  compare.disabled = pairedVersions(paperNow()).length !== 2;
  compare.setAttribute("aria-pressed", String(active));
  compare.title = compare.disabled ? "需要中文译本和英文原文" : "";
  syncHash();
  syncPdfs();
  renderSide(options);
}

function clearPdfs() {
  for (const view of pdfViews.values()) view.destroy();
  pdfViews.clear();
  $("pdf-pane").replaceChildren();
}

function syncPdfs() {
  const pane = $("pdf-pane");
  const paper = paperNow();
  const visible = readingVersions();
  pane.classList.toggle("parallel", visible.length === 2);
  for (const [id, view] of pdfViews) {
    if (!visible.some((version) => version.id === id)) {
      view.destroy();
      pdfViews.delete(id);
    }
  }
  if (!visible.length) {
    pane.replaceChildren(empty("这篇论文还没有 PDF 文件。"));
    return;
  }
  pane.querySelector(".empty")?.remove();
  visible.forEach((version, index) => {
    let view = pdfViews.get(version.id);
    if (!view) {
      view = new LocalPdfView(version, paperTitle(paper) + " · " + versionLabel(version),
        pageFor(version), (page) => updateReadingPosition(version, page));
      pdfViews.set(version.id, view);
    } else if (view.page !== pageFor(version)) {
      view.jump(pageFor(version));
    }
    if (pane.children[index] !== view.node) pane.insertBefore(view.node, pane.children[index] || null);
  });
}

function jump(version, page, section) {
  if (!validPage(version, page)) return;
  pdfViews.get(version.id)?.jump(page);
  updateReadingPosition(version, page, section, true);
}

function updateReadingPosition(version, page, section, force = false) {
  setPage(version, page);
  syncHash();
  const panel = $("reading-panel");
  const field = panel.querySelector('[data-page-input="' + version.id + '"]');
  if (field && (force || field !== document.activeElement)) field.value = page;
  const link = panel.querySelector('[data-open-version="' + version.id + '"]');
  if (link) link.href = pdfUrl(version, page);
  if (state.tab === "toc" && state.tocEdition === version.id) {
    panel.querySelector('[aria-current="location"]')?.removeAttribute("aria-current");
    const activeEntry = section || panel.querySelector('[data-page="' + page + '"]');
    activeEntry?.setAttribute("aria-current", "location");
  }
  const notePage = panel.querySelector(".note-location input");
  const noteVersion = panel.querySelector(".note-location select");
  if (notePage && noteVersion?.value === version.id) notePage.placeholder = String(page);
}

function zoomControl(version) {
  const view = pdfViews.get(version.id);
  const selected = view?.zoom || 1;
  const options = [[.8, "80%"], [1, "适合栏宽"], [1.25, "125%"], [1.5, "150%"], [2, "200%"]];
  const select = h("select", {"aria-label": versionLabel(version) + "缩放",
    onchange: (event) => view?.setZoom(Number(event.target.value))},
  ...options.map(([zoom, label]) => h("option", {value: zoom, selected: selected === zoom ? "" : null}, label)));
  return select;
}

function renderReadingOptions(panel) {
  const paper = paperNow();
  panel.append(h("h2", {class: "reading-paper-title"}, paperTitle(paper)), paperMetadata(paper));
  if (!paper.versions.length) return;
  if (paper.description?.zh || paper.description?.en || paper.overview?.length) {
    panel.append(h("div", {class: "reading-description"}, paperSummary(paper)));
  }
  if (paper.tags?.length) {
    panel.append(h("div", {class: "tags"}, ...paper.tags.map((tag) => h("span", {class: "tag"}, tag))));
  }
  const versions = h("div", {class: "versions", "aria-label": "PDF 版本"});
  for (const candidate of paper.versions) {
    versions.append(button(versionLabel(candidate), () => chooseVersion(candidate), {
      class: "version", "data-version-choice": candidate.id, "aria-pressed": candidate.id === state.edition
    }));
  }
  panel.append(h("section", {class: "reading-options"}, versions, ...readingVersions().map((version) => {
    const page = pageFor(version);
    const field = h("input", {type: "number", min: 1, max: version.pages || null, value: page, required: "",
      "data-page-input": version.id, "aria-label": versionLabel(version) + "跳转页码"});
    const form = h("form", {class: "page-form", onsubmit: (event) => {
      event.preventDefault();
      jump(version, field.valueAsNumber);
    }}, field, h("button", {class: "quiet"}, "跳页"));
    return h("div", {class: "page-control"}, h("p", {class: "muted"}, versionLabel(version)),
      h("div", {class: "page-control-actions"}, form, h("a", {class: "quiet", href: pdfUrl(version, page), target: "_blank",
        rel: "noopener", "data-open-version": version.id}, "单独打开 PDF")), zoomControl(version));
  })));
}

function renderSide({scrollEnd = false} = {}) {
  const notes = activeNotes().filter((note) => note.paperId === state.selected);
  const tabs = [["reading", "阅读"], ["toc", "章节"], ["notes", "笔记" + (notes.length ? " " + notes.length : "")]];
  $("reading-tabs").replaceChildren(...tabs.map(([id, label]) => button(label, () => {
    state.tab = id;
    syncHash();
    renderSide({scrollEnd: id === "notes"});
    $("reading-tabs").querySelector('[aria-pressed="true"]')?.focus({preventScroll: true});
  }, {class: "quiet", "aria-pressed": state.tab === id})));
  const panel = $("reading-panel");
  const scrollMode = state.tab === "notes";
  panel.classList.toggle("conversation-panel", scrollMode);
  const previous = panel.querySelector(".message-history")?.scrollTop || 0;
  if (panel.contains(introAnchor)) closePaperIntro();
  panel.replaceChildren();
  if (scrollMode) {
    renderConversation(panel, state.selected, notes, scrollEnd, previous);
  } else if (state.tab === "reading") {
    renderReadingOptions(panel);
  } else {
    renderToc(panel);
  }
}

function renderToc(panel) {
  const editions = readingVersions();
  const version = editions.find((candidate) => candidate.id === state.tocEdition) || editions[0];
  if (editions.length === 2) {
    const choices = h("div", {class: "versions toc-versions", "aria-label": "章节对应版本"});
    choices.append(...editions.map((candidate) => button(versionLabel(candidate), () => {
      state.tocEdition = candidate.id;
      renderSide();
      $("reading-panel").querySelector('.toc-versions [aria-pressed="true"]')?.focus({preventScroll: true});
    }, {class: "version", "aria-pressed": candidate.id === version.id})));
    panel.append(choices);
  }
  const toc = version?.toc || [];
  if (!toc.length) {
    panel.append(empty("暂无章节目录。可在「阅读」中输入页码跳转。"));
    return;
  }
  const current = toc.find((entry) => entry.page === pageFor(version));
  panel.append(h("nav", {class: "toc", "aria-label": "章节目录"}, ...toc.map((entry) => {
    const row = button(h("span", {}, entry.title), (event) => jump(version, entry.page, event.currentTarget),
      {style: "--indent:" + Math.min(4, Math.max(0, (entry.level || 1) - 1)),
        "data-page": entry.page, "aria-current": entry === current ? "location" : null});
    row.append(h("span", {}, "第 " + entry.page + " 页"));
    return row;
  })));
}


function activeNotes() {
  return records.filter((note) => !note.deleted).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function updateNoteViews({scrollEnd = false, paperId} = {}) {
  if (state.view === "notes") renderAllNotes();
  if (state.view === "reader" && (paperId === undefined || paperId === state.selected)) renderSide({scrollEnd});
  if (state.view === "library") renderDetail(paperNow());
  if (!$("thought-window").hidden) renderThoughts(scrollEnd && paperId == null);
}

function renderAllNotes() {
  const query = $("note-search").value;
  const notes = activeNotes().filter((note) => {
    const paper = paperById.get(note.paperId);
    return phraseMatch([note.title, note.body, ...(note.images || []).map((image) => image.name),
      paper?.title?.zh, paper?.title?.en, paper?.shortTitle, note.paperId || "随想录"].join(" "), query);
  });
  $("all-notes-meta").textContent = notes.length + " 条笔记";
  const list = $("all-notes-list");
  if (list.contains(tipAnchor)) hidePaperNoteTip();
  list.replaceChildren(...notes.map((note) => noteCard(note, "all")));
  if (!notes.length) list.append(empty(loadError || (query ? "没有符合搜索条件的笔记。" : "还没有笔记。可以在论文旁记录，也可以写一条随想。")));
}

function renderThoughts(scrollEnd = false) {
  const history = $("thought-history");
  const following = history.scrollHeight - history.scrollTop - history.clientHeight < 35;
  renderMessages(history, activeNotes(), scrollEnd || following, history.scrollTop, "thoughts");
  const composer = $("thought-composer");
  // Keep the input and its selection intact when a note arrives from the reading pane.
  const key = database ? draftFor(null) : loadError || "正在读取本机笔记…";
  if (key !== renderedThoughtDraft) {
    renderedThoughtDraft = key;
    composer.replaceChildren(database ? noteComposer(null) : empty(key));
  }
}

function showThoughts({focus = true, noteId = ""} = {}) {
  const opening = $("thought-window").hidden;
  thoughtWindow.show();
  $("open-thoughts").setAttribute("aria-expanded", "true");
  if (opening) renderThoughts(true);
  if (focus) (activeComposer(null) || $("close-thoughts")).focus({preventScroll: true});
  if (noteId) scrollToThought(noteId);
}

function hideThoughts() {
  hidePaperNoteTip();
  thoughtWindow.hide();
  $("open-thoughts").setAttribute("aria-expanded", "false");
  $("open-thoughts").focus({preventScroll: true});
}

function scrollToThought(noteId) {
  const entry = Array.from($("thought-history").children).find((node) => node.dataset.note === noteId);
  entry?.scrollIntoView({block: "nearest"});
}

function renderConversation(panel, paperId, messages, scrollEnd, previous) {
  const list = h("div", {class: "message-history", "aria-label": "论文消息记录"});
  panel.append(list, database ? noteComposer(paperId) : empty(loadError || "正在读取本机笔记…"));
  renderMessages(list, messages, scrollEnd, previous, "paper");
}

function renderMessages(list, notes, scrollEnd, previous, mode) {
  const ordered = [...notes].sort((a, b) => (a.createdAt || a.updatedAt).localeCompare(b.createdAt || b.updatedAt));
  if (list.contains(tipAnchor)) hidePaperNoteTip();
  list.replaceChildren(...ordered.map((note) => noteCard(note, mode)));
  if (!notes.length && database) list.append(h("p", {class: "chat-empty muted"}, "写一条文字或粘贴截图，开始记录。"));
  list.scrollTop = scrollEnd ? list.scrollHeight : previous;
}

const formatDate = new Intl.DateTimeFormat("zh-CN", {dateStyle: "medium", timeStyle: "short"});
function noteCard(note, mode) {
  const paper = paperById.get(note.paperId);
  const version = versionById(paper, note.versionId);
  const all = mode === "all";
  const meta = [all && !note.paperId ? "随想录" : "", version ? versionLabel(version) : "",
    note.page ? "第 " + note.page + " 页" : "", formatDate.format(new Date(note.createdAt || note.updatedAt))].filter(Boolean).join(" · ");
  const card = h("article", {class: all ? "note-card" : "message", "data-note": note.id});
  const context = h("div", {class: "note-context"},
    note.paperId && mode !== "paper" ? noteSource(note, paper, version) : null, h("p", {class: "muted message-meta"}, meta));
  const bubble = h("div", {class: all ? "note-content" : "message-bubble"});
  if (note.title) bubble.append(h("h3", {}, note.title));
  if (note.body) bubble.append(h("p", {class: "note-text"}, note.body));
  if (note.images.length) bubble.append(h("div", {class: "thumbnails"}, ...note.images.map((image, index) => thumbnail(image, index))));
  card.append(context, bubble);
  const actions = h("div", {class: "note-actions"});
  if (paper && (all || mode === "paper" && version)) {
    actions.append(button(all ? "打开论文与笔记" : note.page ? "定位" : "打开版本", () => viewNote(note), {class: "quiet"}));
  }
  if (all && !note.paperId) actions.append(button("打开随想录", () => showThoughts({noteId: note.id}), {class: "quiet"}));
  if (mode === "paper" || mode === "thoughts" && !note.paperId) {
    actions.append(button("编辑", () => editNote(note), {class: "quiet"}));
  }
  actions.append(button("删除", () => deleteNote(note), {class: "quiet danger"}));
  card.append(actions);
  return card;
}

function noteSource(note, paper, recordedVersion) {
  const version = recordedVersion || paper?.versions[0];
  const page = recordedVersion && validPage(recordedVersion, note.page) ? note.page : 1;
  const label = "论文 · " + (paper ? shortTitle(paper) : note.paperId);
  const anchor = version ? h("a", {class: "note-source", href: pdfUrl(version, page), target: "_blank", rel: "noopener"}, label)
    : h("span", {class: "note-source", tabindex: "0"}, label);
  const show = () => showPaperNoteTip(anchor, paper, version, page);
  const hide = () => {
    if (tipAnchor === anchor) hidePaperNoteTip();
  };
  anchor.addEventListener("pointerenter", show);
  anchor.addEventListener("pointerleave", hide);
  anchor.addEventListener("focus", show);
  anchor.addEventListener("blur", hide);
  if (version) anchor.addEventListener("click", (event) => {
    hide();
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const width = Math.min(screen.availWidth, 1080);
    const height = Math.min(screen.availHeight, 880);
    window.open(anchor.href, "_blank", "popup,noopener,width=" + width + ",height=" + height);
  });
  return anchor;
}

function showPaperNoteTip(anchor, paper, version, page) {
  hidePaperNoteTip();
  const tip = $("paper-note-tip");
  const title = paper ? paperTitle(paper) : anchor.textContent;
  const metadata = [paper?.published, paper?.team].filter(Boolean).join(" · ");
  const details = version ? versionLabel(version) + " · 第 " + page + " 页" : "目录中暂无可打开的 PDF";
  tip.replaceChildren(h("strong", {}, title));
  if (metadata) tip.append(h("p", {class: "muted"}, metadata));
  tip.append(h("p", {class: "muted"}, details));
  tip.hidden = false;
  const position = anchor.getBoundingClientRect();
  const x = Math.max(8, Math.min(position.right - tip.offsetWidth, document.documentElement.clientWidth - tip.offsetWidth - 8));
  const above = position.top - tip.offsetHeight - 7;
  const y = above >= 8 ? above : Math.min(position.bottom + 7, window.innerHeight - tip.offsetHeight - 8);
  Object.assign(tip.style, {left: x + "px", top: Math.max(8, y) + "px"});
  tipAnchor = anchor;
  anchor.setAttribute("aria-describedby", tip.id);
}

function hidePaperNoteTip() {
  tipAnchor?.removeAttribute("aria-describedby");
  tipAnchor = null;
  $("paper-note-tip").hidden = true;
}


function viewNote(note) {
  const paper = paperById.get(note.paperId);
  if (!paper) return;
  const version = versionById(paper, note.versionId) || paper.versions[0];
  const page = version?.id === note.versionId && validPage(version, note.page) ? note.page : null;
  if (state.view === "reader" && paper.id === state.selected) {
    const visible = readingVersions().some((candidate) => candidate.id === version?.id);
    if (!visible && version) chooseVersion(version);
    if (page) jump(version, page);
    if (state.tab !== "notes") {
      state.tab = "notes";
      syncHash();
      renderSide();
    }
    scrollToNote(note.id);
    return;
  }
  openReader(paper, version, page, {tab: "notes", noteId: note.id});
}

function thumbnail(image, index, remove) {
  const preview = button(h("img", {src: image.data, alt: "", loading: "lazy"}), () => {
    $("full-image").src = image.data;
    $("full-image").alt = image.name || "笔记图片";
    $("image-dialog").showModal();
  }, {class: "thumb-button", "aria-label": "查看图片 " + (index + 1), title: image.name});
  return h("div", {class: "thumbnail"}, preview,
    remove ? button("×", remove, {class: "remove", "aria-label": "移除图片 " + (index + 1)}) : null);
}

function activeComposer(paperId) {
  if (paperId === null && !$("thought-window").hidden) return $("thought-composer").querySelector("textarea");
  if (paperId === state.selected && state.view === "reader" && state.tab === "notes") {
    return $("reading-panel").querySelector("textarea");
  }
}

function draftFor(paperId) {
  if (!state.drafts.has(paperId)) {
    state.drafts.set(paperId, {paperId, versionId: null, page: null, title: "", body: "", images: []});
  }
  return state.drafts.get(paperId);
}

function finishEdit(draft) {
  if (draft.resume) state.drafts.set(draft.paperId, draft.resume);
  else state.drafts.delete(draft.paperId);
}

function editNote(note) {
  const previous = draftFor(note.paperId);
  if (!database || previous.saving || previous.pendingImages) return;
  if (previous.id && previous.dirty && !confirm("放弃正在编辑的内容？")) return;
  const resume = previous.id ? previous.resume : previous;
  state.drafts.set(note.paperId, {...note, images: [...note.images], resume});
  updateNoteViews();
  activeComposer(note.paperId)?.focus();
}

function noteComposer(paperId) {
  const draft = draftFor(paperId);
  const body = h("textarea", {rows: 3, placeholder: paperId ? "记下这篇论文的想法…" : "写下随想，或粘贴图片…",
    "aria-label": paperId ? "论文笔记消息" : "随想消息", readonly: draft.saving ? "" : null}, draft.body);
  body.addEventListener("input", () => {
    draft.body = body.value;
    draft.dirty = true;
  });
  const thumbnails = h("div", {class: "thumbnails"});
  const submit = h("button", {class: "action", title: "Ctrl+Enter", "aria-keyshortcuts": "Control+Enter"},
    draft.id ? "保存修改" : "发送");
  const picker = h("input", {type: "file", "aria-label": "附加图片",
    accept: "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif", multiple: "", hidden: ""});
  function showImages() {
    submit.disabled = Boolean(draft.pendingImages || draft.saving);
    body.readOnly = Boolean(draft.saving);
    thumbnails.replaceChildren(...draft.images.map((image, index) => thumbnail(image, index, () => {
      if (draft.saving) return;
      draft.images.splice(index, 1);
      draft.dirty = true;
      showImages();
    })));
  }
  draft.refreshAttachments = showImages;
  showImages();

  async function addImages(files) {
    if (!files.length || draft.saving) return;
    draft.pendingImages = (draft.pendingImages || 0) + 1;
    submit.disabled = true;
    const results = await Promise.allSettled(files.map(Notes.fromImage));
    draft.pendingImages -= 1;
    for (const result of results) {
      if (result.status === "fulfilled") {
        draft.images.push(result.value);
        draft.dirty = true;
      } else report(result.reason);
    }
    draft.refreshAttachments();
  }

  picker.addEventListener("change", () => {
    void addImages(Array.from(picker.files));
    picker.value = "";
  });
  const form = h("form", {class: "chat-composer", novalidate: "", onsubmit: (event) => {
    event.preventDefault();
    if (!form.checkValidity()) {
      const location = form.querySelector(".note-location");
      if (location) location.open = true;
      form.reportValidity();
      return;
    }
    void sendNote(draft);
  }, onkeydown: (event) => {
    if (event.ctrlKey && event.key === "Enter" && !event.isComposing && !event.repeat) {
      event.preventDefault();
      form.requestSubmit();
    }
  }, onpaste: (event) => {
    const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith("image/"));
    if (files.length) {
      event.preventDefault();
      void addImages(files);
    }
  }});
  if (draft.id) {
    form.append(h("div", {class: "edit-context"}, h("span", {class: "muted"}, "正在编辑"),
      button("取消", () => {
        if (draft.saving || draft.pendingImages) return;
        finishEdit(draft);
        updateNoteViews();
        activeComposer(draft.paperId)?.focus();
      }, {class: "quiet"})));
    if (draft.title) {
      const title = h("input", {class: "legacy-title", "aria-label": "原笔记标题", value: draft.title,
        oninput: (event) => { draft.title = event.target.value; draft.dirty = true; }});
      form.append(title);
    }
  }
  form.append(body, thumbnails, picker,
    h("div", {class: "composer-footer"},
      button("图片", () => picker.click(), {class: "quiet", "aria-label": "添加图片"}),
      paperId && paperById.get(paperId)?.versions.length ? noteLocation(draft) : null,
      h("span", {class: "key-hint", "aria-hidden": "true"}, "Ctrl+Enter"), submit));
  return form;
}

function noteLocation(draft) {
  const versions = paperById.get(draft.paperId).versions;
  const version = h("select", {"aria-label": "笔记所在版本"}, h("option", {value: ""}, "未指定版本"),
    ...versions.map((item) => h("option", {value: item.id}, versionLabel(item))));
  version.value = draft.versionId ?? state.edition;
  const page = h("input", {type: "number", min: 1, value: draft.page ?? "", "aria-label": "笔记页码"});
  const summary = h("summary", {}, draft.page ? "第 " + draft.page + " 页" : "标记页码");
  function setPageMax() {
    const current = versions.find((item) => item.id === version.value);
    if (current?.pages) page.max = current.pages;
    else page.removeAttribute("max");
    page.placeholder = current && !draft.id ? String(pageFor(current)) : "可留空";
  }
  setPageMax();
  const update = () => {
    draft.versionId = version.value;
    draft.page = page.valueAsNumber || null;
    draft.dirty = true;
    summary.textContent = draft.page ? "第 " + draft.page + " 页" : "标记页码";
    setPageMax();
  };
  version.addEventListener("change", update);
  page.addEventListener("input", update);
  return h("details", {class: "note-location", ontoggle: (event) => { draft.locationOpen = event.target.open; },
    open: draft.locationOpen ? "" : null}, summary,
    h("div", {class: "location-fields"}, h("label", {}, "PDF 版本", version), h("label", {}, "页码", page)));
}

async function sendNote(draft) {
  if (!database || draft.saving || draft.pendingImages) return;
  if (!draft.title.trim() && !draft.body.trim() && !draft.images.length) {
    activeComposer(draft.paperId)?.focus();
    return;
  }
  const versionId = draft.paperId ? draft.versionId ?? state.edition : "";
  if (draft.page && !versionId) {
    tell("填写页码时，请选择对应的 PDF 版本。");
    return;
  }
  const now = new Date().toISOString();
  const version = versionById(paperById.get(draft.paperId), versionId);
  const page = draft.page ?? (!draft.id && version ? pageFor(version) : null);
  const record = {
    id: draft.id || crypto.randomUUID(), paperId: draft.paperId, versionId, page,
    pageLayout: version?.pageLayout || "",
    title: draft.title.trim(), body: draft.body, images: [...draft.images],
    createdAt: draft.createdAt || now, updatedAt: now
  };
  draft.saving = true;
  draft.refreshAttachments();
  try {
    await Notes.write(database, [record]);
    finishEdit(draft);
    await refreshNotes({paperId: draft.paperId, scrollEnd: !draft.id});
    const next = activeComposer(draft.paperId);
    if (next) {
      next.focus({preventScroll: true});
      if (draft.id) {
        if (draft.paperId) scrollToNote(draft.id);
        else scrollToThought(draft.id);
      }
    }
  } catch (error) {
    report(error);
  } finally {
    draft.saving = false;
    if (state.drafts.get(draft.paperId) === draft) draft.refreshAttachments();
  }
}

async function deleteNote(note) {
  const draft = state.drafts.get(note.paperId);
  if (draft?.id === note.id && (draft.saving || draft.pendingImages)) return;
  if (!confirm("删除这条笔记？")) return;
  try {
    await Notes.write(database, [{id: note.id, paperId: note.paperId, updatedAt: new Date().toISOString(), deleted: true}]);
    if (draft?.id === note.id) finishEdit(draft);
    await refreshNotes();
    tell("已删除笔记。");
  } catch (error) {
    report(error);
  }
}

async function refreshNotes(options) {
  records = (await Notes.list(database)).map(noteInCurrentLayout);
  updateNoteViews(options);
}


function availableStorage() {
  if (database) return true;
  tell(loadError || "笔记存储还在初始化，请稍后再试。");
  return false;
}

async function exportNotes() {
  if (!availableStorage()) return;
  const contents = Notes.serialize((await Notes.list(database)).map(noteInCurrentLayout));
  const url = URL.createObjectURL(new Blob([contents], {type: "application/json"}));
  const link = h("a", {href: url, download: "阅读笔记-" + new Date().toISOString().slice(0, 10) + ".json"});
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importNotes(file) {
  if (!file || !availableStorage()) return;
  const imported = Notes.parse(await file.text());
  const count = await Notes.merge(database, imported);
  await refreshNotes();
  tell("导入完成，合并了 " + count + " 条记录。");
}

async function saveFolder() {
  if (!availableStorage() || backupBusy) return;
  if (!window.showDirectoryPicker) {
    tell("当前浏览器不支持选择资料目录，请使用下载备份 JSON。");
    return;
  }
  backupBusy = true;
  try {
    const root = await window.showDirectoryPicker({mode: "readwrite", id: "paper-workbench"});
    try {
      await root.getFileHandle("论文阅读.html");
    } catch (error) {
      if (error.name === "NotFoundError") throw new Error("请选择包含「论文阅读.html」的论文资料目录。");
      throw error;
    }
    const data = await root.getDirectoryHandle("data", {create: true});
    const folder = await data.getDirectoryHandle("笔记", {create: true});
    let handle;
    try {
      handle = await folder.getFileHandle("阅读笔记.json");
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
    }
    if (handle) {
      const contents = await (await handle.getFile()).text();
      if (contents.trim()) await Notes.merge(database, Notes.parse(contents));
    } else {
      handle = await folder.getFileHandle("阅读笔记.json", {create: true});
    }
    const backup = Notes.serialize((await Notes.list(database)).map(noteInCurrentLayout));
    const writer = await handle.createWritable();
    try {
      await writer.write(backup);
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
    await refreshNotes();
    tell("已保存到 data/笔记/阅读笔记.json。");
  } catch (error) {
    if (error.name !== "AbortError") report(error);
  } finally {
    backupBusy = false;
  }
}

function go(view) {
  const changed = view !== state.view;
  if (changed) window.scrollTo(0, 0);
  setView(view);
}

function restoreRoute() {
  const key = location.hash.slice(1);
  if (key === "notes" || key === "thoughts") {
    go("notes");
    if (key === "thoughts") showThoughts({focus: false});
    return;
  }
  const params = new URLSearchParams(key);
  const paper = paperById.get(params.get("paper"));
  if (paper) {
    const version = versionById(paper, params.get("version"));
    const other = versionById(paper, params.get("compare"));
    const page = pageInVersionLayout(version, Number(params.get("page")), params.get("layout"));
    const otherPage = pageInVersionLayout(other, Number(params.get("otherPage")), params.get("otherLayout"));
    openReader(paper, version, page, {compare: params.has("compare"), other, otherPage, tab: params.get("tab")});
  } else go("library");
}

$("home").addEventListener("click", (event) => { event.preventDefault(); go("library"); });
$("show-library").addEventListener("click", () => go("library"));
$("reader-home").addEventListener("click", (event) => { event.preventDefault(); go("library"); });
$("show-notes").addEventListener("click", () => go("notes"));
$("open-thoughts").addEventListener("click", () => showThoughts());
$("close-thoughts").addEventListener("click", hideThoughts);
$("thought-window").addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".note-source")) hidePaperNoteTip();
});
window.addEventListener("resize", hidePaperNoteTip);
document.addEventListener("scroll", (event) => {
  if (tipAnchor && event.target.contains(tipAnchor)) hidePaperNoteTip();
}, true);
$("paper-search").addEventListener("input", renderLibrary);
sortField.addEventListener("change", changePaperSort);
sortDirection.addEventListener("change", changePaperSort);
$("note-search").addEventListener("input", () => renderAllNotes());
$("compare").addEventListener("click", toggleComparison);
$("toggle-nav").addEventListener("click", () => setDrawer(true));
$("close-nav").addEventListener("click", () => setDrawer(false));
$("nav-shade").addEventListener("click", () => setDrawer(false));
$("nav-search").addEventListener("input", renderDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("nav-drawer").hidden) {
    event.preventDefault();
    setDrawer(false);
  }
});
$("export-notes").addEventListener("click", () => { $("backup").open = false; void exportNotes().catch(report); });
$("import-notes").addEventListener("click", () => { $("backup").open = false; if (availableStorage()) $("backup-file").click(); });
$("save-folder").addEventListener("click", () => { $("backup").open = false; void saveFolder(); });
$("backup-file").addEventListener("change", (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  void importNotes(file).catch(report);
});
document.addEventListener("click", (event) => {
  if (!$("backup").contains(event.target)) $("backup").open = false;
});
paperIntro.addEventListener("toggle", (event) => {
  if (event.newState === "open") {
    paperIntro.querySelector(".paper-intro-body").scrollTop = 0;
    positionPaperIntro();
  } else {
    introAnchor = null;
  }
});
window.addEventListener("resize", positionPaperIntro);
document.addEventListener("scroll", (event) => {
  if (!paperIntro.contains(event.target)) positionPaperIntro();
}, true);
$("image-dialog").addEventListener("close", () => { $("full-image").removeAttribute("src"); });
window.addEventListener("hashchange", restoreRoute);
window.addEventListener("beforeunload", (event) => {
  if (Array.from(state.drafts.values()).some((draft) =>
    draft.dirty || draft.saving || draft.pendingImages || draft.resume?.dirty)) event.preventDefault();
});
window.addEventListener("focus", () => {
  if (database && !document.activeElement?.closest("input,textarea,select")) void refreshNotes().catch(report);
});

restorePaperSort();
restoreRoute();
if (thoughtWindow.preference.open) showThoughts({focus: false});
void Notes.open().then(async (db) => {
  database = db;
  await refreshNotes({scrollEnd: true});
}).catch((error) => {
  console.error(error);
  database = null;
  loadError = "浏览器无法保存本地笔记。请用普通模式打开，检查是否允许存储。";
  updateNoteViews();
});

