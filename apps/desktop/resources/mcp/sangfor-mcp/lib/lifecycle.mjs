import { api, unwrap } from './http.mjs';

// 版本生命周期（versionQuery/*，匿名可用）。参数约定（逆向 view_assets/versionQuery/index.js）：
//   产品参数 = {product_id, name, code}（来自 lifecycleProductsApi）
//   版本查询 = {...产品参数, version_id, page, page_size} → {rows:[{name,ga_date,eos_date,version_type}]}
//   全量版本 = POST lifecycleProductVersionsApi {regions:'cn'} → {products:{id:{product_code,product_name}}, versions:[{product_id,version_id,version_name,version_type}]}

export async function products() {
  const j = await api('/versionQuery/lifecycleProductsApi', { params: { regions: 'cn' } });
  const cats = j.rows?.categories ?? [];
  return cats.flatMap((c) =>
    (c.products ?? []).map((p) => ({ category: c.category_code, id: p.id, code: p.code, name: p.name, product_name: p.product_name, status: p.status }))
  );
}

/** 某产品的版本清单（带 version_id 与 STS/LTS 类型） */
export async function versionsOf({ product_id, name, code }) {
  const body = { product_id, name, code };
  const j = await api('/versionQuery/lifecycleProductVersionsApi', { method: 'POST', params: body });
  const rows = j.rows ?? {};
  return (rows.versions ?? []).filter((v) => String(v.product_id) === String(product_id));
}

/** 某版本的生命周期（GA/EOS 日期） */
export async function versionEol({ product_id, name, code, version_id }) {
  const j = await api('/versionQuery/lifecycleVersionsApi', {
    method: 'POST',
    params: { product_id, name, code, version_id, page: 1, page_size: 20 },
  });
  return j.rows?.rows ?? [];
}

/** 按版本名关键词跨产品搜版本（如 "6.12.0"），返回带产品信息的候选 */
export async function findVersions({ keyword }) {
  const j = await api('/versionQuery/lifecycleProductVersionsApi', { method: 'POST', params: { regions: 'cn' } });
  const rows = j.rows ?? {};
  const prodMap = rows.products ?? {};
  const kw = String(keyword ?? '').toLowerCase();
  return (rows.versions ?? [])
    .filter((v) => String(v.version_name ?? '').toLowerCase().includes(kw))
    .map((v) => ({
      ...v,
      product_code: prodMap[String(v.product_id)]?.product_code ?? '',
      product_name: prodMap[String(v.product_id)]?.product_name ?? '',
    }));
}
