# docx-kit：深信服风格测试方案/交付文档产出套件

配套 `SKILL.md` 第 13 节（场景 F）。参考实现（完整可跑样例）：`D:\Claude Code\Zcode\xdr-gpt-test\`（generate.js=客户版测试方案、generate_internal.js=内部实施手册）。

## 文件清单

| 文件 | 用途 |
|---|---|
| `tpl-media/logo-dual.png` | 封面双 logo（SANGFOR 深信服科技 \| 深信服智安全），官方模板提取，已裁白边 |
| `tpl-media/image4.png` | 封面底部蓝绿曲线（透明底，满幅 793x144px 放页面最底行） |
| `tpl-media/image5.png` | 微信扫码图（400x520，含"打开微信扫一扫"文案，官方模板原版） |
| `tpl-media/image6~10.png` | 符号说明表"图形"列官方图标条（危险/警告/小心/注意/说明，前四个 153x71，说明 137x80） |
| `fetch-attachment.mjs` | 下载支持站文档附件（须在 sangfor-mcp 目录内运行，复用其 lib 登录态）。用法：`node fetch-attachment.mjs <完整httpsURL> <保存路径>`，**URL 参数必须传完整 https:// 开头**（Git Bash 会把 /xxx 开头参数转成 Windows 路径） |
| `fix_toc_first_entry.py` | 剔除 docx-js TableOfContents 自带的空 PAGEREF 默认首条目（与注入占位重复） |
| `postprocess_footers.py` | 页码后处理：按节序给页脚 PAGE 域加 `\* ROMAN` / `\* arabic` 开关（WPS 兼容）+ 移除空 pgNumType。**节序变了要改脚本里 fmt_by_index** |
| `compute_toc_entries.py` | 两遍法目录页码：从渲染 PDF 反推每个标题实际正文页码，输出 `--entries` JSON |
| `extract_docx_text.py` | 提取 docx 全文为带样式标记的行（对比用户修改版用；已兼容 Word 重存的带属性标签） |

## 版式 token（取自官方《深信服全网行为管理AC测试方案》模板）

- 封面：白底、双 logo 左上（208x32px）、黑色加粗左对齐大标题（雅黑 26pt 两行）、版本信息块（标签加粗）、"深信服科技股份有限公司"、底部曲线（封面节 margin=0，16838 精确高双行表：内容行 14678 + 曲线行 2160）
- 页眉：左文档标题 | 右"密级：外部公开"（内部文档用"密级：内部资料"），底边框线
- 页脚：左"文档版本01（日期）" | 右页码；前置节罗马、正文节阿拉伯从 1 起
- 表格：0070C0 蓝底白字表头 + 细黑全框线；信息表用蓝标签列样式
- 正文：宋体 10.5pt（size 21）、1.5 倍行距（line 360）、首行缩进 420；标题雅黑加粗黑色、字面编号"1. / 1.1."；前置页（修订记录/符号说明/版权声明）标题不用 Heading 样式
- 章节骨架：封面 → 版权声明 → 扫码页 → 修订记录+符号说明+目录（罗马）→ 正文（阿拉伯）

## 生成管线（固定顺序）

```
node generate.js                                   # docx-js 生成（注意：中文弯引号一律 \u201c\u201d 转义；标题禁用 calcTitleLayout 自动断行，混排标题手工分行）
add_toc_placeholders.py doc.docx --auto            # 目录占位
fix_toc_first_entry.py doc.docx                    # 剔默认首条目
postprocess_footers.py doc.docx                    # 页码格式开关
soffice 转 PDF → compute_toc_entries.py            # 第一遍渲染，反推页码
node generate.js && add_toc_placeholders.py --entries "$(cat toc-entries.json)"   # 第二遍注入精确页码（经 subprocess 传，避免 shell 中文乱码）
+ fix_toc_first_entry + postprocess_footers
postcheck.py doc.docx                              # 质检（封面满幅曲线的 image-overflow 是已知误报：检查器按正文节边距算）
LibreOffice 渲染 PNG → visual-judge 子代理逐页验收  # 交付前视觉门禁
```

## 客户版 / 内部版双轨口径（2026-10-28 审定）

给客户的文档**不写**以下内容（进独立《内部实施手册》，同版式、密级=内部资料）：
1. 支持站来源与位置（product_id / category_id / version_id / 栏目路径）
2. 内部接口人姓名与获取渠道
3. 内部流程文档的办理引用（《安全GPT测试流程》、需求调研表名、部署SOP案例名、"取包篇"等）
4. 软件包明细（包名/大小/MD5/获取渠道）
5. 产线支持分责（走XDR产线/SIP产线）；对外措辞用"深信服远程支持"（不说"原厂支持"）
6. 内部案例摘录的集中排障速查表/附录索引

材料名称可作为测试依据被引用（如"按部署指导书执行""以测试策略指引样本包为准"），但不说在哪下载、找谁拿。

**修订已交付客户版时的操作纪律**：绝不重新生成覆盖；先 `cp` 备份，用 extract_docx_text.py 与原始版 diff（unified + opcode 两轮：先滤掉 Word 重存噪音——TOC 条目带页码后缀、Heading 样式 ID 变成数字），再对真实增删归类；悬空引用用 python-docx/lxml 修（注意 TOC 条目在 `w:sdt` 里且文本在 `w:hyperlink` 内，`paragraphs`/`.text` 都拿不到，必须 `body.iter(w:p)` + iter(w:t) 全文匹配；Word 重存后 Heading 样式 ID 是数字）。
