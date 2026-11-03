# -*- coding: utf-8 -*-
# @name 华视影院
# @author 梦
# @description 影视站：https://huavod.com ，Python版；首页返回站点推荐卡片，搜索需验证码校验，支持详情与播放解析
# @version 1.0.28
# @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/影视/采集/华视影院.py

import json
import os
import re
import time
import html
import hashlib
from io import BytesIO
from urllib.parse import quote, quote_plus

import requests
from spider_runner import OmniBox, run


# ==================== 配置区域开始 ====================
# 站点基础地址。
SITE_URL = os.environ.get("HUAVOD_HOST", "https://huavod.com").rstrip("/")
# 播放器基础地址。
PLAYER_URL = os.environ.get("HUAVOD_PLAYER_HOST", "https://newplayer.huavod.com").rstrip("/")
# 默认请求头 UA。
UA = os.environ.get(
    "HUAVOD_UA",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
)
# ==================== 配置区域结束 ====================

SITE_HEADERS = {
    "User-Agent": UA,
    "Referer": f"{SITE_URL}/",
}

PLAY_HEADERS = {
    "User-Agent": UA,
    "Referer": f"{SITE_URL}/",
    "Origin": SITE_URL,
}

SEARCH_UA = os.environ.get(
    "HUAVOD_SEARCH_UA",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0",
)
# 外部 OCR 接口地址。配置后优先用于识别华视搜索验证码；未配置时回退本地 ddddocr。
EXTERNAL_OCR_API = str(os.environ.get("HUAVOD_DDDDOCR_API") or os.environ.get("DDDDOCR_API") or "").strip()
# 外部 OCR 接口路径。默认按通用文本验证码识别接口 `/ocr` 尝试，可按实际服务覆盖。
EXTERNAL_OCR_PATH = str(os.environ.get("HUAVOD_DDDDOCR_PATH") or "/ocr").strip() or "/ocr"
# 可选：直接复用浏览器里已验证可用的搜索 Cookie 串。
HUAVOD_SEARCH_COOKIE = str(os.environ.get("HUAVOD_SEARCH_COOKIE") or "").strip()
# 风在 2026-04-24 提供的一组可用浏览器搜索 Cookie；未显式配置时先用它做回退，便于尽快验证搜索链路。
HUAVOD_SEARCH_COOKIE_FALLBACK = "server_name_session=45e11a32dd697d2f7cb55be681fbb127; mac_history=%7Blog%3A%5B%7B%22name%22%3A%22%5B%E5%A4%A7%E9%99%86%E5%89%A7%5D%E9%80%90%E7%8E%89%22%2C%22link%22%3A%22https%3A%2F%2Fhuavod.com%2Fvodplay%2F194546-1-1.html%22%2C%22pic%22%3A%22https%3A%2F%2Fstatic.huarenlivewebsite.top%2Fpiccdn%2F2%2F14%2Fzhu_yu%2F194546_image.png%22%2C%22mid%22%3A%2201%22%7D%5D%7D; PHPSESSID=i9hi54asmm9mm82edl3qiso23m; DS_Records=%7Blog%3A%5B%7B%22name%22%3A%22%E6%9C%88%E9%B3%9F%E7%BB%AE%E7%BA%AA%22%2C%22url%22%3A%22%2Fvodsearch.html%22%7D%5D%7D"

SCRIPT_VERSION = "1.0.28"
SCRIPT_FINGERPRINT = hashlib.md5(f"huavod:{SCRIPT_VERSION}:cache-verified-search-identity-30m-persist-on-success".encode("utf-8")).hexdigest()[:12]

SITE_CLASS = [
    {"type_id": "1", "type_name": "电影"},
    {"type_id": "2", "type_name": "电视剧"},
    {"type_id": "3", "type_name": "综艺"},
    {"type_id": "4", "type_name": "动漫"},
    {"type_id": "5", "type_name": "短剧"},
    {"type_id": "42", "type_name": "纪录片"},
    {"type_id": "6", "type_name": "奇幻科幻"},
    {"type_id": "10", "type_name": "战争犯罪"},
    {"type_id": "8", "type_name": "悬疑恐怖惊悚"},
    {"type_id": "9", "type_name": "爱情喜剧剧情"},
    {"type_id": "7", "type_name": "动作冒险灾难"},
    {"type_id": "11", "type_name": "动画电影"},
    {"type_id": "12", "type_name": "网络电影"},
    {"type_id": "13", "type_name": "其他"},
    {"type_id": "53", "type_name": "4K影库"},
]

