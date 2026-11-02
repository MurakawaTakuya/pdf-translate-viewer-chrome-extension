// ツールバーのアイコンを押したときの小さな画面
const $ = (s) => document.querySelector(s);
const VIEWER = chrome.runtime.getURL("viewer.html");
const autoBox = $("#auto");
const actionBtn = $("#action");
const note = $("#note");

const HINT = {
  on: "PDFを開くと、自動でこの拡張の画面になります",
  off: "PDFはいつものビューア（Chrome標準や Google Scholar など）で開きます",
};

const { autoOpen } = await chrome.storage.local.get({ autoOpen: true });
autoBox.checked = autoOpen;
$("#hint").textContent = HINT[autoOpen ? "on" : "off"];
autoBox.onchange = async () => {
  await chrome.storage.local.set({ autoOpen: autoBox.checked });
  $("#hint").textContent = HINT[autoBox.checked ? "on" : "off"];
};

// 今のタブに合わせて、ボタンを1つ出す
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const url = tab?.url || "";
let viewerState = null;
if (tab?.id !== undefined) {
  try {
    viewerState = await chrome.tabs.sendMessage(tab.id, {
      type: "getViewerState",
    });
  } catch {
    /* Optional metadata/parsing can be unavailable; keep the existing fallback. */
  }
}
if (viewerState?.fileUrl || url.startsWith(VIEWER)) {
  // 翻訳ビューアで見ている → 通常のビューアに切り替える
  const m = /[?&]file=(.*)$/s.exec(new URL(url).search);
  const file =
    viewerState?.fileUrl ||
    (m && (/^[a-z]+%3A/i.test(m[1]) ? decodeURIComponent(m[1]) : m[1]));
  if (file) {
    actionBtn.textContent = "このPDFを通常のビューアで開く";
    actionBtn.classList.add("sub");
    actionBtn.hidden = false;
    actionBtn.onclick = async () => {
      if (viewerState?.mime)
        await chrome.tabs.sendMessage(tab.id, { type: "openDefaultViewer" });
      else {
        const target = new URL(file),
          hash = new URLSearchParams(target.hash.slice(1));
        if (hash.get("toolbar") === "0") hash.delete("toolbar");
        hash.set("gsr", "1");
        target.hash = hash.toString();
        await chrome.runtime.sendMessage({
          type: "openOriginal",
          tabId: tab.id,
          url: target.href,
          reload: true,
        });
      }
      window.close();
    };
  }
} else if (/^(https?|file):/.test(url)) {
  // それ以外のページ → このページを翻訳ビューアで開く（自動で切り替わらなかったPDF用）
  actionBtn.textContent = "このPDFを翻訳ビューアで開く";
  actionBtn.hidden = false;
  actionBtn.onclick = async () => {
    await chrome.runtime.sendMessage({
      type: "openInViewer",
      tabId: tab.id,
      url,
    });
    window.close();
  };
  note.textContent = "PDFが表示されているタブで押してください";
  note.hidden = false;
}
