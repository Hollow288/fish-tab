const SESSION_KEY = "fishTabCaptures";
const MAX_ENTRIES = 40;
const PER_TAB_THROTTLE_MS = 1500;
const PER_WINDOW_THROTTLE_MS = 650;
const TRANSIENT_RETRY_DELAY_MS = 1800;
const MAX_TRANSIENT_RETRIES = 1;
const RESIZED_WIDTH = 640;
const JPEG_QUALITY = 0.65;

const UNCAPTURABLE_SCHEMES = /^(chrome|edge|about|chrome-extension|chrome-untrusted|devtools|view-source):/i;

const TRANSIENT_ERROR_FRAGMENTS = [
  "user may be dragging",
  "MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND"
];

const SILENT_ERROR_FRAGMENTS = [
  "activeTab",
  "Cannot access contents",
  "No tab with id",
  "No window with id",
  "extension manifest must request permission"
];

const cache = new Map();
const tabCooldowns = new Map();
const windowCooldowns = new Map();
const inflightWindows = new Set();
const retryTimers = new Map();
let restorePromise = null;
let persistInFlight = false;
let persistPending = false;
let captureEnabled = true;

export function setCaptureEnabled(value) {
  const next = Boolean(value);
  if (captureEnabled === next) {
    return;
  }

  captureEnabled = next;
  if (!captureEnabled) {
    for (const timer of retryTimers.values()) {
      clearTimeout(timer);
    }
    retryTimers.clear();
    cache.clear();
    void persistToSession();
  }
}

export function ensureRestored() {
  if (!restorePromise) {
    restorePromise = restoreFromSession();
  }
  return restorePromise;
}

export async function captureForTab(tabId, windowId, options = {}) {
  if (!captureEnabled) {
    return;
  }
  await ensureRestored();
  const numericTabId = Number(tabId);
  const numericWindowId = Number(windowId);
  if (!Number.isInteger(numericTabId) || !Number.isInteger(numericWindowId)) {
    return;
  }

  const now = Date.now();
  const lastTab = tabCooldowns.get(numericTabId) || 0;
  if (!options.force && now - lastTab < PER_TAB_THROTTLE_MS) {
    return;
  }

  const lastWindow = windowCooldowns.get(numericWindowId) || 0;
  if (now - lastWindow < PER_WINDOW_THROTTLE_MS) {
    return;
  }

  if (inflightWindows.has(numericWindowId)) {
    return;
  }

  let tab;
  try {
    tab = await chrome.tabs.get(numericTabId);
  } catch (_error) {
    return;
  }

  if (!tab || tab.active !== true) {
    return;
  }

  const tabUrl = tab.url || "";
  if (!tabUrl || UNCAPTURABLE_SCHEMES.test(tabUrl)) {
    return;
  }

  try {
    const win = await chrome.windows.get(numericWindowId);
    if (!win?.focused) {
      return;
    }
  } catch (_error) {
    return;
  }

  inflightWindows.add(numericWindowId);
  windowCooldowns.set(numericWindowId, now);
  tabCooldowns.set(numericTabId, now);

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(numericWindowId, {
      format: "jpeg",
      quality: 60
    });
  } catch (error) {
    inflightWindows.delete(numericWindowId);
    handleCaptureError(error, numericTabId, numericWindowId, options);
    return;
  }

  inflightWindows.delete(numericWindowId);

  if (!dataUrl) {
    return;
  }

  let resized;
  try {
    resized = await resizeJpeg(dataUrl, RESIZED_WIDTH, JPEG_QUALITY);
  } catch (_error) {
    resized = dataUrl;
  }

  setCacheEntry(numericTabId, {
    dataUrl: resized,
    capturedAt: now,
    url: tabUrl
  });

  await persistToSession();
}

function handleCaptureError(error, tabId, windowId, options) {
  const message = String(error?.message || error || "");
  const isTransient = TRANSIENT_ERROR_FRAGMENTS.some((fragment) => message.includes(fragment));
  const isSilent = SILENT_ERROR_FRAGMENTS.some((fragment) => message.includes(fragment));

  if (isTransient) {
    const retries = Number(options._retries) || 0;
    if (retries < MAX_TRANSIENT_RETRIES) {
      const existing = retryTimers.get(tabId);
      if (existing) {
        clearTimeout(existing);
      }
      const timer = setTimeout(() => {
        retryTimers.delete(tabId);
        // Reset cooldowns so the retry isn't blocked by its own pre-attempt timestamp.
        tabCooldowns.delete(tabId);
        void captureForTab(tabId, windowId, { force: true, _retries: retries + 1 });
      }, TRANSIENT_RETRY_DELAY_MS);
      retryTimers.set(tabId, timer);
    }
    return;
  }

  if (isSilent) {
    return;
  }

  console.warn("[fish-tab] captureVisibleTab failed", { tabId, windowId, error });
}

export async function getCapture(tabId) {
  await ensureRestored();
  return cache.get(Number(tabId)) || null;
}

export async function removeCapture(tabId) {
  await ensureRestored();
  const numericTabId = Number(tabId);
  tabCooldowns.delete(numericTabId);
  const retryTimer = retryTimers.get(numericTabId);
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimers.delete(numericTabId);
  }
  if (cache.delete(numericTabId)) {
    await persistToSession();
  }
}

export async function evictIfPresent(tabId) {
  await ensureRestored();
  if (cache.delete(Number(tabId))) {
    await persistToSession();
  }
}

function setCacheEntry(tabId, entry) {
  if (cache.has(tabId)) {
    cache.delete(tabId);
  }
  cache.set(tabId, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

async function restoreFromSession() {
  if (!chrome.storage?.session) {
    return;
  }

  try {
    const result = await chrome.storage.session.get(SESSION_KEY);
    const saved = result?.[SESSION_KEY];
    if (!saved || typeof saved !== "object") {
      return;
    }

    for (const [tabIdStr, entry] of Object.entries(saved)) {
      const tabId = Number(tabIdStr);
      if (Number.isInteger(tabId) && entry?.dataUrl) {
        cache.set(tabId, entry);
      }
    }
  } catch (_error) {
    // A failed restore just means we start with an empty cache.
  }
}

async function persistToSession() {
  if (!chrome.storage?.session) {
    return;
  }

  persistPending = true;
  if (persistInFlight) {
    return;
  }

  persistInFlight = true;
  try {
    while (persistPending) {
      persistPending = false;
      await writeSessionSnapshot();
    }
  } finally {
    persistInFlight = false;
  }
}

async function writeSessionSnapshot() {
  const snapshot = Object.fromEntries(cache);
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: snapshot });
  } catch (_error) {
    // Likely a quota error; drop oldest entries until we fit.
    while (cache.size > 5) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
      try {
        await chrome.storage.session.set({
          [SESSION_KEY]: Object.fromEntries(cache)
        });
        return;
      } catch (_inner) {
        // Try shrinking further.
      }
    }
  }
}

async function resizeJpeg(dataUrl, targetWidth, quality) {
  const blob = dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  const width = Math.min(targetWidth, bitmap.width);
  const height = Math.round((bitmap.height / bitmap.width) * width);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const resizedBlob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality
  });
  return blobToDataUrl(resizedBlob);
}

function dataUrlToBlob(dataUrl) {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    throw new Error("Invalid data URL");
  }

  const header = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const mimeMatch = /^data:([^;]+);base64$/.exec(header);
  if (!mimeMatch) {
    throw new Error("Unsupported data URL header: " + header);
  }

  const mime = mimeMatch[1];
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mime });
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const chunks = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
  }

  return `data:${blob.type};base64,${btoa(chunks.join(""))}`;
}