FILTER_ITEMS = [
    {
        "key": "area",
        "name": "地区",
        "value": [
            {"name": "全部", "value": ""},
            {"name": "大陆", "value": "/area/大陆"},
            {"name": "香港", "value": "/area/香港"},
            {"name": "台湾", "value": "/area/台湾"},
            {"name": "美国", "value": "/area/美国"},
            {"name": "韩国", "value": "/area/韩国"},
            {"name": "日本", "value": "/area/日本"},
            {"name": "法国", "value": "/area/法国"},
            {"name": "英国", "value": "/area/英国"},
            {"name": "德国", "value": "/area/德国"},
            {"name": "泰国", "value": "/area/泰国"},
            {"name": "印度", "value": "/area/印度"},
            {"name": "其他", "value": "/area/其他"},
        ],
    },
    {
        "key": "year",
        "name": "年份",
        "value": [
            {"name": "全部", "value": ""},
            {"name": "2026", "value": "/year/2026"},
            {"name": "2025", "value": "/year/2025"},
            {"name": "2024", "value": "/year/2024"},
            {"name": "2023", "value": "/year/2023"},
            {"name": "2022", "value": "/year/2022"},
            {"name": "2021", "value": "/year/2021"},
            {"name": "2020", "value": "/year/2020"},
            {"name": "2019", "value": "/year/2019"},
            {"name": "2018", "value": "/year/2018"},
            {"name": "2010年代", "value": "/year/2010"},
        ],
    },
    {
        "key": "lang",
        "name": "语言",
        "value": [
            {"name": "全部", "value": ""},
            {"name": "国语", "value": "/lang/国语"},
            {"name": "英语", "value": "/lang/英语"},
            {"name": "粤语", "value": "/lang/粤语"},
            {"name": "韩语", "value": "/lang/韩语"},
            {"name": "日语", "value": "/lang/日语"},
            {"name": "其他", "value": "/lang/其他"},
        ],
    },
    {
        "key": "by",
        "name": "排序",
        "value": [
            {"name": "时间", "value": "/by/time"},
            {"name": "评分", "value": "/by/score"},
            {"name": "人气", "value": "/by/hits"},
        ],
    },
]

SITE_FILTERS = {item["type_id"]: FILTER_ITEMS for item in SITE_CLASS}


async def log(level: str, message: str):
    try:
        await OmniBox.log(level, f"[华视影院] {message}")
    except Exception:
        pass


async def get_sdk_cache(key: str):
    try:
        fn = getattr(OmniBox, 'getCache', None)
        if not callable(fn):
            return None
        value = await fn(key)
        if not value:
            return None
        if isinstance(value, str):
            try:
                return json.loads(value)
            except Exception:
                return None
        return value
    except Exception:
        return None


async def set_sdk_cache(key: str, value, ex_seconds: int = 1800):
    try:
        fn = getattr(OmniBox, 'setCache', None)
        if not callable(fn):
            return False
        payload = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        await fn(key, payload, ex_seconds)
        return True
    except Exception:
        return False


def safe_text(value):
    return str(value or "").strip()


async def request_text(url: str, method: str = "GET", data=None, referer: str = None, headers_override=None) -> str:
    headers = dict(SITE_HEADERS)
    headers["Referer"] = referer or f"{SITE_URL}/"
    if headers_override:
        headers.update(headers_override)
    response = await OmniBox.request(
        url,
        {
            "method": method,
            "headers": headers,
            "body": data,
        },
    )
    status = int(response.get("statusCode") or 0)
    body = response.get("body", "")
    text = body.decode("utf-8", "ignore") if isinstance(body, (bytes, bytearray)) else str(body or "")
    if status != 200:
        raise RuntimeError(f"HTTP {status} @ {url}")
    return text


def abs_url(url: str) -> str:
    raw = safe_text(url)
    if not raw:
        return ""
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    if raw.startswith("//"):
        return f"https:{raw}"
    if raw.startswith("/"):
        return f"{SITE_URL}{raw}"
    return f"{SITE_URL}/{raw.lstrip('./')}"


def parse_extend(raw):
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


def normalize_filters(raw):
    data = parse_extend(raw)
    normalized = {}
    for key in ("area", "year", "lang", "by"):
        value = safe_text(data.get(key, ""))
        normalized[key] = value if value.startswith("/") else ""
    return normalized


def build_category_urls(category_id: str, page: int, filters: dict):
    suffix = "".join([filters.get(key, "") for key in ("area", "year", "lang", "by") if filters.get(key)])
    urls = []
    if suffix:
        urls.append(f"{SITE_URL}/vodshow/{category_id}{suffix}")
        urls.append(f"{SITE_URL}/vodshow/{category_id}/page/{page}{suffix}")
        urls.append(f"{SITE_URL}/vodshow/{category_id}{suffix}/page/{page}")
    else:
        urls.append(f"{SITE_URL}/vodshow/{category_id}")
        urls.append(f"{SITE_URL}/vodshow/{category_id}/page/{page}")
    dedup = []
    seen = set()
    for item in urls:
        url = f"{item}.html"
        if page <= 1 and "/page/1" in url:
            continue
        if url not in seen:
            seen.add(url)
            dedup.append(url)
    if not dedup:
        dedup.append(f"{SITE_URL}/vodshow/{category_id}.html")
    return dedup


def build_play_sources(play_routes: dict):
    sources = []
    for source_name, raw in (play_routes or {}).items():
        episodes = []
        for index, segment in enumerate(str(raw or "").split("#"), start=1):
            item = safe_text(segment)
            if not item or "$" not in item:
                continue
            ep_name, play_id = item.split("$", 1)
            ep_name = safe_text(ep_name) or f"第{index}集"
            play_id = safe_text(play_id)
            if not play_id:
                continue
            episodes.append({"name": ep_name, "playId": play_id})
        if episodes:
            sources.append({"name": safe_text(source_name) or "默认", "episodes": episodes})
    return sources


