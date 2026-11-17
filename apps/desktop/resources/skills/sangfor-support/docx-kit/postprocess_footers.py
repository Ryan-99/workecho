# 页码后处理：按节序给页脚 PAGE 域加显式格式开关（WPS 兼容），并移除空 pgNumType
# 节顺序：0=封面(无页脚) 1=目录(ROMAN) 2=正文(arabic)
import re, shutil, sys, zipfile, os

path = sys.argv[1]
tmp = path + ".tmp"

with zipfile.ZipFile(path, "r") as zin:
    names = zin.namelist()
    data = {n: zin.read(n) for n in names}

doc = data["word/document.xml"].decode("utf-8")
# 1) 移除空 pgNumType（封面节）
doc = doc.replace("<w:pgNumType/>", "")

# 2) 找出各节的 footerReference r:id（按 sectPr 出现顺序）
sect_prs = re.findall(r"<w:sectPr[ >].*?</w:sectPr>", doc, re.S)
footer_ids = []  # 每节的 default footer rId（可能为 None）
for sp in sect_prs:
    m = re.search(r'<w:footerReference w:type="default" r:id="(rId\d+)"', sp)
    footer_ids.append(m.group(1) if m else None)
print("sections:", len(sect_prs), "footer ids:", footer_ids)

rels = data["word/_rels/document.xml.rels"].decode("utf-8")
def rid_to_target(rid):
    if not rid:
        return None
    m = re.search(r'<Relationship Id="%s"[^>]*Target="([^"]+)"' % rid, rels)
    return ("word/" + m.group(1)) if m else None

# 节→格式：index 3 = 前置(ROMAN), index 4 = 正文(arabic)（0封面 1版权 2扫码 3前置 4正文）
fmt_by_index = {3: "ROMAN", 4: "arabic"}
for idx, rid in enumerate(footer_ids):
    fmt = fmt_by_index.get(idx)
    if not fmt or not rid:
        continue
    target = rid_to_target(rid)
    if not target or target not in data:
        print("skip", idx, rid, target)
        continue
    fx = data[target].decode("utf-8")
    fx2 = re.sub(
        r"(<w:instrText[^>]*>)\s*PAGE\s*(</w:instrText>)",
        r"\1 PAGE \\* %s \\* MERGEFORMAT \2" % fmt,
        fx,
    )
    if fx2 != fx:
        data[target] = fx2.encode("utf-8")
        print("patched", target, "->", fmt)
    else:
        print("no PAGE field found in", target)

data["word/document.xml"] = doc.encode("utf-8")

with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for n in names:
        zout.writestr(n, data[n])
shutil.move(tmp, path)
print("done")
