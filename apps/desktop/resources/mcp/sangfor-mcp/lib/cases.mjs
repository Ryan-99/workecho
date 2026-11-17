import { api, apiAuth, html2text } from './http.mjs';

// 案例中心的 productLineId 与软件下载的 product_id 同源（同一产品目录）。
// 案例搜索/产品线接口匿名可用。

/** 案例中心产品线树（spt/openapi/product/getProductList） */
export async function productLines() {
  const j = await api('/spt/openapi/product/getProductList');
  const rows = j.rows ?? j.data ?? [];
  const flat = [];
  const walk = (nodes, path) => {
    for (const n of nodes ?? []) {
      const p = [...path, n.name];
      if (n.caseAble !== false || !n.children?.length) flat.push({ id: n.id, name: n.name, path: p.join(' / ') });
      if (n.children?.length) walk(n.children, p);
    }
  };
  walk(rows, []);
  return { tree: rows, flat };
}

/** 案例模块（分类）列表 */
export async function modules(productLineId) {
  const j = await api(`/spt/openapi/case/es/getCaseModuleList/${productLineId}`);
  return (j.rows ?? j.data ?? []).map((m) => ({ id: m.id ?? m.moduleId, name: m.name ?? m.moduleName, children: m.children?.map((c) => ({ id: c.id, name: c.name })) }));
}

/** 案例版本列表（版本名实测在 code 字段） */
export async function versions(productLineId) {
  const j = await api(`/spt/openapi/case/es/getProductVersionList/${productLineId}`);
  return (j.rows ?? j.data ?? []).map((v) => ({ id: v.id ?? v.versionId, name: v.version_name ?? v.name ?? v.code ?? v.versionName ?? v.version }));
}

/**
 * 案例搜索。POST /spt/openapi/case/es/search，结果在 rows。
 * 字段名按实际返回自适应，避免强绑定未知结构。
 * 注意：站点 pageNum 是 0 基（前端传 pageNumber-1）；这里保持 1 基入参，内部转换。
 */
export async function search({ keyword, product_line_id, module_id, version, page = 1, page_size = 10 } = {}) {
  const body = {};
  if (keyword) body.keyword = keyword;
  if (product_line_id) body.productLineId = Number(product_line_id);
  if (module_id) body.moduleId = Number(module_id);
  if (version) body.versionId = Number(version);
  body.pageNum = Number(page) - 1;
  body.pageSize = Number(page_size);
  const j = await api('/spt/openapi/case/es/search', { method: 'POST', params: body });
  // 实测结构：rows 是 Spring 分页对象 {content:[...], totalElements?...}
  const rowsObj = j.rows ?? {};
  const rows = Array.isArray(rowsObj) ? rowsObj : (rowsObj.content ?? j.data ?? []);
  const items = rows.map((r) => normalizeCase(r));
  return {
    total: rowsObj.totalElements ?? rowsObj.total ?? rows.length,
    page,
    page_size,
    items,
  };
}

function normalizeCase(r) {
  // 实测字段：id="2:39169"(ES 文档id)、source_id=39169、title、content=全文、main/child_module_names
  const c = r.source ?? r._source ?? r;
  const moduleId = [c.main_module_names, c.child_module_names].filter(Boolean).join(' / ');
  return {
    id: c.source_id ?? c.id ?? c.caseId,
    es_id: c.id ?? null,
    title: c.title ?? c.name ?? '',
    module: moduleId,
    product: c.product_name ?? c.productName ?? c.cate_name ?? '',
    summary: html2text(c.content ?? c.description ?? '').slice(0, 200),
    views: c.viewCount ?? c.views ?? null,
    date: c.createTime ?? c.create_time ?? c.publishTime ?? null,
    raw: r,
  };
}

/** 案例详情（正文 HTML 转纯文本）。实测 rows={name, productName, mainModuleNames, content...} */
export async function detail(id) {
  // 站点权限判定在节点间抖动：同一会话对同一案例间歇返回 666"深信服员工"（内部 KB 权限校验），
  // 重试通常即成功；仅限内部员工的案例重试后仍 666，按权限不足提示。
  let j;
  for (let i = 0; i < 3; i++) {
    j = await api(`/spt/openapi/case/es/getDetailById/${id}`);
    if (j.code !== 666) break;
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  if (j.code === 666) {
    throw new Error(`案例 ${id} 返回"仅深信服员工可见"（已重试 3 次）：站点权限判定抖动或该案例确实需要内部员工权限，请稍后重试`);
  }
  let c = j.rows;
  if (Array.isArray(c)) c = c[0];
  else if (c && Array.isArray(c.content)) c = c.content[0] ?? c; // 搜索结果形态 {content:[...]}
  if (!c || typeof c !== 'object') c = j.data ?? {};
  const atts = c.fileList ?? c.attachments ?? [];
  return {
    id,
    title: c.title ?? c.name ?? '',
    product: c.productName ?? c.product_name ?? '',
    module: [c.mainModuleNames ?? c.main_module_names, c.childModuleNames ?? c.child_module_names].filter(Boolean).join(' / '),
    version: c.suiteVersion ?? '',
    content: html2text(c.content ?? c.detail ?? c.description ?? ''),
    attachments: Array.isArray(atts) ? atts.map((f) => ({ name: f.name ?? f.fileName, url: f.url })) : [],
  };
}
