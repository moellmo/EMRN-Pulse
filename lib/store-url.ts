const DEFAULT_STORE_URL = "https://emrn.ca";

function validStoreOrigin(value?: string) {
  try {
    const url = new URL(value || DEFAULT_STORE_URL);
    if (!/^https?:$/.test(url.protocol)) return DEFAULT_STORE_URL;
    if (!url.hostname.includes(".")) return DEFAULT_STORE_URL;
    return url.origin;
  } catch {
    return DEFAULT_STORE_URL;
  }
}

export const STORE_URL = validStoreOrigin(process.env.EMRN_STORE_URL);

export function absoluteStoreUrl(path?: string) {
  if (!path) return STORE_URL;
  const clean = String(path).trim();
  if (!clean) return STORE_URL;
  if (clean.startsWith("http://") || clean.startsWith("https://")) return clean;
  const withoutBadModelPrefix = clean.replace(/^(?:gpt-[^/]+\/)+/i, "");
  return `${STORE_URL}${withoutBadModelPrefix.startsWith("/") ? "" : "/"}${withoutBadModelPrefix}`;
}
