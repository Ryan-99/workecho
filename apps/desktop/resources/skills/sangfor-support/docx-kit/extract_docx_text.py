# 提取 docx 全文为带结构标记的行，便于逐段对比
# 用法：python extract_docx_text.py <docx> <out.txt>
import re, sys, zipfile

path, out = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(path)
doc = z.read("word/document.xml").decode("utf-8")

lines = []
for pm in re.finditer(r"<w:p\b[^>]*>(?:(?!</w:p>).)*?</w:p>|<w:p\b[^>]*/>", doc, re.S):
    p = pm.group(0)
    texts = re.findall(r"<w:t[^>]*>([^<]*)</w:t>", p)
    text = "".join(texts).strip()
    style = re.search(r'<w:pStyle w:val="([^"]+)"', p)
    has_img = "<w:drawing>" in p or "<w:pict>" in p
    if not text and not has_img:
        continue
    tag = style.group(1) if style else "p"
    if has_img:
        lines.append(f"[{tag}][图] {text}")
    else:
        lines.append(f"[{tag}] {text}")

with open(out, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
print("paragraph lines:", len(lines))
