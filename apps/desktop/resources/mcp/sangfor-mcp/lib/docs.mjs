import { BASE, BASE_HEADERS } from './config.mjs';
import { html2text } from './http.mjs';

// 文档中心 /productDocument/read 是 SSR 页面，正文在 <div id="detailHtmlId"> 里直出，
// 无需登录即可读。此处提取正文并转纯文本（表格行用 | 连接，图片保留 alt+链接）。

function extractDivBlock(html, id) {
  const i = html.indexOf(`id="${id}"`);
  if (i < 0) return null;
  const openEnd = html.indexOf('>', i);
  if (openEnd < 0) return null;
  const re = /<\/?div\b[^>]*>/gi;
  re.lastIndex = openEnd + 1;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[0][1] === '/') depth--;
    else depth++;
    if (depth === 0) return html.slice(openEnd + 1, m.index);
  }
  return html.slice(openEnd + 1, openEnd + 400000);
}

function docHtmlToText(h) {
  let s = String(h)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');
  // 图片 → [图:alt](src)
  s = s.replace(/<img[^>]*>/gi, (tag) => {
    const alt = /alt="([^"]*)"/.exec(tag)?.[1] ?? '';
    const src = /src="([^"]*)"/.exec(tag)?.[1] ?? '';
    const abs = src && !/^https?:/.test(src) ? BASE + (src.startsWith('/') ? src : '/' + src) : src;
    return `\n[图${alt ? ':' + alt : ''}](${abs})\n`;
  });
  // 表格：单元格 | 连接、行换行
  s = s.replace(/<t[dh][^>]*>/gi, '| ').replace(/<\/t[dh]>/gi, ' ');
  s = s.replace(/<tr[^>]*>/gi, '\n').replace(/<\/tr>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|pre)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 读一篇文档：传完整 URL 或 product_id+version_id+category_id 三元组。
 * 实测：正文由服务端注入 JS 全局 `var __DOC_CONTENT_HTML__ = "..."`（json_encode 字符串），
 * v-html 占位本身为空，需从脚本变量提取。
 * 返回 {title, product, text}；页面无正文（如目录节点）时 text 为空并提示。
 */
export async function readDoc({ url, product_id, version_id, category_id } = {}) {
  const u = url ?? `${BASE}/productDocument/read?product_id=${product_id ?? ''}&version_id=${version_id ?? ''}&category_id=${category_id ?? ''}`;
  const res = await fetch(u, { headers: { 'User-Agent': BASE_HEADERS['User-Agent'] } });
  const html = await res.text();
  const title = /category-name="([^"]*)"/.exec(html)?.[1] ?? /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
  const product = /prod-name="([^"]*)"/.exec(html)?.[1] ?? '';
  const text = extractDocContent(html);
  return { url: u, title, product, text, empty: !text };
}

/** 从页面 JS 里解出 __DOC_CONTENT_HTML__ 字符串字面量并转纯文本 */
function extractDocContent(html) {
  const m = /__DOC_CONTENT_HTML__\s*=\s*/.exec(html);
  if (!m) return '';
  const q = html[m.index + m[0].length];
  if (q !== '"' && q !== "'") return '';
  let i = m.index + m[0].length + 1;
  let raw = '';
  while (i < html.length) {
    const ch = html[i];
    if (ch === '\\') {
      raw += ch + html[i + 1];
      i += 2;
      continue;
    }
    if (ch === q) break;
    raw += ch;
    i++;
  }
  let content;
  try {
    content = JSON.parse(`"${raw}"`);
  } catch {
    content = raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\//g, '/');
  }
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(content)?.[1] ?? content;
  return docHtmlToText(body);
}
