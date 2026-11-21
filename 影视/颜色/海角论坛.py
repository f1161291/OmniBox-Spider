# -*- coding: utf-8 -*-
# @name 海角社区
# @version 1.4.1
# @downloadURL https://gh-proxy.org/https://github.com/f1161291/OmniBox-Spider/raw/refs/heads/main/影视/颜色/海角论坛.py
# 域名策略：只用主域 + 内置域名池轮换，不再从发布页拉取域名；成功置顶、连续失败软隔离。

import asyncio
import base64
import ctypes
import hashlib
import ctypes.util
import html
import json
import math
import os
import re
import time
import urllib.request
from urllib.parse import quote, urljoin, urlsplit

from spider_runner import OmniBox, run

HOST = os.environ.get("HJSQN_HOST", "https://hjsqn.com").rstrip("/")

BACKUP_HOSTS = [
    "https://beside.bu5du.cc",
    "https://basic.bu5du.cc",
    "https://by.bu5du.cc",
    "https://066.bdpuodp.com",
]

# ---------------------------------------------------------------------------
# 域名池持久化（成功置顶 / 失败软隔离），与发布页无关：
#   active / hosts / dead 落 SDK 缓存，跨进程复用，避免死域名拖慢每轮请求。
# ---------------------------------------------------------------------------
_HOSTS_CACHE_KEY = "haijiao:py:hosts:v1"
# 单次请求硬超时（秒）：宿主 OmniBox.request 在网络卡住时会挂很久且无视自身超时，
# 这里用 asyncio.wait_for 兜底，保证能轮到域名切换。
_REQUEST_HARD_TIMEOUT = max(3.0, float(os.environ.get("HJSQN_REQUEST_TIMEOUT") or 12))


# 成功域置顶 / 失败软隔离（不使用发布页，域名只来自主域 + BACKUP_HOSTS + HJSQN_HOSTS）
_ACTIVE_HOST = ""
# 已判定失效的域名（连续失败 2 次），下次启动不再优先尝试
_DEAD_HOSTS = set()
_HOST_FAIL_COUNT = {}


HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/138.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "identity",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
}

CLASSES = [
    {"type_name": "全部更新", "type_id": "/"},
    {"type_name": "海角原创", "type_id": "/category/hjyc/"},
    {"type_name": "海角乱伦", "type_id": "/category/hjll/"},
    {"type_name": "海角吃瓜", "type_id": "/category/hjcg/"},
    {"type_name": "海角探花", "type_id": "/category/hjth/"},
    {"type_name": "海角网黄", "type_id": "/category/hjwh/"},
]


def _to_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _strip_tags(value):
    return re.sub(r"<[^>]+>", " ", value or "")


def _clean(value):
    return re.sub(r"\s+", " ", html.unescape(_strip_tags(str(value or "")))).strip()


def _attr(tag, name):
    match = re.search(
        r'\b%s\s*=\s*(["\'])(.*?)\1' % re.escape(name), tag or "", re.I | re.S
    )
    return match.group(2) if match else ""


def _post_id(value):
    match = re.search(r"/archives/(\d+)", str(value or ""))
    return match.group(1) if match else ""


def _json(value):
    try:
        return json.loads(html.unescape(str(value or "")))
    except Exception:
        return {}


def _clean_url(value, page_url):
    url = html.unescape(str(value or "")).replace("\\/", "/").strip()
    return urljoin(page_url, url) if url else ""


def _category_url(path, page):
    path = "/" + str(path or "/").strip("/") + "/"
    if page <= 1:
        return HOST + path
    return HOST + path + "page/%d/" % page


def _page_count(html_text, current):
    values = [current]
    for match in re.finditer(r'/page/(\d+)/?', html_text or ""):
        values.append(_to_int(match.group(1), current))
    return max(values)


COVER_HOLDER_PATH = "/themes/haijiao_sns/static/__base/images/holder.png"
MEDIA_KEY = b"f5d965df75336270"
MEDIA_IV = b"97b60394abc2fbe1"
_COVER_CACHE = {}
_COVER_SEM = None
_COVER_DISK_DIR = os.environ.get(
    "HJSQN_COVER_CACHE", "/tmp/hjsq_cover_cache"
)
_COVER_EVP = None
_COVER_EVP_FAILED = False


