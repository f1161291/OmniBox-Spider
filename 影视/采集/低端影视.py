# -*- coding: utf-8 -*-
# @name 低端影视
# @author 梦
# @description 影视站：https://ddys.io ，Python版，支持首页分类、分类列表、搜索、详情与播放
# @version 1.0.11
# @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/影视/采集/低端影视.py
# @dependencies requests,lxml

import concurrent.futures
import base64
import html
import json
import os
import re
from urllib.parse import quote

import requests
from lxml import etree
from spider_runner import OmniBox, run


# ==================== 配置区域开始 ====================
# 站点基础地址。
HOST = os.environ.get("DDYS_HOST", "https://ddys.io").rstrip("/")
# 默认请求头 UA。
UA = os.environ.get(
    "DDYS_UA",
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
)
# 分类页 / 搜索页默认翻页大小提示。
DEFAULT_LIMIT = max(1, int(os.environ.get("DDYS_DEFAULT_LIMIT", "20") or 20))
# 链接并发校验线程数。
PLAY_CHECK_MAX_WORKERS = max(1, int(os.environ.get("DDYS_PLAY_CHECK_MAX_WORKERS", "10") or 10))
# 链接校验超时（秒）。
PLAY_CHECK_TIMEOUT = max(1, int(os.environ.get("DDYS_PLAY_CHECK_TIMEOUT", "3") or 3))
# 命中的网盘类型才展开代理多线路。
DRIVE_TYPE_CONFIG = [item.lower() for item in str(os.environ.get("DRIVE_TYPE_CONFIG", "quark;uc")).replace(",", ";").split(";") if item.strip()]
# 网盘多线路名称配置。
SOURCE_NAMES_CONFIG = [item.strip() for item in str(os.environ.get("SOURCE_NAMES_CONFIG", "本地代理;服务端代理;直连")).replace(",", ";").split(";") if item.strip()]
# 是否强制允许服务端代理。
EXTERNAL_SERVER_PROXY_ENABLED = str(os.environ.get("EXTERNAL_SERVER_PROXY_ENABLED", "false")).lower() == "true"
# ==================== 配置区域结束 ====================

SITE_HEADERS = {
    "User-Agent": UA,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": f"{HOST}/",
}

SEARCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0",
    "Content-Type": "application/x-www-form-urlencoded",
    "DNT": "1",
    "Origin": HOST,
    "Referer": f"{HOST}/search",
    "Upgrade-Insecure-Requests": "1",
    "sec-ch-ua": '"Microsoft Edge";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

CLASS_LIST = [
    {"type_id": "movie", "type_name": "电影"},
    {"type_id": "series", "type_name": "电视剧"},
    {"type_id": "anime", "type_name": "动漫"},
    {"type_id": "variety", "type_name": "综艺"},
]

SITE_FILTERS = {
    item["type_id"]: [
        {
            "key": "area",
            "name": "地区",
            "value": [
                {"name": "全部", "value": ""},
                {"name": "大陆", "value": "大陆"},
                {"name": "香港", "value": "香港"},
                {"name": "台湾", "value": "台湾"},
                {"name": "美国", "value": "美国"},
                {"name": "韩国", "value": "韩国"},
                {"name": "日本", "value": "日本"},
                {"name": "英国", "value": "英国"},
                {"name": "法国", "value": "法国"},
                {"name": "泰国", "value": "泰国"},
                {"name": "印度", "value": "印度"},
                {"name": "其他", "value": "其他"},
            ],
        },
        {
            "key": "year",
            "name": "年份",
            "value": [
                {"name": "全部", "value": ""},
                {"name": "2025", "value": "2025"},
                {"name": "2024", "value": "2024"},
                {"name": "2023", "value": "2023"},
                {"name": "2022", "value": "2022"},
                {"name": "2021", "value": "2021"},
                {"name": "2020", "value": "2020"},
                {"name": "2019", "value": "2019"},
                {"name": "2018", "value": "2018"},
                {"name": "2017", "value": "2017"},
                {"name": "2016", "value": "2016"},
                {"name": "2015", "value": "2015"},
                {"name": "更早", "value": "2014"},
            ],
        },
        {
            "key": "sort",
            "name": "排序",
            "value": [
                {"name": "最新", "value": "time"},
                {"name": "最热", "value": "hits"},
                {"name": "评分", "value": "score"},
            ],
        },
    ]
    for item in CLASS_LIST
}