def build_play_result(url: str, flag: str, parse: int = 0, header=None):
    real_url = safe_text(url)
    real_flag = safe_text(flag) or "播放"
    real_header = header if isinstance(header, dict) else {}
    return {
        "url": real_url,
        "urls": [{"name": "播放", "url": real_url}] if real_url else [],
        "flag": real_flag,
        "header": real_header,
        "parse": parse,
    }


def build_search_url(keyword: str, page: int = 1):
    if page <= 1:
        return f"{SITE_URL}/vodsearch.html?wd={quote(keyword)}"
    return f"{SITE_URL}/vodsearch.html?wd={quote(keyword)}&page={page}"


def build_search_verify_url(keyword: str, page: int = 1):
    if page <= 1:
        return f"{SITE_URL}/vodsearch/wd/{quote(keyword)}.html"
    return f"{SITE_URL}/vodsearch/wd/{quote(keyword)}/{page}.html"


def build_search_session(page_url: str, keyword: str = ""):
    sess = requests.Session()
    sess.headers.update({
        "User-Agent": SEARCH_UA,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
        "Referer": f"{SITE_URL}/",
        "DNT": "1",
        "Sec-GPC": "1",
        "sec-ch-ua": '"Microsoft Edge";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "priority": "u=0, i",
    })

    cookie_source = HUAVOD_SEARCH_COOKIE or HUAVOD_SEARCH_COOKIE_FALLBACK
    if cookie_source:
        try:
            for part in cookie_source.split(';'):
                seg = part.strip()
                if not seg or '=' not in seg:
                    continue
                k, v = seg.split('=', 1)
                sess.cookies.set(k.strip(), v.strip(), domain="huavod.com", path="/")
        except Exception:
            pass
    else:
        try:
            cf_cookie = os.environ.get("HUAVOD_CF_COOKIE", "").strip()
            if cf_cookie:
                sess.cookies.set("CF_HUAREN_LIVE", cf_cookie, domain="huavod.com", path="/")
        except Exception:
            pass
        if keyword:
            try:
                escaped_keyword = keyword.replace('"', '\\"')
                ds_records = '{log:[{"name":"%s","url":"/vodsearch.html"}]}' % escaped_keyword
                ds_records = quote(ds_records, safe='')
                sess.cookies.set("DS_Records", ds_records, domain="huavod.com", path="/")

                mac_history = '{log:[{"name":"[%s]","link":"%s","pic":"","mid":"01"}]}' % (escaped_keyword, f"{SITE_URL}/vodsearch.html?wd={quote(keyword)}")
                mac_history = quote(mac_history, safe='')
                sess.cookies.set("mac_history", mac_history, domain="huavod.com", path="/")
            except Exception:
                pass
    return sess


def dump_session_cookies(sess):
    try:
        pairs = []
        for c in sess.cookies:
            pairs.append(f"{c.name}={c.value}")
        return '; '.join(pairs[:20])
    except Exception:
        return ''


def search_cache_key(keyword: str):
    return f"huavod:search:identity:{keyword}"


def restore_identity_to_session(sess, identity: dict):
    if not isinstance(identity, dict):
        return
    for key in ("server_name_session", "PHPSESSID", "DS_Records", "mac_history", "CF_HUAREN_LIVE"):
        value = str(identity.get(key) or "").strip()
        if value:
            sess.cookies.set(key, value, domain="huavod.com", path="/")


def capture_identity_from_session(sess):
    data = {}
    try:
        for c in sess.cookies:
            if c.name in {"server_name_session", "PHPSESSID", "DS_Records", "mac_history", "CF_HUAREN_LIVE"}:
                data[c.name] = c.value
    except Exception:
        pass
    return data


async def warm_search_session(sess, page_url: str, referer: str = ""):
    try:
        headers = {"Referer": referer or f"{SITE_URL}/"}
        resp = sess.get(page_url, headers=headers, timeout=15)
        resp.raise_for_status()
        text = resp.text or ""
        await log("info", f"search page fetched status={resp.status_code} len={len(text)} final={resp.url} referer={headers['Referer']} cookies={dump_session_cookies(sess)}")
        return text
    except Exception as e:
        await log("warn", f"search session warmup 失败: {e}")
        return ""


def parse_verify_code(html_text: str):
    if not html_text:
        return ""
    m = re.search(r'/index\.php/verify/index\.html\?r=([0-9.]+)', html_text)
    if m:
        return m.group(1)
    m = re.search(r'verify/index\.html\?r=([0-9.]+)', html_text)
    return m.group(1) if m else ""


async def fetch_verify_image(sess, page_url: str, page_html: str = ""):
    r = parse_verify_code(page_html) or str(time.time())
    img_url = f"{SITE_URL}/index.php/verify/index.html?r={r}"
    await log("info", f"search verify image={img_url}")
    headers = {
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
        "Referer": page_url,
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "same-origin",
        "priority": "i",
    }
    try:
        resp = sess.get(img_url, headers=headers, timeout=15)
        resp.raise_for_status()
        return bytes(resp.content or b'')
    except Exception as e:
        await log("warn", f"search verify image fetch 失败: {e}")
        return b''


