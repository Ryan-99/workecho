#!/usr/bin/env node
// 深信服支持站 MCP 服务器（stdio）
// 能力：登录态管理 / 软件镜像与补丁检索下载（MD5 校验、断点续传）/ 排障案例搜索 / 全局资料搜索
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as auth from './lib/auth.mjs';
import * as software from './lib/software.mjs';
import * as cases from './lib/cases.mjs';
import * as search from './lib/search.mjs';
import * as docs from './lib/docs.mjs';
import * as lifecycle from './lib/lifecycle.mjs';
import { downloadFile, fileMd5 } from './lib/download.mjs';
import { AUTH_DIR, DEFAULT_DOWNLOAD_DIR, SESSION_FILE } from './lib/config.mjs';
import { fmtSize, AuthRequiredError } from './lib/http.mjs';
import fs from 'node:fs';

const server = new McpServer(
  { name: 'sangfor', version: '0.1.0' },
  {
    instructions: [
      '深信服技术支持站（support.sangfor.com.cn）工具集。',
      '快路径（首选）：sangfor_quick_download 一句话直接下载（如 "HCI 6.12.0 C86 安装包"）；sangfor_resolve 只看不下；两者内部自动登录/识别产品/匹配版本，勿再手动 login_status→products→list 长链路。',
      '需要登录的：quick_download/resolve/software_list/software_download/related（内部自动 ensureSession，未登录会提示 sangfor_login，扫码用 method=qrcode + qr_html_dir 内嵌展示）。',
      '查资料类（search/case_*/doc_read/lifecycle）无需登录。',
      '关联件规则：先问后下——sangfor_related 或 quick_download with_related 拿到补丁候选/工具/手册配套表清单后，问用户要下哪些再下载；补丁候选须经配套表核对。',
      '下载默认 8 线程分段，自动选盘（永不写 C 盘），MD5 校验，断点续传；>500MB 自动转后台，sangfor_download_status 轮询。',
    ].join('\n'),
  }
);

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
const fail = (e) => ({
  isError: true,
  content: [{ type: 'text', text: `❌ ${e.message}${e instanceof AuthRequiredError ? '\n（请先 sangfor_login 登录）' : ''}` }],
});

