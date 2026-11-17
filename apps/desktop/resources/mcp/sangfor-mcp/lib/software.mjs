import { apiAuth, api } from './http.mjs';
import { BASE } from './config.mjs';

// 产品树内存缓存 1 小时（scene/productApi 匿名可用）
let productCache = { at: 0, tree: null, flat: null };
const CACHE_MS = 3600_000;

/** 软件下载的产品线树（安全产品/云计算/桌面云… → 产品 → product_id） */
export async function productTree() {
  if (productCache.tree && Date.now() - productCache.at < CACHE_MS) return productCache;
  const j = await apiAuth('/scene/productApi', { params: { type: 0 } });
  const tree = j.data ?? [];
  const flat = [];
  const walk = (nodes, path) => {
    for (const n of nodes ?? []) {
      const p = [...path, n.name];
      if (n.level >= 1 || !n.children?.length) flat.push({ id: n.id, name: n.name, path: p.join(' / ') });
      if (n.children?.length) walk(n.children, p);
    }
  };
  walk(tree, []);
  productCache = { at: Date.now(), tree, flat };
  return productCache;
}

/** 按 id/名称找产品：优先精确 id，其次名称包含 */
export async function findProduct({ product_id, keyword }) {
  const { flat, tree } = await productTree();
  if (product_id != null) {
    const hit = flat.find((x) => x.id === Number(product_id));
    return hit ?? { id: Number(product_id), name: `product_id=${product_id}`, path: '' };
  }
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    const hits = flat.filter((x) => x.name.toLowerCase().includes(kw) || x.path.toLowerCase().includes(kw));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return { ambiguous: hits.slice(0, 10) };
  }
  return null;
}

/** 产品的软件版本筛选项（version_id）。站点按类目分版本，未传类目时全类目合并去重 */
export async function versions(product_id, category_id) {
  const cats = category_id ? [{ id: Number(category_id) }] : await listCategories(product_id);
  const seen = new Map();
  for (const c of cats) {
    try {
      const j = await apiAuth('/productSoftware/softwareVersionApi', { params: { product_id, category_id: c.id } });
      for (const v of j.data ?? []) {
        if (v.version_id != null && !seen.has(v.version_id)) {
          seen.set(v.version_id, { version_id: v.version_id, name: v.version_name, category: c.name ?? null });
        }
      }
    } catch {
      /* 单类目失败不阻塞其余类目 */
    }
  }
  return [...seen.values()];
}

/** "4.29GB"/"523.6MB"/"123" → 字节数；无法解析返回 null */
export function parseSize(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = /^([\d.]+)\s*(B|KB|MB|GB|TB)?$/i.exec(String(v).trim());
  if (!m) return null;
  const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(parseFloat(m[1]) * units[(m[2] ?? 'B').toUpperCase()]);
}

/**
 * 从产品软件下载页 SSR 导航提取类目列表 [{id,name}]（如 12=超融合服务器虚拟化/66=应用中心软件包）。
 * 站点 packageApi/versionApi 都强制要求 category_id 且无独立类目接口，这里是唯一发现途径。
 */