def _cover_mode():
    mode = str(os.environ.get("HJSQN_COVER_MODE") or "data").strip().lower()
    if os.environ.get("HJSQN_RAW_COVER") == "1":
        mode = "raw"
    return mode if mode in ("data", "placeholder", "raw", "off") else "data"


def _is_encrypted_image(url):
    path = urlsplit(str(url or "")).path or ""
    return "/upload_" in path or path.startswith("/hc")


def _normalize_image_url(url):
    parsed = urlsplit(str(url or ""))
    if not _is_encrypted_image(url):
        return url
    if (parsed.hostname or "").lower() == "xi.dzuxta.cn":
        return url
    query = ("?" + parsed.query) if parsed.query else ""
    return "https://xi.dzuxta.cn" + parsed.path + query


def _cover_url(url, base_url):
    mode = _cover_mode()
    if mode == "off":
        return ""
    if mode == "raw":
        return url
    if mode == "placeholder" and _is_encrypted_image(url):
        return _clean_url(COVER_HOLDER_PATH, base_url)
    return url


def _evp():
    global _COVER_EVP, _COVER_EVP_FAILED
    if _COVER_EVP is not None or _COVER_EVP_FAILED:
        return _COVER_EVP
    try:
        lib = ctypes.CDLL(ctypes.util.find_library("crypto") or "libcrypto.so")
        lib.EVP_CIPHER_CTX_new.restype = ctypes.c_void_p
        lib.EVP_aes_128_cbc.restype = ctypes.c_void_p
        lib.EVP_DecryptInit_ex.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
            ctypes.c_char_p, ctypes.c_char_p,
        ]
        lib.EVP_DecryptUpdate.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int),
            ctypes.c_char_p, ctypes.c_int,
        ]
        lib.EVP_DecryptFinal_ex.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int),
        ]
        lib.EVP_CIPHER_CTX_set_padding.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.EVP_CIPHER_CTX_free.argtypes = [ctypes.c_void_p]
        _COVER_EVP = lib
    except Exception:
        _COVER_EVP_FAILED = True
    return _COVER_EVP


def _aes_decrypt(data):
    lib = _evp()
    if lib is None:
        return None
    ctx = lib.EVP_CIPHER_CTX_new()
    if not ctx:
        return None
    try:
        if lib.EVP_DecryptInit_ex(
            ctx, lib.EVP_aes_128_cbc(), None, MEDIA_KEY, MEDIA_IV
        ) != 1:
            return None
        lib.EVP_CIPHER_CTX_set_padding(ctx, 0)
        out = ctypes.create_string_buffer(len(data) + 16)
        out_len = ctypes.c_int(0)
        final_len = ctypes.c_int(0)
        if lib.EVP_DecryptUpdate(
            ctx, out, ctypes.byref(out_len), data, len(data)
        ) != 1:
            return None
        if lib.EVP_DecryptFinal_ex(
            ctx, ctypes.byref(out, out_len.value), ctypes.byref(final_len)
        ) != 1:
            return None
        return out.raw[: out_len.value + final_len.value]
    finally:
        lib.EVP_CIPHER_CTX_free(ctx)


def _image_mime(data):
    if not data:
        return ""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return ""


def _fetch_image(url):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": HEADERS["User-Agent"],
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Accept-Language": HEADERS["Accept-Language"],
            "Accept-Encoding": "identity",
            "Referer": HOST + "/",
        },
    )
    last_error = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=25) as response:
                return response.read()
        except Exception as exc:
            last_error = exc
            if attempt == 0:
                time.sleep(0.6)
    raise last_error


def _cover_key(url):
    parsed = urlsplit(_normalize_image_url(url))
    return (parsed.hostname or "").lower() + (parsed.path or "")


def _cover_disk_path(key):
    name = hashlib.md5(key.encode("utf-8")).hexdigest() + ".txt"
    return os.path.join(_COVER_DISK_DIR, name)


