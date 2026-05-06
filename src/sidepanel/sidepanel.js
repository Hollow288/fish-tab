import { MESSAGE_TYPES } from "../shared/messages.js";
import {
  DEFAULT_SETTINGS,
  PERIODIC_CAPTURE_INTERVAL_OPTIONS_MS,
  SETTINGS_STORAGE_KEY,
  sanitizeSettings
} from "../shared/settings.js";

const COLLAPSED_DOMAINS_KEY = "fishTabCollapsedDomains";
const AUTO_REFRESH_DEBOUNCE_MS = 180;
const HOVER_DELAY_MS = 380;
const PREVIEW_VIEWPORT_PADDING_PX = 8;
const PREVIEW_GAP_PX = 1;
const PREVIEW_MAX_WIDTH_PX = 280;
const SVG_NS = "http://www.w3.org/2000/svg";
const VIEW_OPEN = "open";
const VIEW_CLOSED = "closed";

const state = {
  view: VIEW_OPEN,
  loading: false,
  recentLoading: false,
  groups: [],
  recentClosed: [],
  collapsedDomains: new Set(),
  total: 0,
  recentTotal: 0,
  error: "",
  recentError: "",
  searchQuery: ""
};

const elements = {
  toggleAll: document.querySelector('[data-action="toggle-all"]'),
  refresh: document.querySelector('[data-action="refresh"]'),
  openSettings: document.querySelector('[data-action="open-settings"]'),
  closeSettings: document.querySelector('[data-action="close-settings"]'),
  settingsPanel: document.querySelector(".settings-panel"),
  settingsToggle: document.querySelector('[data-setting="periodicCaptureEnabled"]'),
  settingsInterval: document.querySelector('[data-setting="periodicCaptureIntervalMs"]'),
  stats: document.querySelector(".app-stats"),
  groups: document.querySelector(".app-groups"),
  searchInput: document.querySelector(".search-input"),
  searchClear: document.querySelector(".search-clear"),
  viewSwitcher: document.querySelector(".view-switcher"),
  viewButtons: document.querySelectorAll(".view-button")
};

const settingsState = {
  values: { ...DEFAULT_SETTINGS },
  loaded: false
};

const previewElements = {
  card: document.querySelector(".preview-card"),
  img: document.querySelector(".preview-image-img"),
  empty: document.querySelector(".preview-image-empty")
};

let autoRefreshTimer = null;
let refreshSequence = 0;
let recentRefreshSequence = 0;
let hoverTimer = null;
let hoveredTabId = null;
let previewSequence = 0;
let currentPreviewRow = null;
let currentPreviewSide = null;

initialize();

function initialize() {
  elements.toggleAll.addEventListener("click", toggleAllGroups);
  elements.refresh.addEventListener("click", () => refreshCurrentView());
  elements.groups.addEventListener("click", handleGroupsClick);
  elements.groups.addEventListener("keydown", handleGroupsKeydown);
  elements.searchInput.addEventListener("input", handleSearchInput);
  elements.searchInput.addEventListener("keydown", handleSearchKeydown);
  elements.searchClear.addEventListener("click", clearSearch);
  elements.viewSwitcher.addEventListener("click", handleViewSwitcherClick);

  if (elements.openSettings) {
    elements.openSettings.addEventListener("click", openSettingsPanel);
  }
  if (elements.closeSettings) {
    elements.closeSettings.addEventListener("click", closeSettingsPanel);
  }
  if (elements.settingsToggle) {
    elements.settingsToggle.addEventListener("change", handleSettingsToggleChange);
  }
  if (elements.settingsInterval) {
    elements.settingsInterval.addEventListener("change", handleSettingsIntervalChange);
  }
  document.addEventListener("keydown", handleGlobalKeydown);

  if (
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    chrome.runtime.onMessage &&
    typeof chrome.runtime.onMessage.addListener === "function"
  ) {
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  }

  if (chrome.storage?.onChanged && typeof chrome.storage.onChanged.addListener === "function") {
    chrome.storage.onChanged.addListener(handleStorageChanged);
  }

  initHoverPreview();
  loadCollapsedDomains();
  loadSettings();
  renderViewSwitcher();
  refreshCurrentView();
}

function handleSearchInput(event) {
  state.searchQuery = event.target.value;
  elements.searchClear.hidden = state.searchQuery.trim().length === 0;
  renderStats();
  renderAllToggleButton();
  renderGroups();
}

function handleSearchKeydown(event) {
  if (event.key !== "Escape") {
    return;
  }

  event.preventDefault();
  if (state.searchQuery) {
    clearSearch();
  } else {
    elements.searchInput.blur();
  }
}