def safe_text(value):
    return str(value or "").strip()


async def log(level: str, message: str):
    try:
        await OmniBox.log(level, message)
    except Exception:
        pass


def abs_url(url: str) -> str:
    raw = safe_text(url)
    if not raw:
        return ""
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    if raw.startswith("//"):
        return f"https:{raw}"
    if raw.startswith("/"):
        return f"{HOST}{raw}"
    return f"{HOST}/{raw.lstrip('./')}"


async def request_text(url: str, method: str = "GET", data=None, referer: str = None, headers_override=None) -> str:
    headers = dict(SITE_HEADERS)
    headers["Referer"] = referer or f"{HOST}/"
    if headers_override:
        headers.update(headers_override)
    res = await OmniBox.request(
        url,
        {
            "method": method,
            "headers": headers,
            "body": data,
            "timeout": 20000,
        },
    )
    status = int(res.get("statusCode") or 0)
    body = res.get("body", "")
    text = body.decode("utf-8", "ignore") if isinstance(body, (bytes, bytearray)) else str(body or "")
    if status != 200:
        raise RuntimeError(f"HTTP {status} @ {url}")
    return text


def parse_html(text: str):
    return etree.HTML(text or "")


def extract_vod_id_from_href(href: str) -> str:
    raw = safe_text(href)
    m = re.search(r"/(?:movie|series|anime|variety)/(.*?)(?:\.html)?$", raw)
    return m.group(1) if m else ""


def extract_video_items(root):
    selectors = [
        '//div[contains(@class, "movie-card")]',
        '//article[contains(@class, "movie-card")]',
        '//div[contains(@class, "item")]',
        '//article[contains(@class, "item")]',
    ]
    for selector in selectors:
        items = root.xpath(selector)
        if items:
            return items
    return []


def extract_search_video_items(root):
    selectors = [
        '//div[contains(@class, "mb-12")]//div[contains(@class, "movie-card")]',
        '//main//div[contains(@class, "mb-12")]//a[contains(@href, "/movie/") or contains(@href, "/series/") or contains(@href, "/anime/") or contains(@href, "/variety/")]/ancestor::div[contains(@class, "movie-card")][1]',
    ]
    seen = set()
    out = []
    for selector in selectors:
        for item in root.xpath(selector):
            marker = etree.tostring(item, encoding="unicode") if item is not None else ""
            if marker and marker not in seen:
                seen.add(marker)
                out.append(item)
        if out:
            break
    return out


def build_video_card(item):
    title_elements = item.xpath('.//h3/a | .//h2/a | .//h4/a | .//a[contains(@class, "title")]')
    if not title_elements:
        return None
    title_element = title_elements[0]
    vod_name = safe_text("".join(title_element.xpath('.//text()')))
    href = safe_text(title_element.get("href", ""))
    vod_id = extract_vod_id_from_href(href)
    if not vod_name or not vod_id:
        return None

    vod_pic = ""
    pic_elements = item.xpath('.//img')
    if pic_elements:
        vod_pic = abs_url(pic_elements[0].get("src", "") or pic_elements[0].get("data-src", ""))

    remarks = safe_text("".join(item.xpath('.//div[contains(@class, "text-xs") and contains(@class, "mb-3")][1]//text()')))
    return {
        "vod_id": vod_id,
        "vod_name": vod_name,
        "vod_pic": vod_pic,
        "vod_remarks": remarks,
    }


