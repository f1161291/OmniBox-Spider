# -*- coding: utf-8 -*-
# @name 6v电影
# @version 1.1.2

"""
6v电影 xb6v.com —— OmniBox Python 爬虫源

数据源: https://www.xb6v.com/ (新版6v电影/旧版66影视, 免费电影下载, UTF-8)
类型: 高清电影下载站 —— 详情提供 百度网盘分享链接，通过网盘 SDK 展开播放。
线路: 仅保留百度云盘，默认直连播放。

分类:
  /xijupian/喜剧 /dongzuopian/动作 /aiqingpian/爱情 /kehuanpian/科幻
  /kongbupian/恐怖 /juqingpian/剧情 /zhanzhengpian/战争 /jilupian/纪录
  /donghuapian/动画 /ZongYi/综艺 /dianshiju/(guoju国剧|duanju短剧|rihanju日韩|oumeiju欧美)
列表:
  /dongzuopian/ 第一页; /dongzuopian/index_2.html 第N页
详情:
  /dongzuopian/29637.html
搜索:
  POST /e/search/so.php

环境变量:
  SIXV_HOST           自定义镜像站，默认 https://www.xb6v.com
  DRIVE_ROUTE_TYPES   百度云盘线路，默认 直连；可配 直连,服务端代理
"""

import json
import os
import re
from urllib.parse import urlencode, urlparse

from spider_runner import OmniBox, run

HOST = "https://www.xb6v.com"
SITE_HOST = (os.environ.get("SIXV_HOST") or HOST).rstrip("/")

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

TOPS = [
    ("xijupian", "喜剧片"),
    ("dongzuopian", "动作片"),
    ("aiqingpian", "爱情片"),
    ("kehuanpian", "科幻片"),
    ("kongbupian", "恐怖片"),
    ("juqingpian", "剧情片"),
    ("zhanzhengpian", "战争片"),
    ("jilupian", "纪录片"),
    ("donghuapian", "动画片"),
    ("dianshiju", "电视剧"),
    ("ZongYi", "综艺"),
]

SUB = {
    "dianshiju": [
        ("guoju", "国产剧"),
        ("duanju", "短剧"),
        ("rihanju", "日韩剧"),
        ("oumeiju", "欧美剧"),
    ],
}

VIDEO_EXTS = (
    ".mp4",
    ".mkv",
    ".avi",
    ".rmvb",
    ".rm",
    ".wmv",
    ".flv",
    ".mov",
    ".m4v",
    ".ts",
    ".webm",
    ".mpg",
    ".mpeg",
    ".m2ts",
    ".iso",
)

VALID_ROUTE_TYPES = ("直连", "本地代理", "服务端代理")

DRIVE_PRIORITY = {"baidu": 0}


async def fetch(url, post=None):
    headers = {
        "User-Agent": UA,
        "Referer": SITE_HOST + "/",
        "Accept-Encoding": "identity",
    }
    options = {"method": "GET", "headers": headers}
    if post is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        options["method"] = "POST"
        options["body"] = urlencode(post)

    try:
        await OmniBox.log("info", "[fetch] %s %s" % (options["method"], url))
        res = await OmniBox.request(url, options)
    except Exception as exc:
        await OmniBox.log("error", "[fetch] 请求异常: %s, %s" % (url, exc))
        return ""

    if not isinstance(res, dict):
        await OmniBox.log("error", "[fetch] 返回结构异常: %s" % url)
        return ""

    status = res.get("statusCode")
    body = res.get("body") or ""
    if status != 200:
        await OmniBox.log("error", "[fetch] HTTP %s: %s" % (status, url))
        return ""

    if isinstance(body, bytes):
        try:
            body = body.decode("utf-8")
        except Exception:
            body = body.decode("gbk", "ignore")
    return body


def normalize_url(video_id):
    vid = str(video_id or "").strip()
    if vid.startswith("http://") or vid.startswith("https://"):
        return vid
    return SITE_HOST + (vid if vid.startswith("/") else "/" + vid)


def build_filters():
    filters = {}
    for top, _name in TOPS:
        if top not in SUB:
            continue
        values = [{"name": "全部", "value": ""}]
        values.extend(
            {"name": name, "value": "/%s/%s" % (top, sub)}
            for sub, name in SUB[top]
        )
        filters[top] = [
            {
                "key": "class",
                "name": "子分类",
                "init": "",
                "value": values,
            }
        ]
    return filters