const catCache = new Map(); // product_id -> {at, cats}
export async function listCategories(product_id) {
  const pid = Number(product_id);
  const hit = catCache.get(pid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.cats;
  const res = await fetch(`${BASE}/productSoftware/list?product_id=${pid}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const html = await res.text();
  const cats = [];
  const re = new RegExp(`/productSoftware/list\\?product_id=${pid}&category_id=(\\d+)"[^>]*>([^<]{1,60})<`, 'g');
  const seen = new Set();
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    cats.push({ id: Number(m[1]), name: m[2].trim() });
  }
  catCache.set(pid, { at: Date.now(), cats });
  return cats;
}

// 包列表缓存（product_id → 全量条目）。解析/下载/关联在同一次作业里反复取列表，缓存避免每步都全量拉接口
const pkgCache = new Map(); // product_id -> {at, items}
const PKG_CACHE_MS = 300_000;

/** 拉产品全量包（跨类目并行 + 5 分钟缓存），返回归一化条目数组 */
export async function allPackages(product_id) {
  const pid = Number(product_id);
  const hit = pkgCache.get(pid);
  if (hit && Date.now() - hit.at < PKG_CACHE_MS) return hit.items;

  const cats = await listCategories(pid);
  if (!cats.length) {
    throw new Error(`产品 ${pid} 未发现任何软件类目（站点页面无导航数据），请确认 product_id 或显式传 category_id`);
  }
  const settled = await Promise.all(
    cats.map((c) =>
      apiAuth('/productSoftware/packageApi', { params: { product_id: pid, category_id: c.id } })
        .then((j) => ({ cat: c, j }))
        .catch((e) => ({ cat: c, err: e })) // 某类目对当前账号无权限（power=false）等情况：跳过继续
    )
  );
  const byId = new Map();
  for (const r of settled) {
    if (r.err) continue;
    const groups = Array.isArray(r.j.data) ? r.j.data : [];
    for (const g of groups) {
      for (const p of g.package ?? []) {
        const id = p.id ?? p.file_id;
        if (byId.has(id)) continue;
        byId.set(id, {
          id,
          name: p.name ?? p.package_name ?? p.file_name ?? '',
          md5: p.md5 ?? p.file_md5 ?? null,
          size: parseSize(p.size ?? p.filesize ?? p.file_size),
          sizeText: p.size ?? null,
          version: p.version ?? p.version_name ?? null,
          version_id: p.version_id ?? null,
          category: r.cat.name ?? null,
          time: p.create_time ?? p.update_time ?? p.time ?? null,
          explain: g.explain ?? null,
          desc: p.description ?? p.desc ?? null,
        });
      }
    }
  }
  const items = [...byId.values()];
  if (!items.length && settled.every((r) => r.err)) throw settled[0].err;
  pkgCache.set(pid, { at: Date.now(), items });
  return items;
}

/**
 * 软件包列表（基于 allPackages 缓存做过滤分页）。
 * keyword/version_id 在本地过滤（站点该接口本身不分页）。
 */
export async function packages({ product_id, category_id, version_id, keyword, page = 1, page_size = 50 }) {
  let items = await allPackages(product_id);
  if (category_id) {
    const cname = (await listCategories(product_id)).find((c) => c.id === Number(category_id))?.name;
    if (cname) items = items.filter((x) => x.category === cname);
  }
  if (version_id != null) items = items.filter((x) => x.version_id === Number(version_id) || x.name.includes(String(version_id)));
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    items = items.filter((x) => x.name.toLowerCase().includes(kw) || (x.desc ?? '').toLowerCase().includes(kw));
  }
  const total = items.length;
  const start = (page - 1) * page_size;
  return { total, page, page_size, items: items.slice(start, start + page_size) };
}

/** 在列表里按精确文件名定位一个包（供下载工具用文件名引用时解析） */
export async function findPackageByName(product_id, filename) {
  const { items } = await packages({ product_id, page: 1, page_size: 100000 });
  const name = filename.toLowerCase();
  return (
    items.find((x) => x.name.toLowerCase() === name) ??
    items.find((x) => x.name.toLowerCase().includes(name)) ??
    null
  );
}

// ---------- 一句话解析（快路径） ----------
// 常用产品别名 → product_id。产品树接口不全（HCI/SCP 不在树里），硬编码最可靠。
// start = 名字以产品词开头才认平台主件（"适用于HCI"的驱动/工具不算）
export const PRODUCT_ALIASES = [
  { re: /hci|超融合|cvm/i, id: 33, name: '超融合HCI', self: /hci/i, start: /^hci/i },
  { re: /scp|云管/i, id: 36, name: '云管平台SCP', self: /scp/i, start: /^scp/i },
  { re: /adesk|桌面云|vdc|vdi/i, id: 26, name: '桌面云aDesk', self: /adesk|vdc|vdi/i, start: /^(adesk|vdc|vdi)/i },
  { re: /\baf\b|下一代防火墙/i, id: 13, name: '下一代防火墙AF', self: /\baf\b|next/i, start: /^af/i },
  { re: /\bac\b|行为管理|上网行为/i, id: 22, name: '行为管理AC', self: /\bac\b/i, start: /^ac/i },
  { re: /\bsip\b|\bsta\b|态势感知|探针/i, id: 24, name: 'SIP/STA', self: /\bsip\b|\bsta\b/i, start: /^(sip|sta)/i },
  { re: /atrust|零信任/i, id: 19, name: 'aTrust', self: /atrust/i, start: /^atrust/i },
  { re: /\baes\b|终端安全|edr/i, id: 16, name: 'aES', self: /\baes\b/i, start: /^aes/i },
];

