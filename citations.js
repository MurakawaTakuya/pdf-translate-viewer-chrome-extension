// 公開された識別子と書誌情報だけを使う。PDF本文・APIキー・Cookieは送らない。
const ARXIV_ID = "(?:\\d{4}\\.\\d{4,5}|[a-z][a-z.-]+/\\d{7})(?:v\\d+)?";
const plain = (s) =>
  String(s || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
const normalized = (s) =>
  plain(s)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
const baseArxiv = (s) => s.replace(/v\d+$/i, "");

export function citationIdentifier(value) {
  let text = String(value || "").trim();
  try {
    text = decodeURIComponent(text);
  } catch {
    /* そのまま判定する */
  }
  const arxiv = new RegExp(
    `(?:arxiv\\.org/(?:pdf|abs)/|arxiv:\\s*|^)(${ARXIV_ID})(?:\\.pdf)?(?:$|[\\s?#])`,
    "i"
  ).exec(text);
  if (arxiv) return { type: "arxiv", value: baseArxiv(arxiv[1]) };
  const doi = /10\.\d{4,9}\/[^\s<>"?#]+/i.exec(text);
  if (doi) {
    let id = doi[0].replace(/[.,;]+$/, "");
    while (
      id.endsWith(")") &&
      (id.match(/\)/g)?.length || 0) > (id.match(/\(/g)?.length || 0)
    )
      id = id.slice(0, -1);
    if (/\/doi\/(?:pdf|epdf)\//i.test(text)) id = id.replace(/\.pdf$/i, "");
    return { type: "doi", value: id };
  }
  return null;
}

export async function detectCitationIdentifier(fileUrl, pdf) {
  const fromUrl = citationIdentifier(fileUrl);
  if (fromUrl) return fromUrl;
  try {
    const { info = {}, metadata } = await pdf.getMetadata();
    for (const value of [
      info.DOI,
      info.Subject,
      info.Keywords,
      metadata?.get("prism:doi"),
      metadata?.get("dc:identifier"),
    ]) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        const id = citationIdentifier(entry);
        if (id) return id;
      }
    }
  } catch {
    /* 識別情報のないPDFもある */
  }
  try {
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str).join(" ");
    // 本文中の任意の数字をDOIとみなさず、明示された識別子だけを見る。
    const id =
      new RegExp(`arxiv:\\s*(${ARXIV_ID})`, "i").exec(text)?.[0] ||
      /(?:https?:\/\/(?:dx\.)?doi\.org\/|\bdoi:\s*)10\.\d{4,9}\/[^\s<>]+/i.exec(
        text
      )?.[0];
    return citationIdentifier(id);
  } catch {
    return null;
  }
}

function decodeEntities(text) {
  const entities = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
  };
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,
    (original, key) => {
      if (key[0] !== "#") return entities[key.toLowerCase()] || original;
      const number =
        key[1].toLowerCase() === "x"
          ? parseInt(key.slice(2), 16)
          : Number(key.slice(1));
      return number > 0 && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : original;
    }
  );
}