function clearSearch() {
  state.searchQuery = "";
  elements.searchInput.value = "";
  elements.searchClear.hidden = true;
  elements.searchInput.focus();
  renderStats();
  renderAllToggleButton();
  renderGroups();
}

function handleViewSwitcherClick(event) {
  const button = event.target.closest?.(".view-button");
  if (!button) {
    return;
  }

  setView(button.dataset.view);
}

function setView(view) {
  if (view !== VIEW_OPEN && view !== VIEW_CLOSED) {
    return;
  }

  if (state.view === view) {
    return;
  }

  state.view = view;
  resetHoverPreview();
  renderViewSwitcher();
  refreshCurrentView();
}

function getVisibleGroups() {
  const query = state.searchQuery.trim().toLowerCase();
  if (!query) {
    return state.groups;
  }

  const filtered = [];
  for (const group of state.groups) {
    const domain = (group.domain || "").toLowerCase();
    if (domain.includes(query)) {
      filtered.push(group);
      continue;
    }

    const matchingTabs = (group.tabs || []).filter((tab) => {
      const title = (tab.title || "").toLowerCase();
      const url = (tab.url || "").toLowerCase();
      return title.includes(query) || url.includes(query);
    });

    if (matchingTabs.length > 0) {
      filtered.push({ ...group, tabs: matchingTabs });
    }
  }

  return filtered;
}

function getVisibleRecentlyClosedItems() {
  const query = state.searchQuery.trim().toLowerCase();
  if (!query) {
    return state.recentClosed;
  }

  return state.recentClosed.filter((item) => {
    const title = (item.title || "").toLowerCase();
    const url = (item.url || "").toLowerCase();
    const domain = (item.domain || "").toLowerCase();
    return title.includes(query) || url.includes(query) || domain.includes(query);
  });
}

function isGroupCollapsed(domain) {
  if (state.view !== VIEW_OPEN) {
    return false;
  }

  if (state.searchQuery.trim()) {
    return false;
  }

  return state.collapsedDomains.has(domain);
}

function initHoverPreview() {
  elements.groups.addEventListener("mousemove", handleGroupsMouseMove);
  elements.groups.addEventListener("mouseleave", resetHoverPreview);
  elements.groups.addEventListener("scroll", hidePreview);
  window.addEventListener("blur", resetHoverPreview);
  window.addEventListener("resize", resetHoverPreview);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      resetHoverPreview();
    }
  });

  previewElements.img.addEventListener("load", () => {
    if (!currentPreviewRow || previewElements.card.dataset.visible !== "true") {
      return;
    }

    previewElements.img.hidden = false;
    previewElements.empty.hidden = true;
    positionPreviewNearRow(currentPreviewRow);
  });

  previewElements.img.addEventListener("error", () => {
    if (!currentPreviewRow || previewElements.card.dataset.visible !== "true") {
      return;
    }

    previewElements.img.hidden = true;
    previewElements.empty.hidden = false;
    previewElements.empty.textContent = "暂无预览";
    positionPreviewNearRow(currentPreviewRow);
  });
}

function handleGroupsMouseMove(event) {
  if (state.view !== VIEW_OPEN) {
    return;
  }

  const favicon = event.target.closest?.(".favicon");
  const row = favicon ? favicon.closest(".tab-row") : null;
  const tabId = row?.dataset.tabId ? Number(row.dataset.tabId) : null;
  if (tabId === hoveredTabId) {
    return;
  }

  hoveredTabId = tabId;
  clearHoverTimer();
  hidePreview();

  if (!Number.isInteger(tabId) || !row) {
    return;
  }

  hoverTimer = window.setTimeout(() => {
    hoverTimer = null;
    showPreviewForRow(row, tabId);
  }, HOVER_DELAY_MS);
}

function resetHoverPreview() {
  hoveredTabId = null;
  clearHoverTimer();
  hidePreview();
}

function clearHoverTimer() {
  if (hoverTimer) {
    window.clearTimeout(hoverTimer);
    hoverTimer = null;
  }
}

function hidePreview() {
  previewSequence++;
  currentPreviewRow = null;
  currentPreviewSide = null;
  previewElements.card.dataset.visible = "false";
  previewElements.card.setAttribute("aria-hidden", "true");
}