def build_category_url(tid: str, page: int, extend: dict):
    base_type = "series" if tid == "tv" else tid
    url = f"{HOST}/{base_type}"
    ext = extend or {}

    if ext.get("sort") == "score":
        url = f"{HOST}/rating/{base_type}"
    elif ext.get("sort") in ("hot", "hits"):
        url = f"{HOST}/popular/{base_type}"

    if ext.get("genre"):
        url = f"{HOST}/{base_type}/genre/{quote(safe_text(ext.get('genre')))}"

    area = safe_text(ext.get("area"))
    if area:
        area_map = {
            "中国": "china",
            "大陆": "china",
            "香港": "china",
            "台湾": "china",
            "美国": "usa",
            "日本": "japan",
            "韩国": "korea",
            "英国": "uk",
            "法国": "france",
            "德国": "germany",
            "印度": "india",
            "意大利": "italy",
            "西班牙": "spain",
            "加拿大": "canada",
            "澳大利亚": "australia",
            "俄罗斯": "russia",
            "泰国": "thailand",
        }
        url = f"{HOST}/{base_type}/region/{area_map.get(area, area)}"

    year = safe_text(ext.get("year"))
    if year:
        url = f"{HOST}/{base_type}/year/{year}"

    if int(page) > 1:
        url += f"?page={page}"
    return url


def is_folder_item(item):
    return bool(item.get("isFolder") or item.get("dir") or item.get("folder") or item.get("type") == "folder" or item.get("category") == "folder")


def file_name_of(item):
    return safe_text(item.get("name") or item.get("file_name") or item.get("fileName") or item.get("title"))


def file_id_of(item):
    return safe_text(item.get("fileId") or item.get("fid") or item.get("id") or item.get("shareId"))


def is_video_file(item):
    name = file_name_of(item).lower()
    return bool(re.search(r"\.(mp4|mkv|avi|mov|wmv|flv|m4v|ts|m2ts|webm|mpg|mpeg)$", name)) or safe_text(item.get("mimeType")).startswith("video/")


async def get_drive_file_list(share_url: str, fid: str = "0"):
    return await OmniBox.getDriveFileList(share_url, fid)


async def collect_drive_videos(share_url: str, fid: str = "0", depth: int = 0, visited=None):
    if visited is None:
        visited = set()
    if depth > 3:
        return []
    key = f"{share_url}@@{fid}"
    if key in visited:
        return []
    visited.add(key)

    raw = await get_drive_file_list(share_url, fid)
    items = raw if isinstance(raw, list) else []
    if not items and isinstance(raw, dict):
        for k in ("items", "list", "files", "data", "result"):
            val = raw.get(k)
            if isinstance(val, list):
                items = val
                break
            if isinstance(val, dict):
                for sub_key in ("items", "list", "files"):
                    sub_val = val.get(sub_key)
                    if isinstance(sub_val, list):
                        items = sub_val
                        break
                if items:
                    break

    videos = []
    for item in items:
        if is_folder_item(item):
            child_id = file_id_of(item)
            if child_id:
                videos.extend(await collect_drive_videos(share_url, child_id, depth + 1, visited))
            continue
        if is_video_file(item):
            videos.append({
                "fid": file_id_of(item),
                "name": file_name_of(item),
                "size": int(item.get("size") or item.get("file_size") or item.get("obj_size") or 0),
            })
    return videos


def infer_drive_type(url: str) -> str:
    raw = safe_text(url).lower()
    if "pan.baidu.com" in raw or "baidu" in raw:
        return "baidu"
    if "pan.quark.cn" in raw or "quark" in raw:
        return "quark"
    if "drive.uc.cn" in raw or raw == "uc":
        return "uc"
    if "cloud.189.cn" in raw or "tianyi" in raw:
        return "tianyi"
    if "aliyundrive" in raw or "alipan" in raw or "aliyun" in raw or "ali" in raw:
        return "ali"
    if "pan.xunlei.com" in raw or "xunlei" in raw:
        return "xunlei"
    if "115.com" in raw:
        return "115"
    if "123pan" in raw or "123684" in raw or "123865" in raw or "123912" in raw:
        return "123pan"
    return "netdisk"


def build_drive_play_meta(share_url: str, file: dict) -> str:
    return base64.b64encode(
        json.dumps(
            {
                "kind": "drive",
                "share_url": share_url,
                "fid": safe_text(file.get("fid")),
                "name": safe_text(file.get("name")),
                "size": int(file.get("size") or 0),
            },
            ensure_ascii=False,
        ).encode("utf-8")
    ).decode("utf-8")


