#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 omnibox-stdout-guard.js 注入到 OmniBox 宿主的每个 JS 爬虫源顶部。

问题：部分宿主版本 omnibox_sdk.log 会把日志以 JSON 字符串写入 stdout；
Go 宿主读 search/play 响应时先读到字符串，报
  json: cannot unmarshal string into Go value of type models.SpiderSearchResponse
本脚本在每个 spiders/*/index.js 最早位置注入 stdout 消毒层，把日志字符串
重定向到 stderr，完整对象/数组响应仍由 stdout 放行。

在 NAS / Docker 宿主机上以 root 执行（目录通常是 root:root 755）：

  # 1) 干跑，看会改哪些文件
  python3 inject-omnibox-stdout-guard.py /vol1/1000/docker/omnibox/data/spiders

  # 2) 实际应用（自动备份到 <spiders>/_stdout_guard_backup/）
  python3 inject-omnibox-stdout-guard.py /vol1/1000/docker/omnibox/data/spiders --apply

  # 3) 重启 OmniBox 容器
  docker restart <omnibox-container>

  # 4) 回滚
  python3 inject-omnibox-stdout-guard.py /vol1/1000/docker/omnibox/data/spiders --rollback

幂等：已含 __omniStdoutGuard 的文件跳过；--rollback 只恢复本工具生成的备份。
"""
import glob
import hashlib
import os
import re
import shutil
import sys

MARK = "__omniStdoutGuard"
BACKUP_DIR = "_stdout_guard_backup"


def guard_source(path=None):
    here = os.path.dirname(os.path.abspath(__file__))
    p = path or os.path.join(here, "omnibox-stdout-guard.js")
    with open(p, "r", encoding="utf-8") as f:
        return f.read().rstrip() + "\n"


def name_of(src, fallback):
    m = re.search(r"@name\s+([^\r\n]+)", src)
    return (m.group(1).strip()[:36] if m else fallback)


def js_files(root):
    out = []
    for f in sorted(glob.glob(os.path.join(root, "*", "index.js"))):
        if os.path.basename(os.path.dirname(f)).startswith("_"):
            continue
        try:
            with open(f, "r", encoding="utf-8", errors="replace") as fh:
                s = fh.read()
        except OSError:
            continue
        if re.search(r"require\(|module\.exports|runner\.run", s):
            out.append((f, s))
    return out


def inject(src, guard):
    # 插到第一处 require 之前的行首，保证 OmniBox SDK 加载前已劫持 stdout。
    m = re.search(r"^[ \t]*(?:(?:const|let|var)\s+[^\n]*require\(|[^\n]*=\s*require\(|require\()", src, re.M)
    pos = m.start() if m else 0
    line_start = src.rfind("\n", 0, pos) + 1
    return src[:line_start] + guard + "\n" + src[line_start:]


def main():
    args = sys.argv[1:]
    apply = "--apply" in args
    rollback = "--rollback" in args
    root = next((a for a in args if not a.startswith("--")), None)
    if not root or not os.path.isdir(root):
        print("用法: python3 inject-omnibox-stdout-guard.py <spiders-dir> [--apply|--rollback]")
        return 2
    guard = guard_source()
    backup_root = os.path.join(root, BACKUP_DIR)

    if rollback:
        if not os.path.isdir(backup_root):
            print("无备份目录:", backup_root)
            return 1
        n = 0
        for bak in sorted(glob.glob(os.path.join(backup_root, "*.js"))):
            rel = os.path.basename(bak)
            src_id = rel.split("__", 1)[0]
            target = os.path.join(root, src_id, "index.js")
            if os.path.isfile(target):
                shutil.copy2(bak, target)
                print("ROLLBACK", target)
                n += 1
        print("回滚文件数:", n)
        return 0

    files = js_files(root)
    todo = [(f, s) for f, s in files if MARK not in s]
    mode = "APPLY" if apply else "DRYRUN"
    print("%s: 总 JS 源=%d 待注入=%d 已含 guard=%d" % (mode, len(files), len(todo), len(files) - len(todo)))

    if apply:
        os.makedirs(backup_root, exist_ok=True)

    for f, s in todo:
        src_id = os.path.basename(os.path.dirname(f))
        print("  %-22s %-32s %s" % (src_id, name_of(s, "?"), f))
        if not apply:
            continue
        bak = os.path.join(backup_root, "%s__%s" % (src_id, hashlib.sha1(f.encode()).hexdigest()[:10] + ".js"))
        if not os.path.exists(bak):
            shutil.copy2(f, bak)
        with open(f, "w", encoding="utf-8") as fh:
            fh.write(inject(s, guard))

    if apply:
        print("已注入:", len(todo), "备份目录:", backup_root)
        print("下一步: docker restart <omnibox-container>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
