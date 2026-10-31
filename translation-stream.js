class StreamError extends Error {}

// JSON全体が閉じる前でも、translations配列内の完成したオブジェクトだけを取り出す。
// 文字列内の括弧・エスケープ・改行を区切りと取り違えない。
function translationItems(onItem) {
  let text = '', position = 0, started = false, stopped = false;
  let itemStart = -1, depth = 0, quoted = false, escaped = false, separator = false;
  return (chunk) => {
    text += chunk;
    if (stopped) return;
    if (!started) {
      const prefix = /^\s*\{\s*"translations"\s*:\s*\[/.exec(text);
      if (!prefix) return;
      position = prefix[0].length;
      started = true;
    }
    for (; position < text.length; position++) {
      const ch = text[position];
      if (itemStart < 0) {
        if (/\s/.test(ch)) continue;
        if (ch === ']') { stopped = true; return; }
        if (separator) {
          if (ch !== ',') { stopped = true; return; }
          separator = false;
          continue;
        }
        if (ch !== '{') { stopped = true; return; }
        itemStart = position;
        depth = 1;
        continue;
      }
      if (escaped) { escaped = false; continue; }
      if (quoted && ch === '\\') { escaped = true; continue; }
      if (ch === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (ch === '{' || ch === '[') depth++;
      if (ch === '}' || ch === ']') depth--;
      if (!depth) {
        let item;
        try { item = JSON.parse(text.slice(itemStart, position + 1)); }
        catch { stopped = true; return; }
        onItem(item);
        itemStart = -1;
        separator = true;
      }
    }
  };
}

// Interactions APIのSSEを読む。thought/toolは訳文に混ぜず、完了イベントを必須にする。
export async function readTranslationStream(response, { onItem = () => {}, signal } = {}) {
  signal?.throwIfAborted();
  if (!response.body) throw new StreamError('翻訳の応答が空でした。全文を再試行してください');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const steps = new Map();
  const items = translationItems(onItem);
  let buffer = '', text = '', status = null;
  const append = (value) => {
    if (typeof value !== 'string') return;
    text += value;
    items(value);
  };
  function event(frame) {
    let name = '', data = [];
    for (const line of frame.split(/\r\n|\r|\n/)) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    if (data.join('\n') === '[DONE]') throw new StreamError('翻訳の完了を確認できませんでした。全文を再試行してください');
    let value;
    try { value = JSON.parse(data.join('\n')); }
    catch { throw new StreamError('翻訳ストリームの形式を読み取れませんでした'); }
    const type = value.event_type || name;
    if (type === 'error') throw new StreamError('Geminiの翻訳ストリームでエラーが発生しました。全文を再試行してください');
    if (type === 'step.start') {
      steps.set(value.index, value.step?.type);
      if (value.step?.type === 'model_output') {
        for (const content of value.step.content || []) if (content.type === 'text') append(content.text);
      }
    }
    if (type === 'step.delta' && steps.get(value.index) === 'model_output' && value.delta?.type === 'text') append(value.delta.text);
    if (type === 'step.stop') steps.delete(value.index);
    if (type === 'interaction.completed') status = value.interaction?.status || 'unknown';
    if (type === 'interaction.status_update' && ['failed', 'cancelled', 'incomplete'].includes(value.status)) status = value.status;
  }
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (status === null) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      let boundary;
      while (status === null && (boundary = /\r?\n\r?\n|\r\r/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        event(frame);
      }
      if (done) {
        if (status === null && buffer.trim()) event(buffer);
        break;
      }
    }
    if (status === null) throw new StreamError('翻訳の受信が途中で途切れました。全文を再試行してください');
    return { text, status };
  } catch (error) {
    signal?.throwIfAborted();
    // 生の通信エラーや応答本文を、ログ・UIへ展開しない。
    throw error instanceof StreamError ? error : new StreamError('翻訳の受信が途中で途切れました。全文を再試行してください');
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
