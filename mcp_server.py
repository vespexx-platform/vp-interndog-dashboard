#!/usr/bin/env python3
"""vp-interndog 대시보드 데이터를 노출하는 MCP 서버.

암호화된 site/data.js(매출·재고) 와 site/voc.js(CS·VOC)를 대시보드 비밀번호로
로컬 복호화해 도구로 제공한다. 데이터는 서버 밖으로 나가지 않는다(로컬 stdio).

기본은 GitHub Pages의 라이브 파일을 받아 항상 최신을 반영하고, 실패하면
레포에 커밋된 로컬 site/*.js로 폴백한다.

환경변수:
  DASHBOARD_PASSWORD   (필수) 대시보드 비밀번호 — 복호화 키 유도에 사용
  VP_DATA_URL          (선택) data.js 위치 override
  VP_VOC_URL           (선택) voc.js 위치 override

실행:  pip install "mcp[cli]" cryptography  &&  python3 mcp_server.py
"""
import base64
import json
import os
import urllib.request
from datetime import date, timedelta

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from mcp.server.fastmcp import FastMCP

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "https://vespexx-platform.github.io/vp-interndog-dashboard"
DATA_URL = os.environ.get("VP_DATA_URL", f"{BASE}/data.js")
VOC_URL = os.environ.get("VP_VOC_URL", f"{BASE}/voc.js")

mcp = FastMCP("vp-interndog")


# ── 복호화 ────────────────────────────────────────────────────────────────
def _password() -> str:
    pw = os.environ.get("DASHBOARD_PASSWORD")
    if not pw:
        raise RuntimeError("환경변수 DASHBOARD_PASSWORD 가 설정되지 않았습니다.")
    return pw