async def request_external_ocr(image_bytes: bytes):
    if not EXTERNAL_OCR_API or not image_bytes:
        return ""
    try:
        import base64
        payload_b64 = base64.b64encode(image_bytes).decode("utf-8")
        base = EXTERNAL_OCR_API.rstrip("/")
        path = EXTERNAL_OCR_PATH if EXTERNAL_OCR_PATH.startswith("/") else f"/{EXTERNAL_OCR_PATH}"
        url = f"{base}{path}"
        candidate_payloads = [
            {"data": payload_b64, "type": "text", "source": "huavod"},
            {"data": payload_b64},
            {"image": payload_b64, "type": "text", "source": "huavod"},
            {"img": payload_b64, "type": "text", "source": "huavod"},
            {"image_base64": payload_b64, "type": "text", "source": "huavod"},
        ]
        for payload in candidate_payloads:
            try:
                resp = requests.post(url, json=payload, timeout=20)
                raw = resp.text or ""
                await log("info", f"search external ocr status={resp.status_code} body={raw[:200]}")
                if not raw:
                    continue
                try:
                    data = resp.json()
                except Exception:
                    data = {"text": raw}
                candidates = [
                    data.get("text"),
                    data.get("code"),
                    data.get("result"),
                    data.get("msg"),
                    ((data.get("data") or {}).get("text") if isinstance(data.get("data"), dict) else None),
                    ((data.get("data") or {}).get("code") if isinstance(data.get("data"), dict) else None),
                    ((data.get("data") or {}).get("result") if isinstance(data.get("data"), dict) else None),
                    ((data.get("data") or {}).get("msg") if isinstance(data.get("data"), dict) else None),
                ]
                for item in candidates:
                    text = re.sub(r"\D", "", str(item or ""))[:4]
                    if len(text) == 4:
                        return text
                    if len(text) == 3:
                        return text
            except Exception as inner_e:
                await log("warn", f"search external ocr 请求失败: {inner_e}")
    except Exception as e:
        await log("warn", f"search external ocr 失败: {e}")
    return ""


async def solve_search_verify(sess, page_url: str, page_html: str = ""):
    try:
        image_bytes = await fetch_verify_image(sess, page_url, page_html)
        if not image_bytes:
            return ""
        code = await request_external_ocr(image_bytes)
        if code:
            await log("info", f"search verify external ocr code={code}")
        if not code:
            try:
                import ddddocr
                ocr = ddddocr.DdddOcr(show_ad=False, beta=True)
                code = str((ocr.classification(image_bytes) or "")).strip()
            except Exception as e:
                await log("warn", f"search verify ddddocr 失败: {e}")
        code = re.sub(r'\D', '', code)[:4]
        candidates = []
        if len(code) == 4:
            candidates.append(code)
        elif len(code) == 3:
            candidates.extend([code.zfill(4), code])
        elif len(code) > 0:
            await log("warn", f"search verify OCR 结果异常: {code}")
            return ""
        else:
            await log("warn", f"search verify OCR 结果异常: {code}")
            return ""

        headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
            "Referer": page_url,
            "Origin": SITE_URL,
            "X-Requested-With": "XMLHttpRequest",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
            "priority": "u=1, i",
        }
        for candidate in candidates:
            verify_url = f"{SITE_URL}/index.php/ajax/verify_check?type=search&verify={quote_plus(candidate)}"
            await log("info", f"search verify check={verify_url}")
            resp = sess.post(verify_url, headers=headers, timeout=15)
            text = resp.text or ''
            await log("info", f"search verify resp status={resp.status_code} body={text[:200]} cookies={dump_session_cookies(sess)}")
            if '"code":1' in text or '"msg":"success"' in text or 'success' in text.lower():
                return candidate
    except Exception as e:
        await log("warn", f"search verify 失败: {e}")
    return ""


def clean_card_remark_text(value: str):
    text = html.unescape(str(value or ""))
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'&#x?[0-9a-fA-F]+;', ' ', text)
    text = text.replace('\xa0', ' ').replace('&nbsp;', ' ')
    text = re.sub(r'\s+', ' ', text).strip()
    text = text.lstrip('').strip()
    if re.fullmatch(r'[\W_]+', text or ''):
        return ''
    return text


def parse_list(html_text: str):
    if not html_text:
        return []
    result = []
    seen = set()
    matches = re.findall(r'<a[^>]*href="(/voddetail/(\d+)\.html)"[^>]*title="([^"]+)"', html_text)
    if not matches:
        matches = re.findall(r'href="(/voddetail/(\d+)\.html)"[^>]*>[^<]*<img[^>]*title="([^"]+)"', html_text)
    for href, vid, name in matches:
        if vid in seen:
            continue
        seen.add(vid)
        pic = ""
        pic_m = re.search(r'href="/voddetail/%s\.html"[^>]*>.*?(?:data-src|src)="([^"]*(?:jpg|png|jpeg|webp)[^"]*)"' % vid, html_text, re.S)
        if pic_m:
            pic = abs_url(pic_m.group(1))
        remark = ""
        block = re.search(r'<div[^>]*class="[^"]*public-list-box[^"]*"[^>]*>.*?href="/voddetail/%s\.html.*?</div>\s*</div>\s*</div>' % vid, html_text, re.S)
        if block:
            rm = re.search(r'<span[^>]*class="[^"]*public-list-prb[^"]*"[^>]*>(.*?)</span>', block.group(0), re.S)
            if rm:
                remark = clean_card_remark_text(rm.group(1))
        result.append({
            "vod_id": vid,
            "vod_name": safe_text(name),
            "vod_pic": pic,
            "vod_remarks": remark,
        })
    return result