def clean_text(text):
    text = re.sub(r"<[^>]+>", "", text or "")
    text = (
        text.replace("&amp;", "&")
        .replace("&nbsp;", " ")
        .replace("&hellip;", "…")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&ldquo;", "“")
        .replace("&rdquo;", "”")
    )
    return re.sub(r"\s+", " ", text).strip()


def parse_cards(html):
    out = []
    seen = set()
    pattern = (
        r'<a[^>]*href="(/[^"]*?/[^"]*?\d+\.html)"[^>]*title="([^"]+)"[^>]*>'
        r"[\s\S]{0,300}?<img[^>]*src=\"([^\"]+)\""
    )
    for m in re.finditer(pattern, html or ""):
        href = m.group(1)
        title = clean_text(m.group(2))
        pic = m.group(3) or ""
        if not href or not title or href in seen:
            continue
        seen.add(href)
        out.append(
            {
                "vod_id": href,
                "vod_name": title,
                "vod_pic": pic,
                "vod_remarks": "",
            }
        )
    return out


def parse_page_count(html, page, has_cards):
    if not has_cards:
        return 0
    m = re.search(r"共\s*(\d+)\s*页", html or "")
    if m:
        return max(int(m.group(1)), page)
    nums = [int(n) for n in re.findall(r"index_(\d+)\.html", html or "")]
    if nums:
        return max(max(nums), page)
    return page


def pick_field(html, label):
    pattern = (
        r"◎\s*"
        + r"\s*".join(re.escape(ch) for ch in label)
        + r"[：:]\s*([^\n<◎]{1,120})"
    )
    m = re.search(pattern, html or "")
    return m.group(1).strip().replace("&middot;", "·") if m else ""


def pick_content(html):
    m = re.search(r"◎\s*简\s*介", html or "")
    if not m:
        return ""
    tail = html[m.end():]
    stop = len(tail)
    for pattern in (r"<hr", r"【下载地址】", r"◎"):
        mm = re.search(pattern, tail)
        if mm:
            stop = min(stop, mm.start())
    text = tail[:stop]
    text = text.replace("&hellip;", "…")
    return clean_text(text)[:1200]


def pick_pic(html):
    for m in re.finditer(
        r'<img[^>]+(?:data-original|data-src|src)=["\']([^"\']+)', html or ""
    ):
        url = (m.group(1) or "").strip()
        low = url.lower()
        if not url or "logo" in low or "/skin/" in low or "placeholder" in low:
            continue
        return url.replace("&amp;", "&")
    return ""


def drive_kind(url):
    return "baidu" if "pan.baidu.com" in (url or "").lower() else ""


def pan_line_name(url):
    return "百度云盘" if drive_kind(url) == "baidu" else ""


def normalize_share_url(share_url):
    raw = str(share_url or "").strip()
    if not raw:
        return ""
    if "pan.baidu.com" in raw:
        m = re.search(r"/s/([^/?#]+)", raw)
        pm = re.search(r"[?&](?:pwd|password|passwd)=([^&#]+)", raw)
        pwd = pm.group(1) if pm else ""
        if m:
            base = "https://pan.baidu.com/s/%s" % m.group(1)
            return base + ("?pwd=%s" % pwd if pwd else "")
    return raw


def extract_links(html):
    text = (html or "").replace("&amp;", "&")
    links = []
    seen = set()

    def push(url):
        url = url.strip().rstrip(".,;)]}，。；）】")
        if url and url not in seen:
            seen.add(url)
            links.append(url)

    for m in re.finditer(r'https?://pan\.baidu\.com/[^"\'<\s]*', text, re.I):
        push(m.group(0))
    return links


def file_id_of(item):
    if not isinstance(item, dict):
        return ""
    return str(
        item.get("fid")
        or item.get("file_id")
        or item.get("id")
        or item.get("fileId")
        or ""
    ).strip()


def file_name_of(item):
    if not isinstance(item, dict):
        return ""
    return str(
        item.get("file_name")
        or item.get("name")
        or item.get("title")
        or item.get("filename")
        or ""
    ).strip()


