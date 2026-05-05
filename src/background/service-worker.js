import { MESSAGE_TYPES } from "../shared/messages.js";
import {
  captureForTab,
  ensureRestored,
  evictIfPresent,
  getCapture,
  removeCapture
} from "./captures.js";
import {
  activateTab,
  closeTabs,
  getGroupedTabs,
  getRecentlyClosedSessions,
  restoreSession
} from "./tabs.js";

const TABS_CHANGED_DEBOUNCE_MS = 120;

let tabsChangedTimer = null;

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {
    // Older Chrome versions may not support setPanelBehavior; silently ignore.
  });

if (chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    void warmUpCaptures();
  });
}

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    void warmUpCaptures();
  });
}

void ensureRestored();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === MESSAGE_TYPES.GET_TABS) {
    getGroupedTabs()
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.GET_RECENTLY_CLOSED) {
    getRecentlyClosedSessions()
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.ACTIVATE_TAB) {
    activateTab(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.CLOSE_TABS) {
    closeTabs(message.tabIds)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.RESTORE_SESSION) {
    restoreSession(message.sessionId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.GET_CAPTURE) {
    handleGetCapture(message.tabId)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
    return true;
  }

  return false;
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  scheduleTabsChangedNotification();
  void captureForTab(tabId, windowId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  scheduleTabsChangedNotification();

  if (changeInfo.url) {
    void evictIfPresent(tabId);
  }

  if (changeInfo.status === "complete" && tab?.active && typeof tab.windowId === "number") {
    void captureForTab(tabId, tab.windowId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  scheduleTabsChangedNotification();
  void removeCapture(tabId);
});

const otherTabEvents = [
  chrome.tabs.onCreated,
  chrome.tabs.onMoved,
  chrome.tabs.onAttached,
  chrome.tabs.onDetached,
  chrome.tabs.onReplaced,
  chrome.tabs.onHighlighted
];

for (const event of otherTabEvents) {
  if (event && typeof event.addListener === "function") {
    event.addListener(scheduleTabsChangedNotification);
  }
}

if (chrome.sessions?.onChanged && typeof chrome.sessions.onChanged.addListener === "function") {
  chrome.sessions.onChanged.addListener(scheduleTabsChangedNotification);
}

async function handleGetCapture(tabId) {
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId)) {
    return null;
  }

  const cached = await getCapture(numericTabId);
  if (cached?.dataUrl) {
    return cached.dataUrl;
  }

  // Fallback: if the requested tab is currently active in some window, capture now.
  try {
    const tab = await chrome.tabs.get(numericTabId);
    if (tab?.active && typeof tab.windowId === "number") {
      await captureForTab(numericTabId, tab.windowId);
      const refreshed = await getCapture(numericTabId);
      if (refreshed?.dataUrl) {
        return refreshed.dataUrl;
      }
      console.warn("[fish-tab] active-tab fallback capture produced no entry", {
        tabId: numericTabId,
        windowId: tab.windowId,
        url: tab.url
      });
    }
  } catch (error) {
    console.warn("[fish-tab] handleGetCapture lookup failed", { tabId: numericTabId, error });
  }

  return null;
}

async function warmUpCaptures() {
  console.info("[fish-tab] warming up captures");
  try {
    const windows = await chrome.windows.getAll();
    for (const window of windows) {
      if (typeof window.id !== "number") {
        continue;
      }

      const activeTabs = await chrome.tabs.query({
        active: true,
        windowId: window.id
      });
      for (const tab of activeTabs) {
        if (typeof tab.id === "number") {
          await captureForTab(tab.id, window.id);
        }
      }
    }
  } catch (error) {
    console.warn("[fish-tab] warmUpCaptures failed", error);
  }
}

function scheduleTabsChangedNotification() {
  if (tabsChangedTimer) {
    clearTimeout(tabsChangedTimer);
  }

  tabsChangedTimer = setTimeout(() => {
    tabsChangedTimer = null;
    chrome.runtime.sendMessage({ type: MESSAGE_TYPES.TABS_CHANGED }, () => {
      // No side panel open in any window — that's fine.
      void chrome.runtime.lastError;
    });
  }, TABS_CHANGED_DEBOUNCE_MS);
}

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "操作失败";
}
