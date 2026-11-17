# 删除 docx-js TableOfContents 域内自带的默认首条目（与注入的占位条目重复且无页码）
# 做法：把该段落里的 TOC 域 begin/instrText/separate 三个 run 移入下一个占位段落开头，整段删除
import re, shutil, sys, zipfile

path = sys.argv[1]
tmp = path + ".tmp"

with zipfile.ZipFile(path, "r") as zin:
    names = zin.namelist()
    data = {n: zin.read(n) for n in names}

doc = data["word/document.xml"].decode("utf-8")

# 定位包含 TOC instrText 的段落（docx-js 默认首条目段落）
m = re.search(
    r"<w:p>(?:(?!</w:p>).)*?<w:instrText[^>]*>\s*TOC[^<]*</w:instrText>(?:(?!</w:p>).)*?</w:p>",
    doc, re.S,
)
if not m:
    print("TOC first-entry paragraph not found; nothing to do")
    sys.exit(0)

para = m.group(0)
# 提取域三件套 runs
field_runs = re.findall(r"<w:r>(?:(?!</w:r>).)*?(?:<w:fldChar[^>]*/>|<w:instrText[^>]*>\s*TOC[^<]*</w:instrText>)(?:(?!</w:r>).)*?</w:r>", para, re.S)
if len(field_runs) < 3:
    print("unexpected structure, abort without change")
    sys.exit(1)

# 删除默认条目段落，把域三件套插入下一个段落（第一个占位条目）的 </w:pPr> 之后
before, after = doc[:m.start()], doc[m.end():]
nm = re.search(r"<w:p>(?:(?!</w:p>).)*?</w:pPr>", after, re.S)
if not nm:
    print("next paragraph not found, abort")
    sys.exit(1)
inject = "".join(field_runs[:3])
after = after[:nm.end()] + inject + after[nm.end():]
doc = before + after

data["word/document.xml"] = doc.encode("utf-8")
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for n in names:
        zout.writestr(n, data[n])
shutil.move(tmp, path)
print("TOC default first entry removed, field runs preserved")
