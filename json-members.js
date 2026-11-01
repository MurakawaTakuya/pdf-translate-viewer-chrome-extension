// JSON.parse hides duplicate properties. Reject them at every object level,
// including escaped spellings of a key, before a block can be previewed.
export function strictJson(text) {
  const value = JSON.parse(text), objects = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') objects.push(new Set());
    else if (c === '[') objects.push(null);
    else if (c === '}' || c === ']') objects.pop();
    else if (c === '"') {
      const start = i++;
      for (; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') break;
      }
      let after = i + 1;
      while (/\s/.test(text[after] || '') && after < text.length) after++;
      if (text[after] === ':') {
        const key = JSON.parse(text.slice(start, i + 1)), seen = objects.at(-1);
        if (!seen || seen.has(key)) throw new Error('重複したJSONプロパティがあります');
        seen.add(key);
      }
    }
  }
  return value;
}

// A completed root property is the streaming unit. An atom object by itself is
// never exposed: its entire containing block must finish and pass validation.
export function jsonMembers(onItem = () => {}) {
  let text = '', position = 0, state = 'root', start = 0, escaped = false, key, depth = 0, quoted = false;
  const entries = [];
  const emit = (end) => {
    let value;
    try { value = strictJson(text.slice(start, end)); }
    catch { state = 'invalid'; return; }
    const item = { id: key, value }; entries.push(item); state = 'separator'; onItem(item);
  };
  return {
    append(chunk) {
      text += chunk;
      for (; position < text.length && state !== 'invalid'; position++) {
        const c = text[position];
        if (state === 'key-string' || state === 'string') {
          if (escaped) { escaped = false; continue; }
          if (c === '\\') { escaped = true; continue; }
          if (c !== '"') continue;
          if (state === 'key-string') {
            try { key = JSON.parse(text.slice(start, position + 1)); state = 'colon'; }
            catch { state = 'invalid'; }
          } else emit(position + 1);
          continue;
        }
        if (state === 'object') {
          if (escaped) { escaped = false; continue; }
          if (quoted && c === '\\') { escaped = true; continue; }
          if (c === '"') { quoted = !quoted; continue; }
          if (quoted) continue;
          if (c === '{' || c === '[') depth++;
          if (c === '}' || c === ']') depth--;
          if (!depth) emit(position + 1);
          continue;
        }
        if (/\s/.test(c)) continue;
        if (state === 'root' && c === '{') state = 'key';
        else if (state === 'key' && c === '"') { start = position; state = 'key-string'; }
        else if (state === 'key' && c === '}') state = 'done';
        else if (state === 'colon' && c === ':') state = 'value';
        else if (state === 'value' && c === '"') { start = position; state = 'string'; }
        else if (state === 'value' && (c === '{' || c === '[')) { start = position; depth = 1; quoted = false; state = 'object'; }
        else if (state === 'separator' && c === ',') state = 'key';
        else if (state === 'separator' && c === '}') state = 'done';
        else state = 'invalid';
      }
    },
    finish() {
      const value = strictJson(text);
      if (state !== 'done' || !value || Array.isArray(value) || typeof value !== 'object') throw new Error('翻訳応答の形式が不正です');
      return entries;
    },
  };
}