def decode_play_meta(raw: str):
    try:
        return json.loads(base64.b64decode(safe_text(raw)).decode("utf-8"))
    except Exception:
        return {}


def drive_display_name(drive_type: str) -> str:
    mapping = {
        "baidu": "百度",
        "quark": "夸克",
        "uc": "UC",
        "tianyi": "天翼",
        "ali": "阿里",
        "xunlei": "迅雷",
        "115": "115",
        "123pan": "123",
        "netdisk": "网盘",
    }
    return mapping.get(drive_type, "网盘")


def build_numbered_share_line_names(share_urls):
    counters = {}
    totals = {}
    typed = []
    for share_url in share_urls:
        drive_type = infer_drive_type(share_url)
        typed.append((share_url, drive_type))
        totals[drive_type] = totals.get(drive_type, 0) + 1

    result = {}
    for share_url, drive_type in typed:
        counters[drive_type] = counters.get(drive_type, 0) + 1
        base_name = drive_display_name(drive_type)
        if totals.get(drive_type, 0) > 1:
            result[share_url] = f"{base_name}{counters[drive_type]}"
        else:
            result[share_url] = base_name
    return result


def get_base_url_host(context=None) -> str:
    base_url = safe_text((context or {}).get("baseURL"))
    if not base_url:
        return ""
    m = re.match(r"^https?://([^/:?#]+)", base_url, re.I)
    return safe_text(m.group(1) if m else base_url).lower()


def is_private_host(hostname: str = "") -> bool:
    host = safe_text(hostname).lower()
    if not host:
        return False
    if host in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):
        return True
    if re.match(r"^(10\.|192\.168\.|169\.254\.)", host):
        return True
    if re.match(r"^172\.(1[6-9]|2\d|3[0-1])\.", host):
        return True
    if host.endswith(".local") or host.endswith(".lan") or host.endswith(".internal") or host.endswith(".intra"):
        return True
    if ":" in host:
        return host.startswith("fc") or host.startswith("fd") or host.startswith("fe80")
    return False


def can_use_server_proxy(context=None) -> bool:
    if EXTERNAL_SERVER_PROXY_ENABLED:
        return True
    return is_private_host(get_base_url_host(context or {}))


def resolve_route_types_for_drive(share_url: str, context=None):
    drive_type = infer_drive_type(share_url)
    if drive_type in DRIVE_TYPE_CONFIG:
        allow_server_proxy = can_use_server_proxy(context or {})
        route_types = list(SOURCE_NAMES_CONFIG) or ["直连"]
        caller_source = safe_text((context or {}).get("from")).lower()
        if caller_source == "web":
            route_types = [name for name in route_types if name != "本地代理"]
        elif caller_source == "emby":
            route_types = [name for name in route_types if name == "服务端代理"] if allow_server_proxy else [name for name in route_types if name != "服务端代理"]
        elif caller_source == "uz":
            route_types = [name for name in route_types if name != "本地代理"]
        if not allow_server_proxy:
            route_types = [name for name in route_types if name != "服务端代理"]
        return route_types or ["直连"]
    return ["直连"]


def normalize_drive_play_result(play_info, fallback_name: str = "播放"):
    if not isinstance(play_info, dict):
        return {"parse": 0, "url": "", "urls": [], "header": {}}

    header = play_info.get("header") or {}
    raw_url = play_info.get("url")
    raw_urls = play_info.get("urls")

    url_list = []
    if isinstance(raw_urls, list):
        url_list = raw_urls
    elif isinstance(raw_url, list):
        url_list = raw_url

    urls_result = []
    if isinstance(url_list, list):
        for idx, item in enumerate(url_list, start=1):
            if isinstance(item, str):
                urls_result.append({"name": f"播放{idx}", "url": item})
            elif isinstance(item, dict):
                candidate = safe_text(item.get("url") or item.get("src") or item.get("playUrl") or item.get("link") or item.get("file"))
                if candidate:
                    urls_result.append({
                        "name": safe_text(item.get("name") or item.get("label") or item.get("title") or f"播放{idx}"),
                        "url": candidate,
                    })

    if urls_result:
        return {
            "urls": urls_result,
            "flag": fallback_name,
            "header": header,
            "parse": 0,
            "danmaku": play_info.get("danmaku") or [],
        }

    final_url = safe_text(raw_url) if isinstance(raw_url, str) else ""
    if final_url:
        return {
            "urls": [{"name": fallback_name or "播放", "url": final_url}],
            "flag": fallback_name,
            "header": header,
            "parse": 0,
            "danmaku": play_info.get("danmaku") or [],
        }

    return {"parse": 0, "url": "", "urls": [], "header": header}