function showPreviewForRow(row, tabId) {
  const tab = findTabById(tabId);
  if (!tab) {
    return;
  }

  currentPreviewRow = row;
  currentPreviewSide = null;
  previewElements.img.hidden = true;
  previewElements.img.removeAttribute("src");
  previewElements.empty.hidden = false;
  previewElements.empty.textContent = "";

  positionPreviewNearRow(row);
  previewElements.card.dataset.visible = "true";
  previewElements.card.setAttribute("aria-hidden", "false");

  const sequence = ++previewSequence;
  sendMessage({ type: MESSAGE_TYPES.GET_CAPTURE, tabId }, (response) => {
    if (sequence !== previewSequence) {
      return;
    }

    if (response?.ok && response.dataUrl) {
      previewElements.img.src = response.dataUrl;
    } else {
      previewElements.empty.textContent = "暂无预览";
    }
  });
}

function positionPreviewNearRow(row) {
  const titleEl = row.querySelector(".tab-title");
  const faviconEl = row.querySelector(".favicon");
  const horizontalAnchor = titleEl || faviconEl || row;
  const verticalAnchor = faviconEl || row;
  const horizontalRect = horizontalAnchor.getBoundingClientRect();
  const verticalRect = verticalAnchor.getBoundingClientRect();

  const maxAvailableWidth = window.innerWidth - PREVIEW_VIEWPORT_PADDING_PX * 2;
  const cardWidth = Math.min(PREVIEW_MAX_WIDTH_PX, maxAvailableWidth);
  const measuredHeight = previewElements.card.offsetHeight;
  const cardHeight = measuredHeight > 0
    ? measuredHeight
    : Math.round((cardWidth * 10) / 16) + 2;

  if (currentPreviewSide === null) {
    const spaceBelow = window.innerHeight - verticalRect.bottom - PREVIEW_VIEWPORT_PADDING_PX;
    const spaceAbove = verticalRect.top - PREVIEW_VIEWPORT_PADDING_PX;
    const requiredHeight = cardHeight + PREVIEW_GAP_PX;
    if (spaceBelow >= requiredHeight) {
      currentPreviewSide = "below";
    } else if (spaceAbove >= requiredHeight) {
      currentPreviewSide = "above";
    } else {
      currentPreviewSide = spaceBelow >= spaceAbove ? "below" : "above";
    }
  }

  let top;
  if (currentPreviewSide === "below") {
    top = verticalRect.bottom + PREVIEW_GAP_PX;
    const maxTop = window.innerHeight - cardHeight - PREVIEW_VIEWPORT_PADDING_PX;
    if (top > maxTop) {
      top = Math.max(PREVIEW_VIEWPORT_PADDING_PX, maxTop);
    }
  } else {
    top = verticalRect.top - cardHeight - PREVIEW_GAP_PX;
    if (top < PREVIEW_VIEWPORT_PADDING_PX) {
      top = PREVIEW_VIEWPORT_PADDING_PX;
    }
  }

  let left = horizontalRect.left;
  if (left + cardWidth > window.innerWidth - PREVIEW_VIEWPORT_PADDING_PX) {
    left = window.innerWidth - cardWidth - PREVIEW_VIEWPORT_PADDING_PX;
  }
  if (left < PREVIEW_VIEWPORT_PADDING_PX) {
    left = PREVIEW_VIEWPORT_PADDING_PX;
  }

  previewElements.card.style.top = `${Math.round(top)}px`;
  previewElements.card.style.left = `${Math.round(left)}px`;
  previewElements.card.style.width = `${cardWidth}px`;
}

function findTabById(tabId) {
  for (const group of state.groups) {
    for (const tab of group.tabs || []) {
      if (tab.id === tabId) {
        return tab;
      }
    }
  }

  return null;
}

function refreshCurrentView(options = {}) {
  if (state.view === VIEW_CLOSED) {
    refreshRecentlyClosed(options);
    return;
  }

  refreshTabs(options);
}

function refreshTabs(options = {}) {
  const silent = Boolean(options.silent);
  const sequence = ++refreshSequence;

  if (!silent) {
    state.loading = true;
  }

  state.error = "";
  render();

  sendMessage({ type: MESSAGE_TYPES.GET_TABS }, (response) => {
    if (sequence !== refreshSequence) {
      return;
    }

    state.loading = false;

    if (!response || !response.ok) {
      state.error = response?.error || "无法读取标签页，请重新加载扩展后再试。";
      state.groups = [];
      pruneCollapsedDomains();
      state.total = 0;
      render();
      return;
    }

    state.groups = Array.isArray(response.groups) ? response.groups : [];
    pruneCollapsedDomains();
    state.total = Number(response.total) || 0;
    state.error = "";
    render();
  });
}

