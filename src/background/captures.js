const SESSION_KEY = "fishTabCaptures";
const MAX_ENTRIES = 40;
const CAPTURE_THROTTLE_MS = 500;
const RESIZED_WIDTH = 640;
const JPEG_QUALITY = 0.65;

const cache = new Map();
const captureCooldowns = new Map();
let restorePromise = null;

export function ensureRestored() {
  if (!restorePromise) {
    restorePromise = restoreFromSession();
  }
  return restorePromise;
}

export async function captureForTab(tabId, windowId, options = {}) {
  await ensureRestored();
  const numericTabId = Number(tabId);
  const numericWindowId = Number(windowId);
  if (!Number.isInteger(numericTabId) || !Number.isInteger(numericWindowId)) {
    return;
  }

  const now = Date.now();
  const last = captureCooldowns.get(numericTabId) || 0;
  if (!options.force && now - last < CAPTURE_THROTTLE_MS) {
    return;
  }
  captureCooldowns.set(numericTabId, now);

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(numericWindowId, {
      format: "jpeg",
      quality: 60
    });
  } catch (error) {
    console.warn("[fish-tab] captureVisibleTab failed", { tabId: numericTabId, windowId: numericWindowId, error });
    return;
  }

  if (!dataUrl) {
    console.warn("[fish-tab] captureVisibleTab returned empty", { tabId: numericTabId, windowId: numericWindowId });
    return;
  }

  let resized;
  try {
    resized = await resizeJpeg(dataUrl, RESIZED_WIDTH, JPEG_QUALITY);
  } catch (error) {
    console.warn("[fish-tab] resize failed; using original", { tabId: numericTabId, error });
    resized = dataUrl;
  }

  let url = "";
  try {
    const tab = await chrome.tabs.get(numericTabId);
    url = tab?.url || "";
  } catch (_error) {
    // Tab may have closed mid-capture; the entry is still useful.
  }

  setCacheEntry(numericTabId, {
    dataUrl: resized,
    capturedAt: now,
    url
  });

  await persistToSession();
}

export async function getCapture(tabId) {
  await ensureRestored();
  return cache.get(Number(tabId)) || null;
}

export async function removeCapture(tabId) {
  await ensureRestored();
  const numericTabId = Number(tabId);
  captureCooldowns.delete(numericTabId);
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
