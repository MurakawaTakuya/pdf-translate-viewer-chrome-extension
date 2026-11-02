// Chrome's original-URL MIME wrapper is text/html, not application/pdf.
// Only our stream-backed child viewer may rename its matching top document.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (
    message?.type !== "setPaperTabTitle" ||
    sender.id !== chrome.runtime.id ||
    sender.url?.split("?")[0] !== chrome.runtime.getURL("viewer.html") ||
    window !== window.top ||
    typeof message.fileUrl !== "string" ||
    typeof message.title !== "string"
  )
    return;
  try {
    const target = new URL(message.fileUrl);
    if (
      !["http:", "https:", "file:"].includes(target.protocol) ||
      target.href.split("#")[0] !== location.href.split("#")[0]
    )
      return;
    const title = message.title
      .replace(/\p{Cc}/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!title || title.length > 1000) return;
    document.title = title;
    reply({ ok: true });
  } catch {
    // Malformed or stale requests must leave the current document untouched.
  }
});