function refreshRecentlyClosed(options = {}) {
  const silent = Boolean(options.silent);
  const sequence = ++recentRefreshSequence;

  if (!silent) {
    state.recentLoading = true;
  }

  state.recentError = "";
  render();

  sendMessage({ type: MESSAGE_TYPES.GET_RECENTLY_CLOSED }, (response) => {
    if (sequence !== recentRefreshSequence) {
      return;
    }

    state.recentLoading = false;

    if (!response || !response.ok) {
      state.recentError = response?.error || "无法读取最近关闭项。";
      state.recentClosed = [];
      state.recentTotal = 0;
      render();
      return;
    }

    state.recentClosed = Array.isArray(response.items) ? response.items : [];
    state.recentTotal = Number(response.total) || state.recentClosed.length;
    state.recentError = "";
    render();
  });
}

function handleRuntimeMessage(message) {
  if (!message || message.type !== MESSAGE_TYPES.TABS_CHANGED) {
    return false;
  }

  scheduleAutoRefresh();
  return false;
}

function scheduleAutoRefresh() {
  if (autoRefreshTimer) {
    window.clearTimeout(autoRefreshTimer);
  }

  autoRefreshTimer = window.setTimeout(() => {
    autoRefreshTimer = null;
    refreshCurrentView({ silent: true });
  }, AUTO_REFRESH_DEBOUNCE_MS);
}

function handleGroupsClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== "function") {
    return;
  }

  const restoreButton = target.closest(".session-restore");
  if (restoreButton) {
    restoreSessionById(restoreButton.dataset.sessionId);
    return;
  }

  if (state.view === VIEW_CLOSED) {
    const recentRow = target.closest(".recent-row");
    if (recentRow && !target.closest("button")) {
      restoreSessionById(recentRow.dataset.sessionId);
    }

    return;
  }

  const tabCloseButton = target.closest(".tab-close");
  if (tabCloseButton) {
    const tabId = Number(tabCloseButton.dataset.tabId);
    if (Number.isInteger(tabId)) {
      closeTabsById([tabId]);
    }

    return;
  }

  const domainCloseButton = target.closest(".domain-close");
  if (domainCloseButton) {
    const domain = domainCloseButton.dataset.domain;
    const group = state.groups.find((item) => (item.domain || "未知页面") === domain);
    if (group) {
      closeTabsById((group.tabs || []).map((tab) => tab.id));
    }

    return;
  }

  const toggle = target.closest(".domain-toggle");
  if (toggle) {
    const domain = toggle.dataset.domain;
    if (!domain) {
      return;
    }

    if (state.collapsedDomains.has(domain)) {
      state.collapsedDomains.delete(domain);
    } else {
      state.collapsedDomains.add(domain);
    }

    saveCollapsedDomains();
    renderAllToggleButton();
    applyCollapsedStateToDom();
    return;
  }

  const row = target.closest(".tab-row");
  if (!row) {
    return;
  }

  const tabId = Number(row.dataset.tabId);
  if (Number.isInteger(tabId)) {
    activateTabById(tabId);
  }
}

function handleGroupsKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  const target = event.target;
  if (!target || typeof target.closest !== "function") {
    return;
  }

  if (state.view === VIEW_CLOSED) {
    const recentRow = target.closest(".recent-row");
    if (!recentRow || target.closest("button")) {
      return;
    }

    event.preventDefault();
    restoreSessionById(recentRow.dataset.sessionId);
    return;
  }

  const row = target.closest(".tab-row");
  if (!row || target.closest("button")) {
    return;
  }

  const tabId = Number(row.dataset.tabId);
  if (!Number.isInteger(tabId)) {
    return;
  }

  event.preventDefault();
  activateTabById(tabId);
}

function activateTabById(tabId) {
  sendMessage({ type: MESSAGE_TYPES.ACTIVATE_TAB, tabId }, (response) => {
    if (!response || !response.ok) {
      state.error = response?.error || "无法切换到该标签页。";
      render();
    }
  });
}

function restoreSessionById(sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    return;
  }

  sendMessage({
    type: MESSAGE_TYPES.RESTORE_SESSION,
    sessionId: normalizedSessionId
  }, (response) => {
    if (!response || !response.ok) {
      state.recentError = response?.error || "无法恢复最近关闭项。";
      render();
      return;
    }

    removeRestoredSession(normalizedSessionId);
    render();
    refreshRecentlyClosed({ silent: true });
  });
}

