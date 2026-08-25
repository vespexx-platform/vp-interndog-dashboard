/**
 * vp-interndog 원격 MCP 서버 (Cloudflare Worker · Streamable HTTP).
 *
 * 암호화된 data.js/voc.js를 Worker 시크릿(DASHBOARD_PASSWORD)으로 서버에서 복호화해
 * 6개 도구로 노출한다. 키는 Worker 밖으로 나가지 않는다.
 * Claude(claude.ai / Desktop)에 커스텀 커넥터로 URL(…/mcp)을 추가하면 붙는다.
 *
 * 인증: 기본은 MCP_BEARER 시크릿이 있으면 Bearer 토큰 요구.
 *       제대로 하려면 Cloudflare Access(Google IdP + @vespexx.com)를 앞단에 두고
 *       Claude가 Access OAuth로 인증하게 한다(대시보드 구글 로그인과 동일 메커니즘).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  DASHBOARD_PASSWORD: string;
  MCP_BEARER?: string;
  VP_DATA_URL?: string;
  VP_VOC_URL?: string;
}

const BASE = "https://vespexx-platform.github.io/vp-interndog-dashboard";

// ── 복호화 (브라우저 대시보드와 동일 포맷: PBKDF2-SHA256 + AES-256-GCM) ──────
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function decryptJs(jsText: string, password: string): Promise<any> {
  const enc = JSON.parse(jsText.slice(jsText.indexOf("{"), jsText.lastIndexOf("}") + 1));
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64(enc.salt), iterations: enc.iters, hash: "SHA-256" },
    km, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(enc.iv) }, key, b64(enc.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// 아이솔레이트 수명 동안 60초 캐시
const cache = new Map<string, { at: number; data: any }>();
async function load(env: Env, which: "amz" | "voc"): Promise<any> {
  const hit = cache.get(which);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;
  const url = which === "amz" ? (env.VP_DATA_URL ?? `${BASE}/data.js`) : (env.VP_VOC_URL ?? `${BASE}/voc.js`);
  const res = await fetch(url, { headers: { "User-Agent": "vp-interndog-mcp/1.0" } });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  const data = await decryptJs(await res.text(), env.DASHBOARD_PASSWORD);
  cache.set(which, { at: Date.now(), data });
  return data;
}

// ── 집계 헬퍼 ─────────────────────────────────────────────────────────────
function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((t.getTime() - yStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(w).padStart(2, "0")}`;
}
function bucket(date: string, gran: string): string {
  if (gran === "daily") return date;
  if (gran === "monthly") return date.slice(0, 7);
  if (gran === "yearly") return date.slice(0, 4);
  const [y, m] = date.split("-").map(Number);
  if (gran === "quarterly") return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
  if (gran === "weekly") return isoWeek(new Date(date + "T00:00:00Z"));
  return date;
}
function aggregate(series: any[], gran: string) {
  const out = new Map<string, any>();
  for (const r of series) {
    const k = bucket(r.date, gran);
    const b = out.get(k) ?? { period: k, sales: 0, units: 0, sessions: 0, pageViews: 0, days: 0 };
    b.sales += r.sales ?? 0; b.units += r.units ?? 0; b.sessions += r.sessions ?? 0;
    b.pageViews += r.pageViews ?? 0; b.days += 1;
    out.set(k, b);
  }
  return [...out.values()].sort((a, b) => a.period.localeCompare(b.period)).map((b) => ({
    ...b, sales: Math.round(b.sales * 100) / 100,
    conv: b.sessions ? Math.round((b.units / b.sessions) * 1000) / 10 : 0,
  }));
}
function recentDaily(series: any[], days = 28) {
  const tail = series.slice(-days);
  const n = Math.max(1, tail.length);
  const units = tail.reduce((x, r) => x + (r.units ?? 0), 0);
  const sess = tail.reduce((x, r) => x + (r.sessions ?? 0), 0);
  const sales = tail.reduce((x, r) => x + (r.sales ?? 0), 0);
  return {
    window_days: tail.length,
    daily_units: Math.round((units / n) * 1000) / 1000,
    daily_sessions: Math.round((sess / n) * 10) / 10,
    daily_sales: Math.round((sales / n) * 100) / 100,
    conv_pct: sess ? Math.round((units / sess) * 1000) / 10 : 0,
  };
}
const addDays = (iso: string, d: number) => {
  const t = new Date(iso + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
};
const asText = (obj: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

// ── MCP 서버 ──────────────────────────────────────────────────────────────
export class VpInterndogMCP extends McpAgent<Env, {}, {}> {
  server = new McpServer({ name: "vp-interndog", version: "1.0.0" });
  initialState = {};

  async init() {
    const env = this.env;

    this.server.registerTool("get_summary",
      { description: "최신 KPI 요약: 마지막 날짜 실적 + 최근 7/14/28일 집계(매출·주문·세션·전환·바이박스)", inputSchema: {} },
      async () => {
        const d = await load(env, "amz"); const s = d.series;
        const agg = (n: number) => {
          const t = s.slice(-n); const units = t.reduce((x: number, r: any) => x + (r.units ?? 0), 0);
          const sess = t.reduce((x: number, r: any) => x + (r.sessions ?? 0), 0);
          return {
            days: t.length, sales: Math.round(t.reduce((x: number, r: any) => x + (r.sales ?? 0), 0) * 100) / 100,
            units, sessions: sess, conv_pct: sess ? Math.round((units / sess) * 1000) / 10 : 0,
            buybox_pct: Math.round((t.reduce((x: number, r: any) => x + (r.buybox ?? 0), 0) / Math.max(1, t.length)) * 100) / 100,
          };
        };
        const last = s[s.length - 1];
        return asText({
          generated: d.generated, timezone: d.tz,
          range: { start: s[0].date, end: last.date, days: s.length },
          latest_day: { date: last.date, sales: last.sales, units: last.units, sessions: last.sessions, conv_pct: last.conv, buybox_pct: last.buybox },
          recent_7d: agg(7), recent_14d: agg(14), recent_28d: agg(28),
        });
      });

    this.server.registerTool("get_sales_series",
      {
        description: "매출 시계열 집계. granularity=daily|weekly|monthly|quarterly|yearly, start/end='YYYY-MM-DD'(선택), limit=최근 N구간(0=전체)",
        inputSchema: {
          granularity: z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"]).default("daily"),
          start: z.string().optional(), end: z.string().optional(), limit: z.number().int().default(0),
        },
      },
      async ({ granularity, start, end, limit }) => {
        const d = await load(env, "amz");
        let s = d.series as any[];
        if (start) s = s.filter((r) => r.date >= start);
        if (end) s = s.filter((r) => r.date <= end);
        let rows = aggregate(s, granularity);
        if (limit && limit > 0) rows = rows.slice(-limit);
        return asText({ granularity, count: rows.length, series: rows });
      });

    this.server.registerTool("get_products",
      { description: "ASIN별 상품 성과(매출 내림차순, 리포트 기간 누적). limit=상위 N개", inputSchema: { limit: z.number().int().default(20) } },
      async ({ limit }) => {
        const d = await load(env, "amz"); const p = d.products ?? [];
        return asText({ count: p.length, products: limit ? p.slice(0, limit) : p });
      });

    this.server.registerTool("get_inventory",
      { description: "FBA 재고 목록 + 계정 단위 소진 예상(최근 28일 일평균 판매 기준)", inputSchema: {} },
      async () => {
        const d = await load(env, "amz"); const inv = d.inventory ?? [];
        const total = inv.reduce((x: number, i: any) => x + (i.available || 0), 0);
        const rd = recentDaily(d.series);
        const days = rd.daily_units > 0 ? Math.round(total / rd.daily_units) : null;
        const last = d.series[d.series.length - 1].date;
        return asText({
          total_available: total, recent: rd, days_to_deplete: days,
          estimated_depletion_date: days != null ? addDays(last, days) : null,
          note: "계정 합계 기준 추정 — SKU/ASIN 매핑이 어긋나면 상품별 정확도는 제한적", items: inv,
        });
      });

    this.server.registerTool("forecast_depletion",
      { description: "전환율 what-if: 목표 전환율(예 2.0=2%)일 때 일 판매량·재고 소진 시점 추정(최근 28일 일평균 세션 유지 가정)", inputSchema: { conversion_pct: z.number() } },
      async ({ conversion_pct }) => {
        const d = await load(env, "amz"); const rd = recentDaily(d.series);
        const dailyUnits = (rd.daily_sessions * conversion_pct) / 100;
        const total = (d.inventory ?? []).reduce((x: number, i: any) => x + (i.available || 0), 0);
        const days = dailyUnits > 0 ? Math.round(total / dailyUnits) : null;
        const last = d.series[d.series.length - 1].date;
        return asText({
          assumed_conversion_pct: conversion_pct, assumed_daily_sessions: rd.daily_sessions,
          projected_daily_units: Math.round(dailyUnits * 100) / 100, current_conversion_pct: rd.conv_pct,
          total_available: total, days_to_deplete: days,
          estimated_depletion_date: days != null ? addDays(last, days) : null,
        });
      });

    this.server.registerTool("get_voc_summary",
      { description: "CS·VOC 유형 집계. product 지정 시(예 '시그널링'/'수너') 해당 제품 티켓만", inputSchema: { product: z.string().optional() } },
      async ({ product }) => {
        const v = await load(env, "voc");
        const cats = v.cats ?? []; const tickets = v.tickets ?? [];
        if (product) {
          const filt = tickets.filter((t: any) => t.p === product);
          const counts = new Map<string, number>();
          for (const t of filt) {
            const name = cats[t.c]?.name ?? String(t.c);
            counts.set(name, (counts.get(name) ?? 0) + 1);
          }
          const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
          return asText({ product, ticket_count: filt.length, by_category: ranked });
        }
        return asText({
          channel: v.channel, total_tickets: v.total, noise_excluded: v.noise,
          products: v.prods ?? [], categories: [...cats].sort((a: any, b: any) => (b.count ?? 0) - (a.count ?? 0)),
        });
      });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("vp-interndog MCP server · connect to /mcp", { status: 200 });
    if (url.pathname.startsWith("/mcp")) {
      // 선택적 Bearer 게이트(Access를 앞단에 두면 생략 가능)
      if (env.MCP_BEARER) {
        const auth = request.headers.get("Authorization") ?? "";
        if (auth !== `Bearer ${env.MCP_BEARER}`) {
          return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
        }
      }
      return VpInterndogMCP.serve("/mcp", { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};