// 查询没点名时，这些字样的包视为衍生件而非主体（仲裁节点/延伸集群/应用组件模板等）
const DERIVATIVE_RE = /仲裁|延伸|组件模板|应用组件|模板|测试|beta|内测/i;

export function guessProductId(query) {
  for (const a of PRODUCT_ALIASES) {
    if (a.re.test(query)) return { id: a.id, name: a.name, self: a.self, start: a.start };
  }
  return null;
}

const TYPE_HINTS = [
  { re: /安装包|镜像|\.iso|全新安装|iso\b/i, tag: '安装', weight: 40 },
  { re: /升级包|upgrade/i, tag: '升级', weight: 40 },
  { re: /补丁|patch|hotfix|热修/i, tag: '补丁', weight: 45 },
  { re: /工具|tool|导航/i, tag: '工具', weight: 40 },
  { re: /规则库|特征库|规则/i, tag: '规则库', weight: 40 },
];

/**
 * 一句话解析：如 "HCI 6.12.0 C86 安装包" / "SCP 6.12.1" / "最新 VDC 镜像"。
 * 返回 {product_id, product_name, version, build, typeTag, candidates:[{...,score,why}] }，
 * candidates 按相关度排序，前几名可直接喂给下载工具。
 */
export async function resolveQuery({ query, product_id, limit = 5 } = {}) {
  const q = String(query ?? '').trim();
  if (!q && !product_id) throw new Error('缺少 query 或 product_id');

  // 1. 定产品：显式 product_id > 别名 > 报错
  let prod = null;
  if (product_id) {
    prod = { id: Number(product_id), name: `product_id=${product_id}`, self: null, start: null };
  } else {
    prod = guessProductId(q);
    if (prod?.start && /adesk|桌面云|vdc|vdi/i.test(q)) {
      // aDesk 家族细分：查询里写了哪个词就用哪个收紧开头匹配（查 VDC 别把 VDI 客户端顶上来）
      if (/\bvdc\b|vdc/i.test(q)) prod = { ...prod, start: /^vdc/i };
      else if (/\bvdi\b/i.test(q)) prod = { ...prod, start: /^vdi/i };
      else if (/adesk|桌面云/i.test(q)) prod = { ...prod, start: /^adesk/i };
    }
    if (!prod) {
      // 兜底：产品树名称匹配
      const flat = (await productTree()).flat;
      const kw = q.toLowerCase();
      const hits = flat.filter((x) => x.name.toLowerCase().includes(kw.slice(0, 4)));
      if (hits.length) prod = { id: hits[0].id, name: hits[0].name, self: null, start: null };
    }
  }
  if (!prod) {
    return { product_id: null, error: `无法从「${q}」识别产品。已知别名：HCI/超融合、SCP/云管、aDesk/桌面云/VDC、AF、AC、SIP、aTrust、aES，或直接给 product_id` };
  }

  // 2. 解析版本 / build / 类型意图
  const ver = extractVersion(q);
  const build = /(?:^|[^a-z0-9])c[- ]?(\d{2,3})(?![a-z0-9])/i.exec(q)?.[1] ?? null; // C86（兼容 _C86/C-86）
  const typeHints = TYPE_HINTS.filter((t) => t.re.test(q));
  const wantLatest = /最新|latest/i.test(q);

  // 3. 全量包（缓存）+ 类型过滤 + 打分
  let items = await allPackages(prod.id);
  // 查询点了类型（安装/升级/补丁/工具/规则库）→ 只留名字也命中的（驱动/工具不再混进安装包查询）；零命中则保留全部
  if (typeHints.length) {
    const matched = items.filter((x) => typeHints.some((t) => t.re.test(x.name)));
    if (matched.length) items = matched;
  }
  const BUILD_RE = /(?:^|[^a-z0-9])c[- ]?(\d{2,3})(?![a-z0-9])/i;
  const scored = items.map((x) => {
    let score = 0;
    const why = [];
    const xv = extractVersion(x.name);
    if (ver && xv) {
      if (xv.full === ver.full) { score += 100; why.push(`版本=${ver.full}`); }
      else if (xv.full.startsWith(ver.full)) { score += 70; why.push(`版本前缀=${ver.full}`); }
      else if (xv.family === ver.family) { score += 30; why.push(`同版本族=${ver.family}`); }
      else return null; // 版本不符直接出局
    }
    if (build) {
      const xb = BUILD_RE.exec(x.name)?.[1];
      if (xb && xb !== build) return null; // 标了别的 build，出局
      if (xb === build) { score += 60; why.push(`build=C${build}`); }
    }
    // 相邻命中：版本+build 在名字里连写（6.12.0-C86 / 6.12.0（C86））→ 更"正"
    if (ver && build && new RegExp(`${ver.full.replace('.', '\\.')}[-–—（(_]\\s*c${build}`, 'i').test(x.name)) {
      score += 15;
      why.push('版本build相邻');
    }
    // 查询没点名的衍生件（仲裁/延伸/模板/测试）压后
    if (!/仲裁|延伸|模板|测试|beta/i.test(q) && DERIVATIVE_RE.test(x.name)) {
      score -= 55;
      why.push('衍生件');
    }
    for (const t of typeHints) {
      if (t.re.test(x.name)) { score += t.weight; why.push(t.tag); }
    }
    return { ...x, score, why };
  }).filter(Boolean);

  // 无版本指定或要求最新 → 专门比较器：名字以产品词开头 > 版本号降序 > 衍生件靠后 > 时间
  if (!ver || wantLatest) {
    const start = prod.start;
    scored.sort((a, b) => {
      if (start) {
        const sa = start.test(a.name) ? 1 : 0;
        const sb = start.test(b.name) ? 1 : 0;
        if (sa !== sb) return sb - sa;
      }
      const ka = verKey(a.name);
      const kb = verKey(b.name);
      if (ka || kb) {
        if (!ka) return 1;
        if (!kb) return -1;
        for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
          const d = (kb[i] ?? 0) - (ka[i] ?? 0);
          if (d) return d;
        }
      }
      const da = DERIVATIVE_RE.test(a.name) ? 1 : 0;
      const db = DERIVATIVE_RE.test(b.name) ? 1 : 0;
      if (da !== db) return da - db;
      return String(b.time ?? '').localeCompare(String(a.time ?? ''));
    });
    scored.forEach((x, i) => {
      const tags = [];
      if (start) tags.push(start.test(x.name) ? '平台主件' : '非平台主件');
      tags.push(i === 0 ? '最新' : `版本排名${i + 1}`);
      x.why = [...x.why, ...tags];
    });
  } else {
    scored.sort((a, b) => b.score - a.score || String(b.time ?? '').localeCompare(String(a.time ?? '')));
  }

  return {
    product_id: prod.id,
    product_name: prod.name,
    version: ver?.full ?? null,
    build: build ? 'C' + build : null,
    typeTag: typeHints.map((t) => t.tag).join('/') || null,
    total: items.length,
    candidates: scored.slice(0, limit),
  };
}