function closeTabsById(tabIds) {
  const numericTabIds = Array.from(new Set(tabIds
    .map((tabId) => Number(tabId))
    .filter((tabId) => Number.isInteger(tabId))));

  if (numericTabIds.length === 0) {
    return;
  }

  sendMessage({ type: MESSAGE_TYPES.CLOSE_TABS, tabIds: numericTabIds }, (response) => {
    if (!response || !response.ok) {
      state.error = response?.error || "无法关闭标签页。";
      render();
      return;
    }

    removeClosedTabs(numericTabIds);
    render();
  });
}

function toggleAllGroups() {
  if (state.view !== VIEW_OPEN) {
    return;
  }

  if (state.searchQuery.trim()) {
    return;
  }

  if (state.groups.length === 0) {
    return;
  }

  if (areAllGroupsCollapsed()) {
    state.collapsedDomains.clear();
  } else {
    for (const domain of getGroupDomains()) {
      state.collapsedDomains.add(domain);
    }
  }

  saveCollapsedDomains();
  renderAllToggleButton();
  applyCollapsedStateToDom();
}

function applyCollapsedStateToDom() {
  for (const section of elements.groups.querySelectorAll(".domain-group")) {
    const toggle = section.querySelector(".domain-toggle");
    const domain = toggle?.dataset.domain;
    if (!domain) {
      continue;
    }

    const collapsed = isGroupCollapsed(domain);
    section.dataset.collapsed = String(collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
  }
}

function render() {
  renderViewSwitcher();
  renderStats();
  renderAllToggleButton();
  renderGroups();
}

function renderViewSwitcher() {
  for (const button of elements.viewButtons) {
    const selected = button.dataset.view === state.view;
    button.setAttribute("aria-selected", String(selected));
  }

  elements.searchInput.placeholder = state.view === VIEW_CLOSED
    ? "搜索最近关闭..."
    : "按域名或标题搜索...";
  elements.groups.dataset.view = state.view;
}

function isCurrentViewLoading() {
  return state.view === VIEW_CLOSED ? state.recentLoading : state.loading;
}

function getCurrentError() {
  return state.view === VIEW_CLOSED ? state.recentError : state.error;
}

function renderAllToggleButton() {
  const hasGroups = state.view === VIEW_OPEN &&
    state.groups.length > 0 &&
    !state.loading &&
    !state.error;
  const isSearching = Boolean(state.searchQuery.trim());
  const enabled = hasGroups && !isSearching;
  const allCollapsed = enabled && areAllGroupsCollapsed();
  const label = allCollapsed ? "全部展开" : "全部折叠";

  elements.toggleAll.disabled = !enabled;
  elements.toggleAll.dataset.mode = allCollapsed ? "expand" : "collapse";
  elements.toggleAll.setAttribute("aria-label", label);
  elements.toggleAll.title = state.view === VIEW_CLOSED
    ? "最近关闭视图无需折叠/展开"
    : isSearching ? "搜索中无法折叠/展开" : label;
}

function renderStats() {
  const error = getCurrentError();
  const loading = isCurrentViewLoading();

  if (error) {
    elements.stats.dataset.state = "error";
    elements.stats.textContent = error;
    return;
  }

  if (loading) {
    elements.stats.dataset.state = "loading";
    elements.stats.textContent = state.view === VIEW_CLOSED
      ? "正在读取最近关闭..."
      : "正在读取标签页...";
    return;
  }

  elements.stats.dataset.state = "info";

  if (state.view === VIEW_CLOSED) {
    renderRecentlyClosedStats();
    return;
  }

  if (state.searchQuery.trim()) {
    const visible = getVisibleGroups();
    const tabCount = visible.reduce((sum, group) => sum + (group.tabs?.length || 0), 0);
    if (tabCount === 0) {
      elements.stats.textContent = "没有匹配的标签页";
      return;
    }

    elements.stats.replaceChildren(
      createStat("匹配", `${tabCount} / ${state.total}`),
      createStat("域名", String(visible.length))
    );
    return;
  }

  if (state.total === 0) {
    elements.stats.textContent = "暂无标签页";
    return;
  }

  elements.stats.replaceChildren(
    createStat("标签页", String(state.total)),
    createStat("域名分组", String(state.groups.length))
  );
}

function renderRecentlyClosedStats() {
  if (state.searchQuery.trim()) {
    const visible = getVisibleRecentlyClosedItems();
    if (visible.length === 0) {
      elements.stats.textContent = "没有匹配的最近关闭项";
      return;
    }

    elements.stats.replaceChildren(
      createStat("匹配", `${visible.length} / ${state.recentTotal}`)
    );
    return;
  }

  if (state.recentTotal === 0) {
    elements.stats.textContent = "暂无最近关闭";
    return;
  }

  elements.stats.replaceChildren(
    createStat("最近关闭", String(state.recentTotal))
  );
}

function createStat(label, value) {
  const wrapper = document.createElement("span");
  wrapper.className = "app-stat";

  const labelNode = document.createElement("span");
  labelNode.className = "app-stat-label";
  labelNode.textContent = `${label}：`;

  const valueNode = document.createElement("span");
  valueNode.className = "app-stat-value";
  valueNode.textContent = value;

  wrapper.append(labelNode, valueNode);
  return wrapper;
}

function renderGroups() {
  const previousScrollTop = elements.groups.scrollTop;
  resetHoverPreview();
  elements.groups.replaceChildren();

  if (isCurrentViewLoading()) {
    const loading = document.createElement("div");
    loading.className = "loading";
    loading.textContent = "加载中...";
    elements.groups.appendChild(loading);
    restoreGroupsScroll(previousScrollTop);
    return;
  }

  if (getCurrentError()) {
    restoreGroupsScroll(previousScrollTop);
    return;
  }

  if (state.view === VIEW_CLOSED) {
    renderRecentlyClosedItems();
    restoreGroupsScroll(previousScrollTop);
    return;
  }

  const visible = getVisibleGroups();

  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = state.searchQuery.trim()
      ? "没有匹配的标签页。"
      : "没有可展示的标签页。";
    elements.groups.appendChild(empty);
    restoreGroupsScroll(previousScrollTop);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const group of visible) {
    fragment.appendChild(createGroupNode(group));
  }

  elements.groups.appendChild(fragment);
  restoreGroupsScroll(previousScrollTop);
}

