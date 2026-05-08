import { MESSAGE_TYPES } from "../shared/messages.js";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  sanitizeSettings
} from "../shared/settings.js";
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
  restoreSession,
  tidyAllWindows
} from "./tabs.js";

const TABS_CHANGED_DEBOUNCE_MS = 120;
const ACTIVATION_SETTLE_DELAY_MS = 1500;
const IDLE_DETECTION_INTERVAL_S = 60;

let tabsChangedTimer = null;

let settings = { ...DEFAULT_SETTINGS };

const tracking = {
  tabId: null,
  windowId: null,
  settleTimer: null,
  periodicTimer: null
};

let focusedWindowId = chrome.windows?.WINDOW_ID_NONE ?? -1;
let idleState = "active";

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
void bootstrapSettingsAndFocus();

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[SETTINGS_STORAGE_KEY]) {
      return;
    }

    settings = sanitizeSettings(changes[SETTINGS_STORAGE_KEY].newValue);
    if (tracking.tabId !== null && tracking.windowId !== null) {
      restartPeriodicCapture();
    }
  });
}

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

  if (message.type === MESSAGE_TYPES.TIDY_WINDOWS) {
    tidyAllWindows()
      .then((payload) => sendResponse({ ok: true, ...payload }))
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
  trackActiveTab(tabId, windowId);
  void captureForTab(tabId, windowId, { force: true });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  scheduleTabsChangedNotification();

  if (changeInfo.url) {
    void evictIfPresent(tabId);
  }

  if (changeInfo.status === "complete" && tab?.active && typeof tab.windowId === "number") {
    void captureForTab(tabId, tab.windowId, { force: true });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  scheduleTabsChangedNotification();
  void removeCapture(tabId);
  if (tracking.tabId === tabId) {
    stopTracking();
  }
});

if (chrome.windows?.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    focusedWindowId = windowId;

    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      clearPeriodicTimer();
      return;
    }

    void onWindowFocused(windowId);
  });
}

if (chrome.windows?.onRemoved) {
  chrome.windows.onRemoved.addListener((windowId) => {
    if (tracking.windowId === windowId) {
      stopTracking();
    }
  });
}

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

if (chrome.idle) {
  try {
    chrome.idle.setDetectionInterval(IDLE_DETECTION_INTERVAL_S);
  } catch (_error) {
    // Older platforms may not allow this; fall back to default interval.
  }

  chrome.idle.queryState(IDLE_DETECTION_INTERVAL_S, (state) => {
    if (typeof state === "string") {
      idleState = state;
    }
  });

  chrome.idle.onStateChanged.addListener((state) => {
    idleState = state;
    if (state === "active" && tracking.tabId !== null && tracking.windowId !== null) {
      // Wake up: refresh the active tab's capture and resume periodic ticks.
      void captureForTab(tracking.tabId, tracking.windowId, { force: true });
      restartPeriodicCapture();
    }
  });
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

async function bootstrapSettingsAndFocus() {
  try {
    if (chrome.storage?.local) {
      const result = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
      settings = sanitizeSettings(result?.[SETTINGS_STORAGE_KEY]);
    }
  } catch (error) {
    console.warn("[fish-tab] failed to load settings", error);
  }

  try {
    const focused = await chrome.windows.getLastFocused({ populate: false });
    if (focused?.focused && typeof focused.id === "number") {
      focusedWindowId = focused.id;
      const [tab] = await chrome.tabs.query({ active: true, windowId: focused.id });
      if (tab?.id != null) {
        trackActiveTab(tab.id, focused.id);
        void captureForTab(tab.id, focused.id, { force: true });
      }
    }
  } catch (error) {
    console.warn("[fish-tab] focus bootstrap failed", error);
  }
}

async function onWindowFocused(windowId) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id != null) {
      trackActiveTab(tab.id, windowId);
      void captureForTab(tab.id, windowId, { force: true });
    }
  } catch (error) {
    console.warn("[fish-tab] onWindowFocused failed", error);
  }
}

function trackActiveTab(tabId, windowId) {
  const numericTabId = Number(tabId);
  const numericWindowId = Number(windowId);
  if (!Number.isInteger(numericTabId) || !Number.isInteger(numericWindowId)) {
    return;
  }

  tracking.tabId = numericTabId;
  tracking.windowId = numericWindowId;

  scheduleSettleCapture(numericTabId, numericWindowId);
  restartPeriodicCapture();
}

function stopTracking() {
  clearSettleTimer();
  clearPeriodicTimer();
  tracking.tabId = null;
  tracking.windowId = null;
}

function scheduleSettleCapture(tabId, windowId) {
  clearSettleTimer();
  tracking.settleTimer = setTimeout(() => {
    tracking.settleTimer = null;
    if (tracking.tabId === tabId && tracking.windowId === windowId) {
      void captureForTab(tabId, windowId);
    }
  }, ACTIVATION_SETTLE_DELAY_MS);
}

function restartPeriodicCapture() {
  clearPeriodicTimer();

  if (!settings.periodicCaptureEnabled) {
    return;
  }

  const tabId = tracking.tabId;
  const windowId = tracking.windowId;
  if (tabId === null || windowId === null) {
    return;
  }

  if (focusedWindowId !== windowId) {
    return;
  }

  tracking.periodicTimer = setInterval(() => {
    if (
      tracking.tabId === tabId &&
      tracking.windowId === windowId &&
      focusedWindowId === windowId &&
      idleState === "active"
    ) {
      void captureForTab(tabId, windowId, { force: true });
    }
  }, settings.periodicCaptureIntervalMs);
}

function clearSettleTimer() {
  if (tracking.settleTimer) {
    clearTimeout(tracking.settleTimer);
    tracking.settleTimer = null;
  }
}

function clearPeriodicTimer() {
  if (tracking.periodicTimer) {
    clearInterval(tracking.periodicTimer);
    tracking.periodicTimer = null;
  }
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
