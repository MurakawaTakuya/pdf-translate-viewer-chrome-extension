// Error responses may be JSON or an SSE error frame, even for non-2xx HTTP.
// Return structured fields only; never surface an unparsed HTML/raw body.
export async function readApiError(response) {
  let text;
  try {
    text = await response.text();
  } catch {
    return {};
  }
  const error = (value) => {
    const first = Array.isArray(value) ? value[0] : value,
      e = first?.error || first;
    if (!e || typeof e !== "object" || typeof e.message !== "string")
      return null;
    return {
      message: e.message,
      ...(e.code !== undefined ? { code: e.code } : {}),
      ...(typeof e.status === "string" ? { status: e.status } : {}),
      ...(Array.isArray(e.details) ? { details: e.details } : {}),
    };
  };
  try {
    const found = error(JSON.parse(text));
    if (found) return found;
  } catch {
    /* Optional metadata/parsing can be unavailable; keep the existing fallback. */
  }
  for (const frame of text.trim().split(/\r?\n\r?\n|\r\r/)) {
    const data = frame
      .split(/\r\n|\r|\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const found = error(JSON.parse(data));
      if (found) return found;
    } catch {
      /* Non-JSON frames are skipped. */
    }
  }
  return { message: "APIエラー本文を解析できませんでした（JSON/SSE）" };
}

export function redactApiError(value, secret) {
  const redact = (text) =>
    typeof secret === "string" && secret
      ? text.replaceAll(secret, "[redacted]")
      : text;
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactApiError(v, secret));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        redact(k),
        redactApiError(v, secret),
      ])
    );
  return value;
}