function restoreGroupsScroll(scrollTop) {
  if (!scrollTop) {
    return;
  }

  const maxScrollTop = elements.groups.scrollHeight - elements.groups.clientHeight;
  elements.groups.scrollTop = Math.min(scrollTop, Math.max(0, maxScrollTop));
}

function renderRecentlyClosedItems() {
  const visible = getVisibleRecentlyClosedItems();

  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = state.searchQuery.trim()
      ? "没有匹配的最近关闭项。"
      : "暂无最近关闭项。";
    elements.groups.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of visible) {
    fragment.appendChild(createRecentlyClosedRow(item));
  }

  elements.groups.appendChild(fragment);
}

function createGroupNode(group) {
  const domain = group.domain || "未知页面";
  const collapsed = isGroupCollapsed(domain);
  const section = document.createElement("section");
  section.className = "domain-group";
  section.dataset.collapsed = String(collapsed);

  const header = document.createElement("div");
  header.className = "domain-header";

  const toggle = document.createElement("button");
  toggle.className = "domain-toggle";
  toggle.type = "button";
  toggle.dataset.domain = domain;
  toggle.setAttribute("aria-expanded", String(!collapsed));

  const summary = document.createElement("span");
  summary.className = "domain-summary";

  const chevron = document.createElement("span");
  chevron.className = "domain-chevron";
  chevron.appendChild(createIcon(["M6 9l6 6 6-6"]));

  const domainName = document.createElement("div");
  domainName.className = "domain-name";
  domainName.textContent = domain;
  summary.append(chevron, domainName);

  const count = document.createElement("span");
  count.className = "count";
  count.textContent = String(group.tabs?.length || 0);

  toggle.append(summary, count);

  const close = createButton("mini-button domain-close", {
    "aria-label": `关闭 ${domain} 的全部标签页`,
    title: `关闭 ${domain} 的全部标签页`
  });
  close.dataset.domain = domain;
  close.appendChild(createIcon(["M18 6 6 18", "M6 6l12 12"]));

  header.append(toggle, close);
  section.appendChild(header);

  const list = document.createElement("div");
  list.className = "tab-list";

  for (const tab of group.tabs || []) {
    list.appendChild(createTabRow(tab));
  }

  section.appendChild(list);
  return section;
}