export function parseArxivMetadata(html) {
  const meta = new Map();
  for (const tag of html.match(/<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi) ||
    []) {
    const attributes = Object.fromEntries(
      [...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map((m) => [
        m[1].toLowerCase(),
        decodeEntities(m[3]),
      ])
    );
    const key = attributes.name?.toLowerCase();
    if (key && attributes.content)
      meta.set(key, [...(meta.get(key) || []), attributes.content]);
  }
  return {
    title: meta.get("citation_title")?.[0] || "",
    authors: meta.get("citation_author") || [],
    doi: meta.get("citation_doi")?.[0],
    year: Number((meta.get("citation_date")?.[0] || "").slice(0, 4)),
  };
}

export function matchingPublication(items, arxiv) {
  const title = normalized(arxiv.title),
    authorName = plain(arxiv.authors[0]);
  const firstAuthor = normalized(authorName);
  if (title.length < 15 || !firstAuthor) return null;
  const matches = items.filter((item) => {
    const family = normalized(item.author?.[0]?.family);
    const year = item.published?.["date-parts"]?.[0]?.[0];
    return (
      ["journal-article", "proceedings-article"].includes(item.type) &&
      normalized(item.title?.[0]) === title &&
      family &&
      (authorName.includes(",")
        ? normalized(authorName.split(",")[0]) === family
        : firstAuthor.endsWith(family)) &&
      (!arxiv.year || !year || Math.abs(year - arxiv.year) <= 4) &&
      citationIdentifier(item.DOI)?.type === "doi"
    );
  });
  // 同名の別論文や複数の出版版を推測で選ばない。
  return matches.length === 1 ? matches[0] : null;
}

export const CITATION_STYLES = [
  { id: "mla", label: "MLA", style: "modern-language-association" },
  { id: "apa", label: "APA", style: "apa" },
  { id: "iso", label: "ISO 690", style: "iso690-author-date-en" },
];
export const CITATION_EXPORTS = [
  { id: "bibtex", label: "BibTeX", format: "bibtex", extension: "bib" },
  { id: "endnote", label: "EndNote", format: "ris", extension: "ris" },
  { id: "refman", label: "RefMan", format: "ris", extension: "ris" },
  { id: "refworks", label: "RefWorks", format: "ris", extension: "ris" },
];

// 値の中のカンマ、入れ子の波括弧、引用符は保持し、フィールドの区切りだけを改行する。
export function formatBibtex(value) {
  const text = value.trim();
  const head = /^(@[a-z]+\s*)([{(])/i.exec(text);
  if (!head || /^@(comment|string|preamble)\b/i.test(text)) return text;
  const open = head[2],
    close = open === "{" ? "}" : ")";
  const base = open === "{" ? 1 : 0;
  let depth = base,
    quoted = false,
    start = head[0].length,
    end = -1;
  const parts = [];
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"' && depth === base) quoted = !quoted;
    if (!quoted && depth === base && ch === close) {
      parts.push(text.slice(start, i).trim());
      end = i;
      break;
    }
    if (!quoted && depth === base && ch === ",") {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
    if (ch === "{") depth++;
    if (ch === "}") depth--;
  }
  // 複数エントリや不完全なデータは、推測で書き換えない。
  if (end < 0 || quoted || text.slice(end + 1).trim() || parts.length < 2)
    return text;
  const [key, ...fields] = parts;
  return `${head[1]}${open}${key},\n${fields
    .filter(Boolean)
    .map((field) => `  ${field}`)
    .join(",\n")}\n${close}`;
}

export function createCitationService({
  fetch: fetcher = globalThis.fetch,
} = {}) {
  const cache = new Map(),
    records = new Map();
  function cached(key, work) {
    if (!cache.has(key))
      cache.set(
        key,
        Promise.resolve()
          .then(work)
          .catch((error) => {
            cache.delete(key);
            throw error;
          })
      );
    return cache.get(key);
  }
  async function request(url, accept) {
    let response;
    try {
      response = await fetcher(url, {
        headers: { Accept: accept },
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new Error(
        "書誌情報サービスに接続できませんでした。しばらくして再試行してください"
      );
    }
    if (!response.ok)
      throw new Error(
        `書誌情報を取得できませんでした（HTTP ${response.status}）`
      );
    const text = (await response.text()).trim();
    if (
      !text ||
      (accept !== "text/html" && /^\s*(?:<!doctype|<html)/i.test(text))
    )
      throw new Error("書誌情報サービスから有効な引用が返りませんでした");
    return text;
  }
  const doiUrl = (doi) =>
    "https://doi.org/" + doi.split("/").map(encodeURIComponent).join("/");

  async function resolve(identifier) {
    const parsed = citationIdentifier(
      typeof identifier === "string" ? identifier : identifier?.value
    );
    const id =
      parsed &&
      (typeof identifier === "string" || identifier?.type === parsed.type)
        ? parsed
        : null;
    if (!id) throw new Error("DOIまたはarXiv IDを入力してください");
    return cached(`resolve:${id.type}:${id.value.toLowerCase()}`, async () => {
      let doi = id.value,
        version = "DOI登録情報",
        metadata;
      if (id.type === "arxiv") {
        doi = `10.48550/arXiv.${baseArxiv(id.value)}`;
        version = "arXiv版";
        try {
          const arxiv = parseArxivMetadata(
            await request(
              "https://arxiv.org/abs/" + baseArxiv(id.value),
              "text/html"
            )
          );
          const explicit = citationIdentifier(arxiv.doi);
          if (explicit?.type === "doi") {
            doi = explicit.value;
            version = "出版版";
          } else if (arxiv.title && arxiv.authors.length) {
            const url = new URL("https://api.crossref.org/works");
            url.searchParams.set("query.title", arxiv.title);
            url.searchParams.set("rows", "5");
            const result = JSON.parse(
              await request(url.href, "application/json")
            );
            const match = matchingPublication(
              result.message?.items || [],
              arxiv
            );
            if (match) {
              doi = match.DOI;
              version = "出版版（Crossref）";
              // The title/author/year match already verified this Crossref
              // record. Reuse it instead of fetching the same DOI metadata.
              // Human-readable styles and exports still come from the DOI service.
              metadata = { ...match, title: plain(match.title[0]) };
            }
          }
        } catch {
          /* 出版版を照合できなければ、識別子の確かなarXiv版を引用する */
        }
      }
      try {
        metadata ??= JSON.parse(
          await request(doiUrl(doi), "application/vnd.citationstyles.csl+json")
        );
      } catch (error) {
        throw new Error(
          /書誌情報/.test(error.message)
            ? error.message
            : "書誌情報の形式を読み取れませんでした",
          { cause: error }
        );
      }
      if (
        !plain(metadata.title) ||
        String(metadata.DOI || "").toLowerCase() !== doi.toLowerCase()
      )
        throw new Error("対象論文の書誌情報を確認できませんでした");
      records.set(doi.toLowerCase(), metadata);
      return { doi, title: plain(metadata.title), version, metadata };
    });
  }

  function formatted(doi, style) {
    const entry = CITATION_STYLES.find((item) => item.id === style);
    if (!entry) return Promise.reject(new Error("未対応の引用形式です"));
    return cached(`style:${doi.toLowerCase()}:${style}`, async () => {
      let text = await request(
        doiUrl(doi),
        `text/x-bibliography; style=${entry.style}; locale=en-US`
      );
      const metadata = records.get(doi.toLowerCase());
      // DOIサービスは同じAcceptでもHTMLを返すことがある。画面・コピーとも本文だけに揃える。
      text = decodeEntities(plain(text.replace(/<\/(?:div|p|li)>/gi, " ")));
      // 一部のISOスタイルは書誌情報のabstractも末尾へ出力する。既知の要旨だけを除く。
      const abstract = decodeEntities(plain(metadata?.abstract));
      if (abstract.length > 40) text = text.replace(abstract, "").trim();
      // Crossrefの空のeditorレコードが生む、名前のない編集者表記だけを除く。
      if (
        metadata &&
        !metadata.editor?.some((person) =>
          plain(person.family || person.given || person.literal)
        )
      ) {
        text = text
          .replace(/, edited by\s*,/gi, ",")
          .replace(/\s+\(ed\.\),/g, "");
      }
      return text;
    });
  }
  function exported(doi, format) {
    const accepts = {
      bibtex: "application/x-bibtex",
      ris: "application/x-research-info-systems",
    };
    if (!accepts[format])
      return Promise.reject(new Error("未対応の出力形式です"));
    return cached(`export:${doi.toLowerCase()}:${format}`, async () => {
      const text = await request(doiUrl(doi), accepts[format]);
      return format === "bibtex" ? formatBibtex(text) : text;
    });
  }
  return { resolve, formatted, exported };
}