async def home(params=None, context=None):
    try:
        text = await request_text(f"{HOST}/")
        root = parse_html(text)
        items = extract_video_items(root)
        videos = []
        seen = set()
        for item in items:
            video = build_video_card(item)
            if not video or video["vod_id"] in seen:
                continue
            seen.add(video["vod_id"])
            videos.append(video)
        await log("info", f"[低端影视][home] count={len(videos)}")
        return {"class": CLASS_LIST, "filters": SITE_FILTERS, "list": videos[:24]}
    except Exception as e:
        await log("error", f"[低端影视][home] {e}")
        return {"class": CLASS_LIST, "filters": SITE_FILTERS, "list": []}


async def category(params, context):
    try:
        tid = safe_text(params.get("categoryId") or params.get("type_id") or "movie")
        page = max(1, int(params.get("page") or 1))
        extend = params.get("filters") or params.get("extend") or {}
        url = build_category_url(tid, page, extend)
        await log("info", f"[低端影视][category] tid={tid} page={page} url={url}")
        text = await request_text(url)
        root = parse_html(text)
        items = extract_video_items(root)
        videos = []
        seen = set()
        for item in items:
            video = build_video_card(item)
            if not video:
                continue
            if video["vod_id"] in seen:
                continue
            seen.add(video["vod_id"])
            videos.append(video)
        return {
            "page": page,
            "pagecount": page + 1 if videos else page,
            "limit": DEFAULT_LIMIT,
            "total": page * max(len(videos), 1),
            "list": videos,
        }
    except Exception as e:
        await log("error", f"[低端影视][category] {e}")
        return {"page": 1, "pagecount": 1, "limit": DEFAULT_LIMIT, "total": 0, "list": []}


async def search(params, context):
    try:
        keyword = safe_text(params.get("wd") or params.get("keyword"))
        page = max(1, int(params.get("page") or 1))
        if not keyword:
            return {"page": 1, "pagecount": 1, "limit": DEFAULT_LIMIT, "total": 0, "list": []}
        if page > 1:
            return {"page": page, "pagecount": 1, "limit": DEFAULT_LIMIT, "total": 0, "list": []}
        url = f"{HOST}/search"
        post_body = f"q={quote(keyword)}&type=all"
        await log("info", f"[低端影视][search] keyword={keyword}")
        text = await request_text(url, method="POST", data=post_body, referer=f"{HOST}/search", headers_override=SEARCH_HEADERS)
        root = parse_html(text)
        items = extract_search_video_items(root)
        videos = []
        seen = set()
        for item in items:
            video = build_video_card(item)
            if not video or video["vod_id"] in seen:
                continue
            seen.add(video["vod_id"])
            videos.append(video)
        return {"page": 1, "pagecount": 1, "limit": DEFAULT_LIMIT, "total": len(videos), "list": videos}
    except Exception as e:
        await log("error", f"[低端影视][search] {e}")
        return {"page": 1, "pagecount": 1, "limit": DEFAULT_LIMIT, "total": 0, "list": []}


def build_detail_urls(vod_id: str):
    return [
        f"{HOST}/play/{vod_id}.html",
        f"{HOST}/movie/{vod_id}",
        f"{HOST}/series/{vod_id}",
        f"{HOST}/anime/{vod_id}",
        f"{HOST}/variety/{vod_id}",
        f"{HOST}/v/{vod_id}.html",
    ]


def check_play_link(url: str, source_name: str, sub_name: str = "", is_sub_link: bool = False):
    try:
        r = requests.get(url, headers=SITE_HEADERS, timeout=PLAY_CHECK_TIMEOUT)
        if r.status_code == 200 and "#EXTM3U" in r.text:
            if is_sub_link:
                return f"{source_name} - {sub_name}${url}"
            return f"{source_name}${url}"
    except Exception:
        return None
    return None