function createTabRow(tab) {
  const row = document.createElement("div");
  row.className = "tab-row";
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.dataset.tabId = String(tab.id);
  row.dataset.active = String(Boolean(tab.active));
  row.setAttribute("aria-label", tab.title || tab.url || "未命名标签页");

  const favicon = createFavicon(tab);

  const text = document.createElement("span");
  text.className = "tab-text";

  const title = document.createElement("span");
  title.className = "tab-title";
  title.textContent = tab.title || "未命名标签页";

  const url = document.createElement("span");
  url.className = "tab-url";
  url.textContent = getReadableUrl(tab.url);

  text.append(title, url);

  const badges = document.createElement("span");
  badges.className = "badges";
  appendBadge(badges, tab.active, "当前");
  appendBadge(badges, tab.pinned, "固定");
  appendBadge(badges, tab.audible, "声音");

  const close = createButton("mini-button tab-close", {
    "aria-label": `关闭 ${tab.title || "未命名标签页"}`,
    title: "关闭标签页"
  });
  close.dataset.tabId = String(tab.id);
  close.appendChild(createIcon(["M18 6 6 18", "M6 6l12 12"]));

  row.append(favicon, text, badges, close);
  return row;
}

function createRecentlyClosedRow(item) {
  const row = document.createElement("div");
  row.className = "tab-row recent-row";
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.dataset.sessionId = item.sessionId || "";
  row.dataset.active = "false";
  row.dataset.restorable = String(Boolean(item.sessionId));
  row.setAttribute("aria-label", `恢复 ${item.title || item.url || "最近关闭项"}`);

  const favicon = createFavicon(item);

  const text = document.createElement("span");
  text.className = "tab-text";

  const title = document.createElement("span");
  title.className = "tab-title";
  title.textContent = item.title || "未命名标签页";

  const url = document.createElement("span");
  url.className = "tab-url";
  url.textContent = getReadableUrl(item.url) || item.domain || "";

  text.append(title, url);

  const badges = document.createElement("span");
  badges.className = "badges";
  appendBadge(badges, item.type === "window", "窗口");
  appendBadge(badges, Number(item.tabCount) > 1, `${item.tabCount} 页`);

  const restore = createButton("mini-button session-restore", {
    "aria-label": `恢复 ${item.title || "最近关闭项"}`,
    title: "恢复"
  });
  restore.dataset.sessionId = item.sessionId || "";
  restore.disabled = !item.sessionId;
  restore.appendChild(createIcon([
    "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",
    "M3 3v5h5"
  ]));

  row.append(favicon, text, badges, restore);
  return row;
}

function createFavicon(tab) {
  const favicon = document.createElement("span");
  favicon.className = "favicon";
  const primaryIcon = tab.favIconUrl;
  const fallbackIcon = tab.url ? buildCachedFaviconUrl(tab.url) : "";
  const useLetterFallback = () => {
    favicon.classList.add("favicon--fallback");
    favicon.textContent = getDomainInitial(tab.domain);
  };

  if (primaryIcon || fallbackIcon) {
    const image = document.createElement("img");
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    let triedFallback = !primaryIcon;
    image.addEventListener("error", () => {
      if (!triedFallback && fallbackIcon) {
        triedFallback = true;
        image.src = fallbackIcon;
        return;
      }

      image.remove();
      useLetterFallback();
    });
    image.src = primaryIcon || fallbackIcon;
    favicon.appendChild(image);
  } else {
    useLetterFallback();
  }

  return favicon;
}

function appendBadge(parent, visible, label) {
  if (!visible) {
    return;
  }

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = label;
  parent.appendChild(badge);
}

function createButton(className, attributes) {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";

  for (const [name, value] of Object.entries(attributes)) {
    button.setAttribute(name, value);
  }

  return button;
}

function createIcon(paths) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  for (const data of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", data);
    svg.appendChild(path);
  }

  return svg;
}

function areAllGroupsCollapsed() {
  const domains = getGroupDomains();
  return domains.length > 0 && domains.every((domain) => state.collapsedDomains.has(domain));
}

function getGroupDomains() {
  return state.groups.map((group) => group.domain || "未知页面");
}

function pruneCollapsedDomains() {
  const domains = new Set(getGroupDomains());
  for (const domain of Array.from(state.collapsedDomains)) {
    if (!domains.has(domain)) {
      state.collapsedDomains.delete(domain);
    }
  }
}

function removeClosedTabs(tabIds) {
  const closedTabIds = new Set(tabIds);
  state.groups = state.groups
    .map((group) => ({
      ...group,
      tabs: (group.tabs || []).filter((tab) => !closedTabIds.has(tab.id))
    }))
    .filter((group) => group.tabs.length > 0);
  state.total = state.groups.reduce((total, group) => total + group.tabs.length, 0);
  pruneCollapsedDomains();
}

function removeRestoredSession(sessionId) {
  state.recentClosed = state.recentClosed
    .filter((item) => item.sessionId !== sessionId);
  state.recentTotal = state.recentClosed.length;
}

