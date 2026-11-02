// 開いたときの自動翻訳とGemini APIの設定
import { createGeminiTranslator, DEFAULT_MODEL } from "./gemini.js";
import { dismissOnOutsideClick } from "./dialog.js";

const DEFAULTS = {
  autoTranslate: true,
  geminiKey: "",
  geminiModel: DEFAULT_MODEL,
};

// 拡張機能の保存領域（この拡張だけが読める）に保存する。拡張の外で開いたとき（開発用）は localStorage
const area = self.chrome?.storage?.local;

export async function loadSettings() {
  if (area) return { ...DEFAULTS, ...(await area.get(DEFAULTS)) };
  try {
    return {
      ...DEFAULTS,
      ...JSON.parse(localStorage.getItem("settings") || "{}"),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

async function saveSettings(s) {
  if (area) await area.set(s);
  else localStorage.setItem("settings", JSON.stringify(s));
}

const $ = (s) => document.querySelector(s);

// 設定ダイアログを開く。保存されたら新しい設定、キャンセルなら null を返す
export function openSettings(current) {
  const dlg = $("#settings");
  dismissOnOutsideClick(dlg);
  const form = dlg.querySelector("form");
  const autoInput = $("#autoTranslate");
  const keyInput = $("#apiKey");
  const modelInput = $("#model");
  const modelPreset = $("#modelPreset");
  const testOut = $("#testResult");
  const testButton = $("#testKey");
  let testJob = null;
  function stopTest(message) {
    const job = testJob;
    testJob = null;
    if (job) {
      clearTimeout(job.timer);
      job.controller.abort();
    }
    testButton.textContent = "接続テスト";
    if (message !== undefined) testOut.textContent = message;
  }
  stopTest();

  autoInput.checked = current.autoTranslate !== false;
  keyInput.value = current.geminiKey;
  keyInput.type = "password";
  modelInput.value = current.geminiModel;
  modelPreset.value = [...modelPreset.options].some(
    (option) => option.value === current.geminiModel
  )
    ? current.geminiModel
    : "custom";
  modelInput.hidden = modelPreset.value !== "custom";
  let customModel = modelInput.hidden ? "" : current.geminiModel;
  let previousPreset = modelPreset.value;
  modelPreset.onchange = () => {
    stopTest("");
    if (previousPreset === "custom") customModel = modelInput.value;
    modelInput.hidden = modelPreset.value !== "custom";
    modelInput.value = modelInput.hidden ? modelPreset.value : customModel;
    previousPreset = modelPreset.value;
  };
  testOut.textContent = "";

  $("#toggleKey").onclick = () => {
    keyInput.type = keyInput.type === "password" ? "text" : "password";
  };
  $("#clearKey").onclick = () => {
    stopTest("");
    keyInput.value = "";
  };
  keyInput.oninput = modelInput.oninput = () => stopTest("");
  $("#testKey").onclick = async () => {
    if (testJob) {
      stopTest("接続テストを中断しました");
      return;
    }
    if (!keyInput.value.trim()) {
      testOut.textContent = "APIキーを入力してください";
      return;
    }
    const job = { controller: new AbortController() };
    testJob = job;
    const model = modelInput.value.trim() || DEFAULT_MODEL;
    testButton.textContent = "テストを中断";
    testOut.textContent = `${model}：接続テスト中…`;
    job.timer = setTimeout(() => {
      if (testJob === job)
        stopTest(
          "NG：30秒以内に接続テストが完了しませんでした。モデル側の混雑・利用可否や通信状態を確認してください"
        );
    }, 30000);
    try {
      const tr = createGeminiTranslator({
        apiKey: keyInput.value.trim(),
        model,
        signal: job.controller.signal,
        sourceLanguage: "en",
        targetLanguage: "ja",
        onWait: (m) => {
          if (testJob === job) testOut.textContent = m;
        },
      });
      await tr.translateBatch(["Hello, world."], (_, t) => {
        if (testJob === job) testOut.textContent = `OK（${model}）：「${t}」`;
      });
    } catch (e) {
      if (testJob === job) testOut.textContent = "NG：" + e.message;
    } finally {
      if (testJob === job) stopTest();
    }
  };

  dlg.showModal();
  return new Promise((resolve) => {
    let saving = false;
    dlg.oncancel = () => {
      stopTest();
      resolve(null);
    }; // Esc
    dlg.onclose = () => {
      stopTest();
      if (!saving) resolve(null);
    }; // 外側クリックもキャンセル扱い
    // close イベントは描画のタイミングまで遅れることがあるので、ボタンの submit で判定する
    form.onsubmit = async (e) => {
      stopTest();
      if (e.submitter?.value !== "save") {
        resolve(null);
        return;
      }
      saving = true;
      const next = {
        autoTranslate: autoInput.checked,
        geminiKey: keyInput.value.trim(),
        geminiModel: modelInput.value.trim() || DEFAULT_MODEL,
      };
      await saveSettings(next);
      resolve(next);
    };
  });
}