async def detail(params, context):
    try:
        vod_id = safe_text(params.get("videoId") or params.get("vod_id") or params.get("id"))
        if not vod_id:
            return {"list": []}

        detail_text = ""
        detail_url = ""
        for url in build_detail_urls(vod_id):
            try:
                await log("info", f"[低端影视][detail] try={url}")
                detail_text = await request_text(url)
                detail_url = url
                if detail_text:
                    break
            except Exception:
                continue
        if not detail_text:
            return {"list": []}

        root = parse_html(detail_text)

        title_elements = root.xpath('//h1')
        vod_name = safe_text("".join(title_elements[0].xpath('.//text()')) if title_elements else vod_id)

        alias_text = safe_text(" ".join(root.xpath('//h1//span//text()')))
        if alias_text:
            vod_name = safe_text(vod_name.replace(alias_text, "")) or vod_name

        pic_elements = root.xpath('//img[contains(@src, "img.ddys.io") and contains(@class, "object-cover")][1]')
        vod_pic = abs_url(pic_elements[0].get("src", "")) if pic_elements else ""

        detail_meta = safe_text("".join(root.xpath('(//div[contains(@class, "text-xs") and contains(@class, "mb-3")])[1]//text()')))
        director = safe_text("".join(root.xpath('//span[contains(text(), "导演")]/following-sibling::span[1]//text()')))
        actor = safe_text("".join(root.xpath('//span[contains(text(), "主演")]/following-sibling::span[1]//text()')))
        content = safe_text(" ".join(root.xpath('//meta[@name="description"]/@content')))

        vod_play_from = []
        vod_play_url = []
        vod_play_sources = []

        # 在线播放线路：每个采集播放源单独成线路
        buttons = root.xpath('//button[contains(@onclick, "switchSource")]')
        if buttons:
            for i, button in enumerate(buttons, start=1):
                onclick = safe_text(button.get("onclick"))
                match = re.search(r'switchSource\s*\((\d+)\s*,\s*[\'\"]([^\'\"]+)[\'\"]', onclick)
                if not match:
                    continue
                source_id = safe_text(match.group(1))
                play_url = safe_text(match.group(2))
                if not play_url:
                    continue
                source_name = safe_text("".join(button.xpath('.//text()'))) or f"播放源 {i}"
                online_episodes = []
                if "#" in play_url and "$" in play_url:
                    for sub_link in play_url.split("#"):
                        if "$" not in sub_link:
                            continue
                        sub_name, sub_url = sub_link.split("$", 1)
                        sub_name = safe_text(sub_name)
                        sub_url = safe_text(sub_url)
                        if sub_name and sub_url:
                            online_episodes.append({"name": sub_name, "playId": sub_url})
                else:
                    online_episodes.append({"name": "播放", "playId": play_url})

                if online_episodes:
                    line_name = source_name if source_id else source_name
                    vod_play_from.append(line_name)
                    vod_play_url.append("#".join([f"{ep['name']}${ep['playId']}" for ep in online_episodes]))
                    vod_play_sources.append({"name": line_name, "episodes": online_episodes})

        # 网盘资源线路：每个分享链接单独成线路，并展开为集数
        download_buttons = root.xpath('//button[contains(@onclick, "trackAndOpenResource")]')
        if download_buttons:
            share_urls = []
            for button in download_buttons:
                onclick = safe_text(button.get("onclick"))
                b64_match = re.search(r"atob\('([^']+)'\)", onclick)
                if not b64_match:
                    b64_match = re.search(r'atob\("([^\"]+)"\)', onclick)
                if not b64_match:
                    continue
                try:
                    share_url = base64.b64decode(b64_match.group(1)).decode("utf-8")
                except Exception:
                    continue
                if share_url and share_url not in share_urls:
                    share_urls.append(share_url)

            share_name_map = build_numbered_share_line_names(share_urls)
            for share_url in share_urls:
                line_name = share_name_map.get(share_url) or "网盘"
                pan_episodes = []
                try:
                    videos = await collect_drive_videos(share_url, "0")
                    await log("info", f"[低端影视][detail] pan={line_name} videos={len(videos)}")
                    for i, file in enumerate(videos, start=1):
                        file_name = safe_text(file.get("name")) or f"文件{i}"
                        pan_episodes.append({"name": file_name, "playId": build_drive_play_meta(share_url, file)})
                except Exception as e:
                    await log("warn", f"[低端影视][detail] pan={line_name} err={e}")

                # 无法解析 / 无法展开的网盘不显示线路
                if not pan_episodes:
                    continue

                route_types = resolve_route_types_for_drive(share_url, context)
                for route_type in route_types:
                    display_name = line_name if len(route_types) == 1 else f"{line_name}-{route_type}"
                    route_episodes = []
                    for ep in pan_episodes:
                        meta = decode_play_meta(ep["playId"])
                        meta["route_type"] = route_type
                        route_episodes.append({
                            "name": ep["name"],
                            "playId": base64.b64encode(json.dumps(meta, ensure_ascii=False).encode("utf-8")).decode("utf-8"),
                        })
                    vod_play_from.append(display_name)
                    vod_play_url.append("#".join([f"{ep['name']}${ep['playId']}" for ep in route_episodes]))
                    vod_play_sources.append({"name": display_name, "episodes": route_episodes})

        if not vod_play_sources:
            iframe_elements = root.xpath('//iframe[@src]')
            if iframe_elements:
                iframe_episodes = []
                for iframe in iframe_elements:
                    iframe_src = abs_url(iframe.get("src", ""))
                    if iframe_src:
                        iframe_episodes.append({"name": "播放", "playId": iframe_src})
                if iframe_episodes:
                    vod_play_from.append("默认")
                    vod_play_url.append("#".join([f"{ep['name']}${ep['playId']}" for ep in iframe_episodes]))
                    vod_play_sources.append({"name": "默认", "episodes": iframe_episodes})

        item = {
            "vod_id": vod_id,
            "vod_name": vod_name,
            "vod_pic": vod_pic,
            "vod_year": "",
            "vod_area": "",
            "vod_actor": actor,
            "vod_director": director,
            "vod_content": content,
            "vod_play_sources": vod_play_sources,
            "vod_play_from": "|".join(vod_play_from) if vod_play_from else "默认",
            "vod_play_url": "|".join(vod_play_url) if vod_play_url else "",
            "vod_remarks": detail_meta,
        }
        return {"list": [item]}
    except Exception as e:
        await log("error", f"[低端影视][detail] {e}")
        return {"list": []}