// ---------- 1. 登录状态 ----------
server.registerTool(
  'sangfor_login_status',
  {
    title: '深信服登录状态',
    description: '查看支持站登录状态与已存凭据配置',
    inputSchema: {},
  },
  async () => {
    await auth.loadSession();
    const me = await auth.whoami();
    const cred = auth.loadCredentials();
    const sess = fs.existsSync(SESSION_FILE) ? JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) : null;
    return text(
      [
        me ? `✅ 已登录：${me.username}（uid=${me.uid}）` : '❌ 未登录',
        sess?.savedAt ? `会话保存时间：${sess.savedAt}` : '',
        cred ? '自动重登凭据：已配置（会话过期会自动重试登录）' : '自动重登凭据：未配置（可选： sangfor_login 传 store=true，或设 SANGFOR_USERNAME/SANGFOR_PASSWORD 环境变量）',
        '',
        '未登录时：查资料/案例仍可用；软件列表与下载需要先 sangfor_login。',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
);

// ---------- 2. 登录 ----------
server.registerTool(
  'sangfor_login',
  {
    title: '深信服登录',
    description:
      '登录深信服支持站。method=password 用账号密码（username/password 参数，省略时用已存凭据）；method=qrcode 生成二维码（保存为 PNG + 终端字符画，用手机微信/深信服 App 扫码），随后用 sangfor_login_poll 轮询。store=true 把凭据存到本机用于会话过期自动重登。',
    inputSchema: {
      method: z.enum(['password', 'qrcode']).default('password').describe('登录方式'),
      username: z.string().optional().describe('账号（手机号/邮箱）'),
      password: z.string().optional().describe('密码'),
      captcha: z.string().optional().describe('图形验证码（站点要求时，先 sangfor_captcha 取图）'),
      store: z.boolean().default(false).describe('是否把凭据保存到本机 auth/credentials.json 供自动重登'),
      qr_html_dir: z.string().optional().describe('可视化/资源目录（仅支持富媒体内嵌展示的 Agent 需要，如客户端提供的 Gen UI 会话目录）：扫码登录时传入，会生成内嵌二维码的 HTML 片段，用内嵌引用直接展示在对话里让用户扫，比弹窗图片可靠；不支持的客户端忽略此参数'),
    },
  },
  async ({ method, username, password, captcha, store, qr_html_dir }) => {
    try {
      await auth.loadSession();
      if (method === 'qrcode') {
        const url = await auth.qrCreate();
        const qrFile = AUTH_DIR + '\\qr.png';
        const QRCode = (await import('qrcode')).default;
        await QRCode.toFile(qrFile, url, { width: 400 });
        const lines = [
          '请扫码登录（微信/深信服 App）：',
          `二维码图片：${qrFile}（打开后扫码）`,
        ];
        if (qr_html_dir) {
          const frag = auth.writeQrHtmlFragment(qr_html_dir, qrFile);
          lines.push(
            '',
            '已生成内嵌二维码的 HTML 片段（推荐在对话里展示用这个，弹窗图片容易被挡住）：',
            `::visualize{"path":"${frag}"}`,
            '（把上面这行原样输出在回复里即可内嵌展示；二维码约 4 分钟有效，过期重新调用本工具生成新的）'
          );
        }
        lines.push('', '或直接打开链接：' + url, '', '扫码后调用 sangfor_login_poll 确认登录结果。');
        return text(lines.join('\n'));
      }
      const cred = auth.loadCredentials();
      const u = username ?? cred?.username;
      const p = password ?? cred?.password;
      if (!u || !p) return text('❌ 缺少账号或密码：请传 username/password，或先配置 SANGFOR_USERNAME/SANGFOR_PASSWORD / auth/credentials.json');
      if (store) auth.storeCredentials(u, p);
      const me = await auth.loginPassword(u, p, captcha);
      return text(`✅ 登录成功：${me.username}（uid=${me.uid}）${store ? '，凭据已存本机（自动重登已启用）' : ''}`);
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- 3. 扫码轮询 ----------
server.registerTool(
  'sangfor_login_poll',
  { title: '扫码结果轮询', description: '轮询扫码登录状态（0 等待 / 1 已扫待确认 / 2 过期 / 3 成功）', inputSchema: {} },
  async () => {
    try {
      const r = await auth.qrPoll();
      if (r.status === 3) return text(`✅ ${r.message}：${r.info?.username ?? ''}`);
      return text(`⏳ ${r.message}`);
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- 4. 图形验证码 ----------
server.registerTool(
  'sangfor_captcha',
  { title: '获取图形验证码', description: '登录被要求图形验证码时，拉取验证码图片到本机，用户看图输码后带 captcha 参数重试 sangfor_login', inputSchema: {} },
  async () => {
    try {
      const file = await auth.captchaImage();
      return text(`验证码图片已保存：${file}\n请打开图片识别字符，然后用 sangfor_login 传 captcha 参数重试（保持同一会话）。`);
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- 5. 产品线 ----------
server.registerTool(
  'sangfor_products',
  {
    title: '软件产品线',
    description: '列出支持站软件下载的产品线树（含 product_id）。支持 keyword 过滤，如 AF/HCI/SCP/aDesk/AC/EDS',
    inputSchema: { keyword: z.string().optional().describe('按产品名过滤') },
  },
  async ({ keyword }) => {
    try {
      const { flat } = await software.productTree();
      let items = flat;
      if (keyword) {
        const kw = keyword.toLowerCase();
        items = flat.filter((x) => x.name.toLowerCase().includes(kw) || x.path.toLowerCase().includes(kw));
      }
      return text(
        items.map((x) => `product_id=${x.id}  ${x.name}  [${x.path}]`).join('\n') +
          (items.length
            ? ''
            : '\n（站点产品树接口不全，很多产品不在树里。可用 sangfor_search 搜目标包名，从结果的 product_id 聚合里反查，如 HCI=33、SCP=36、aDesk=26）')
      );
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- 6. 软件版本 ----------
server.registerTool(
  'sangfor_software_versions',
  {
    title: '软件版本列表',
    description: '列出某产品可下载的版本筛选项（version_id），用于 sangfor_software_list 的 version_id 参数',
    inputSchema: { product_id: z.number().describe('产品 ID（sangfor_products 里查）') },
  },
  async ({ product_id }) => {
    try {
      const vs = await software.versions(product_id);
      return text(vs.map((v) => `version_id=${v.version_id}  ${v.name}${v.category ? '  [' + v.category + ']' : ''}`).join('\n') || '（无版本数据）');
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- 7. 软件包列表 ----------
server.registerTool(
  'sangfor_software_list',
  {
    title: '软件包列表',
    description:
      '检索某产品的可下载软件包（镜像/补丁/升级包/工具）。返回条目含 id（下载用）、文件名、大小、MD5、时间。需要登录。',
    inputSchema: {
      product_id: z.number().describe('产品 ID'),
      keyword: z.string().optional().describe('按文件名/描述过滤，如 6.12、VDC、patch'),
      version_id: z.number().optional().describe('版本过滤'),
      category_id: z.number().optional().describe('包分类 ID（一般不用传）'),
      page: z.number().default(1),
      page_size: z.number().default(50).describe('每页条数（默认 50，最大 200）'),
    },
  },
  async ({ product_id, keyword, version_id, category_id, page, page_size }) => {
    try {
      const r = await software.packages({
        product_id,
        keyword,
        version_id,
        category_id,
        page,
        page_size: Math.min(page_size, 200),
      });
      if (!r.total) return text('（无匹配软件包）');
      const lines = r.items.map(
        (x) =>
          `id=${x.id}  ${x.name}\n    大小:${fmtSize(x.size) ?? '?'}  时间:${x.time ?? '?'}  版本:${x.version ?? '-'}  MD5:${x.md5 ?? '-'}`
      );
      const foot = r.total > r.items.length ? `\n（共 ${r.total} 条，当前第 ${r.page} 页，翻页用 page 参数）` : `（共 ${r.total} 条）`;
      return text(lines.join('\n') + foot + '\n\n下载：sangfor_software_download 传 file_id（和 name 以便命名）。');
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- 8. 下载 ----------
// 后台下载任务表：大镜像走后台（立即返回 job_id），sangfor_download_status 轮询
const jobs = new Map();
let jobSeq = 0;

server.registerTool(
  'sangfor_software_download',
  {
    title: '下载软件包',
    description:
      '下载镜像/补丁到本地。file_id 来自 sangfor_software_list；也可用 product_id+filename 按文件名定位。自动 MD5 校验、断点续传；目标同名旧文件先挪开。默认保存到 ' +
      DEFAULT_DOWNLOAD_DIR +
      '。文件>500MB 或 wait=false 时转后台任务（返回 job_id），用 sangfor_download_status 查进度；中断后续传：重新调用即可。',
    inputSchema: {
      file_id: z.union([z.number(), z.string()]).optional().describe('文件 id（软件列表里的 id）'),
      filename: z.string().optional().describe('按文件名定位（需同时给 product_id），支持模糊匹配'),
      product_id: z.number().optional().describe('产品 ID（配合 filename 使用）'),
      name: z.string().optional().describe('保存的文件名（缺省用站点 Content-Disposition）'),
      md5: z.string().optional().describe('期望 MD5（列表里有；不传则下载后报告实际值）'),
      save_dir: z.string().optional().describe('保存目录；缺省自动选盘（优先下载目录，空间不足换非 C 盘）'),
      threads: z.number().default(8).describe('分段下载并发数 1-32（默认 8；站点不支持 Range 时自动回退单线程）'),
      wait: z.boolean().default(true).describe('true=等下载完成再返回；false=后台任务'),
    },
  },
  async (args) => {
    try {
      await auth.ensureSession();
      let { file_id, filename, product_id, name, md5, save_dir, threads, wait } = args;
      let knownSize = null;
      if (!file_id && filename) {
        if (!product_id) return text('❌ 用 filename 定位时需要同时给 product_id');
        const hit = await software.findPackageByName(product_id, filename);
        if (!hit) return text(`❌ 产品 ${product_id} 下没找到文件名含「${filename}」的包`);
        file_id = hit.id;
        name = name ?? hit.name;
        md5 = md5 ?? hit.md5;
        knownSize = hit.size ?? null;
      }
      if (!file_id) return text('❌ 需要 file_id 或 product_id+filename');

      // knownSize 是站点显示值换算的近似字节数：只用于大文件转后台判断与提示，
      // 不传给 downloadFile（完整性以 MD5 + content-length 为准，近似值会误删好文件）
      const run = (onProgress) =>
        downloadFile({ id: file_id, name, md5, saveDir: save_dir ?? undefined, threads, onProgress });

      // 大文件自动转后台
      const big = knownSize != null && Number(knownSize) > 500 * 1024 * 1024;
      if (wait === false || big) {
        const jobId = `dl_${++jobSeq}`;
        const job = { jobId, file_id, name: name ?? null, status: 'downloading', written: 0, total: knownSize, speed: 0, threads, startedAt: new Date().toISOString() };
        jobs.set(jobId, job);
        run((written, total, speed) => {
          job.written = written;
          job.total = total || job.total;
          job.speed = speed;
        })
          .then((r) => Object.assign(job, { status: 'done', file: r.file, size: r.size, md5: r.md5, verified: r.verified, threads: r.threads, finishedAt: new Date().toISOString() }))
          .catch((e) => Object.assign(job, { status: 'error', error: e.message, finishedAt: new Date().toISOString() }));
        return text(
          [
            `⏳ 已转后台下载（job_id=${jobId}）`,
            knownSize ? `预计大小：${fmtSize(knownSize)}` : '',
            `保存目录：${save_dir ?? '自动选盘（优先 ' + DEFAULT_DOWNLOAD_DIR + '，空间不足换非 C 盘）'}`,
            `并发：${threads} 线程`,
            '用 sangfor_download_status {job_id} 查进度；下载在 MCP 服务进程内继续，不受单次工具调用时限影响。',
          ]
            .filter(Boolean)
            .join('\n')
        );
      }

      const log = (written, total, speed) => {
        server.server
          .sendLoggingMessage({ level: 'info', data: `下载进度 ${fmtSize(written)} / ${total ? fmtSize(total) : '?'}（${fmtSize(speed)}/s）` })
          .catch?.(() => {});
      };
      const r = await run(log);
      return text(
        [
          r.alreadyDownloaded ? '✅ 文件已存在且 MD5 一致：' : '✅ 下载完成',
          `文件：${r.file}`,
          `大小：${fmtSize(r.size)}（${r.size} 字节）`,
          `MD5：${r.md5}${r.verified ? '（已校验一致）' : '（站点未提供 MD5，此为实际计算值）'}`,
          r.movedAside ? `同名旧文件已挪开：${r.movedAside}` : '',
          r.threads > 1 ? `本次 ${r.threads} 线程分段下载` : '本次单线程下载（站点未开放 Range）',
        ]
          .filter(Boolean)
          .join('\n')
      );
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- 8b. 下载任务状态 ----------
server.registerTool(
  'sangfor_download_status',
  {
    title: '下载任务状态',
    description: '查询后台下载任务进度；不传 job_id 返回全部任务',
    inputSchema: { job_id: z.string().optional() },
  },
  async ({ job_id }) => {
    const list = job_id ? [jobs.get(job_id)].filter(Boolean) : [...jobs.values()];
    if (!list.length) return text('（没有下载任务）');
    return text(
      list
        .map((j) => {
          const pct = j.total ? ` ${(Math.min(100, (j.written / j.total) * 100)).toFixed(1)}%` : '';
          const base = `${j.jobId}  ${j.name ?? 'file_' + j.file_id}  [${j.status}]  ${fmtSize(j.written)}${j.total ? '/' + fmtSize(j.total) : ''}${pct}  ${fmtSize(j.speed)}/s`;
          if (j.status === 'done') return `✅ ${base}\n   文件：${j.file}\n   MD5：${j.md5}${j.verified ? '（已校验）' : ''}`;
          if (j.status === 'error') return `❌ ${base}\n   错误：${j.error}\n   重试：重新调用 sangfor_software_download 会断点续传`;
          return `⏳ ${base}`;
        })
        .join('\n\n')
    );
  }
);

// ---------- 8c. 一句话解析（快路径） ----------
function fmtCandidates(r) {
  const lines = r.candidates.map(
    (c, i) => `${i === 0 ? '▶' : ' '} ${c.id}  ${c.name}\n    ${c.sizeText ?? fmtSize(c.size) ?? '?'}  ${c.time ?? ''}  MD5:${c.md5 ?? '-'}  [${(c.why ?? []).join(',')}]`
  );
  return [
    `产品：${r.product_name}（product_id=${r.product_id}）` + (r.version ? `  版意图：${r.version}${r.build ? ' ' + r.build : ''}` : '') + (r.typeTag ? `  类型：${r.typeTag}` : ''),
    '',
    ...lines,
  ].join('\n');
}

server.registerTool(
  'sangfor_resolve',
  {
    title: '一句话找包',
    description:
      '快路径：一句话描述要找的包（如 "HCI 6.12.0 C86 安装包"、"VDC 最新 镜像"、"SCP 6.12.1"），直接返回排序后的候选（id/文件名/大小/MD5）。识别产品别名（HCI/SCP/aDesk/VDC/AF/AC/SIP/aTrust/aES）、版本、build（C86）、类型（安装/升级/补丁/工具）。需要登录。',
    inputSchema: {
      query: z.string().describe('一句话描述，如 "HCI 6.12.0 C86 安装包"'),
      product_id: z.number().optional().describe('显式指定产品 ID（跳过别名识别）'),
      limit: z.number().default(5).describe('返回候选数（默认 5）'),
    },
  },
  async ({ query, product_id, limit }) => {
    try {
      await auth.ensureSession();
      const r = await software.resolveQuery({ query, product_id, limit: Math.min(limit ?? 5, 20) });
      if (r.error) return text('❌ ' + r.error);
      return text(fmtCandidates(r) + '\n\n下载：sangfor_quick_download 用同一句话，或 sangfor_software_download {product_id, filename:"<候选文件名>"}。');
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- 8d. 一句话直下（解析+下载一次完成） ----------
server.registerTool(
  'sangfor_quick_download',
  {
    title: '一句话下载',
    description:
      '最快路径：一句话（如 "HCI 6.12.0 C86 安装包"）→ 解析出最佳匹配 → 直接下载（8线程/自动选盘/MD5校验/续传）。命中多个候选时不下，返回候选让用户挑。with_related=true 时顺带返回补丁候选/工具/手册配套表清单（只列不下，供先问后下流程）。需要登录。',
    inputSchema: {
      query: z.string().describe('一句话描述，如 "HCI 6.12.0 C86 安装包"'),
      product_id: z.number().optional().describe('显式指定产品 ID'),
      save_dir: z.string().optional().describe('保存目录（绝对路径）；缺省自动选盘'),
      threads: z.number().default(8),
      wait: z.boolean().default(true).describe('false=转后台任务（返回 job_id）'),
      with_related: z.boolean().default(false).describe('顺带返回关联件清单（不下）'),
    },
  },
  async (args) => {
    try {
      await auth.ensureSession();
      const { query, product_id, save_dir, threads, wait, with_related } = args;
      const r = await software.resolveQuery({ query, product_id, limit: 5 });
      if (r.error) return text('❌ ' + r.error);
      if (!r.candidates.length) return text(`❌「${query}」在 ${r.product_name} 下没有匹配的包，试试 sangfor_resolve 换个说法或 sangfor_software_list 浏览。`);

      const best = r.candidates[0];
      const second = r.candidates[1];
      // 首选优势不足时不要猜：给出候选让用户挑（分数接近且不是同款的不同架构变体）
      const ambiguous = second && best.score - second.score < 15 && second.name.replace(/\([^)]*\)/g, '') !== best.name.replace(/\([^)]*\)/g, '');
      if (ambiguous) {
        return text('⚠「' + query + '」命中多个相近候选，请指定后重试（把文件名带上）：\n\n' + fmtCandidates(r));
      }

      const log = (written, total, speed) => {
        server.server
          .sendLoggingMessage({ level: 'info', data: `下载进度 ${fmtSize(written)} / ${total ? fmtSize(total) : '?'}（${fmtSize(speed)}/s）` })
          .catch?.(() => {});
      };
      const big = best.size != null && Number(best.size) > 500 * 1024 * 1024;
      if (wait === false || big) {
        const jobId = `dl_${++jobSeq}`;
        const job = { jobId, file_id: best.id, name: best.name, status: 'downloading', written: 0, total: best.size, speed: 0, threads, startedAt: new Date().toISOString() };
        jobs.set(jobId, job);
        downloadFile({ id: best.id, name: best.name, md5: best.md5, size: best.size, saveDir: save_dir, threads, onProgress: (w, t, s) => { job.written = w; job.total = t || job.total; job.speed = s; } })
          .then((res) => Object.assign(job, { status: 'done', file: res.file, size: res.size, md5: res.md5, verified: res.verified, threads: res.threads, finishedAt: new Date().toISOString() }))
          .catch((e) => Object.assign(job, { status: 'error', error: e.message, finishedAt: new Date().toISOString() }));
        return text(
          [
            `✅ 已识别并转后台下载（job_id=${jobId}）`,
            `包：${best.name}`,
            `大小：${best.sizeText ?? fmtSize(best.size) ?? '?'}`,
            `保存：${save_dir ?? '自动选盘'}`,
            with_related ? '' : '关联件需要时再调 sangfor_related。',
            '用 sangfor_download_status {job_id} 查进度。',
          ]
            .filter(Boolean)
            .join('\n')
        );
      }

      const res = await downloadFile({ id: best.id, name: best.name, md5: best.md5, size: best.size, saveDir: save_dir, threads, onProgress: log });
      const out = [
        `✅ ${res.alreadyDownloaded ? '文件已存在且 MD5 一致' : '下载完成'}`,
        `包：${best.name}`,
        `文件：${res.file}`,
        `大小：${fmtSize(res.size)}（${res.size} 字节）`,
        `MD5：${res.md5}${res.verified ? '（已校验一致）' : ''}`,
        res.threads > 1 ? `${res.threads} 线程分段` : '单线程',
      ];
      if (with_related) {
        try {
          const rel = await software.related({ product_id: r.product_id, base_keyword: (software.extractVersion(best.name)?.full) ?? undefined });
          out.push(
            '',
            `关联件清单（未下载，按先问后下规则请用户确认）：`,
            `  补丁候选 ${rel.patches.length} 个：${rel.patches.slice(0, 5).map((p) => p.name).join('、') || '无'}`,
            `  工具 ${rel.tools.length} 个：${rel.tools.slice(0, 3).map((p) => p.name).join('、') || '无'}`,
            `  手册/配套表 ${rel.docs.length} 篇：${rel.docs.slice(0, 3).map((d) => d.title).join('、') || '无'}`
          );
        } catch (e) {
          out.push('', `（关联件查询失败：${e.message}）`);
        }
      }
      return text(out.join('\n'));
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- 9. 全局搜索 ----------
server.registerTool(
  'sangfor_search',
  {
    title: '全局资料搜索',
    description: '支持站全站搜索（文档/软件/案例聚合），无需登录。type 聚合会返回各类型数量帮助二次过滤',
    inputSchema: {
      keyword: z.string().describe('关键词'),
      type: z.number().optional().describe('类型过滤（见返回的 typeAggs：2≈文档 5≈软件包 1≈案例）'),
      product_id: z.number().optional().describe('按产品过滤'),
      page: z.number().default(1),
    },
  },
  async ({ keyword, type, product_id, page }) => {
    try {
      const r = await search.globalSearch({ keyword, type, product_id, page });
      const lines = r.items.map((x) => {
        const caseHint = x.caseId ? `\n    案例 id=${x.caseId}（sangfor_case_detail 直接传该 id 看正文）` : '';
        return `[type=${x.type}] ${x.title}\n    ${x.crumbs || ''}\n    ${x.summary}${x.date ? `\n    ${x.date}` : ''}\n    ${x.link ?? ''}${caseHint}`;
      });
      return text(
        [
          `共 ${r.total} 条结果（第 ${page} 页）`,
          `类型分布：${r.typeAggs.map((t) => `type${t.id}×${t.count}`).join('  ')}`,
          `热门产品：${r.productAggs.map((p) => `${p.product_id}×${p.count}`).join('  ')}`,
          '',
          lines.join('\n\n'),
        ].join('\n')
      );
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- 10. 案例筛选 ----------
server.registerTool(
  'sangfor_case_filters',
  {
    title: '案例筛选条件',
    description: '列出排障案例的产品线树；传 product_line_id 时返回该产品下的案例模块与版本',
    inputSchema: { product_line_id: z.number().optional().describe('产品线 ID（不传则列出产品线树）') },
  },
  async ({ product_line_id }) => {
    try {
      if (!product_line_id) {
        const { flat } = await cases.productLines();
        return text(flat.map((x) => `product_line_id=${x.id}  ${x.name}  [${x.path}]`).join('\n'));
      }
      const [mods, vers] = await Promise.all([cases.modules(product_line_id), cases.versions(product_line_id)]);
      const modLines = mods.map((m) => `  module_id=${m.id}  ${m.name}`);
      const verLines = vers.map((v) => `  ${v.id ?? ''}  ${v.name}`);
      return text(
        [
          '模块（module_id）：',
          modLines.length ? modLines.join('\n') : '  （无）',
          '',
          '版本：',
          verLines.length ? verLines.join('\n') : '  （无）',
        ].join('\n')
      );
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- 11. 案例搜索 ----------
server.registerTool(
  'sangfor_case_search',
  {
    title: '排障案例搜索',
    description:
      '按关键词搜排障案例（无需登录），可按产品线/模块/版本过滤；第一页即相关度排序，标题含关键词的案例通常在前列；拿 id 后用 sangfor_case_detail 看正文。命中不理想时用 sangfor_search 全站搜索（案例结果会直接给出案例 id）',
    inputSchema: {
      keyword: z.string().describe('关键词'),
      product_line_id: z.number().optional().describe('产品线 ID'),
      module_id: z.number().optional().describe('模块 ID'),
      version: z.string().optional().describe('版本（version_id，来自 sangfor_case_filters 的版本列表）'),
      page: z.number().default(1),
      page_size: z.number().default(10),
    },
  },
  async ({ keyword, product_line_id, module_id, version, page, page_size }) => {
    try {
      const r = await cases.search({ keyword, product_line_id, module_id, version, page, page_size });
      if (!r.items.length) return text('（无匹配案例）可尝试去掉过滤条件、换关键词，或先 sangfor_case_filters 看产品线。');
      const lines = r.items.map((x) => [
        `id=${x.id}  ${x.title}`,
        `    模块:${x.module || '-'}  产品:${x.product || '-'}  ${x.date ?? ''}`,
        x.summary ? `    ${x.summary}` : '',
      ].filter(Boolean).join('\n'));
      return text(`共 ${r.total} 条（第 ${page} 页）\n\n` + lines.join('\n\n') + '\n\n看正文：sangfor_case_detail 传 id。');
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- 12. 案例详情 ----------
server.registerTool(
  'sangfor_case_detail',
  { title: '案例详情', description: '读取一个排障案例的完整正文（HTML 已转纯文本）', inputSchema: { case_id: z.union([z.number(), z.string()]).describe('案例 id') } },
  async ({ case_id }) => {
    try {
      const d = await cases.detail(case_id);
      return text(
        [`标题：${d.title}`, `模块：${d.module || '-'}`, '', d.content || '（正文为空，原始数据可能结构不同）'].join('\n')
      );
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- 13. 关联下载发现 ----------
server.registerTool(
  'sangfor_related',
  {
    title: '关联下载发现',
    description:
      '给定产品 + 基础包版本关键词（如 "6.12.0"），或 latest=true 自动定位该产品最新版本。返回：基础包候选、同版本补丁候选（名称启发式，须配套表核对）、相关工具、升级手册/版本配套表文档链接。需要登录。',
    inputSchema: {
      product_id: z.number().describe('产品 ID'),
      base_keyword: z.string().optional().describe('基础包版本关键词，如 6.12.0、5.9.8'),
      latest: z.boolean().optional().describe('true=不看 base_keyword，自动取版本号最新的基础包'),
    },
  },
  async ({ product_id, base_keyword, latest }) => {
    try {
      const r = await software.related({ product_id, base_keyword, latest });
      const fmtPkgs = (list) =>
        list.map((x) => `  id=${x.id}  ${x.name}  (${fmtSize(x.size) ?? '?'}, ${x.time ?? '?'}, MD5:${x.md5 ?? '-'})`).join('\n');
      const fmtDocs = (list) => list.map((d) => `  [type=${d.type}] ${d.title}\n    ${d.link ?? ''}`).join('\n');
      return text(
        [
          `产品：${r.product}（product_id=${r.product_id}）  识别版本：${r.version ?? '?'}（族 ${r.family ?? '?'}）`,
          '',
          `■ 基础包（${r.base.length}）：`,
          fmtPkgs(r.base) || '  （无）',
          '',
          `■ 补丁候选（${r.patches.length}）⚠ 名称启发式，下载前用配套表核对：`,
          fmtPkgs(r.patches) || '  （无）',
          '',
          `■ 相关工具（${r.tools.length}）：`,
          fmtPkgs(r.tools) || '  （无）',
          '',
          `■ 手册/配套表文档（${r.docs.length}）：`,
          fmtDocs(r.docs) || '  （无）',
          '',
          r.note ?? '下一步：sangfor_doc_read 读配套表核对补丁版本 → sangfor_software_download 逐个下载 → sangfor_doc_read 保存升级手册。',
        ].join('\n')
      );
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- 14. 文档阅读 ----------
server.registerTool(
  'sangfor_doc_read',
  {
    title: '读文档',
    description:
      '读取产品文档中心一篇文档的正文（SSR 提取，无需登录）。传 doc_url 或 product_id+version_id+category_id 三元组。save_dir 给定时同时保存为 Markdown 文件（升级手册落盘用）。',
    inputSchema: {
      doc_url: z.string().optional().describe('文档页 URL（sangfor_search 结果里的链接）'),
      product_id: z.number().optional(),
      version_id: z.number().optional(),
      category_id: z.number().optional(),
      save_dir: z.string().optional().describe('保存目录；给定时把正文存成 <标题>.md'),
    },
  },
  async ({ doc_url, product_id, version_id, category_id, save_dir }) => {
    try {
      if (!doc_url && !product_id) return text('❌ 需要 doc_url 或 product_id（+version_id/category_id）');
      const d = await docs.readDoc({ url: doc_url, product_id, version_id, category_id });
      if (d.empty) return text(`❌ 没取到正文：${d.title}（${d.url}）\n该页面可能是目录节点，用 sangfor_search 换具体文档试试。`);
      let saved = '';
      if (save_dir) {
        fs.mkdirSync(save_dir, { recursive: true });
        const safe = (d.title || '文档').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
        const file = `${save_dir}\\${safe}.md`;
        fs.writeFileSync(
          file,
          [`# ${d.title}`, ``, `- 产品：${d.product}`, `- 来源：${d.url}`, ``, d.text].join('\n'),
          'utf8'
        );
        saved = `\n已保存：${file}`;
      }
      return text([`# ${d.title}`, `产品：${d.product}`, `来源：${d.url}`, '', d.text].join('\n') + saved);
    } catch (e) {
      return fail(e);
    }
  }
);

// ---------- 15. 版本生命周期 ----------
server.registerTool(
  'sangfor_lifecycle',
  {
    title: '版本生命周期查询',
    description:
      '查深信服产品的版本生命周期：action=products 列产品线；action=versions 列某产品全部版本（带 STS/LTS 与 version_id）；action=eos 查版本的 GA/EOS 停服日期（版本是否快停服，交付前必看）。无需登录。',
    inputSchema: {
      action: z.enum(['products', 'versions', 'eos']).describe('products=产品线 / versions=产品版本列表 / eos=版本GA与停服日期'),
      product_id: z.number().optional().describe('生命周期产品 ID（products 里查，注意与软件下载 product_id 不同体系）'),
      name: z.string().optional().describe('产品名（products 里的 name，如 超融合）'),
      code: z.string().optional().describe('产品代码（products 里的 code，如 HCI）'),
      version_id: z.number().optional().describe('版本 ID（versions 里查）'),
      version_name: z.string().optional().describe('版本名关键词（eos 时可替代 version_id，如 6.12.0，跨产品匹配）'),
    },
  },
  async ({ action, product_id, name, code, version_id, version_name }) => {
    try {
      if (action === 'products') {
        const list = await lifecycle.products();
        return text(
          list
            .map((p) => `id=${p.id}  code=${p.code}  ${p.product_name}  [${p.category}]${p.status !== 'active' ? '  (' + p.status + ')' : ''}`)
            .join('\n')
        );
      }
      if (action === 'versions') {
        if (!product_id) return text('❌ 需要 product_id（action=products 里查）');
        const vs = await lifecycle.versionsOf({ product_id, name, code });
        return text(
          vs.map((v) => `version_id=${v.version_id}  ${v.version_name}  (${v.version_type ?? '?'})`).join('\n') || '（无版本）'
        );
      }
      // eos
      if (version_id != null && product_id != null) {
        const rows = await lifecycle.versionEol({ product_id, name, code, version_id });
        return fmtEol(rows);
      }
      if (version_name) {
        const cands = await lifecycle.findVersions({ keyword: version_name });
        if (!cands.length) return text(`（没有版本名含「${version_name}」的记录）`);
        const out = [];
        for (const c of cands.slice(0, 12)) {
          const rows = await lifecycle.versionEol({ product_id: c.product_id, version_id: c.version_id });
          out.push(...rows.map((r) => ({ ...r, product_name: c.product_name })));
        }
        return fmtEol(out);
      }
      return text('❌ eos 需要 version_id+product_id，或 version_name 关键词');
    } catch (e) {
      return fail(e);
    }
  }
);

function fmtEol(rows) {
  if (!rows?.length) return text('（查无该版本的生命周期记录）');
  return text(
    rows
      .map(
        (r) =>
          `${r.name ?? r.version_name ?? ''}  [${r.product_code ?? ''}${r.product_name ? ' ' + r.product_name : ''}]  类型:${r.version_type ?? '?'}  GA:${r.ga_date ?? '?'}  EOS(停服):${r.eos_date ?? '?'}`
      )
      .join('\n') +
      '\n\n注：EOS 临近（<1 年）的版本交付时要主动提醒客户规划升级；LTS 优于 STS 适合长期维护场景。'
  );
}

// ---------- 启动 ----------
await auth.loadSession();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[sangfor-mcp] started, session=${fs.existsSync(SESSION_FILE) ? 'loaded' : 'none'}`);
