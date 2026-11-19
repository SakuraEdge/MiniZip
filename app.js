(() => {
  "use strict";

  const C = window.MiniZipCore;
  const native = window.miniZip || null;
  const e = C.escapeHtml;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const icon = (name, className = "") => `<i data-lucide="${name}"${className ? ` class="${className}"` : ""}></i>`;
  const archives = new Map();
  const readPreference = (key, fallback) => {
    try { const value = localStorage.getItem("minizip." + key); return value === null ? fallback : JSON.parse(value); }
    catch { return fallback; }
  };
  const preferences = readPreference("preferences", {});
  const state = {
    archive: null,
    page: "browser",
    path: [],
    selection: new Set(),
    focusedId: null,
    query: "",
    sortKey: "name",
    sortDirection: "asc",
    view: preferences.view === "grid" ? "grid" : "list",
    details: preferences.details !== false,
    compact: preferences.compact === true,
    subfolder: preferences.subfolder !== false,
    history: [],
    favorites: new Set(),
    sidebarExpanded: preferences.sidebarExpanded === true,
    update: { status: "idle", current: "Dev v1.0.1", repository: null, autoCheck: true, allowDev: true, available: null, error: null },
    edits: { count: 0, entries: [], canUpdate: false, busy: false },
    tasks: [],
    taskTab: "all",
    dialog: null,
    passwordContinuation: null,
    extractionSelection: [],
    extractHere: false,
    dragDepth: 0,
    previewUrl: null
  };
  const dialog = $("#app-dialog");
  let toastTimeout;

  async function callNative(method, ...args) {
    const result = await native[method](...args);
    if (!result.ok) { const error = new Error(result.error.message); error.code = result.error.code; throw error; }
    return result.value;
  }
  function acceptNativeArchive(archive, focus = true) {
    if (!archive) return;
    archives.set(archive.id, archive);
    if (focus) {
      state.edits = { count: 0, entries: [], canUpdate: Boolean(archive.canUpdate), busy: false };
      openArchive(archive.id);
      if (archive.launchAction?.startsWith("extract")) {
        const mode = archive.launchAction;
        delete archive.launchAction;
        setTimeout(() => {
          if (mode === "extract-here") extractHere().catch((error) => toast(error.message, true));
          else if (mode === "extract-folder") extractFolder().catch((error) => toast(error.message, true));
          else showExtraction();
        }, 50);
      }
      return;
    }
    if (state.archive?.id === archive.id) {
      state.archive = archive;
      state.selection.clear(); state.focusedId = null;
      while (state.path.length && !C.visibleEntries(archive, state.path).length) state.path.pop();
      render();
    }
  }
  function acceptNativeTask(task, focus = false) {
    if (!task) return;
    const previous = state.tasks.find((item) => item.id === task.id);
    if (previous) Object.assign(previous, task);
    else state.tasks.unshift(task);
    if (focus) { state.taskTab = "all"; closeDialog(); navigate("tasks"); }
    else { if (state.page === "tasks") { renderTasks(); paintIcons(); } updateTaskStatus(); }
  }
  async function pickNative(method, ...args) {
    $("#global-status").textContent = "正在读取文件…";
    try { const archive = await callNative(method, ...args); acceptNativeArchive(archive); }
    finally { updateTaskStatus(); }
  }

  function paintIcons(root = document) {
    if (window.lucide) window.lucide.createIcons({ root, attrs: { "aria-hidden": "true" } });
  }
  function savePreference(key, value) {
    try { localStorage.setItem("minizip." + key, JSON.stringify(value)); }
    catch { /* Private browsing may disable local preference storage. */ }
  }
  function savePreferences() {
    savePreference("preferences", { view: state.view, details: state.details, compact: state.compact, subfolder: state.subfolder, sidebarExpanded: state.sidebarExpanded });
  }
  function toast(message, warning = false) {
    clearTimeout(toastTimeout);
    $("#toast-region").innerHTML = `<div class="toast${warning ? " warning" : ""}">${icon(warning ? "info" : "circle-check")}<span>${e(message)}</span></div>`;
    paintIcons();
    toastTimeout = setTimeout(() => { $("#toast-region").innerHTML = ""; }, 4000);
  }
  const archiveGlyph = '<img class="archive-glyph" src="assets/archive.svg" alt="" />';
  function fileIcon(item, large = false) {
    const names = { folder: "folder", image: "image", pdf: "file-text", design: "figma", text: "file-text", video: "film", font: "type", file: "file" };
    const glyph = item.kind === "archive" ? archiveGlyph : item.thumbnail ? `<img src="${e(item.thumbnail)}" alt="" loading="lazy" />` : icon(names[item.kind] || "file");
    return `<span class="file-icon ${item.kind}${large ? " details-large-file" : ""}">${glyph}</span>`;
  }
  function archiveIcon(archive, className = "archive-icon") {
    if (archive?.folder) return `<span class="${className}">${icon("folder")}</span>`;
    const badge = archive?.encrypted ? `<span class="archive-badge" role="img" aria-label="已加密">${icon("lock-keyhole")}</span>` : "";
    return `<span class="${className} is-archive">${archiveGlyph}${badge}</span>`;
  }
  function isLocked() { return Boolean(state.archive?.locked); }
  function currentEntries() { return state.archive ? C.visibleEntries(state.archive, state.path) : []; }
  function filteredEntries() { return C.filterAndSort(currentEntries(), state.query, state.sortKey, state.sortDirection); }
  function currentItem(id) { return currentEntries().find((item) => item.id === id); }
  function summaryValue(bytes) {
    const [number, unit] = C.formatBytes(bytes).split(" ");
    return `${number}<small>${unit || ""}</small>`;
  }

  function render() {
    const titles = { browser: "文件浏览", recent: "最近打开", favorites: "我的收藏", tasks: "文件任务", updates: "软件更新" };
    $("#page-title").textContent = titles[state.page];
    $(".workspace-name").textContent = titles[state.page];
    $("#browser-view").hidden = state.page !== "browser";
    $("#collection-view").hidden = !["recent", "favorites"].includes(state.page);
    $("#tasks-view").hidden = state.page !== "tasks";
    $("#updates-view").hidden = state.page !== "updates";
    $$(".nav-item[data-page]").forEach((button) => {
      const active = button.dataset.page === state.page;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    document.body.classList.toggle("compact", state.compact);
    document.body.classList.toggle("no-details", !state.details);
    document.body.classList.toggle("sidebar-collapsed", !state.sidebarExpanded);
    document.body.classList.toggle("sidebar-expanded", state.sidebarExpanded);
    const railToggle = $(".sidebar-toggle");
    railToggle.title = state.sidebarExpanded ? "收起侧栏" : "展开侧栏";
    railToggle.setAttribute("aria-label", railToggle.title); railToggle.setAttribute("aria-expanded", state.sidebarExpanded);
    if (state.page === "browser") renderBrowser();
    else if (state.page === "tasks") renderTasks();
    else if (state.page === "updates") renderUpdates();
    else renderCollection();
    renderEditNotice();
    updateTaskStatus();
    $("#recent-count").textContent = state.history.length;
    paintIcons();
  }

  function renderEditNotice() {
    const notice = $("#edit-notice");
    const value = state.edits;
    notice.hidden = !state.archive || !value.count;
    if (notice.hidden) return;
    const names = value.entries.map((entry) => entry.entryId + (entry.missing ? "（副本不可读取）" : "")).join("、");
    notice.innerHTML = `<div class="edit-message">${icon("file-pen-line")}<div><strong>${value.count} 个文件有改动，是否保存到压缩包？</strong><span>${e(names)}</span>${!value.canUpdate ? `<span>此格式不支持写回，可另存修改后的文件。</span>` : ""}</div></div><div class="edit-actions"><button class="icon-button" data-action="reveal-edits" aria-label="打开工作副本" title="打开工作副本">${icon("folder-open")}</button><button class="button secondary" data-action="export-edits" ${value.busy ? "disabled" : ""}>${icon("save-all")}另存副本</button>${value.canUpdate ? `<button class="button primary" data-action="save-edits" ${value.busy || value.entries.some((entry) => entry.missing) ? "disabled" : ""}>${icon("save")}保存到压缩包</button>` : ""}</div>`;
    paintIcons(notice);
  }

  function renderBrowser() {
    const archive = state.archive;
    const hasArchive = Boolean(archive);
    $("#archive-summary").hidden = !hasArchive;
    $("#file-toolbar").hidden = !hasArchive;
    $(".path-bar").hidden = !hasArchive;
    $(".browser-footer").hidden = !hasArchive;
    $("#details-panel").hidden = !hasArchive;
    $("#selection-bar").hidden = !state.selection.size;
    if (!archive) {
      $("#file-content").innerHTML = `<div class="empty-state"><span class="empty-icon">${icon("folder-open")}</span><h3>尚未打开压缩包</h3><p>ZIP · RAR · 7Z · TAR · LZ4</p><button class="button primary" data-action="open">${icon("plus")}打开压缩包</button></div>`;
      return;
    }
    const counts = C.countEntries(archive.entries || []);
    const ratio = archive.originalSize ? Math.round((1 - archive.size / archive.originalSize) * 100) : 0;
    $("#archive-summary").innerHTML = `${archiveIcon(archive)}<div class="archive-title-group"><div class="archive-title-line"><h2 title="${e(archive.name)}">${e(archive.name)}</h2><span class="format-tag">${e(archive.format)}</span></div><div class="archive-meta"><span class="summary-location">${icon("folder")}</span><span class="summary-location">${e(archive.source || "本地文件")}</span><span class="meta-separator summary-location">/</span><span>${archive.folder ? "本地文件夹" : "本地压缩包"}</span><span class="meta-separator">·</span><span>${archive.external ? "目录待解析" : `${counts.files} 个文件，${counts.folders} 个文件夹`}</span></div></div><div class="archive-summary-stats"><div class="summary-stat"><div class="stat-label">${archive.folder ? "总大小" : "压缩后"}</div><div class="stat-value">${summaryValue(archive.size)}</div></div><div class="summary-stat original"><div class="stat-label">原始大小</div><div class="stat-value">${summaryValue(archive.originalSize)}</div></div><div class="summary-stat compression"><div class="stat-label">${icon("chart-no-axes-column-increasing")}节省空间</div><div class="stat-value savings">${archive.originalSize && !archive.folder ? `${icon("arrow-down-right")}${ratio}<small>%</small>` : "—"}</div></div></div>`;
    if (ratio < 0 && !archive.folder) {
      $(".summary-stat.compression .stat-label").innerHTML = `${icon("chart-no-axes-column-increasing")}增加空间`;
      $(".summary-stat.compression .stat-value").innerHTML = `${icon("arrow-up-right")}${Math.abs(ratio)}<small>%</small>`;
      $(".summary-stat.compression .stat-value").classList.remove("savings");
    }
    $("#extract-button").disabled = archive.folder;
    $("#extract-button").title = archive.folder ? "当前是文件夹，无需解压" : "解压到指定位置";
    $("#extract-here-button").disabled = archive.folder;
    $("#extract-here-button").title = archive.folder ? "当前是文件夹，无需解压" : "解压到压缩包所在文件夹";
    updateDeleteButton();
    $("[data-action='test']").disabled = archive.folder;
    $("#favorite-button").classList.toggle("is-favorite", state.favorites.has(archive.id));
    $("#favorite-button").setAttribute("aria-label", state.favorites.has(archive.id) ? "取消收藏压缩包" : "收藏压缩包");
    $("#favorite-button").title = state.favorites.has(archive.id) ? "取消收藏压缩包" : "收藏压缩包";
    $$("[data-action='view']").forEach((button) => {
      const active = state.view === button.dataset.view;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active);
    });
    $(".detail-toggle").classList.toggle("active", state.details);
    $(".detail-toggle").setAttribute("aria-pressed", state.details);
    $("#file-search").placeholder = archive.folder ? "搜索文件夹内的文件" : "搜索压缩包内的文件";
    $("#file-search").disabled = Boolean(archive.external || isLocked());
    $("#file-search").value = state.query;
    renderBreadcrumbs();
    renderFiles();
    renderDetails();
  }

  function renderBreadcrumbs() {
    const archive = state.archive;
    let entries = archive.entries || [];
    let html = `${icon(archive.folder ? "folder" : "folder-archive")}<button data-action="breadcrumb" data-depth="0">${e(archive.name)}</button>`;
    state.path.forEach((id, index) => {
      const folder = entries.find((item) => item.id === id);
      if (!folder) return;
      html += `${icon("chevron-right")}<button data-action="breadcrumb" data-depth="${index + 1}">${e(folder.name)}</button>`;
      entries = folder.children || [];
    });
    $("#breadcrumbs").innerHTML = html;
    $("#up-button").disabled = !state.path.length;
  }

  function renderFiles() {
    const archive = state.archive;
    if (!archive) return;
    $("#archive-kind").textContent = archive.format;
    if (archive.external || isLocked()) {
      const locked = isLocked();
      $("#file-content").innerHTML = `<div class="empty-state${locked ? " locked-state" : ""}"><span class="empty-icon">${icon(locked ? "lock-keyhole" : "file-archive")}</span><h3>${locked ? "这是一个加密压缩包" : "文件已在浏览器中打开"}</h3><p>${locked ? "目录已锁定，等待输入密码。" : "请使用 MiniZip 桌面版读取压缩包内容。"}</p>${locked ? `<button class="button primary" data-action="unlock">${icon("key-round")}输入密码</button>` : ""}</div>`;
      $("#folder-count").textContent = locked ? "已加密" : "待解析";
      $("#file-footer-count").textContent = locked ? "已加密 · 等待解锁" : "仅显示文件元数据";
      $("#selection-bar").hidden = true;
      return;
    }
    const entries = filteredEntries();
    const all = currentEntries();
    $("#folder-count").textContent = `${entries.length} 个项目`;
    $("#file-footer-count").textContent = state.query ? `找到 ${entries.length} 个项目 · 当前目录` : `${all.length} 个项目 · ${C.formatBytes(all.reduce((sum, item) => sum + (item.size || 0), 0))}`;
    $("#selection-bar").hidden = !state.selection.size;
    $("#selection-text").textContent = `已选择 ${state.selection.size} 个项目`;
    $("[data-action='extract-selected']").disabled = archive.folder;
    if (!entries.length) {
      $("#file-content").innerHTML = `<div class="empty-state"><span class="empty-icon">${icon(state.query ? "search-x" : "folder")}</span><h3>${state.query ? "没有找到匹配的文件" : "这个文件夹是空的"}</h3>${state.query ? `<p>“${e(state.query)}” · 当前目录</p><button class="button secondary" data-action="clear-search">${icon("x")}清除搜索</button>` : ""}</div>`;
      paintIcons();
      return;
    }
    if (state.view === "grid") {
      $("#file-content").innerHTML = `<div class="file-grid" role="list" aria-label="文件网格">${entries.map((item) => `<div class="file-tile${state.selection.has(item.id) ? " selected" : ""}" tabindex="0" role="listitem" data-file-id="${e(item.id)}" aria-label="${e(item.name)}" title="${e(item.name)}"><input type="checkbox" data-select-id="${e(item.id)}" aria-label="选择 ${e(item.name)}" ${state.selection.has(item.id) ? "checked" : ""} />${fileIcon(item)}<span class="tile-name">${e(item.name)}</span><span class="tile-size">${item.kind === "folder" ? e(item.type) : C.formatBytes(item.size)}</span></div>`).join("")}</div>`;
    } else {
      const sortHeading = (label, key) => `<button data-action="sort" data-sort="${key}" aria-label="按${label}排序">${label}${state.sortKey === key ? icon(state.sortDirection === "asc" ? "chevron-up" : "chevron-down") : ""}</button>`;
      $("#file-content").innerHTML = `<table class="file-table" aria-label="文件列表"><colgroup><col class="col-check" /><col class="col-name" /><col class="col-size" /><col class="col-packed" /><col class="col-date" /></colgroup><thead><tr><th><input id="select-all" type="checkbox" aria-label="选择当前目录所有文件" ${entries.every((item) => state.selection.has(item.id)) ? "checked" : ""} /></th><th aria-sort="${state.sortKey === "name" ? state.sortDirection === "asc" ? "ascending" : "descending" : "none"}">${sortHeading("名称", "name")}</th><th aria-sort="${state.sortKey === "size" ? state.sortDirection === "asc" ? "ascending" : "descending" : "none"}">${sortHeading("原始大小", "size")}</th><th class="packed-cell">压缩后</th><th class="date-cell" aria-sort="${state.sortKey === "date" ? state.sortDirection === "asc" ? "ascending" : "descending" : "none"}">${sortHeading("修改时间", "date")}</th></tr></thead><tbody>${entries.map((item) => `<tr class="${state.selection.has(item.id) ? "selected" : ""}" tabindex="0" data-file-id="${e(item.id)}" aria-selected="${state.selection.has(item.id)}"><td><input type="checkbox" data-select-id="${e(item.id)}" aria-label="选择 ${e(item.name)}" ${state.selection.has(item.id) ? "checked" : ""} /></td><td class="file-name-cell"><span class="file-name-inner">${fileIcon(item)}<span class="file-name" title="${e(item.name)}">${e(item.name)}</span>${archive.encrypted ? icon("lock-keyhole", "file-lock") : ""}</span></td><td>${C.formatBytes(item.size)}</td><td class="packed-cell">${C.formatBytes(item.packed)}</td><td class="date-cell">${e(item.date?.slice(0, 10) || "—")}</td></tr>`).join("")}</tbody></table>`;
      const selectedVisible = entries.filter((item) => state.selection.has(item.id)).length;
      $("#select-all").indeterminate = selectedVisible > 0 && selectedVisible < entries.length;
    }
    paintIcons();
  }

  function renderDetails() {
    const archive = state.archive;
    if (!archive) return;
    const item = currentItem(state.focusedId);
    const panel = $("#details-panel");
    const heading = `<div class="details-heading"><span>${item ? "文件信息" : "压缩包信息"}</span><button class="small-icon-button" data-action="close-details" aria-label="隐藏详情" title="隐藏详情">${icon("panel-right-close")}</button></div>`;
    if (item && !isLocked()) {
      panel.innerHTML = `${heading}<div class="detail-preview">${item.thumbnail ? `<img class="details-photo" src="${e(item.thumbnail)}" alt="${e(item.name)}" />` : fileIcon(item, true)}<strong class="detail-preview-name" title="${e(item.name)}">${e(item.name)}</strong><span class="detail-preview-subtitle">${e(item.type)}</span></div><div class="detail-section"><div class="detail-section-title">基本信息</div><dl><div><dt>文件大小</dt><dd>${C.formatBytes(item.size)}</dd></div>${!archive.folder ? `<div><dt>压缩后</dt><dd>${C.formatBytes(item.packed)}</dd></div>` : ""}<div><dt>修改时间</dt><dd>${e(item.date || "—")}</dd></div>${item.dimensions ? `<div><dt>图像尺寸</dt><dd>${e(item.dimensions)}</dd></div>` : ""}<div><dt>位置</dt><dd>${e(archive.name)}</dd></div></dl></div><div class="detail-actions"><button class="button secondary" data-action="open-item" data-id="${e(item.id)}">${icon(item.kind === "folder" ? "folder-open" : state.archive.native ? "external-link" : "eye")}${item.kind === "folder" ? "打开文件夹" : state.archive.native ? item.kind === "archive" ? "在新工作台打开" : "打开文件" : "预览文件"}</button>${state.archive.native && ["text", "image"].includes(item.kind) ? `<button class="button subtle" data-action="preview-item" data-id="${e(item.id)}">${icon("eye")}预览文件</button>` : ""}${!archive.folder ? `<button class="button subtle" data-action="extract-item" data-id="${e(item.id)}">${icon("arrow-down-to-line")}解压此${item.kind === "folder" ? "文件夹" : "文件"}</button>` : ""}</div>`;
      return;
    }
    const counts = C.countEntries(archive.entries || []);
    panel.innerHTML = `${heading}<div class="detail-preview">${archiveIcon(archive, "detail-archive-art")}<strong class="detail-preview-name" title="${e(archive.name)}">${e(archive.name)}</strong><span class="detail-preview-subtitle">${archive.folder ? "本地文件夹" : `${e(archive.format)} 压缩文件`}</span></div><div class="detail-section"><div class="detail-section-title">基本信息</div><dl><div><dt>${archive.folder ? "总大小" : "压缩大小"}</dt><dd>${C.formatBytes(archive.size)}</dd></div><div><dt>原始大小</dt><dd>${C.formatBytes(archive.originalSize)}</dd></div><div><dt>包含项目</dt><dd>${archive.external ? "待解析" : `${counts.files} 文件 / ${counts.folders} 文件夹`}</dd></div><div><dt>修改时间</dt><dd>${e(archive.date.slice(0, 10))}</dd></div><div><dt>压缩方式</dt><dd>${e(archive.method || "待检测")}</dd></div><div><dt>加密状态</dt><dd><span class="safe-status">${icon(archive.encrypted ? "lock-keyhole" : "shield-check")}${archive.external ? "待检测" : archive.encrypted ? isLocked() ? "已加密" : "已解锁" : "未加密"}</span></dd></div></dl></div>${!archive.external ? renderDistribution(archive.entries) : ""}`;
    if (archive.native && archive.encrypted) $(".safe-status", panel).innerHTML = `${icon("lock-keyhole")}${isLocked() ? "已加密" : "已解锁"}`;
  }

  function renderDistribution(entries) {
    const totals = { design: 0, image: 0, document: 0, other: 0 };
    const count = (items) => items.forEach((item) => {
      if (item.kind === "folder") count(item.children || []);
      else totals[item.kind === "design" ? "design" : item.kind === "image" ? "image" : ["pdf", "text"].includes(item.kind) ? "document" : "other"] += item.size || 0;
    });
    count(entries || []);
    const sum = Object.values(totals).reduce((a, b) => a + b, 0);
    const groups = [{ key: "design", name: "设计文件" }, { key: "image", name: "图片" }, { key: "document", name: "文档" }, { key: "other", name: "其他" }];
    return `<div class="detail-section"><div class="detail-section-title">内容分布<span>按原始大小</span></div><div class="distribution-bar">${groups.filter((group) => totals[group.key]).map((group) => `<span class="distribution-${group.key}" style="width:${totals[group.key] / sum * 100}%" title="${group.name} ${C.formatBytes(totals[group.key])}"></span>`).join("")}</div><div class="distribution-legend">${groups.map((group) => `<span><i class="legend-dot distribution-${group.key}"></i>${group.name}</span>`).join("")}</div></div>`;
  }

  function renderCollection() {
    const favorites = state.page === "favorites";
    const items = (favorites ? [...state.favorites] : state.history).map((id) => archives.get(id)).filter(Boolean);
    const panel = $("#collection-view");
    if (!items.length) {
      panel.innerHTML = `<div class="empty-state"><span class="empty-icon">${icon(favorites ? "star" : "history")}</span><h3>${favorites ? "收藏夹还是空的" : "暂无最近打开的文件"}</h3><button class="button secondary" data-action="open">${icon("folder-open")}打开压缩包</button></div>`;
      return;
    }
    panel.innerHTML = `<div class="collection-toolbar"><span>${items.length} 个${favorites ? "收藏" : "压缩包与文件夹"}</span>${!favorites ? `<button class="text-button" data-action="clear-history">${icon("list-x")}清空记录</button>` : ""}</div><div class="collection-grid">${items.map((archive) => `<article class="archive-card"><div class="archive-card-top">${archiveIcon(archive)}<button class="icon-button${state.favorites.has(archive.id) ? " is-favorite" : ""}" data-action="toggle-favorite" data-id="${e(archive.id)}" aria-label="${state.favorites.has(archive.id) ? "取消收藏" : "收藏"} ${e(archive.name)}" title="${state.favorites.has(archive.id) ? "取消收藏" : "收藏"}">${icon("star")}</button></div><h3>${e(archive.name)}</h3><div class="archive-card-info"><span>${C.formatBytes(archive.size)}</span><span>·</span><span>${e(archive.format)}</span>${archive.encrypted ? icon("lock-keyhole") : ""}</div><div class="archive-card-footer"><span>本地 · ${e(archive.date.slice(0, 10))}</span><button class="text-button" data-action="open-recent" data-archive="${e(archive.id)}">打开${icon("arrow-up-right")}</button></div></article>`).join("")}</div>`;
  }

  function renderTasks() {
    const completed = state.tasks.filter((task) => ["completed", "cancelled", "failed"].includes(task.status));
    const active = state.tasks.filter((task) => ["running", "paused"].includes(task.status));
    const tasks = state.taskTab === "active" ? active : state.taskTab === "completed" ? completed : state.tasks;
    $("#tasks-view").innerHTML = `<div class="task-view-heading"><div class="task-tabs" role="tablist" aria-label="任务状态">${[["all", "全部", state.tasks.length], ["active", "进行中", active.length], ["completed", "已结束", completed.length]].map(([key, label, count]) => `<button class="task-tab${state.taskTab === key ? " active" : ""}" data-action="task-tab" data-tab="${key}" role="tab" aria-selected="${state.taskTab === key}">${label} <span>${count}</span></button>`).join("")}</div><button class="text-button" data-action="clear-tasks" ${completed.length ? "" : "disabled"}>${icon("list-x")}清除已结束</button></div>${tasks.length ? `<div class="task-list">${tasks.map(taskMarkup).join("")}</div>` : `<div class="empty-state"><span class="empty-icon">${icon("list-checks")}</span><h3>${state.tasks.length ? "这里暂时没有任务" : "暂无文件任务"}</h3><button class="button secondary" data-action="navigate" data-page="browser">${icon("folder-open")}返回文件浏览</button></div>`}`;
  }

  function renderUpdates() {
    const update = state.update;
    const busy = ["checking", "downloading"].includes(update.status);
    const status = { idle: "等待检查", checking: "正在检查 GitHub…", current: "当前已是最新版本", available: "发现新版本", downloading: "正在下载安装包", ready: "安装包已下载并通过校验", error: "暂时无法完成更新检查" }[update.status] || "等待检查";
    $("#updates-view").innerHTML = `<div class="update-overview"><img class="update-logo" src="assets/favicon.svg" alt="MiniZip 图标" /><div class="update-current"><h2>MiniZip</h2><p>${e(update.current)}</p><span class="update-status ${update.status}" role="status">${e(status)}</span></div><button class="button secondary" data-action="check-updates" ${busy ? "disabled" : ""}>${icon("refresh-cw")}检查更新</button></div><div class="update-options"><label class="update-setting"><span><strong>启动时自动检查</strong><small>仅查询公开发布信息，不上传本地文件</small></span><span class="toggle"><input type="checkbox" id="update-auto" aria-label="启动时自动检查" ${update.autoCheck ? "checked" : ""} ${busy ? "disabled" : ""} /><span></span></span></label><label class="update-setting"><span><strong>接收 Dev 开发版本</strong><small>关闭后仅接收 Rev 正式版本</small></span><span class="toggle"><input type="checkbox" id="update-dev" aria-label="接收 Dev 开发版本" ${update.allowDev ? "checked" : ""} ${busy ? "disabled" : ""} /><span></span></span></label><div class="update-source"><span>发布源</span><button class="text-button" data-action="repository" ${update.repository ? "" : "disabled"}>${icon("github")}${e(update.repository || "GitHub 仓库待配置")}${update.repository ? icon("arrow-up-right") : ""}</button></div>${update.checkedAt ? `<div class="update-source"><span>上次检查</span><span>${e(new Date(update.checkedAt).toLocaleString("zh-CN"))}</span></div>` : ""}</div>${update.error ? `<div class="update-error" role="alert">${icon("circle-alert")}<span>${e(update.error)}</span></div>` : ""}${update.available ? `<section class="release-notes"><div class="release-heading"><div><h3>${e(update.available.displayVersion)}</h3><p>${update.available.publishedAt ? e(new Date(update.available.publishedAt).toLocaleDateString("zh-CN")) : ""}${update.available.size ? ` · ${C.formatBytes(update.available.size)}` : ""}</p></div>${update.status === "ready" ? `<button class="button primary" data-action="install-update">${icon("arrow-up-to-line")}安装更新</button>` : update.status === "downloading" ? `<button class="button secondary" data-action="cancel-update">${icon("x")}取消下载</button>` : `<button class="button primary" data-action="download-update" ${!update.available.canDownload || busy ? "disabled" : ""}>${icon("download")}下载更新</button>`}</div>${update.status === "downloading" ? `<div class="update-progress"><div><span>下载中</span><span>${Math.round(update.progress)}%</span></div><progress value="${update.progress}" max="100" aria-label="更新下载进度"></progress></div>` : ""}<h4>更新内容</h4><pre>${e(update.available.notes)}</pre>${!update.available.canDownload ? `<p class="field-hint">此版本尚未提供可校验的 Windows 安装包。</p>` : ""}</section>` : ""}`;
    paintIcons();
  }

  function taskMarkup(task) {
      const names = { extract: "解压", test: "完整性测试", delete: "删除", compress: "压缩", update: "保存修改" };
      const labels = { running: task.phase === "committing" ? "正在提交" : `${names[task.kind]}中`, completed: "已完成", failed: "失败", cancelled: "已取消" };
      const result = task.result || {};
      const note = task.status === "completed" ? task.kind === "extract" ? `${result.files} 个文件已解压${result.skipped ? ` · 跳过 ${result.skipped} 个` : ""}${result.renamed ? ` · 重命名 ${result.renamed} 个` : ""}` : task.kind === "compress" ? `压缩完成 · ${C.formatBytes(result.size)}` : task.kind === "test" ? "完整性检查通过" : task.kind === "update" ? `${result.updated} 个修改已保存，原包备份已保留` : result.backupPath ? "删除完成，原包备份已保留" : "所选文件已移至回收站" : "";
      return `<article class="task-card" data-task-id="${task.id}"><div class="task-card-top">${archiveIcon(task)}<div class="task-card-title"><h3>${e(task.name)}</h3><p>${e(task.destination)} · ${names[task.kind]}</p></div><span class="task-card-state ${task.status}">${labels[task.status]}</span></div><div class="task-progress ${task.status}${task.progress === null && task.status === "running" ? " indeterminate" : ""}"><span style="width:${task.progress || 0}%"></span></div><div class="task-card-bottom"><span>${task.progress === null ? "" : task.progress + "%"}${task.phase === "committing" ? " · 正在安全提交" : ""}</span><div class="task-card-actions">${task.status === "running" ? `<button class="icon-button" data-action="task-cancel" data-id="${task.id}" title="取消任务" aria-label="取消任务" ${task.canCancel ? "" : "disabled"}>${icon("x")}</button>` : `${task.status === "completed" ? `<button class="icon-button" data-action="task-reveal" data-id="${task.id}" title="打开所在目录" aria-label="打开所在目录">${icon("folder-open")}</button>` : ""}<button class="icon-button" data-action="task-remove" data-id="${task.id}" title="移除记录" aria-label="移除记录">${icon("trash-2")}</button>`}</div></div>${task.error ? `<p class="task-error">${e(task.error.message)}</p>` : note ? `<p class="task-completion-note">${e(note)}</p>` : ""}</article>`;
  }

  function updateTaskStatus() {
    const active = state.tasks.filter((task) => ["running", "paused"].includes(task.status));
    $("#task-count").textContent = active.length;
    $("#task-count").hidden = !active.length;
    $("#status-task-text").textContent = active.length ? `${active.length} 个进行中的任务` : "无进行中的任务";
    $("#global-status").textContent = state.tasks.some((task) => task.status === "running") ? "任务进行中" : "就绪";
  }

  function navigate(page) {
    state.page = page;
    document.body.classList.remove("sidebar-open");
    $(".sidebar-backdrop").hidden = true;
    render();
  }
  function openArchive(id) {
    const archive = archives.get(id);
    if (!archive) return;
    closeDialog();
    state.archive = archive;
    state.path = [];
    state.query = "";
    state.selection.clear();
    state.focusedId = null;
    state.history = [id, ...state.history.filter((entry) => entry !== id)];
    navigate("browser");
  }
  function changePath(path) {
    state.path = path;
    state.query = "";
    state.selection.clear();
    state.focusedId = null;
    render();
    $("#file-content").scrollTop = 0;
  }
  function selectItem(id, additive = false) {
    if (!additive) state.selection.clear();
    if (additive && state.selection.has(id)) state.selection.delete(id);
    else state.selection.add(id);
    state.focusedId = state.selection.has(id) ? id : [...state.selection].at(-1) || null;
    updateSelection();
    renderDetails();
    paintIcons();
  }
  function updateSelection() {
    $$("[data-file-id]").forEach((row) => {
      const selected = state.selection.has(row.dataset.fileId);
      row.classList.toggle("selected", selected);
      if (row.tagName === "TR") row.setAttribute("aria-selected", selected);
      const checkbox = $("input[data-select-id]", row);
      if (checkbox) checkbox.checked = selected;
    });
    $("#selection-bar").hidden = !state.selection.size;
    $("#selection-text").textContent = `已选择 ${state.selection.size} 个项目`;
    $("[data-action='extract-selected']").disabled = Boolean(state.archive?.folder);
    updateDeleteButton();
    const allCheckbox = $("#select-all");
    if (allCheckbox) {
      const entries = filteredEntries();
      const selected = entries.filter((item) => state.selection.has(item.id)).length;
      allCheckbox.checked = selected === entries.length && entries.length > 0;
      allCheckbox.indeterminate = selected > 0 && selected < entries.length;
    }
  }
  function updateDeleteButton() {
    const archive = state.archive;
    const canDelete = archive?.native && archive.canDelete;
    $("#delete-button").disabled = !canDelete || !state.selection.size || isLocked();
    $("#delete-button").title = !state.selection.size ? "先选择要删除的文件" : !canDelete ? "此格式或加密方式暂不支持直接删除" : archive.folder ? "将所选文件移到回收站" : "删除所选文件，保留原压缩包备份";
  }
  function toggleSelectAll(checked) {
    if (checked) filteredEntries().forEach((item) => state.selection.add(item.id));
    else filteredEntries().forEach((item) => state.selection.delete(item.id));
    state.focusedId = state.selection.size === 1 ? [...state.selection][0] : null;
    updateSelection();
    renderDetails();
    paintIcons();
  }
  function toggleFavorite(id) {
    const archiveId = id || state.archive?.id;
    if (!archiveId) return;
    if (state.favorites.has(archiveId)) state.favorites.delete(archiveId);
    else state.favorites.add(archiveId);
    render();
    toast(state.favorites.has(archiveId) ? "已添加到我的收藏" : "已取消收藏");
  }

  function openDialog(type, body, footer = "", title = "", wide = false) {
    if (dialog.open) dialog.close();
    state.dialog = type;
    dialog.classList.toggle("preview-dialog", wide);
    dialog.innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${e(title)}</h2><button class="icon-button" data-action="dialog-close" title="关闭" aria-label="关闭对话框">${icon("x")}</button></div>${body}${footer ? `<div class="dialog-footer">${footer}</div>` : ""}`;
    dialog.showModal();
    paintIcons();
  }
  function closeDialog() {
    const password = $("#archive-password");
    if (password) password.value = "";
    if (dialog.open) dialog.close();
    state.dialog = null;
    if (state.previewUrl) { URL.revokeObjectURL(state.previewUrl); state.previewUrl = null; }
  }
  const cancelButton = `<button class="button secondary" data-action="dialog-close">取消</button>`;
  const doneButton = `<button class="button secondary" data-action="dialog-close">知道了</button>`;
  function dialogFile(archive) { return `<div class="dialog-file">${archiveIcon(archive)}<div><strong>${e(archive.name)}</strong><p>${e(archive.format)} · ${C.formatBytes(archive.size)}</p></div></div>`; }

  function showOpen() {
    if (native) return pickNative("openArchive");
    $("#archive-input").click();
  }
  function showPassword(continuation = "browse") {
    if (!state.archive) return;
    state.passwordContinuation = continuation;
    openDialog("password", `<form id="password-form"><div class="dialog-body">${dialogFile(state.archive)}<div class="field-group"><label for="archive-password">压缩包密码</label><div class="input-with-action"><input id="archive-password" type="password" placeholder="输入密码" autocomplete="off" autofocus /><button type="button" class="icon-button" data-action="password-visibility" title="显示密码" aria-label="显示密码">${icon("eye")}</button></div><p class="field-error" id="password-error" role="alert"></p></div><div class="form-notice">${icon("lock-keyhole")}<span>密码仅保留在当前打开的压缩包会话中，关闭后清除，不写入磁盘。</span></div></div><div class="dialog-footer">${cancelButton}<button class="button primary" type="submit">${icon("key-round")}解锁</button></div></form>`, "", "输入压缩包密码");
    $("#archive-password").focus();
  }
  async function submitPassword() {
    const input = $("#archive-password");
    const value = input.value;
    if (!C.validatePassword(value)) { $("#password-error").textContent = "请输入密码。"; input.focus(); return; }
    if (state.archive.native) {
      const button = $("#password-form [type='submit']");
      button.disabled = true;
      try {
        const unlocked = await callNative("unlock", state.archive.id, value);
        state.archive = unlocked; archives.set(unlocked.id, unlocked);
        const continuation = state.passwordContinuation;
        input.value = ""; closeDialog(); render();
        if (continuation === "extract") showExtraction(true);
        else if (continuation === "here") await extractHere();
        else if (continuation === "folder") await extractFolder();
        else if (continuation === "test") await showTest();
        else toast("压缩包已解锁");
      } catch (error) { if ($("#password-error")) $("#password-error").textContent = error.message; input.value = ""; input.focus(); }
      finally { button.disabled = false; }
      return;
    }
    showEngineNotice();
  }
  function showExtraction(preserveSelection = false) {
    const archive = state.archive;
    if (!archive || archive.folder) return;
    if (!archive.native) { showEngineNotice(); return; }
    if (!preserveSelection) { state.extractionSelection = [...state.selection]; state.extractHere = false; }
    if (isLocked()) { showPassword("extract"); return; }
    const selected = state.extractionSelection.length;
    openDialog("extract", `<form id="extract-form"><div class="dialog-body">${dialogFile(archive)}<div class="field-group"><label for="destination">解压到</label><div class="input-with-action"><input id="destination" type="text" value="${e(archive.defaultDestination || "")}" placeholder="目标文件夹" required readonly /><button class="icon-button" type="button" data-action="choose-destination" title="选择文件夹" aria-label="选择文件夹">${icon("folder-open")}</button></div><p class="field-error" id="destination-error" role="alert"></p></div><label class="checkbox-field"><input type="checkbox" id="create-subfolder" ${state.subfolder && !state.extractHere ? "checked" : ""} ${state.extractHere ? "disabled" : ""} />创建同名文件夹</label><div class="field-group"><label for="overwrite-policy">遇到同名文件</label><select id="overwrite-policy"><option value="rename">自动重命名</option><option value="skip">跳过现有文件</option><option value="overwrite">覆盖现有文件</option></select></div><div class="field-group"><span class="field-label">解压范围</span><p class="field-hint">${selected ? `所选 ${selected} 个项目` : "压缩包中的所有文件"}</p></div></div><div class="dialog-footer">${cancelButton}<button class="button primary" type="submit">${icon("arrow-down-to-line")}开始解压</button></div></form>`, "", "解压到…");
  }
  async function extractHere() {
    const archive = state.archive;
    if (!archive || archive.folder) return;
    state.extractHere = true; state.extractionSelection = [...state.selection];
    if (isLocked()) { showPassword("here"); return; }
    if (!archive.native) { showExtraction(true); return; }
    const task = await callNative("extract", { archiveId: archive.id, here: true, subfolder: false, policy: "rename", selection: state.extractionSelection });
    acceptNativeTask(task, true);
  }
  async function extractFolder() {
    const archive = state.archive;
    if (!archive || archive.folder) return;
    if (isLocked()) { showPassword("folder"); return; }
    const task = await callNative("extract", { archiveId: archive.id, destination: archive.defaultDestination, subfolder: true, policy: "rename", selection: [] });
    acceptNativeTask(task, true);
  }
  async function submitExtraction() {
    const destination = $("#destination").value.trim();
    if (!destination) { $("#destination-error").textContent = "请输入目标文件夹。"; $("#destination").focus(); return; }
    const archive = state.archive;
    const subfolder = $("#create-subfolder").checked;
    if (archive.native) {
      const button = $("#extract-form [type='submit']");
      button.disabled = true;
      try {
        const task = await callNative("extract", { archiveId: archive.id, destination, subfolder, policy: $("#overwrite-policy").value, selection: state.extractionSelection });
        acceptNativeTask(task, true);
      } catch (error) { if ($("#destination-error")) $("#destination-error").textContent = error.message; }
      finally { button.disabled = false; }
      return;
    }
    showEngineNotice();
  }
  function showEngineNotice() {
    openDialog("engine", `<div class="dialog-body"><div class="test-result">${icon("monitor")}<h3>请使用 MiniZip 桌面版</h3><p>本地压缩包读写与系统集成在桌面程序中运行。</p></div></div>`, doneButton, "桌面功能");
  }
  async function showTest() {
    if (!state.archive || state.archive.folder) return;
    if (state.archive.external) { showEngineNotice(); return; }
    if (state.archive.native) {
      if (isLocked()) { showPassword("test"); return; }
      acceptNativeTask(await callNative("test", state.archive.id), true);
      return;
    }
    showEngineNotice();
  }
  function showSettings() {
    openDialog("settings", `<form id="settings-form"><div class="dialog-body"><div class="settings-section-title">浏览偏好</div><div class="field-group"><label for="default-view">默认视图</label><select id="default-view"><option value="list" ${state.view === "list" ? "selected" : ""}>列表</option><option value="grid" ${state.view === "grid" ? "selected" : ""}>网格</option></select></div><div class="settings-row"><div><strong>紧凑列表</strong><p>文件行高 · 39 px</p></div><label class="toggle"><input type="checkbox" id="setting-compact" aria-label="紧凑列表" ${state.compact ? "checked" : ""} /><span></span></label></div><div class="settings-row"><div><strong>详细信息面板</strong><p>文件属性与内容分布</p></div><label class="toggle"><input type="checkbox" id="setting-details" aria-label="详细信息面板" ${state.details ? "checked" : ""} /><span></span></label></div><div class="settings-section-title">解压偏好</div><div class="settings-row"><div><strong>创建同名文件夹</strong><p>默认解压目录</p></div><label class="toggle"><input type="checkbox" id="setting-subfolder" aria-label="创建同名文件夹" ${state.subfolder ? "checked" : ""} /><span></span></label></div><p class="field-hint">偏好设置保存在当前浏览器。密码不会保存。</p></div><div class="dialog-footer">${cancelButton}<button class="button primary" type="submit">${icon("check")}保存设置</button></div></form>`, "", "偏好设置");
  }
  function showAbout() {
    openDialog("about", `<div class="dialog-body"><div class="about-brand"><img class="brand-logo" src="assets/favicon.svg" alt="" /><div><h3>MiniZip</h3><p>${e(state.update.current)} · Windows x64</p></div></div><p class="about-copy">7-Zip 26.06 · LZ4 1.10.0 · zip.js</p><div class="format-chips">${["ZIP", "RAR / RAR5", "7Z", "LZ4", "TAR", "GZ", "XZ", "ZSTD"].map((format) => `<span>${format}</span>`).join("")}</div><p class="field-hint">压缩：ZIP / 7Z。删除包内文件：未加密 ZIP / 7Z / TAR。RAR 等格式只读。</p></div>`, `<button class="button secondary" data-action="default-apps">默认应用设置</button>${doneButton}`, "关于 MiniZip");
  }

  async function openItem(id, previewOnly = false) {
    const item = currentItem(id);
    if (!item) return;
    if (item.kind === "folder") { changePath([...state.path, id]); return; }
    if (state.archive.native) {
      try {
        if (!previewOnly) {
          $("#global-status").textContent = "正在打开文件…";
          await callNative("openEntry", state.archive.id, id);
          updateTaskStatus();
          return;
        }
        const preview = await callNative("preview", state.archive.id, id);
        openDialog("preview", `<div class="dialog-body">${preview.kind === "text" ? `<pre class="preview-code">${e(preview.content)}</pre>` : `<img class="preview-image" src="${e(preview.dataUrl)}" alt="${e(item.name)}" />`}</div>`, "", item.name, true);
      } catch (error) { updateTaskStatus(); toast(error.message, true); }
      return;
    }
    if (item.file) {
      if (item.kind === "image" && ["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(C.extension(item.name))) {
        state.previewUrl = URL.createObjectURL(item.file);
        openDialog("preview", `<div class="dialog-body"><img class="preview-image" src="${state.previewUrl}" alt="${e(item.name)}" /></div>`, "", item.name, true);
        return;
      }
      if (item.kind === "text") {
        if (item.size > 1024 * 1024) { toast("当前文本预览上限为 1 MB", true); return; }
        try {
          const content = await item.file.text();
          openDialog("preview", `<div class="dialog-body"><pre class="preview-code">${e(content)}</pre></div>`, "", item.name, true);
        } catch { toast("无法读取此文件，请重新选择", true); }
        return;
      }
    }
    openDialog("preview", `<div class="dialog-body"><div class="empty-state">${fileIcon(item, true)}<h3>此类型暂不支持预览</h3><p>${e(item.type)} · ${C.formatBytes(item.size)}</p></div></div>`, doneButton, item.name);
  }
  function importArchive(file) {
    if (!file) return;
    if (!C.isArchive(file.name)) { toast("未识别此压缩包扩展名，请选择压缩文件", true); return; }
    const archive = { id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: file.name, format: C.extension(file.name).toUpperCase(), method: "待检测", size: file.size, date: new Date(file.lastModified || Date.now()).toISOString().slice(0, 16).replace("T", " "), source: "本地文件", encrypted: false, external: true, demo: false, entries: [] };
    archives.set(archive.id, archive);
    openArchive(archive.id);
    toast("文件已在本地打开，压缩目录待接入引擎解析");
  }
  function importFolder(files) {
    if (!files.length) return;
    const tree = C.buildFolderTree(files);
    const archive = { id: `folder-${Date.now()}`, name: tree.name, entries: tree.entries, size: tree.size, originalSize: tree.size, format: "文件夹", method: "—", date: new Date().toISOString().slice(0, 16).replace("T", " "), source: "本地文件", folder: true, demo: false };
    archives.set(archive.id, archive);
    openArchive(archive.id);
    toast(`已打开本地文件夹：${tree.name}`);
  }

  async function deleteSelected() {
    if (!state.selection.size) return;
    const archive = state.archive;
    if (archive.native) { acceptNativeTask(await callNative("remove", { archiveId: archive.id, selection: [...state.selection] }), true); return; }
    showEngineNotice();
  }

  const actions = {
    home: () => navigate("browser"),
    navigate: (button) => navigate(button.dataset.page),
    "toggle-rail": () => { state.sidebarExpanded = !state.sidebarExpanded; savePreferences(); render(); },
    "create-archive": () => native ? callNative("createArchive") : toast("请使用 MiniZip 桌面版创建压缩包", true),
    "default-apps": () => native ? callNative("defaultApps") : toast("请在 Windows 设置中选择默认应用", true),
    "check-updates": async () => { if (!native) { state.update.status = "error"; state.update.error = "请使用 MiniZip 桌面版检查更新。"; renderUpdates(); return; } state.update = await callNative("checkUpdates"); renderUpdates(); },
    "download-update": () => callNative("downloadUpdate"),
    "cancel-update": () => callNative("cancelUpdate"),
    "install-update": () => callNative("installUpdate"),
    repository: () => native ? callNative("repository") : toast("请使用桌面版打开项目仓库", true),
    open: showOpen,
    "open-recent": (button) => openArchive(button.dataset.archive),
    "pick-archive": () => native ? pickNative("openArchive") : $("#archive-input").click(),
    "open-folder": () => native ? pickNative("openFolder") : $("#folder-input").click(),
    "toggle-sidebar": () => { const open = document.body.classList.toggle("sidebar-open"); $(".sidebar-backdrop").hidden = !open; },
    "toggle-favorite": (button) => toggleFavorite(button.dataset.id),
    view: (button) => { state.view = button.dataset.view; savePreferences(); render(); },
    "toggle-details": () => {
      if (matchMedia("(max-width: 1000px)").matches) { const show = document.body.classList.toggle("show-details"); state.details = show; }
      else state.details = !state.details;
      savePreferences(); render();
    },
    "close-details": () => { state.details = false; document.body.classList.remove("show-details"); savePreferences(); render(); },
    more: () => { const menu = $("#more-menu"); menu.hidden = !menu.hidden; $("#more-button").setAttribute("aria-expanded", !menu.hidden); },
    "select-all": () => { if (!isLocked() && !state.archive?.external) toggleSelectAll(true); },
    "clear-selection": () => { state.selection.clear(); state.focusedId = null; render(); },
    "archive-info": () => { state.focusedId = null; state.details = true; document.body.classList.add("show-details"); render(); },
    "close-archive": async () => {
      if (state.archive?.native) { const id = state.archive.id; if (!await callNative("closeArchive", id)) return; archives.delete(id); state.history = state.history.filter((item) => item !== id); state.favorites.delete(id); }
      state.archive = null; state.selection.clear(); state.focusedId = null; render();
    },
    sort: (button) => { const key = button.dataset.sort; state.sortDirection = state.sortKey === key && state.sortDirection === "asc" ? "desc" : "asc"; state.sortKey = key; renderFiles(); },
    breadcrumb: (button) => changePath(state.path.slice(0, Number(button.dataset.depth))),
    up: () => { if (state.path.length) changePath(state.path.slice(0, -1)); },
    "clear-search": () => { state.query = ""; $("#file-search").value = ""; renderFiles(); },
    "open-item": (button) => openItem(button.dataset.id),
    "preview-item": (button) => openItem(button.dataset.id, true),
    "save-edits": async () => { acceptNativeTask(await callNative("saveEdits", state.archive.id)); toast("正在保存修改…"); },
    "export-edits": async () => { if (await callNative("exportEdits", state.archive.id)) toast("修改副本已另存"); },
    "reveal-edits": () => callNative("revealEdits", state.archive.id),
    "work-files": () => native ? callNative("workFiles") : showEngineNotice(),
    extract: () => showExtraction(),
    "extract-here": extractHere,
    "delete-selected": deleteSelected,
    "choose-destination": async () => { const selected = await callNative("chooseDestination", state.archive.id); if (selected && $("#destination")) $("#destination").value = selected; },
    "extract-selected": () => { state.extractHere = false; state.extractionSelection = [...state.selection]; showExtraction(true); },
    "extract-item": (button) => { state.extractHere = false; state.extractionSelection = [button.dataset.id]; showExtraction(true); },
    unlock: () => showPassword(),
    "password-visibility": (button) => {
      const input = $("#archive-password");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.innerHTML = icon(show ? "eye-off" : "eye");
      button.title = show ? "隐藏密码" : "显示密码";
      button.setAttribute("aria-label", button.title);
      paintIcons();
      input.focus();
    },
    test: showTest,
    settings: showSettings,
    about: showAbout,
    "dialog-close": closeDialog,
    "clear-history": () => { state.history = []; render(); toast("最近打开记录已清空，本地文件未改动"); },
    "task-tab": (button) => { state.taskTab = button.dataset.tab; renderTasks(); paintIcons(); },
    "task-cancel": async (button) => {
      const task = state.tasks.find((item) => item.id === button.dataset.id);
      if (task?.native) { await callNative("cancelTask", task.id); toast("正在取消任务…"); return; }
    },
    "task-reveal": (button) => callNative("revealTask", button.dataset.id),
    "task-remove": (button) => { state.tasks = state.tasks.filter((task) => task.id !== button.dataset.id); render(); },
    "clear-tasks": () => { state.tasks = state.tasks.filter((task) => ["running", "paused"].includes(task.status)); render(); }
  };

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (button) {
      if (button.disabled) return;
      event.preventDefault();
      const action = button.dataset.action;
      if (actions[action]) Promise.resolve(actions[action](button)).catch((error) => toast(error.message || "操作失败", true));
      if (action !== "more") { $("#more-menu").hidden = true; $("#more-button").setAttribute("aria-expanded", "false"); }
      return;
    }
    if (!event.target.closest(".menu-anchor")) { $("#more-menu").hidden = true; $("#more-button").setAttribute("aria-expanded", "false"); }
    if (event.target.closest("input")) return;
    const row = event.target.closest("[data-file-id]");
    if (row) {
      const id = row.dataset.fileId;
      if (state.selection.size === 1 && state.selection.has(id) && !event.ctrlKey && !event.metaKey && !event.shiftKey) return;
      else selectItem(id, event.ctrlKey || event.metaKey || event.shiftKey);
    }
  });
  document.addEventListener("dblclick", (event) => {
    const row = event.target.closest("[data-file-id]");
    if (row && !event.target.closest("input")) openItem(row.dataset.fileId).catch((error) => toast(error.message, true));
  });
  document.addEventListener("change", (event) => {
    if (["update-auto", "update-dev"].includes(event.target.id)) {
      const settings = { autoCheck: $("#update-auto").checked, allowDev: $("#update-dev").checked };
      if (native) callNative("updatePreferences", settings).then((value) => { state.update = value; renderUpdates(); }).catch((error) => { toast(error.message, true); renderUpdates(); });
      else { Object.assign(state.update, settings); renderUpdates(); }
      return;
    }
    if (event.target.dataset.selectId) {
      const id = event.target.dataset.selectId;
      if (event.target.checked) state.selection.add(id); else state.selection.delete(id);
      state.focusedId = state.selection.has(id) ? id : [...state.selection].at(-1) || null;
      updateSelection(); renderDetails(); paintIcons();
    }
    if (event.target.id === "select-all") toggleSelectAll(event.target.checked);
    if (event.target.id === "archive-input") { importArchive(event.target.files[0]); event.target.value = ""; }
    if (event.target.id === "folder-input") { importFolder([...event.target.files]); event.target.value = ""; }
  });
  $("#file-search").addEventListener("input", (event) => {
    state.query = event.target.value;
    state.selection.clear(); state.focusedId = null;
    renderFiles(); renderDetails(); paintIcons();
  });
  document.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.target.id === "password-form") submitPassword().catch((error) => toast(error.message, true));
    else if (event.target.id === "extract-form") submitExtraction().catch((error) => toast(error.message, true));
    else if (event.target.id === "settings-form") {
      state.view = $("#default-view").value;
      state.compact = $("#setting-compact").checked;
      state.details = $("#setting-details").checked;
      state.subfolder = $("#setting-subfolder").checked;
      savePreferences(); closeDialog(); render(); toast("偏好设置已保存");
    }
  });
  dialog.addEventListener("cancel", () => {
    const password = $("#archive-password");
    if (password) password.value = "";
    state.dialog = null;
    if (state.previewUrl) { URL.revokeObjectURL(state.previewUrl); state.previewUrl = null; }
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && state.page === "browser" && !dialog.open) { event.preventDefault(); $("#file-search").focus(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o" && !dialog.open) { event.preventDefault(); Promise.resolve(showOpen()).catch((error) => toast(error.message, true)); }
    if (event.key === "Escape" && !dialog.open) { $("#more-menu").hidden = true; document.body.classList.remove("sidebar-open", "show-details"); $(".sidebar-backdrop").hidden = true; }
    if (event.target.matches("input, textarea, select") || dialog.open) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && state.page === "browser" && !isLocked() && !state.archive?.external) { event.preventDefault(); toggleSelectAll(true); }
    const row = event.target.closest("[data-file-id]");
    if (row && event.key === "Enter") { event.preventDefault(); openItem(row.dataset.fileId); }
    if (row && event.key === " ") { event.preventDefault(); selectItem(row.dataset.fileId, true); }
    if (event.key === "Delete" && state.page === "browser" && state.selection.size) { event.preventDefault(); deleteSelected().catch((error) => toast(error.message, true)); }
    if (event.altKey && event.key === "ArrowUp" && state.page === "browser" && state.path.length) { event.preventDefault(); changePath(state.path.slice(0, -1)); }
  });

  // Desktop file drops pass through the restricted preload bridge.
  document.addEventListener("dragenter", (event) => {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault(); state.dragDepth += 1; $("#drop-overlay").hidden = false;
  });
  document.addEventListener("dragover", (event) => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); });
  document.addEventListener("dragleave", (event) => {
    event.preventDefault(); state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (!state.dragDepth) $("#drop-overlay").hidden = true;
  });
  document.addEventListener("drop", (event) => {
    event.preventDefault(); state.dragDepth = 0; $("#drop-overlay").hidden = true;
    const files = [...event.dataTransfer.files];
    if (native && files.length > 1) { (async () => { for (const file of files) await pickNative("openDropped", file); })().catch((error) => toast(error.message, true)); return; }
    if (files.length > 1) { toast("请一次打开一个压缩包", true); return; }
    if (files[0]) {
      if (native) pickNative("openDropped", files[0]).catch((error) => toast(error.message, true));
      else importArchive(files[0]);
    }
  });
  window.addEventListener("beforeunload", () => { if (state.previewUrl) URL.revokeObjectURL(state.previewUrl); });
  render();
  if (native) {
    $(".preview-tag").textContent = "Dev v1.0.1";
    native.onTask((task) => acceptNativeTask(task));
    native.onArchive((archive) => acceptNativeArchive(archive, state.archive?.id !== archive.id));
    native.onUpdate((value) => { state.update = value; if (state.page === "updates") renderUpdates(); });
    native.onEdits((value) => { if (state.archive?.id === value.archiveId) { state.edits = value; renderEditNotice(); } });
    callNative("ready").then((info) => { $("#engine-status").textContent = info.engine; $(".preview-tag").textContent = info.version; if (info.updates) state.update = info.updates; info.tasks.forEach((task) => acceptNativeTask(task)); }).catch((error) => toast(error.message, true));
  }
})();