async def play(params, context):
    try:
        raw_url = safe_text(params.get("playId") or params.get("id"))
        await log("info", f"[低端影视][play] {raw_url}")

        meta = decode_play_meta(raw_url)
        if meta.get("kind") == "drive":
            share_url = safe_text(meta.get("share_url"))
            fid = safe_text(meta.get("fid"))
            route_type = safe_text(meta.get("route_type")) or "直连"
            if not share_url or not fid:
                raise RuntimeError("网盘播放元数据不完整")
            await log("info", f"[低端影视][play][drive] share={share_url} fid={fid} route={route_type}")
            play_info = await OmniBox.getDriveVideoPlayInfo(share_url, fid, route_type)
            normalized = normalize_drive_play_result(play_info, safe_text(meta.get("name")) or "播放")
            await log("info", f"[低端影视][play][drive] out parse={normalized.get('parse')} urls={len(normalized.get('urls') or [])} header_keys={','.join(list((normalized.get('header') or {}).keys())[:10])}")
            return normalized

        play_header = {
            "User-Agent": UA,
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": f"{HOST}/",
            "Origin": HOST,
            "Connection": "keep-alive",
        }
        return {
            "parse": 0,
            "playUrl": "",
            "url": raw_url,
            "header": play_header,
            "urls": [{"name": "播放", "url": raw_url}],
        }
    except Exception as e:
        await log("error", f"[低端影视][play] {e}")
        return {"parse": 0, "playUrl": "", "url": "", "urls": [], "header": {}}


run(
    {
        "home": home,
        "category": category,
        "search": search,
        "detail": detail,
        "play": play,
    }
)
