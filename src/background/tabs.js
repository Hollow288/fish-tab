const RECENTLY_CLOSED_MAX_RESULTS = 25;

export async function getGroupedTabs() {
  const tabs = await chrome.tabs.query({});
  const normalizedTabs = tabs
    .filter((tab) => typeof tab.id === "number")
    .map(normalizeTab);

  const groupMap = new Map();
  for (const tab of normalizedTabs) {
    if (!groupMap.has(tab.domain)) {
      groupMap.set(tab.domain, { domain: tab.domain, tabs: [] });
    }

    groupMap.get(tab.domain).tabs.push(tab);
  }

  const groups = Array.from(groupMap.values())
    .map((group) => ({ ...group, tabs: group.tabs.sort(sortTabs) }))
    .sort(sortGroups);

  return {
    total: normalizedTabs.length,
    groups,
    generatedAt: Date.now()
  };
}

export async function getRecentlyClosedSessions() {
  if (!chrome.sessions || typeof chrome.sessions.getRecentlyClosed !== "function") {
    throw new Error("当前浏览器不支持最近关闭会话");
  }

  const sessions = await chrome.sessions.getRecentlyClosed({
    maxResults: getRecentlyClosedMaxResults()
  });
  const items = sessions
    .map(normalizeRecentlyClosedSession)
    .filter(Boolean);

  return {
    total: items.length,
    items,
    generatedAt: Date.now()
  };
}

export async function activateTab(tabId) {
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId)) {
    throw new Error("无效的标签页 ID");
  }

  const tab = await chrome.tabs.update(numericTabId, { active: true });
  if (tab && typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

export async function restoreSession(sessionId) {
  if (!chrome.sessions || typeof chrome.sessions.restore !== "function") {
    throw new Error("当前浏览器不支持恢复最近关闭项");
  }

  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    throw new Error("无效的会话 ID");
  }

  await chrome.sessions.restore(normalizedSessionId);
}

export async function closeTabs(tabIds) {
  const numericTabIds = Array.from(new Set((Array.isArray(tabIds) ? tabIds : [tabIds])
    .map((tabId) => Number(tabId))
    .filter((tabId) => Number.isInteger(tabId))));

  if (numericTabIds.length === 0) {
    throw new Error("没有可关闭的标签页");
  }

  await chrome.tabs.remove(numericTabIds);
}

function normalizeRecentlyClosedSession(session, closedOrder) {
  if (!session || typeof session !== "object") {
    return null;
  }

  if (session.tab) {
    return normalizeRecentlyClosedTab(session.tab, {
      closedOrder,
      lastModified: session.lastModified
    });
  }

  if (session.window) {
    return normalizeRecentlyClosedWindow(session.window, {
      closedOrder,
      lastModified: session.lastModified
    });
  }

  return null;
}

function normalizeRecentlyClosedTab(tab, metadata = {}) {
  const sessionId = String(tab.sessionId || "").trim();
  if (!sessionId) {
    return null;
  }

  const domain = getDisplayDomain(tab.url);
  return {
    sessionId,
    type: "tab",
    title: tab.title || getFallbackTitle(tab.url),
    url: tab.url || "",
    favIconUrl: tab.favIconUrl || "",
    domain,
    tabCount: 1,
    lastModified: Number(metadata.lastModified) || 0,
    closedOrder: Number(metadata.closedOrder) || 0
  };
}

function normalizeRecentlyClosedWindow(window, metadata = {}) {
  const sessionId = String(window.sessionId || "").trim();
  if (!sessionId) {
    return null;
  }

  const tabs = Array.isArray(window.tabs) ? window.tabs : [];
  const representativeTab = tabs.find((tab) => tab?.active) || tabs[0] || {};
  const tabCount = Number(window.tabs?.length) || tabs.length || 0;
  const title = tabCount === 1
    ? representativeTab.title || getFallbackTitle(representativeTab.url)
    : `关闭的窗口（${tabCount} 个标签页）`;

  return {
    sessionId,
    type: "window",
    title,
    url: representativeTab.url || "",
    favIconUrl: representativeTab.favIconUrl || "",
    domain: representativeTab.url ? getDisplayDomain(representativeTab.url) : "浏览器窗口",
    tabCount,
    lastModified: Number(metadata.lastModified) || 0,
    closedOrder: Number(metadata.closedOrder) || 0
  };
}