// ---------- 关联下载 ----------
// 从基础包名提取版本：HCI6.12.0_X86(...).iso → {full:'6.12.0', family:'6.12'}
export function extractVersion(name) {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[Rr]\d+)?(?:[Ss][Pp]\d+)?)/.exec(name ?? '');
  if (!m) return null;
  const full = m[1];
  const family = full.replace(/([Rr]\d+|[Ss][Pp]\d+)$/, '').split('.').slice(0, 2).join('.');
  return { full, family };
}

const PATCH_RE = /补丁|patch|hotfix|热修/i;
const TOOL_RE = /工具|zip$|\.zip|navigator|导航/i;

/** 版本排序键：6.12.0R1 → [6,12,0,0,1]（SP<R 优先级在后），便于比较新旧 */
function verKey(name) {
  const v = extractVersion(name);
  if (!v) return null;
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[Rr](\d+))?(?:[Ss][Pp](\d+))?$/.exec(v.full);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0), Number(m[5] ?? 0), Number(m[4] ?? 0)];
}

function cmpVerDesc(a, b) {
  const ka = verKey(a?.name);
  const kb = verKey(b?.name);
  if (!ka && !kb) return String(b?.time ?? '').localeCompare(String(a?.time ?? ''));
  if (!ka) return 1;
  if (!kb) return -1;
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (kb[i] ?? 0) - (ka[i] ?? 0);
    if (d) return d;
  }
  return String(b?.time ?? '').localeCompare(String(a?.time ?? ''));
}