def _decode_cover(url):
    key = _cover_key(url)
    if key in _COVER_CACHE:
        return _COVER_CACHE[key]
    if url in _COVER_CACHE:
        return _COVER_CACHE[url]
    disk_path = _cover_disk_path(key)
    try:
        with open(disk_path, "r", encoding="utf-8") as cache_file:
            cached = cache_file.read().strip()
        if cached.startswith("data:image/"):
            _COVER_CACHE[key] = cached
            return cached
    except Exception:
        pass
    candidates = [_normalize_image_url(url)]
    if candidates[0] != url:
        candidates.append(url)
    for candidate in candidates:
        try:
            raw = _fetch_image(candidate)
            mime = _image_mime(raw)
            if not mime:
                decrypted = _aes_decrypt(raw)
                mime = _image_mime(decrypted or b"")
                raw = decrypted or b""
            if not mime:
                continue
            result = "data:%s;base64,%s" % (
                mime, base64.b64encode(raw).decode("ascii")
            )
            _COVER_CACHE[key] = result
            _COVER_CACHE[url] = result
            _COVER_CACHE[candidate] = result
            try:
                os.makedirs(_COVER_DISK_DIR, exist_ok=True)
                with open(disk_path, "w", encoding="utf-8") as cache_file:
                    cache_file.write(result)
            except Exception:
                pass
            return result
        except Exception:
            continue
    return None


async def _cover_for(url, base_url):
    url = str(url or "").strip()
    if not url:
        return ""
    mode = _cover_mode()
    if mode != "data":
        return _cover_url(url, base_url)
    if not _is_encrypted_image(url):
        return url
    global _COVER_SEM
    if _COVER_SEM is None:
        _COVER_SEM = asyncio.Semaphore(3)
    async with _COVER_SEM:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _decode_cover, url)
    return result or _clean_url(COVER_HOLDER_PATH, base_url)


async def _fill_covers(videos, base_url):
    if not videos:
        return
    if _cover_mode() != "data":
        for item in videos:
            item["vod_pic"] = _cover_url(item.get("vod_pic"), base_url)
        return
    covers = await asyncio.gather(
        *[_cover_for(item.get("vod_pic"), base_url) for item in videos]
    )
    for item, cover in zip(videos, covers):
        item["vod_pic"] = cover


def _parse_cards(html_text, base_url=None):
    base_url = base_url or (HOST + "/")
    videos = []
    seen = set()
    blocks = re.split(
        r'(?=<div[^>]*\bclass="xqbj-list-rows(?:\s[^"]*)?")',
        html_text or "",
    )
    for block in blocks:
        anchor = re.search(
            r'<a\b[^>]*\bhref="([^"]*?/archives/\d+/?)"[^>]*>',
            block,
            re.I | re.S,
        )
        if not anchor:
            continue
        href = anchor.group(1)
        post_id = _post_id(href)
        if not post_id or post_id in seen:
            continue

        title = _clean(_attr(anchor.group(0), "title"))
        if not title:
            title_match = re.search(
                r'class="[^"]*xqbj-list-rows-image-title[^"]*"[^>]*>(.*?)</div>',
                block,
                re.I | re.S,
            )
            title = _clean(title_match.group(1)) if title_match else ""
        if not title:
            continue
        seen.add(post_id)

        image = re.search(
            r'<img\b[^>]*\bz-image-loader-url\s*=\s*(["\'])(.*?)\1',
            block,
            re.I | re.S,
        )
        pic = _clean_url(image.group(2), base_url) if image else ""

        category_match = re.search(
            r'<a\b[^>]*\bhref="(/category/[^"]*)"[^>]*>(.*?)</a>',
            block,
            re.I | re.S,
        )
        category = _clean(category_match.group(2)) if category_match else ""

        count_match = re.search(
            r'<div\b[^>]*class="[^"]*list-text-play[^"]*"[^>]*>(.*?)</div>',
            block,
            re.I | re.S,
        )
        count = _clean(count_match.group(1)) if count_match else ""

        date_match = re.search(
            r'<div\b[^>]*class="[^"]*is-desktop[^"]*"[^>]*>(.*?)</div>',
            block,
            re.I | re.S,
        )
        date = _clean(date_match.group(1)) if date_match else ""

        remark = category
        if count and count.isdigit():
            remark = ("%s · " % category if category else "") + count + "项"
        elif date:
            remark = ("%s · " % category if category else "") + date

        videos.append(
            {
                "vod_id": _clean_url(href, base_url),
                "vod_name": title,
                "vod_pic": pic,
                "vod_remarks": remark,
                "style": {"type": "rect", "ratio": 1.33},
            }
        )
    return videos