def parse_row9_results(html_text: str):
    text = html_text or ""
    if not text or 'public-list-box search-box' not in text:
        return []

    blocks = re.findall(
        r'<div[^>]*class="[^"]*public-list-box\s+search-box[^"]*"[^>]*>(.*?)</div>\s*</div>\s*</div>\s*<script>',
        text,
        re.S,
    )
    if not blocks:
        blocks = re.findall(
            r'<div[^>]*class="[^"]*public-list-box\s+search-box[^"]*"[^>]*>(.*?)</div>\s*</div>\s*</div>',
            text,
            re.S,
        )
    if not blocks:
        return []

    result = []
    seen = set()
    for block in blocks:
        vod_id = ""
        title = ""
        pic = ""
        remark = ""

        detail_m = re.search(r'/voddetail/(\d+)\.html', block)
        if detail_m:
            vod_id = detail_m.group(1)
        if not vod_id:
            play_m = re.search(r'/vodplay/(\d+)-\d+-\d+\.html', block)
            if play_m:
                vod_id = play_m.group(1)

        title_patterns = [
            r'<div[^>]*class="thumb-txt[^"]*">\s*<a[^>]*>([^<]+)</a>',
            r'<a[^>]*class="public-list-exp"[^>]*title="([^"]+)"',
            r'<img[^>]*alt="([^"]+)封面图"',
            r'<img[^>]*alt="([^"]+)"',
        ]
        for pat in title_patterns:
            m = re.search(pat, block, re.S)
            if m and safe_text(m.group(1)):
                title = safe_text(m.group(1))
                break

        pic_m = re.search(r'(?:data-src|src)="([^"]*(?:jpg|png|jpeg|webp)[^"]*)"', block, re.S)
        if pic_m:
            pic = abs_url(pic_m.group(1))

        remark_patterns = [
            r'<span[^>]*class="public-list-prb[^"]*">([^<]+)</span>',
            r'(\d+集全)',
            r'(全\d+集)',
            r'(更新至\d+集)',
        ]
        for pat in remark_patterns:
            m = re.search(pat, block, re.S)
            if m and safe_text(m.group(1)):
                remark = safe_text(m.group(1))
                break

        if vod_id and title and vod_id not in seen:
            seen.add(vod_id)
            result.append({
                "vod_id": vod_id,
                "vod_name": title,
                "vod_pic": pic,
                "vod_remarks": remark,
            })
    return result


def extract_meta_value(html_text: str, key: str) -> str:
    m = re.search(rf'<meta[^>]+{key}="([^"]+)"', html_text)
    return abs_url(m.group(1)) if m else ""


def summarize_search_page(html_text: str):
    text = html_text or ""
    return {
        "len": len(text),
        "has_verify": ('验证码' in text) or ('verify/index.html' in text),
        "has_voddetail": '/voddetail/' in text,
        "voddetail_count": text.count('/voddetail/'),
        "public_list_count": text.count('public-list-box'),
        "search_box_count": text.count('public-list-box search-box'),
        "row9_count": text.count('row-9'),
        "search_show_count": text.count('search-show'),
        "title": (re.search(r'<title>(.*?)</title>', text, re.S).group(1).strip() if re.search(r'<title>(.*?)</title>', text, re.S) else ''),
    }


def extract_search_debug_snippets(html_text: str, keyword: str):
    text = html_text or ""
    snippets = {}

    idx = text.find(keyword) if keyword else -1
    if idx >= 0:
        snippets['keyword_snippet'] = text[max(0, idx - 800):idx + 2200]

    search_idx = text.find('search-show')
    if search_idx >= 0:
        snippets['search_show_snippet'] = text[max(0, search_idx - 400):search_idx + 2600]

    row9_idx = text.find('row-9')
    if row9_idx >= 0:
        snippets['row9_snippet'] = text[max(0, row9_idx - 400):row9_idx + 3200]

    search_box_idx = text.find('public-list-box search-box')
    if search_box_idx >= 0:
        snippets['search_box_snippet'] = text[max(0, search_box_idx - 400):search_box_idx + 3200]

    for pat_name, pat in [
        ('href_title_pairs', r'href="([^"]+)"[^>]*title="([^"]+)"'),
        ('href_text_pairs', r'<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>'),
        ('list_items', r'<li[^>]*>(.*?)</li>'),
    ]:
        try:
            matches = re.findall(pat, text, re.S)
        except Exception:
            matches = []
        if matches:
            snippets[pat_name] = matches[:8]

    return snippets


