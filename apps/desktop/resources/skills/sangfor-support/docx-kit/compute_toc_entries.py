# 从渲染 PDF 反推每个标题的实际正文页码，输出 add_toc_placeholders.py --entries 所需 JSON
# 用法：python compute_toc_entries.py <docx> <pdf> <out.json>
import json, re, sys, zipfile

import fitz

docx_path, pdf_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

# 1) 按文档顺序提取 Heading1/Heading2 标题文本
z = zipfile.ZipFile(docx_path)
doc = z.read("word/document.xml").decode("utf-8")
headings = []
for pm in re.finditer(r"<w:p>(?:(?!</w:p>).)*?</w:p>", doc, re.S):
    p = pm.group(0)
    sm = re.search(r'<w:pStyle w:val="Heading([12])"/>', p)
    if not sm:
        continue
    text = "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", p))
    if text.strip():
        headings.append({"level": int(sm.group(1)), "text": text.strip()})
print(f"headings: {len(headings)}")

# 2) 在 PDF 中定位（标题在目录和正文各出现一次，取最后一次出现 = 正文位置）
pdf = fitz.open(pdf_path)
pages_text = [pdf[i].get_text() for i in range(len(pdf))]

def norm(s):
    return re.sub(r"\s+", "", s)

pages_norm = [norm(t) for t in pages_text]
entries = []
body_start = None
for h in headings:
    key = norm(h["text"])
    last = None
    for i, t in enumerate(pages_norm):
        if key in t:
            last = i
    if last is None:
        print("NOT FOUND:", h["text"])
        sys.exit(1)
    if h["text"].startswith("1. ") and body_start is None:
        body_start = last
    h["pdf_page"] = last

if body_start is None:
    print("body start not found")
    sys.exit(1)

for h in headings:
    h["page"] = str(h["pdf_page"] - body_start + 1)
    entries.append({"level": h["level"], "text": h["text"], "page": h["page"]})
    print(f'  L{h["level"]} {h["text"]}  -> p{h["page"]}')

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(entries, f, ensure_ascii=False)
print("wrote", out_path)
