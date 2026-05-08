export const SETTINGS_STORAGE_KEY = "fishTabSettings";

export const PERIODIC_CAPTURE_INTERVAL_OPTIONS_MS = [10000, 15000, 30000, 60000];

export const DEFAULT_SETTINGS = Object.freeze({
  previewEnabled: true,
  periodicCaptureEnabled: true,
  periodicCaptureIntervalMs: 15000
});

export function sanitizeSettings(input) {
  const source = input && typeof input === "object" ? input : {};
  const previewEnabled = typeof source.previewEnabled === "boolean"
    ? source.previewEnabled
    : DEFAULT_SETTINGS.previewEnabled;
  const enabled = typeof source.periodicCaptureEnabled === "boolean"
    ? source.periodicCaptureEnabled
    : DEFAULT_SETTINGS.periodicCaptureEnabled;
  const intervalMs = Number(source.periodicCaptureIntervalMs);
  const safeInterval = PERIODIC_CAPTURE_INTERVAL_OPTIONS_MS.includes(intervalMs)
    ? intervalMs
    : DEFAULT_SETTINGS.periodicCaptureIntervalMs;

  return {
    previewEnabled,
    periodicCaptureEnabled: enabled,
    periodicCaptureIntervalMs: safeInterval
  };
}