async def home(params, context):
    try:
        await log("info", f"home from={safe_text((context or {}).get('from', 'web'))}")
        html_text = await request_text(f"{SITE_URL}/")
        return {
            "class": SITE_CLASS,
            "filters": SITE_FILTERS,
            "list": parse_list(html_text)[:30],
        }
    except Exception as e:
        await log("error", f"home 失败: {e}")
        return {"class": SITE_CLASS, "filters": SITE_FILTERS, "list": []}


async def category(params, context):
    try:
        category_id = safe_text(params.get("categoryId") or params.get("tid") or params.get("typeId") or params.get("type_id") or "1")
        page = int(params.get("page") or 1)
        filters = normalize_filters(params.get("filters") or params.get("extend") or {})
        urls = build_category_urls(category_id, page, filters)
        html_text = ""
        picked_url = ""
        items = []
        for url in urls:
            try:
                current_html = await request_text(url)
                current_items = parse_list(current_html)
                picked_url = url
                html_text = current_html
                items = current_items
                if current_items or not filters:
                    break
            except Exception as inner_e:
                await log("warn", f"category 尝试失败 url={url} err={inner_e}")
        await log("info", f"category tid={category_id} page={page} filters={filters} picked={picked_url}")
        return {
            "page": page,
            "pagecount": 999,
            "limit": 30,
            "total": 999 if items else 0,
            "list": items,
        }
    except Exception as e:
        await log("error", f"category 失败: {e}")
        return {"page": 1, "pagecount": 0, "limit": 30, "total": 0, "list": []}


async def detail(params, context):
    try:
        ids = params.get("ids") or params.get("videoId") or params.get("id")
        if isinstance(ids, str):
            ids = [ids]
        ids = ids or []
        result = []
        for raw_id in ids:
            vod_id = safe_text(raw_id).split("_")[0]
            if not vod_id:
                continue
            url = f"{SITE_URL}/voddetail/{vod_id}.html"
            await log("info", f"detail vod_id={vod_id} url={url}")
            html_text = await request_text(url)
            if not html_text:
                continue

            name = ""
            pic = ""
            desc = ""
            year = ""
            area = ""
            actor = ""
            director = ""

            ld_match = re.search(r'<script type="application/ld\+json">(.*?)</script>', html_text, re.S)
            if ld_match:
                try:
                    ld = json.loads(ld_match.group(1))
                    name = safe_text(ld.get("name", ""))
                    pic = abs_url(ld.get("image", ""))
                    desc = safe_text(ld.get("description", ""))[:200]
                    year = safe_text(ld.get("datePublished", ""))[:4]
                    genre = ld.get("genre", [])
                    if isinstance(genre, list):
                        area = ",".join([safe_text(x) for x in genre[:3] if safe_text(x)])
                    d = ld.get("director", {})
                    if isinstance(d, dict):
                        director = safe_text(d.get("name", ""))
                    elif isinstance(d, list):
                        director = "|".join([safe_text(x.get("name", "")) for x in d[:3] if isinstance(x, dict)])
                    ac = ld.get("actor", [])
                    if isinstance(ac, list):
                        actor = "|".join([safe_text(x.get("name", "")) for x in ac[:8] if isinstance(x, dict)])
                except Exception:
                    pass

            if not name:
                m = re.search(r'<h1[^>]*>([^<]+)</h1>', html_text)
                if m:
                    name = re.sub(r'\s*[-–].*$', '', m.group(1)).strip()
            if not pic:
                m = re.search(r'(?:data-src|src)="(https?://[^"]+(?:jpg|png|jpeg|webp)[^"]*)"', html_text)
                if m:
                    pic = m.group(1)

            route_names = re.findall(r'class="swiper-slide"[^>]*>\s*<i[^>]*></i>\s*&nbsp;([^<]+)</a>', html_text)
            if not route_names:
                route_names = re.findall(r'class="swiper-slide[^>]*>([^<]+)</a>', html_text)
                route_names = [safe_text(n).replace("\xa0", "") for n in route_names if safe_text(n)]

            play_routes = {}
            idx = html_text.find("anthology-list")
            if idx >= 0:
                segment = html_text[idx:]
                for tag in ['class="ads', '<footer', 'class="footer']:
                    end_idx = segment.find(tag)
                    if end_idx > 0:
                        segment = segment[:end_idx]
                        break
                parts = segment.split("anthology-list-box")
                for i, part in enumerate(parts[1:], 1):
                    route_name = route_names[i - 1] if i - 1 < len(route_names) else f"线路{i}"
                    eps = re.findall(r'/vodplay/(\d+)-(\d+)-(\d+)\.html"[^>]*>([^<]+)<', part)
                    if eps:
                        play_routes[route_name] = "#".join([f"{safe_text(ep[3])}${ep[0]}-{ep[1]}-{ep[2]}" for ep in eps])

            if not play_routes:
                eps = re.findall(r'/vodplay/(\d+)-(\d+)-(\d+)\.html"[^>]*>([^<]+)<', html_text)
                if eps:
                    play_routes["默认"] = "#".join([f"{safe_text(ep[3])}${ep[0]}-{ep[1]}-{ep[2]}" for ep in eps])

            play_sources = build_play_sources(play_routes)
            vod = {
                "vod_id": vod_id,
                "vod_name": name,
                "vod_pic": pic,
                "vod_remarks": "",
                "vod_year": year,
                "vod_area": area,
                "vod_actor": actor,
                "vod_director": director,
                "vod_content": desc,
                "vod_play_from": "$$$".join(play_routes.keys()),
                "vod_play_url": "$$$".join(play_routes.values()),
                "vod_play_sources": play_sources,
            }
            result.append(vod)

        return {"list": result}
    except Exception as e:
        await log("error", f"detail 失败: {e}")
        return {"list": []}