def _content_image_urls(html_text, page_url):
    start = (html_text or "").find("text text-content")
    scope = html_text[start:] if start >= 0 else (html_text or "")
    result = []
    for match in re.finditer(
        r'<img\b[^>]*\bz-image-loader-url\s*=\s*(["\'])(.*?)\1',
        scope,
        re.I | re.S,
    ):
        raw = match.group(2).strip().strip("`")
        absolute = _clean_url(raw, page_url)
        if not absolute or absolute in result:
            continue
        low = absolute.lower()
        if not low.startswith(("http://", "https://")):
            continue
        if any(
            item in low
            for item in ("default-avatar", "/logo", "/icon", "loading", "qrcode")
        ):
            continue
        result.append(absolute)
    return result


_HOSTS_CACHE_RESTORED = False


async def restore_hosts_cache():
    """从 SDK 缓存恢复 active / dead（成功置顶、失败软隔离），不拉取任何发布页。"""
    global _HOSTS_CACHE_RESTORED
    if _HOSTS_CACHE_RESTORED:
        return
    _HOSTS_CACHE_RESTORED = True
    try:
        saved = await OmniBox.getCache(_HOSTS_CACHE_KEY)
        if isinstance(saved, str):
            try:
                saved = json.loads(saved)
            except Exception:
                saved = None
        if isinstance(saved, dict):
            for d in (saved.get("dead") or []):
                if isinstance(d, str):
                    _DEAD_HOSTS.add(d.rstrip("/"))
            act = str(saved.get("active") or "").strip().rstrip("/")
            if act and act not in _DEAD_HOSTS:
                globals()["_ACTIVE_HOST"] = act
    except Exception:
        pass


def _site_hosts():
    """候选域名：上次成功域置顶、已判死的域软隔离剔除。域名只来自主域 + HJSQN_HOSTS + BACKUP_HOSTS，不再从发布页拉取。"""
    raw = [HOST]
    for item in str(os.environ.get("HJSQN_HOSTS") or "").split(","):
        item = item.strip().rstrip("/")
        if item and item not in raw:
            raw.append(item)
    for item in BACKUP_HOSTS:
        if item not in raw:
            raw.append(item)

    # 剔除判死的域（但如果全死光了，就保留全部，避免彻底不可用）
    alive = [h for h in raw if h not in _DEAD_HOSTS]
    if not alive:
        alive = raw
        _DEAD_HOSTS.clear()

    if _ACTIVE_HOST and _ACTIVE_HOST in alive:
        alive.remove(_ACTIVE_HOST)
        alive.insert(0, _ACTIVE_HOST)
    return alive


def _mark_host_ok(host):
    """域名可用：清零失败、设为当前域、并触发持久化。"""
    global _ACTIVE_HOST
    if not host:
        return
    _HOST_FAIL_COUNT[host] = 0
    _DEAD_HOSTS.discard(host)
    _ACTIVE_HOST = host
    _schedule_persist_hosts()


def _mark_host_dead(host, reason=""):
    """域名失败：连续 2 次判死并移出候选池。"""
    if not host:
        return
    n = _HOST_FAIL_COUNT.get(host, 0) + 1
    _HOST_FAIL_COUNT[host] = n
    if n >= 2 and host not in _DEAD_HOSTS:
        _DEAD_HOSTS.add(host)
        _PERSIST_DEAD[host] = str(reason or "")[:120]
        _schedule_persist_hosts()


_PERSIST_DEAD = {}
_PERSIST_TIMER = None


