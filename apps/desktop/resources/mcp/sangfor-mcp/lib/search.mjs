import { api, html2text } from './http.mjs';
import { BASE } from './config.mjs';

// 全局搜索（头部导航的搜索）：文档/案例/软件聚合，匿名可用。
// type 聚合含义（2026-10 实测推断）：2=文档、5=软件包、1=案例/其他、3=其他；以 aggs 原样透出。

export async function globalSearch({ keyword, type, product_id, page = 1, page_size = 10 } = {}) {
  const body = { keyword, page: Number(page) };
  if (type) body.type = Number(type);
  if (product_id) body.product_id = Number(product_id);
  if (page_size) body.pageSize = Number(page_size);
  const j = await api('/search/search', { method: 'POST', params: body });
  const d = j.data ?? {};
  const list = d.list ?? {};
  const items = (list.list ?? []).map((hit) => {
    const s = hit.source ?? {};
    const link = s.link ? BASE + (s.link.startsWith('/') ? s.link : '/' + s.link) : null;
    // 案例条目的 link 是 /cases/list?...&category_id=<id>，实测该 id 即案例 id（getDetailById 可直取正文）
    const caseId = /\/cases\/list\?.*category_id=(\d+)/.exec(s.link ?? '')?.[1] ?? null;
    return {
      type: s.type,
      title: html2text(s.title),
      summary: html2text(s.content ?? '').slice(0, 200),
      link,
      caseId: caseId ? Number(caseId) : null,
      date: s.create_time ?? null,
      crumbs: (s.crumbs ?? []).map((c) => c.name).join(' / '),
    };
  });
  return {
    total: list.total ?? items.length,
    page,
    typeAggs: list.aggs?.type ?? [],
    productAggs: (list.aggs?.product ?? []).slice(0, 12).map((p) => ({ product_id: p.id, count: p.count })),
    items,
  };
}