def is_folder(item):
    if not isinstance(item, dict):
        return False
    if item.get("is_dir") is True or item.get("is_folder") is True:
        return True
    if str(item.get("dir") or "") in ("1", "true", "True"):
        return True
    if str(item.get("type") or "").lower() in ("folder", "dir", "directory"):
        return True
    if str(item.get("category") or "").lower() in ("folder", "dir", "directory"):
        return True
    if str(item.get("file_category") or "").lower() in ("folder", "dir", "directory"):
        return True
    if str(item.get("kind") or "").lower() in ("folder", "dir", "directory"):
        return True
    if str(item.get("file_type") or "") == "0":
        return True
    return False


def looks_like_video(item):
    if not isinstance(item, dict):
        return False
    name = file_name_of(item).lower()
    if any(name.endswith(ext) for ext in VIDEO_EXTS):
        return True
    mime = str(item.get("mime_type") or item.get("mime") or item.get("mimetype") or "").lower()
    if mime.startswith("video/"):
        return True
    category = str(
        item.get("category")
        or item.get("file_category")
        or item.get("type")
        or item.get("kind")
        or ""
    ).lower()
    if category == "video":
        return True
    if str(item.get("file_type") or "") == "1":
        return True
    return False


def normalize_items(data):
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("items", "list", "files", "data", "result"):
            value = data.get(key)
            if isinstance(value, list):
                return value
            if isinstance(value, dict):
                for sub_key in ("items", "list", "files", "data", "result"):
                    sub_value = value.get(sub_key)
                    if isinstance(sub_value, list):
                        return sub_value
    return []


def build_drive_play_meta(share_url, file, route_type):
    return {
        "kind": "drive-file",
        "shareURL": share_url,
        "fid": file.get("fid"),
        "name": file.get("name") or "播放",
        "routeType": route_type,
    }


async def collect_drive_videos(share_url, folder_id="0", depth=0, limit=120):
    if depth > 2:
        return []

    share_url = normalize_share_url(share_url)
    tried_ids = [str(folder_id or "0")]
    if depth == 0:
        for extra in ("0", "root", ""):
            if extra not in tried_ids:
                tried_ids.append(extra)

    items = []
    for current_fid in tried_ids:
        try:
            raw = await OmniBox.getDriveFileList(share_url, current_fid)
        except Exception as exc:
            await OmniBox.log(
                "warn",
                "[drive-list] share=%s fid=%s err=%s" % (share_url, current_fid, exc),
            )
            continue
        items = normalize_items(raw)
        if items:
            break

    if not items:
        return []

    videos = []
    seen_file_ids = set()
    for item in items:
        if len(videos) >= limit:
            break
        if not isinstance(item, dict):
            continue
        fid = file_id_of(item)
        if is_folder(item) and fid:
            sub_videos = await collect_drive_videos(
                share_url, fid, depth + 1, max(0, limit - len(videos))
            )
            videos.extend(sub_videos)
            continue
        if looks_like_video(item) and fid:
            if fid in seen_file_ids:
                continue
            seen_file_ids.add(fid)
            videos.append(
                {
                    "fid": fid,
                    "name": file_name_of(item) or "文件%d" % (len(videos) + 1),
                    "size": item.get("size")
                    or item.get("file_size")
                    or item.get("obj_size")
                    or 0,
                }
            )
    return videos[:limit]


def is_private_host(hostname):
    host = str(hostname or "").lower()
    if not host:
        return False
    if host in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):
        return True
    if re.match(r"^(10\.|192\.168\.|169\.254\.)", host):
        return True
    if re.match(r"^172\.(1[6-9]|2\d|3[0-1])\.", host):
        return True
    if host.endswith((".local", ".lan", ".internal", ".intra")):
        return True
    if ":" in host:
        return host.startswith(("fc", "fd", "fe80"))
    return False


def can_use_server_proxy(context):
    flag = str(os.environ.get("EXTERNAL_SERVER_PROXY_ENABLED") or "").lower()
    if flag in ("1", "true", "yes", "on"):
        return True
    try:
        host = (urlparse(str((context or {}).get("baseURL") or "")).hostname or "").lower()
    except Exception:
        host = ""
    return is_private_host(host)