async def search(params, context):
    try:
        keyword = safe_text(params.get("keyword") or params.get("wd") or params.get("search") or "")
        page = int(params.get("page") or 1)
        await log("info", f"search runtime version={SCRIPT_VERSION} fingerprint={SCRIPT_FINGERPRINT}")
        if not keyword:
            return {"page": 1, "pagecount": 0, "total": 0, "list": []}

        search_url = build_search_url(keyword, page)
        verify_page_url = build_search_verify_url(keyword, page)
        await log("info", f"search runtime url={search_url}")
        await log("info", f"search runtime verify_url={verify_page_url}")
        await log("info", f"search runtime cookie_override={'env' if HUAVOD_SEARCH_COOKIE else ('fallback' if HUAVOD_SEARCH_COOKIE_FALLBACK else 'no')}")
        items = []
        verify_code = ""
        cache_key = search_cache_key(keyword)
        cached_identity = await get_sdk_cache(cache_key)
        if isinstance(cached_identity, dict):
            await log("info", f"search cache hit key={cache_key} fields={list(cached_identity.keys())}")

        def _extract_items_from_page(search_page: str):
            parsed = parse_list(search_page)
            return parsed if parsed else parse_row9_results(search_page)

        for attempt in range(3):
            sess = build_search_session(verify_page_url, keyword)
            if isinstance(cached_identity, dict):
                restore_identity_to_session(sess, cached_identity)
            if attempt == 0 and isinstance(cached_identity, dict):
                await log("info", f"search restored cached identity cookies={dump_session_cookies(sess)}")
            sess.headers.update({
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
                "Cache-Control": "max-age=0",
                "Upgrade-Insecure-Requests": "1",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "same-origin",
                "Sec-Fetch-User": "?1",
            })

            # 先按浏览器成功链路直接打 query 结果页；很多词并不一定需要再次走验证码链。
            search_page = await warm_search_session(sess, search_url, referer=f"{SITE_URL}/")
            page_summary = summarize_search_page(search_page)
            await log("info", f"search direct-query attempt={attempt + 1} summary={json.dumps(page_summary, ensure_ascii=False)}")
            if search_page and not page_summary["has_verify"]:
                items = _extract_items_from_page(search_page)
                await log("info", f"search direct-query parsed items={len(items)}")
                if items:
                    await set_sdk_cache(cache_key, capture_identity_from_session(sess), 1800)
                    break

            verify_page = await warm_search_session(sess, verify_page_url, referer=search_url)
            verify_summary = summarize_search_page(verify_page)
            await log("info", f"search verify-page attempt={attempt + 1} summary={json.dumps(verify_summary, ensure_ascii=False)}")
            if not verify_page:
                continue

            verify_code = await solve_search_verify(sess, verify_page_url, verify_page)
            if not verify_code:
                await log("warn", f"search 验证失败 keyword={keyword} page={page} attempt={attempt + 1}")
                continue

            search_page = await warm_search_session(sess, search_url, referer=f"{SITE_URL}/")
            page_summary = summarize_search_page(search_page)
            await log("info", f"search post-verify summary={json.dumps(page_summary, ensure_ascii=False)}")

            if search_page and not page_summary["has_verify"]:
                items = parse_list(search_page)
                await log("info", f"search parsed items={len(items)}")
                if items:
                    await set_sdk_cache(cache_key, capture_identity_from_session(sess), 1800)
                if not items:
                    row9_items = parse_row9_results(search_page)
                    await log("info", f"search row9 items={len(row9_items)} sample={json.dumps(row9_items[:3], ensure_ascii=False)}")
                    items = row9_items
                if not items:
                    direct_matches = re.findall(r'href="/voddetail/(\d+)\.html"[^>]*title="([^"]+)"', search_page)
                    await log("info", f"search direct matches={len(direct_matches)} sample={json.dumps(direct_matches[:5], ensure_ascii=False)}")
                    debug_snippets = extract_search_debug_snippets(search_page, keyword)
                    if debug_snippets:
                        try:
                            await log("info", f"search debug snippets={json.dumps(debug_snippets, ensure_ascii=False)[:3500]}")
                        except Exception:
                            pass
                    seen_direct = set()
                    for vod_id, vod_name in direct_matches:
                        if vod_id in seen_direct:
                            continue
                        seen_direct.add(vod_id)
                        items.append({"vod_id": vod_id, "vod_name": safe_text(vod_name), "vod_pic": "", "vod_remarks": ""})
                if items:
                    break

        await log("info", f"search keyword={keyword} page={page} verify={verify_code or 'none'} result={len(items)}")
        total = len(items)
        pagecount = 1 if total > 0 else 0
        return {"page": page, "pagecount": pagecount, "total": total, "list": items}
    except Exception as e:
        await log("error", f"search 失败: {e}")
        return {"page": 1, "pagecount": 0, "total": 0, "list": []}