function normalizeTab(tab) {
  const domain = getDisplayDomain(tab.url);

  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    title: tab.title || getFallbackTitle(tab.url),
    url: tab.url || "",
    favIconUrl: tab.favIconUrl || "",
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    audible: Boolean(tab.audible),
    discarded: Boolean(tab.discarded),
    domain
  };
}

function getRecentlyClosedMaxResults() {
  const browserLimit = Number(chrome.sessions?.MAX_SESSION_RESULTS);
  if (Number.isInteger(browserLimit) && browserLimit > 0) {
    return browserLimit;
  }

  return RECENTLY_CLOSED_MAX_RESULTS;
}

function getDisplayDomain(rawUrl) {
  if (!rawUrl) {
    return "未知页面";
  }

  try {
    const url = new URL(rawUrl);
    if (url.protocol === "file:") {
      return "本地文件";
    }

    if (!url.hostname) {
      return protocolLabel(url.protocol);
    }

    return url.hostname.replace(/^www\./i, "").toLowerCase();
  } catch (_error) {
    return "未知页面";
  }
}

function getFallbackTitle(rawUrl) {
  if (!rawUrl) {
    return "未命名标签页";
  }

  try {
    const url = new URL(rawUrl);
    return url.hostname || rawUrl;
  } catch (_error) {
    return rawUrl;
  }
}

function protocolLabel(protocol) {
  const normalized = protocol.replace(":", "");

  switch (normalized) {
    case "chrome":
      return "Chrome 页面";
    case "edge":
      return "Edge 页面";
    case "about":
      return "浏览器页面";
    case "data":
      return "数据页面";
    default:
      return normalized ? `${normalized} 页面` : "未知页面";
  }
}

function sortGroups(first, second) {
  const firstSortKey = getSecondLevelSortKey(first.domain);
  const secondSortKey = getSecondLevelSortKey(second.domain);
  const bySecondLevelDomain = firstSortKey.localeCompare(secondSortKey, "en", {
    numeric: true,
    sensitivity: "base"
  });

  if (bySecondLevelDomain !== 0) {
    return bySecondLevelDomain;
  }

  const byFullDomain = first.domain.localeCompare(second.domain, "en", {
    numeric: true,
    sensitivity: "base"
  });

  if (byFullDomain !== 0) {
    return byFullDomain;
  }

  return second.tabs.length - first.tabs.length;
}

function getSecondLevelSortKey(domain) {
  const normalized = String(domain || "").toLowerCase();
  const labels = normalized.split(".").filter(Boolean);
  if (labels.length < 2 || isIpAddress(normalized)) {
    return normalized;
  }

  const suffixIndex = getSuffixStartIndex(labels);
  return labels[Math.max(0, suffixIndex - 1)] || normalized;
}

function getSuffixStartIndex(labels) {
  const suffixSecondLevelLabels = new Set([
    "ac",
    "co",
    "com",
    "edu",
    "gov",
    "net",
    "org"
  ]);
  const topLevelLabel = labels[labels.length - 1];
  const possibleSuffixLabel = labels[labels.length - 2];

  if (
    labels.length >= 3 &&
    topLevelLabel.length === 2 &&
    suffixSecondLevelLabels.has(possibleSuffixLabel)
  ) {
    return labels.length - 2;
  }

  return labels.length - 1;
}

function isIpAddress(value) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return true;
  }

  return value.includes(":");
}

function sortTabs(first, second) {
  const byWindow = first.windowId - second.windowId;
  if (byWindow !== 0) {
    return byWindow;
  }

  return first.index - second.index;
}