def _fetch(url: str, local_name: str) -> str:
    """라이브 URL 우선, 실패 시 레포 로컬 site/<local_name> 폴백."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "vp-interndog-mcp/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode("utf-8")
    except Exception:
        path = os.path.join(HERE, "site", local_name)
        with open(path, encoding="utf-8") as f:
            return f.read()


def _decrypt_js(js_text: str) -> dict:
    """`window.__X__ = {...};` 형태에서 JSON을 뽑아 복호화한 payload(dict) 반환."""
    enc = json.loads(js_text[js_text.index("{"):js_text.rindex("}") + 1])
    key = PBKDF2HMAC(algorithm=SHA256(), length=32,
                     salt=base64.b64decode(enc["salt"]),
                     iterations=enc["iters"]).derive(_password().encode())
    pt = AESGCM(key).decrypt(base64.b64decode(enc["iv"]),
                             base64.b64decode(enc["ct"]), None)
    return json.loads(pt.decode())


_CACHE: dict = {}


def _amz() -> dict:
    if "amz" not in _CACHE:
        _CACHE["amz"] = _decrypt_js(_fetch(DATA_URL, "data.js"))
    return _CACHE["amz"]


def _voc() -> dict:
    if "voc" not in _CACHE:
        _CACHE["voc"] = _decrypt_js(_fetch(VOC_URL, "voc.js"))
    return _CACHE["voc"]


# ── 집계 헬퍼 ─────────────────────────────────────────────────────────────
def _bucket(d: str, gran: str) -> str:
    if gran == "daily":
        return d
    if gran == "monthly":
        return d[:7]
    if gran == "yearly":
        return d[:4]
    y, m, day = map(int, d.split("-"))
    if gran == "quarterly":
        return f"{y}-Q{(m - 1) // 3 + 1}"
    if gran == "weekly":
        iso = date(y, m, day).isocalendar()
        return f"{iso[0]}-W{iso[1]:02d}"
    return d


def _aggregate(series: list, gran: str) -> list:
    out: dict = {}
    for r in series:
        k = _bucket(r["date"], gran)
        b = out.setdefault(k, {"period": k, "sales": 0.0, "units": 0,
                               "sessions": 0, "pageViews": 0, "days": 0})
        b["sales"] += r.get("sales", 0)
        b["units"] += r.get("units", 0)
        b["sessions"] += r.get("sessions", 0)
        b["pageViews"] += r.get("pageViews", 0)
        b["days"] += 1
    rows = sorted(out.values(), key=lambda x: x["period"])
    for b in rows:
        b["sales"] = round(b["sales"], 2)
        b["conv"] = round(b["units"] / b["sessions"] * 100, 3) if b["sessions"] else 0.0
    return rows


def _recent_daily(series: list, days: int = 28) -> dict:
    """최근 N일 일평균(판매·세션·전환)."""
    tail = series[-days:] if len(series) > days else series
    n = max(1, len(tail))
    units = sum(r.get("units", 0) for r in tail)
    sess = sum(r.get("sessions", 0) for r in tail)
    sales = sum(r.get("sales", 0) for r in tail)
    return {
        "window_days": len(tail),
        "daily_units": round(units / n, 3),
        "daily_sessions": round(sess / n, 1),
        "daily_sales": round(sales / n, 2),
        "conv_pct": round(units / sess * 100, 3) if sess else 0.0,
    }


# ── 도구 ──────────────────────────────────────────────────────────────────
@mcp.tool()
def get_summary() -> dict:
    """최신 KPI 요약: 마지막 날짜 실적과 최근 7/14/28일 집계(매출·주문·세션·전환·바이박스)."""
    d = _amz()
    s = d["series"]
    if not s:
        return {"error": "series 비어있음"}

    def agg(n):
        t = s[-n:] if len(s) > n else s
        units = sum(r.get("units", 0) for r in t)
        sess = sum(r.get("sessions", 0) for r in t)
        return {
            "days": len(t),
            "sales": round(sum(r.get("sales", 0) for r in t), 2),
            "units": units,
            "sessions": sess,
            "conv_pct": round(units / sess * 100, 3) if sess else 0.0,
            "buybox_pct": round(sum(r.get("buybox", 0) for r in t) / max(1, len(t)), 2),
        }

    last = s[-1]
    return {
        "generated": d.get("generated"),
        "timezone": d.get("tz"),
        "range": {"start": s[0]["date"], "end": last["date"], "days": len(s)},
        "latest_day": {
            "date": last["date"], "sales": last.get("sales"),
            "units": last.get("units"), "sessions": last.get("sessions"),
            "conv_pct": last.get("conv"), "buybox_pct": last.get("buybox"),
        },
        "recent_7d": agg(7),
        "recent_14d": agg(14),
        "recent_28d": agg(28),
    }


@mcp.tool()
def get_sales_series(granularity: str = "daily", start: str = "", end: str = "",
                     limit: int = 0) -> dict:
    """매출 시계열을 집계해 반환.

    granularity: daily | weekly | monthly | quarterly | yearly
    start/end:   'YYYY-MM-DD' (선택, 포함 범위 필터)
    limit:       최근 N개 구간만 (0=전체)
    """
    gran = granularity.lower()
    if gran not in ("daily", "weekly", "monthly", "quarterly", "yearly"):
        return {"error": f"granularity 값 오류: {granularity}"}
    s = _amz()["series"]
    if start:
        s = [r for r in s if r["date"] >= start]
    if end:
        s = [r for r in s if r["date"] <= end]
    rows = _aggregate(s, gran)
    if limit and limit > 0:
        rows = rows[-limit:]
    return {"granularity": gran, "count": len(rows), "series": rows}


@mcp.tool()
def get_products(limit: int = 20) -> dict:
    """ASIN별 상품 성과(매출 내림차순). 리포트 기간 누적치."""
    p = _amz().get("products", [])
    return {"count": len(p), "products": p[:limit] if limit else p}


@mcp.tool()
def get_inventory() -> dict:
    """FBA 재고 목록 + 계정 단위 소진 예상(최근 28일 일평균 판매 기준)."""
    d = _amz()
    inv = d.get("inventory", [])
    total_avail = sum(i.get("available", 0) or 0 for i in inv)
    rd = _recent_daily(d["series"])
    dpd = rd["daily_units"]
    days_left = round(total_avail / dpd) if dpd > 0 else None
    depletion = None
    if days_left is not None:
        depletion =(date.fromisoformat(d["series"][-1]["date"])
                     + timedelta(days=days_left)).isoformat()
    return {
        "total_available": total_avail,
        "recent": rd,
        "days_to_deplete": days_left,
        "estimated_depletion_date": depletion,
        "note": "계정 합계 기준 추정 — SKU/ASIN 매핑이 어긋나면 상품별 정확도는 제한적",
        "items": inv,
    }


@mcp.tool()
def forecast_depletion(conversion_pct: float) -> dict:
    """전환율 what-if: 목표 전환율일 때 일 판매량과 재고 소진 시점 추정.

    최근 28일 일평균 세션은 유지된다고 가정. conversion_pct 예: 2.0 (=2%)
    """
    d = _amz()
    rd = _recent_daily(d["series"])
    daily_units = rd["daily_sessions"] * conversion_pct / 100.0
    total_avail = sum(i.get("available", 0) or 0 for i in d.get("inventory", []))
    days_left = round(total_avail / daily_units) if daily_units > 0 else None
    depletion = None
    if days_left is not None:
        depletion =(date.fromisoformat(d["series"][-1]["date"])
                     + timedelta(days=days_left)).isoformat()
    return {
        "assumed_conversion_pct": conversion_pct,
        "assumed_daily_sessions": rd["daily_sessions"],
        "projected_daily_units": round(daily_units, 2),
        "current_conversion_pct": rd["conv_pct"],
        "total_available": total_avail,
        "days_to_deplete": days_left,
        "estimated_depletion_date": depletion,
    }


@mcp.tool()
def get_voc_summary(product: str = "") -> dict:
    """CS·VOC 유형 집계. product 지정 시(예: '시그널링'/'수너') 해당 제품 티켓만."""
    v = _voc()
    cats = v.get("cats", [])
    tickets = v.get("tickets", [])
    if product:
        filt = [t for t in tickets if t.get("p") == product]
        counts: dict = {}
        for t in filt:
            name = cats[t["c"]]["name"] if 0 <= t["c"] < len(cats) else str(t["c"])
            counts[name] = counts.get(name, 0) + 1
        ranked = sorted(counts.items(), key=lambda x: -x[1])
        return {"product": product, "ticket_count": len(filt),
                "by_category": [{"name": k, "count": c} for k, c in ranked]}
    return {
        "channel": v.get("channel"),
        "total_tickets": v.get("total"),
        "noise_excluded": v.get("noise"),
        "products": v.get("prods", []),
        "categories": sorted(cats, key=lambda x: -x.get("count", 0)),
    }


if __name__ == "__main__":
    mcp.run()