def get_route_types(context):
    raw = os.environ.get("DRIVE_ROUTE_TYPES") or "直连"
    requested = [item.strip() for item in raw.split(",") if item.strip()]
    requested = [item for item in requested if item in VALID_ROUTE_TYPES] or ["直连"]

    caller = str((context or {}).get("from") or "web").lower()
    allow_proxy = can_use_server_proxy(context)

    routes = []
    for route_type in requested:
        if route_type == "服务端代理" and not allow_proxy:
            continue
        if caller in ("web", "uz") and route_type == "本地代理":
            continue
        if caller == "emby" and route_type != "服务端代理":
            continue
        if route_type not in routes:
            routes.append(route_type)
    return routes or ["直连"]


def resolve_route_type(flag, context, meta):
    route_type = str((meta or {}).get("routeType") or "").strip()
    if route_type not in VALID_ROUTE_TYPES:
        flag_text = str(flag or "").strip()
        if flag_text in VALID_ROUTE_TYPES:
            route_type = flag_text
        elif "-" in flag_text:
            route_type = flag_text.rsplit("-", 1)[-1]

    if route_type not in VALID_ROUTE_TYPES:
        caller = str((context or {}).get("from") or "web").lower()
        if caller in ("web", "emby") and can_use_server_proxy(context):
            route_type = "服务端代理"
        else:
            route_type = "直连"

    return route_type


def normalize_play_urls(play_info, fallback_name):
    urls = []
    if not isinstance(play_info, dict):
        return urls

    for key in ("urls", "url"):
        raw = play_info.get(key)
        if isinstance(raw, str) and raw.strip():
            urls.append({"name": fallback_name or "播放", "url": raw.strip()})
        elif isinstance(raw, list):
            for item in raw:
                if isinstance(item, dict):
                    item_url = str(item.get("url") or "").strip()
                    if item_url:
                        urls.append(
                            {
                                "name": str(item.get("name") or fallback_name or "播放"),
                                "url": item_url,
                            }
                        )
                elif isinstance(item, str) and item.strip():
                    urls.append(
                        {"name": fallback_name or "播放", "url": item.strip()}
                    )

    deduped = []
    seen = set()
    for item in urls:
        url = item.get("url")
        if not url or url in seen:
            continue
        seen.add(url)
        deduped.append(item)
    return deduped


def resolve_category_path(category_id, filters):
    cid = str(category_id or "").strip().strip("/")
    raw = ""
    if isinstance(filters, dict):
        for key in ("class", "subclass", "sub"):
            value = filters.get(key)
            if isinstance(value, dict):
                value = value.get("value") or value.get("v")
            if value:
                raw = str(value)
                break

    if raw.startswith("/"):
        return raw.strip("/")
    raw = raw.strip("/")
    if not raw:
        return cid
    if "/" in raw:
        return raw
    return (cid + "/" + raw).strip("/") if cid else raw


async def home(params, context):
    try:
        from_val = (context or {}).get("from", "web")
        await OmniBox.log("info", "[home] from=%s" % from_val)

        html = await fetch(SITE_HOST + "/dongzuopian/")
        cards = parse_cards(html)[:24]
        await OmniBox.log("info", "[home] 返回数量=%d" % len(cards))

        return {
            "class": [{"type_id": tid, "type_name": name} for tid, name in TOPS],
            "list": cards,
            "filters": build_filters(),
        }
    except Exception as exc:
        await OmniBox.log("error", "[home] 失败: %s" % exc)
        return {"class": [], "list": [], "filters": {}}


async def category(params, context):
    params = params or {}
    try:
        category_id = params.get("categoryId") or params.get("category_id") or "xijupian"
        page = params.get("page") or 1
        try:
            page = max(int(page), 1)
        except (TypeError, ValueError):
            page = 1

        filters = params.get("filters") or params.get("extend") or params.get("ext") or {}
        path = resolve_category_path(category_id, filters)
        if not path:
            path = "xijupian"

        url = SITE_HOST + "/" + path + "/"
        if page > 1:
            url = SITE_HOST + "/" + path + "/index_%d.html" % page

        await OmniBox.log(
            "info",
            "[category] categoryId=%s, page=%d, filters=%s, url=%s"
            % (category_id, page, filters, url),
        )

        html = await fetch(url)
        cards = parse_cards(html)
        pagecount = parse_page_count(html, page, bool(cards))
        await OmniBox.log(
            "info", "[category] 返回数量=%d, pagecount=%d" % (len(cards), pagecount)
        )

        return {
            "page": page,
            "pagecount": pagecount,
            "total": 0,
            "list": cards,
        }
    except Exception as exc:
        await OmniBox.log("error", "[category] 失败: %s" % exc)
        return {"page": 1, "pagecount": 0, "total": 0, "list": []}