/**
 * 关联下载发现：给定产品 + 基础包关键词（如 "6.12.0"），或 latest:true 自动定位最新版本，
 * 返回基础包 / 同版本补丁候选 / 相关工具 / 升级手册与配套表文档。
 * 补丁为名称启发式候选，须经版本配套表核对后再下载。
 */
export async function related({ product_id, base_keyword, latest } = {}) {
  const all = await packages({ product_id, page: 1, page_size: 100000 });
  let bases;
  if (latest) {
    bases = all.items.filter((x) => !PATCH_RE.test(x.name)).sort(cmpVerDesc).slice(0, 5);
  } else {
    const kw = String(base_keyword ?? '').toLowerCase();
    bases = kw ? all.items.filter((x) => x.name.toLowerCase().includes(kw)) : all.items;
    bases = bases
      .filter((x) => !PATCH_RE.test(x.name))
      .sort((a, b) => String(b.time ?? '').localeCompare(String(a.time ?? '')))
      .slice(0, 5);
  }
  if (!bases.length) return { base: [], patches: [], tools: [], docs: [], note: '未找到匹配的基础包' };

  const primary = bases[0];
  const ver = extractVersion(primary.name);
  const family = ver?.family;

  const inFamily = (x) => {
    if (!family) return true;
    const v = extractVersion(x.name);
    return v && (v.full.startsWith(family) || family.startsWith(v.full.split('.').slice(0, 2).join('.')));
  };
  const patches = all.items.filter((x) => PATCH_RE.test(x.name) && inFamily(x));
  const tools = all.items.filter((x) => !PATCH_RE.test(x.name) && TOOL_RE.test(x.name) && inFamily(x)).slice(0, 8);

  // 文档：升级手册 / 版本配套表 / 升级指导
  const prod = (await productTree()).flat.find((x) => x.id === Number(product_id));
  const prodName = prod?.name ?? '';
  const { globalSearch } = await import('./search.mjs');
  const docQueries = [
    `${prodName} ${ver?.full ?? kw} 升级`,
    `${prodName} ${family ?? kw} 版本配套表`,
  ];
  const docs = [];
  const seen = new Set();
  for (const q of docQueries) {
    try {
      const r = await globalSearch({ keyword: q, type: 2, page: 1 });
      for (const d of r.items) {
        if (seen.has(d.link)) continue;
        seen.add(d.link);
        docs.push(d);
        if (docs.length >= 8) break;
      }
    } catch {
      /* 搜索失败不阻塞 */
    }
    if (docs.length >= 8) break;
  }

  return { product: prodName, product_id: Number(product_id), version: ver?.full ?? null, family: family ?? null, base: bases, patches, tools, docs };
}