async def play(params, context):
    try:
        play_id = safe_text(params.get("playId") or params.get("id") or params.get("url"))
        flag = safe_text(params.get("flag") or "播放")
        if not play_id:
            raise ValueError("playId 不能为空")

        if play_id.startswith("http://") or play_id.startswith("https://") or play_id.endswith((".m3u8", ".mp4")):
            await log("info", f"play 直链返回 playId={play_id}")
            return build_play_result(play_id, flag, 0, PLAY_HEADERS)

        parts = play_id.split("-")
        if len(parts) < 3:
            await log("warn", f"playId 格式异常，直接回退页面: {play_id}")
            play_url = play_id if play_id.startswith("http") else f"{SITE_URL}/vodplay/{play_id}.html"
            return build_play_result(play_url, flag, 1, PLAY_HEADERS)

        vod_id, route, ep = parts[0], parts[1], parts[2]
        play_url = f"{SITE_URL}/vodplay/{vod_id}-{route}-{ep}.html"
        await log("info", f"play vod_id={vod_id} route={route} ep={ep}")
        html_text = await request_text(play_url)
        if not html_text:
            return build_play_result(play_url, flag, 1, PLAY_HEADERS)

        m = re.search(r'var\s+mac_player_info\s*=\s*', html_text)
        if not m:
            return build_play_result(play_url, flag, 1, PLAY_HEADERS)

        try:
            decoder = json.JSONDecoder()
            info, _ = decoder.raw_decode(html_text, m.end())
        except Exception as e:
            await log("warn", f"play 解析 mac_player_info 失败: {e}")
            return build_play_result(play_url, flag, 1, PLAY_HEADERS)

        enc_url = quote(safe_text(info.get("url", "")), safe="")
        ec_url = f"{PLAYER_URL}/player/ec.php?code=ok&url={enc_url}&main_domain={quote(play_url, safe='')}"
        ec_html = await request_text(ec_url, referer=f"{PLAYER_URL}/player/ec.php")
        if not ec_html:
            return build_play_result(play_url, flag, 1, PLAY_HEADERS)

        token_m = re.search(r'"token"\s*:\s*"([^"]+)"', ec_html)
        token = token_m.group(1) if token_m else ""
        if not token:
            return build_play_result(play_url, flag, 1, PLAY_HEADERS)

        ad_duration_ms = 0
        ad_m = re.search(r'"ad_duration_ms"\s*:\s*(\d+)', ec_html)
        if ad_m:
            ad_duration_ms = int(ad_m.group(1))

        initial_delay_ms = max(0, ad_duration_ms - 2000) if ad_duration_ms > 0 else 0
        if initial_delay_ms > 0:
            await log("info", f"play 等待广告 {initial_delay_ms}ms")
            time.sleep(initial_delay_ms / 1000.0)

        api_url = f"{PLAYER_URL}/index.php/api/resolve/url"
        api_headers = {
            "Origin": PLAYER_URL,
            "Referer": f"{PLAYER_URL}/player/ec.php",
            "Content-Type": "application/x-www-form-urlencoded",
        }

        for attempt in range(5):
            res = await OmniBox.request(
                api_url,
                {
                    "method": "POST",
                    "headers": {**SITE_HEADERS, **api_headers},
                    "body": f"token={quote_plus(token)}",
                },
            )
            body = res.get("body", "")
            text = body.decode("utf-8", "ignore") if isinstance(body, (bytes, bytearray)) else str(body or "")
            try:
                data = json.loads(text or "{}")
            except Exception:
                data = {}

            if data.get("code") == 1 and data.get("data", {}).get("url"):
                resolved_url = data["data"]["url"]
                await log("info", f"play 解析成功: {resolved_url}")
                return build_play_result(resolved_url, flag, 0, PLAY_HEADERS)

            if data.get("code") == 0 and data.get("data", {}).get("retry_after_ms"):
                retry_ms = min(int(data["data"]["retry_after_ms"]), 35000)
                await log("info", f"play too early，等待 {retry_ms}ms 后重试 ({attempt + 1}/5)")
                time.sleep(retry_ms / 1000.0)
                continue

            msg = safe_text(data.get("msg", ""))
            if msg:
                await log("warn", f"play resolve 失败: {msg} ({attempt + 1}/5)")
            else:
                await log("warn", f"play resolve 返回异常 ({attempt + 1}/5)")
            if attempt < 4:
                time.sleep(3)

        return build_play_result(play_url, flag, 1, PLAY_HEADERS)
    except Exception as e:
        await log("error", f"play 失败: {e}")
        return build_play_result("", safe_text(params.get("flag", "")), 1, PLAY_HEADERS)


if __name__ == "__main__":
    run({"home": home, "category": category, "detail": detail, "search": search, "play": play})