async def detail(params, context):
    params = params or {}
    try:
        video_id = (
            params.get("videoId")
            or params.get("video_id")
            or params.get("id")
            or ""
        )
        video_id = str(video_id).strip()
        if not video_id:
            return {"list": []}

        url = normalize_url(video_id)
        await OmniBox.log("info", "[detail] videoId=%s, url=%s" % (video_id, url))
        html = await fetch(url)
        if not html:
            return {"list": []}

        vod = {
            "vod_id": video_id if not video_id.startswith("http") else url,
            "vod_name": "",
            "vod_pic": "",
            "vod_year": "",
            "vod_actor": "",
            "vod_director": "",
            "vod_area": "",
            "type_name": "",
            "vod_content": "",
            "vod_remarks": "",
        }

        m = re.search(r"<title>([^<]*)", html)
        if m:
            vod["vod_name"] = re.split(r"[_\-|]", m.group(1))[0].strip()

        m = re.search(
            r'<meta[^>]+(?:property|name)=["\']og:image["\'][^>]+content=["\']([^"\']+)',
            html,
        )
        if not m:
            m = re.search(
                r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']og:image',
                html,
            )
        if m:
            vod["vod_pic"] = m.group(1).replace("&amp;", "&")
        else:
            vod["vod_pic"] = pick_pic(html)

        vod["vod_year"] = pick_field(html, "年代")
        vod["vod_area"] = pick_field(html, "产地")
        vod["type_name"] = pick_field(html, "类别")
        vod["vod_director"] = pick_field(html, "导演")
        vod["vod_actor"] = pick_field(html, "主演")
        vod["vod_content"] = pick_content(html)
        if vod["vod_area"]:
            vod["vod_remarks"] = vod["vod_area"]

        share_links = []
        for link in extract_links(html):
            link = normalize_share_url(link)
            if not link or drive_kind(link) not in DRIVE_PRIORITY:
                continue
            if link not in share_links:
                share_links.append(link)
        share_links.sort(key=lambda item: DRIVE_PRIORITY.get(drive_kind(item), 99))
        await OmniBox.log(
            "info",
            "[detail] 网盘分享数量=%d, 顺序=%s"
            % (
                len(share_links),
                " > ".join(pan_line_name(item) for item in share_links) or "无",
            ),
        )

        label_counts = {}
        for share_url in share_links:
            label = pan_line_name(share_url)
            label_counts[label] = label_counts.get(label, 0) + 1

        sources = []
        used_counts = {}
        for share_url in share_links:
            label = pan_line_name(share_url)
            used_counts[label] = used_counts.get(label, 0) + 1
            if label_counts.get(label, 0) > 1:
                source_name = "%s%d" % (label, used_counts[label])
            else:
                source_name = label

            videos = await collect_drive_videos(share_url, "0")
            await OmniBox.log(
                "info",
                "[detail] 解析网盘: %s, 文件数=%d" % (source_name, len(videos)),
            )
            if not videos:
                await OmniBox.log("warn", "[detail] 跳过空网盘线路: %s" % source_name)
                continue

            route_types = get_route_types(context)
            for route_type in route_types:
                episodes = []
                for idx, file in enumerate(videos, start=1):
                    meta = build_drive_play_meta(share_url, file, route_type)
                    episodes.append(
                        {
                            "name": file.get("name") or "文件%d" % idx,
                            "playId": json.dumps(meta, ensure_ascii=False),
                            "size": int(file.get("size") or 0),
                        }
                    )
                line_name = source_name
                if len(route_types) > 1:
                    line_name = "%s-%s" % (source_name, route_type)
                sources.append({"name": line_name, "episodes": episodes})

        if sources:
            vod["vod_play_sources"] = sources

        episode_count = sum(len(s.get("episodes") or []) for s in sources)
        await OmniBox.log(
            "info",
            "[detail] 完成: name=%s, sources=%d, episodes=%d"
            % (vod["vod_name"], len(sources), episode_count),
        )
        return {"list": [vod]}
    except Exception as exc:
        await OmniBox.log("error", "[detail] 失败: %s" % exc)
        return {"list": []}