function getReadableUrl(rawUrl) {
  if (!rawUrl) {
    return "";
  }

  try {
    const url = new URL(rawUrl);
    if (url.protocol === "file:") {
      return decodeURIComponent(url.pathname);
    }

    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch (_error) {
    return rawUrl;
  }
}

function buildCachedFaviconUrl(pageUrl) {
  if (
    typeof chrome === "undefined" ||
    !chrome.runtime ||
    typeof chrome.runtime.getURL !== "function"
  ) {
    return "";
  }

  try {
    const url = new URL(chrome.runtime.getURL("/_favicon/"));
    url.searchParams.set("pageUrl", pageUrl);
    url.searchParams.set("size", "32");
    return url.toString();
  } catch (_error) {
    return "";
  }
}

function getDomainInitial(domain) {
  const value = String(domain || "?").trim();
  return value ? value[0].toUpperCase() : "?";
}

function loadCollapsedDomains() {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  storage.get(COLLAPSED_DOMAINS_KEY, (result) => {
    const saved = result?.[COLLAPSED_DOMAINS_KEY];
    if (!Array.isArray(saved)) {
      return;
    }

    state.collapsedDomains = new Set(saved.filter((domain) => typeof domain === "string"));
    render();
  });
}

function saveCollapsedDomains() {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  storage.set({
    [COLLAPSED_DOMAINS_KEY]: Array.from(state.collapsedDomains)
  });
}

function loadSettings() {
  const storage = getStorage();
  if (!storage) {
    applySettingsToControls();
    return;
  }

  storage.get(SETTINGS_STORAGE_KEY, (result) => {
    settingsState.values = sanitizeSettings(result?.[SETTINGS_STORAGE_KEY]);
    settingsState.loaded = true;
    applySettingsToControls();
  });
}

function applySettingsToControls() {
  if (elements.settingsToggle) {
    elements.settingsToggle.checked = settingsState.values.periodicCaptureEnabled;
  }
  if (elements.settingsInterval) {
    const value = String(settingsState.values.periodicCaptureIntervalMs);
    if (PERIODIC_CAPTURE_INTERVAL_OPTIONS_MS.map(String).includes(value)) {
      elements.settingsInterval.value = value;
    }
    elements.settingsInterval.disabled = !settingsState.values.periodicCaptureEnabled;
  }
}

function persistSettings() {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  storage.set({ [SETTINGS_STORAGE_KEY]: { ...settingsState.values } });
}

function handleSettingsToggleChange(event) {
  settingsState.values = sanitizeSettings({
    ...settingsState.values,
    periodicCaptureEnabled: Boolean(event.target.checked)
  });
  applySettingsToControls();
  persistSettings();
}

function handleSettingsIntervalChange(event) {
  settingsState.values = sanitizeSettings({
    ...settingsState.values,
    periodicCaptureIntervalMs: Number(event.target.value)
  });
  applySettingsToControls();
  persistSettings();
}

function handleStorageChanged(changes, area) {
  if (area !== "local" || !changes[SETTINGS_STORAGE_KEY]) {
    return;
  }

  settingsState.values = sanitizeSettings(changes[SETTINGS_STORAGE_KEY].newValue);
  applySettingsToControls();
}

function openSettingsPanel() {
  if (!elements.settingsPanel) {
    return;
  }

  elements.settingsPanel.dataset.open = "true";
  elements.settingsPanel.setAttribute("aria-hidden", "false");
  if (elements.openSettings) {
    elements.openSettings.setAttribute("aria-expanded", "true");
  }
  resetHoverPreview();

  if (elements.closeSettings) {
    elements.closeSettings.focus();
  }
}

function closeSettingsPanel() {
  if (!elements.settingsPanel || elements.settingsPanel.dataset.open !== "true") {
    return;
  }

  elements.settingsPanel.dataset.open = "false";
  elements.settingsPanel.setAttribute("aria-hidden", "true");
  if (elements.openSettings) {
    elements.openSettings.setAttribute("aria-expanded", "false");
    elements.openSettings.focus();
  }
}

function handleGlobalKeydown(event) {
  if (event.key !== "Escape") {
    return;
  }

  if (elements.settingsPanel?.dataset.open === "true") {
    event.preventDefault();
    closeSettingsPanel();
  }
}

function getStorage() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
    return null;
  }

  return chrome.storage.local;
}

function sendMessage(message, callback) {
  try {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        callback({
          ok: false,
          error: chrome.runtime.lastError.message
        });
        return;
      }

      callback(response);
    });
  } catch (error) {
    callback({
      ok: false,
      error: error instanceof Error ? error.message : "扩展通信失败"
    });
  }
}