def _schedule_persist_hosts():
    """把 active / hosts / dead 落 SDK 缓存（去抖 0.5s）。"""
    global _PERSIST_TIMER
    if _PERSIST_TIMER is not None:
        return

    async def _flush():
        global _PERSIST_TIMER
        _PERSIST_TIMER = None
        try:
            await OmniBox.setCache(
                _HOSTS_CACHE_KEY,
                {
                    "at": time.time(),
                    "active": _ACTIVE_HOST or HOST,
                    "hosts": _site_hosts(),
                    "dead": sorted(_DEAD_HOSTS),
                },
                30 * 24 * 3600,
            )
        except Exception:
            pass

    try:
        loop = asyncio.get_event_loop()
        _PERSIST_TIMER = loop.call_later(0.5, lambda: asyncio.ensure_future(_flush()))
    except Exception:
        _PERSIST_TIMER = None


def _candidate_urls(url):
    hosts = _site_hosts()
    base = ""
    for host in hosts:
        if url == host or url.startswith(host + "/"):
            base = host
            break
    if not base and url.startswith("https://www.hjsqn.com"):
        base = "https://www.hjsqn.com"

    urls = []
    for host in hosts:
        candidate = host + url[len(base):] if base else url
        if candidate not in urls:
            urls.append(candidate)
    return urls


async def _request_ex(url, attempts=2):
    """遍历主域 + 内置域名池请求；全部失败时仅在池内重试，不再从发布页拉取。"""
    await restore_hosts_cache()
    last_error = None

    async def _try_all():
        nonlocal last_error
        for index, candidate in enumerate(_candidate_urls(url)):
            max_attempts = attempts if index == 0 else 1
            for attempt in range(1, max_attempts + 1):
                try:
                    await OmniBox.log(
                        "info",
                        "[hjsq][request] %s (try %d)" % (candidate, attempt),
                    )
                    res = await asyncio.wait_for(
                        OmniBox.request(candidate, {"method": "GET", "headers": HEADERS}),
                        timeout=_REQUEST_HARD_TIMEOUT,
                    )
                    if not isinstance(res, dict):
                        raise RuntimeError("返回结构异常")
                    if res.get("statusCode") != 200:
                        raise RuntimeError(
                            "HTTP %s: %s" % (res.get("statusCode"), candidate)
                        )
                    body = res.get("body", "")
                    if body:
                        parsed = urlsplit(candidate)
                        _mark_host_ok("%s://%s" % (parsed.scheme, parsed.netloc))
                        return body, candidate
                    raise RuntimeError("空响应")
                except Exception as exc:
                    last_error = exc
                    parsed_fail = urlsplit(candidate)
                    _mark_host_dead(
                        "%s://%s" % (parsed_fail.scheme, parsed_fail.netloc), exc
                    )
                    is_timeout = isinstance(exc, asyncio.TimeoutError)
                    await OmniBox.log(
                        "warn",
                        "[hjsq][request] %s(%s, 第%d次): %s"
                        % ("超时" if is_timeout else "失败", candidate, attempt,
                           "超过 %.0fs 未返回" % _REQUEST_HARD_TIMEOUT if is_timeout else exc),
                    )
                    if attempt < max_attempts:
                        await asyncio.sleep(float(attempt))
        return None

    hit = await _try_all()
    if hit:
        return hit

    # 所有已知域名都失败 → 不再从发布页拉取，仅在现有域名池内重试一次
    await OmniBox.log("warn", "[hjsq][request] 所有域名不可达，仅在内置域名池内重试一次（不再拉发布页）")
    hit = await _try_all()
    if hit:
        return hit
    raise RuntimeError("请求失败: %s" % last_error)


async def home(params, context):
    try:
        html_text, final_url = await _request_ex(HOST + "/")
        videos = _parse_cards(html_text, final_url)
        await _fill_covers(videos, final_url)
        await OmniBox.log("info", "[hjsq][home] count=%d" % len(videos))
        return {"class": CLASSES, "list": videos}
    except Exception as exc:
        await OmniBox.log("error", "[hjsq][home] %s" % exc)
        return {"class": CLASSES, "list": []}


