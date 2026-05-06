export const SETTINGS_STORAGE_KEY = "fishTabSettings";

export const PERIODIC_CAPTURE_INTERVAL_OPTIONS_MS = [10000, 15000, 30000, 60000];

export const DEFAULT_SETTINGS = Object.freeze({
  periodicCaptureEnabled: true,
  periodicCaptureIntervalMs: 15000
});

export function sanitizeSettings(input) {
  const source = input && typeof input === "object" ? input : {};
  const enabled = typeof source.periodicCaptureEnabled === "boolean"
    ? source.periodicCaptureEnabled
    : DEFAULT_SETTINGS.periodicCaptureEnabled;
  const intervalMs = Number(source.periodicCaptureIntervalMs);
  const safeInterval = PERIODIC_CAPTURE_INTERVAL_OPTIONS_MS.includes(intervalMs)
    ? intervalMs
    : DEFAULT_SETTINGS.periodicCaptureIntervalMs;

  return {
    periodicCaptureEnabled: enabled,
    periodicCaptureIntervalMs: safeInterval
  };
}
