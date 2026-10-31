// Gemini APIの設定（翻訳方法はビューアのボタンで選ぶ）
import { createGeminiTranslator, DEFAULT_MODEL } from './gemini.js';
import { dismissOnOutsideClick } from './dialog.js';

const DEFAULTS = { geminiKey: '', geminiModel: DEFAULT_MODEL };

// 拡張機能の保存領域（この拡張だけが読める）に保存する。拡張の外で開いたとき（開発用）は localStorage
const area = self.chrome?.storage?.local;

export async function loadSettings() {
  if (area) return { ...DEFAULTS, ...(await area.get(DEFAULTS)) };
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('settings') || '{}') }; } catch { return { ...DEFAULTS }; }
}

async function saveSettings(s) {
  if (area) await area.set(s);
  else localStorage.setItem('settings', JSON.stringify(s));
}

const $ = (s) => document.querySelector(s);

// 設定ダイアログを開く。保存されたら新しい設定、キャンセルなら null を返す
export function openSettings(current) {
  const dlg = $('#settings');
  dismissOnOutsideClick(dlg);
  const form = dlg.querySelector('form');
  const keyInput = $('#apiKey');
  const modelInput = $('#model');
  const testOut = $('#testResult');

  keyInput.value = current.geminiKey;
  keyInput.type = 'password';
  modelInput.value = current.geminiModel;
  testOut.textContent = '';

  $('#toggleKey').onclick = () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; };
  $('#clearKey').onclick = () => { keyInput.value = ''; testOut.textContent = ''; };
  $('#testKey').onclick = async () => {
    if (!keyInput.value.trim()) { testOut.textContent = 'APIキーを入力してください'; return; }
    testOut.textContent = '接続テスト中…';
    try {
      const tr = createGeminiTranslator({
        apiKey: keyInput.value.trim(), model: modelInput.value.trim(),
        sourceLanguage: 'en', targetLanguage: 'ja', onWait: (m) => { testOut.textContent = m; },
      });
      await tr.translateBatch(['Hello, world.'], (_, t) => { testOut.textContent = `OK：「${t}」`; });
    } catch (e) {
      testOut.textContent = 'NG：' + e.message;
    }
  };

  dlg.showModal();
  return new Promise((resolve) => {
    let saving = false;
    dlg.oncancel = () => resolve(null); // Esc
    dlg.onclose = () => { if (!saving) resolve(null); }; // 外側クリックもキャンセル扱い
    // close イベントは描画のタイミングまで遅れることがあるので、ボタンの submit で判定する
    form.onsubmit = async (e) => {
      if (e.submitter?.value !== 'save') { resolve(null); return; }
      saving = true;
      const next = {
        geminiKey: keyInput.value.trim(),
        geminiModel: modelInput.value.trim() || DEFAULT_MODEL,
      };
      await saveSettings(next);
      resolve(next);
    };
  });
}