async def category(params, context):
    params = params or {}
    page = max(1, _to_int(params.get("page"), 1))
    category_id = str(
        params.get("categoryId") or params.get("category_id") or "/"
    ).strip()
    try:
        url = _category_url(category_id, page)
        await OmniBox.log(
            "info",
            "[hjsq][category] categoryId=%s, page=%d, url=%s"
            % (category_id, page, url),
        )
        html_text, final_url = await _request_ex(url)
        videos = _parse_cards(html_text, final_url)
        await _fill_covers(videos, final_url)
        page_count = _page_count(html_text, page)
        await OmniBox.log(
            "info",
            "[hjsq][category] count=%d, pagecount=%d"
            % (len(videos), page_count),
        )
        return {
            "list": videos,
            "page": page,
            "pagecount": page_count,
            "limit": len(videos) or 20,
            "total": page_count * (len(videos) or 20),
        }
    except Exception as exc:
        await OmniBox.log("error", "[hjsq][category] %s" % exc)
        return {
            "list": [],
            "page": page,
            "pagecount": page,
            "limit": 20,
            "total": 0,
        }


async def detail(params, context):
    params = params or {}
    raw_id = str(params.get("videoId") or params.get("video_id") or "").strip()
    if not raw_id:
        return {"list": []}
    try:
        page_url = urljoin(HOST + "/", raw_id)
        await OmniBox.log("info", "[hjsq][detail] page_url=%s" % page_url)
        html_text, page_url = await _request_ex(page_url)
        await OmniBox.log("info", "[hjsq][detail] final_url=%s" % page_url)

        title_match = re.search(
            r'<h1\b[^>]*\bclass="[^"]*novel-title[^"]*"[^>]*>(.*?)</h1>',
            html_text,
            re.I | re.S,
        )
        if not title_match:
            title_match = re.search(
                r"<h1\b[^>]*>(.*?)</h1>", html_text, re.I | re.S
            )
        title = _clean(title_match.group(1)) if title_match else "海角帖子"

        configs = []
        for match in re.finditer(
            r'<div\b[^>]*\bdata-config\s*=\s*(["\'])(.*?)\1',
            html_text,
            re.I | re.S,
        ):
            if "dplayer" not in match.group(0).lower():
                continue
            config = _json(match.group(2))
            video = config.get("video") if isinstance(config, dict) else {}
            if isinstance(video, dict):
                configs.append(video)

        plays = []
        used_urls = set()
        total = len(configs)
        for index, video in enumerate(configs, start=1):
            h264 = _clean_url(video.get("url", ""), page_url)
            h265 = _clean_url(
                video.get("h_265") or video.get("h265") or "", page_url
            )
            await OmniBox.log(
                "info",
                "[hjsq][detail] player%d h264=%s h265=%s"
                % (index, h264[:80], h265[:80]),
            )
            if h264 and h264 not in used_urls:
                used_urls.add(h264)
                name = "视频%d H264" % index if total > 1 else "H264原画"
                plays.append({"name": name, "playId": h264})
            if h265 and h265 not in used_urls:
                used_urls.add(h265)
                name = "视频%d H265" % index if total > 1 else "H265原画"
                plays.append({"name": name, "playId": h265})

        await OmniBox.log("info", "[hjsq][detail] video_plays=%d" % len(plays))
        if not plays:
            return {"list": []}

        desc_match = re.search(
            r'<div\b[^>]*\bclass="[^"]*detail-info-desc[^"]*"[^>]*>(.*?)</div>',
            html_text,
            re.I | re.S,
        )
        desc = desc_match.group(1) if desc_match else ""
        category_match = re.search(
            r'<a\b[^>]*\bhref="(/category/[^"]*)"[^>]*>(.*?)</a>',
            desc,
            re.I | re.S,
        )
        category = _clean(category_match.group(2)) if category_match else ""

        author = ""
        novel_index = html_text.find("novel-info")
        if novel_index >= 0:
            author_match = re.search(
                r"<h2\b[^>]*>(.*?)</h2>",
                html_text[novel_index:novel_index + 4000],
                re.I | re.S,
            )
            author = _clean(author_match.group(1)) if author_match else ""

        images = _content_image_urls(html_text, page_url)
        cover = await _cover_for(images[0] if images else "", page_url)
        remark = _clean(desc)

        vod = {
            "vod_id": page_url,
            "vod_name": title,
            "vod_pic": cover,
            "vod_remarks": category or "视频",
            "vod_actor": author,
            "vod_content": remark or title,
            "vod_play_sources": [{"name": "海角视频", "episodes": plays}],
        }
        return {"list": [vod]}
    except Exception as exc:
        await OmniBox.log("error", "[hjsq][detail] %s" % exc)
        return {"list": []}