async def search(params, context):
    params = params or {}
    try:
        keyword = str(params.get("keyword") or params.get("wd") or "").strip()
        page = params.get("page") or 1
        try:
            page = max(int(page), 1)
        except (TypeError, ValueError):
            page = 1

        if not keyword or page > 1:
            return {"page": 1, "pagecount": 0, "total": 0, "list": []}

        await OmniBox.log("info", "[search] keyword=%s, page=%d" % (keyword, page))
        html = await fetch(
            SITE_HOST + "/e/search/so.php",
            {
                "keyboard": keyword,
                "show": "title",
                "tempid": "1",
                "tbname": "",
                "mid": "1",
                "dopost": "1",
                "submit": "搜索",
            },
        )

        cards = parse_cards(html)
        if not cards:
            seen = set()
            for m in re.finditer(
                r'href="(/[^"]*?/[^"]*?\d+\.html)"[^>]*>\s*([^<]{2,60})', html or ""
            ):
                href = m.group(1)
                title = clean_text(m.group(2))
                if not href or not title or href in seen or "第" in title[:2]:
                    continue
                seen.add(href)
                cards.append(
                    {
                        "vod_id": href,
                        "vod_name": title,
                        "vod_pic": "",
                        "vod_remarks": "",
                    }
                )

        await OmniBox.log("info", "[search] 返回数量=%d" % len(cards))
        return {
            "page": 1,
            "pagecount": 1 if cards else 0,
            "total": len(cards),
            "list": cards,
        }
    except Exception as exc:
        await OmniBox.log("error", "[search] 失败: %s" % exc)
        return {"page": 1, "pagecount": 0, "total": 0, "list": []}


async def play(params, context):
    params = params or {}
    flag = params.get("flag") or "play"
    raw_play_id = params.get("playId") or params.get("play_id") or ""
    try:
        await OmniBox.log("info", "[play] flag=%s, playId=%s" % (flag, raw_play_id))

        if isinstance(raw_play_id, dict):
            meta = raw_play_id
        else:
            try:
                meta = json.loads(str(raw_play_id or ""))
            except Exception:
                meta = {}
        if not isinstance(meta, dict):
            meta = {}

        if str(meta.get("kind") or "") == "drive-file":
            share_url = normalize_share_url(str(meta.get("shareURL") or "").strip())
            fid = str(meta.get("fid") or "").strip()
            file_name = str(meta.get("name") or "播放")
            route_type = resolve_route_type(flag, context, meta)
            if not share_url or not fid:
                raise ValueError("drive-file 缺少 shareURL/fid")

            await OmniBox.log(
                "info",
                "[play] 网盘播放: share=%s, fid=%s, route=%s"
                % (share_url, fid, route_type),
            )
            play_info = await OmniBox.getDriveVideoPlayInfo(
                share_url, fid, route_type
            )
            urls = normalize_play_urls(play_info, file_name)
            if urls:
                return {
                    "urls": urls,
                    "flag": flag,
                    "header": (play_info or {}).get("header")
                    or (play_info or {}).get("headers")
                    or {},
                    "parse": int((play_info or {}).get("parse") or 0),
                    "danmaku": (play_info or {}).get("danmaku") or [],
                }

            await OmniBox.log(
                "warn", "[play] 网盘 SDK 未返回可播地址，回退分享页: %s" % share_url
            )
            return {
                "urls": [{"name": file_name, "url": share_url}],
                "flag": flag,
                "parse": 0,
            }

        text = str(raw_play_id or "").strip()
        if text.lower().startswith("magnet:"):
            await OmniBox.log("warn", "[play] 磁力播放已移除: %s" % text)
            return {"urls": [], "flag": flag, "parse": 0}

        await OmniBox.log("warn", "[play] 无法识别的 playId: %s" % text)
        return {"urls": [], "flag": flag, "parse": 0}
    except Exception as exc:
        await OmniBox.log("error", "[play] 失败: %s" % exc)
        return {"urls": [], "flag": flag, "parse": 0}


if __name__ == "__main__":
    run(
        {
            "home": home,
            "category": category,
            "detail": detail,
            "search": search,
            "play": play,
        }
    )