async def search(params, context):
    params = params or {}
    page = max(1, _to_int(params.get("page"), 1))
    keyword = str(params.get("keyword") or params.get("wd") or "").strip()
    if not keyword:
        return {"list": [], "page": page, "pagecount": page, "limit": 20, "total": 0}

    limit = 20
    try:
        url = (
            "%s/Searchs/searchpagination/?keyword=%s&type=posts&page=%d&limit=%d"
            % (HOST, quote(keyword, safe=""), page, limit)
        )
        await OmniBox.log(
            "info", "[hjsq][search] keyword=%s, page=%d" % (keyword, page)
        )
        body, final_url = await _request_ex(url)
        parsed_url = urlsplit(final_url)
        base_url = "%s://%s" % (parsed_url.scheme, parsed_url.netloc)

        payload = json.loads(body or "{}")
        raw_list = payload.get("list") if isinstance(payload, dict) else []
        if isinstance(raw_list, dict):
            raw_list = raw_list.get("posts") or []

        videos = []
        for item in raw_list if isinstance(raw_list, list) else []:
            if not isinstance(item, dict):
                continue
            post_id = str(item.get("cid") or "").strip()
            title = _clean(item.get("title"))
            if not post_id or not title:
                continue

            raw_pic = str(item.get("imageUrl") or "")
            thumbnails = item.get("thumbnails") or []
            if thumbnails and isinstance(thumbnails[0], dict):
                raw_pic = thumbnails[0].get("url") or raw_pic

            category = _clean(item.get("category_name"))
            views = _to_int(item.get("view", item.get("viewsNum")), 0)
            remark = category + ((" · %s浏览" % views) if views else "")
            videos.append(
                {
                    "vod_id": "%s/archives/%s/" % (base_url, post_id),
                    "vod_name": title,
                    "vod_pic": raw_pic,
                    "vod_remarks": remark,
                    "style": {"type": "rect", "ratio": 1.33},
                }
            )

        await _fill_covers(videos, base_url)
        total = max(0, _to_int(payload.get("total"), len(videos)))
        page_count = max(page, int(math.ceil(float(total) / limit))) if total else page
        await OmniBox.log(
            "info",
            "[hjsq][search] count=%d, total=%d" % (len(videos), total),
        )
        return {
            "list": videos,
            "page": page,
            "pagecount": page_count,
            "limit": limit,
            "total": total,
        }
    except Exception as exc:
        await OmniBox.log("error", "[hjsq][search] %s" % exc)
        return {
            "list": [],
            "page": page,
            "pagecount": page,
            "limit": limit,
            "total": 0,
        }


async def play(params, context):
    params = params or {}
    value = html.unescape(
        str(params.get("playId") or params.get("play_id") or "").strip()
    )
    flag = params.get("flag") or "海角视频"
    await OmniBox.log(
        "info", "[hjsq][play] flag=%s, playId=%s" % (flag, value[:120])
    )
    if not value.startswith(("http://", "https://")):
        await OmniBox.log("error", "[hjsq][play] playId 不是有效 URL: %s" % value)
        return {"urls": [], "flag": flag, "header": {}, "parse": 0}

    parsed = urlsplit(value)
    origin = "%s://%s" % (parsed.scheme, parsed.netloc)
    header = {
        "User-Agent": HEADERS["User-Agent"],
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "identity",
        "Referer": origin + "/",
        "Origin": origin,
        "Connection": "keep-alive",
    }
    await OmniBox.log("info", "[hjsq][play] origin=%s" % origin)
    result = {
        "parse": 0,
        "playUrl": "",
        "url": value,
        "urls": [{"name": flag, "url": value}],
        "flag": flag,
        "header": header,
    }
    if ".m3u8" in value.lower():
        result["type"] = "m3u8"
        result["format"] = "application/x-mpegURL"
        result["contentType"] = "application/x-mpegURL"
    return result


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
