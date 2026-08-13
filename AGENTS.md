# AGENTS.md — Amazon 판매 리포트/대시보드 시스템 인수인계

이 문서 하나로 전체 시스템을 파악하고 이어서 작업할 수 있도록 작성함.
**이 레포는 PUBLIC이다. 시크릿 값(토큰·비밀번호·웹훅 URL)을 이 파일이나 코드에 절대 넣지 말 것.**

## 1. 무엇을 하는가
아마존 셀러센트럴(Amazon US) 판매 데이터를 두 가지로 전달:
1. **Slack 리포트** — 일간(매일)·주간(월요일). 매출/트래픽/전환/바이박스 + 차트 + 대시보드 버튼 + 비번 스레드.
2. **웹 대시보드** — 비밀번호로 보호되는 정적 SPA(GitHub Pages). 개요/트래픽·전환/상품(ASIN)/재고/날짜별, 일·주·월·분기·년 집계.

## 2. 왜 이런 구조인가 (핵심 제약)
- **직접 SP-API 불가** — 개발자 등록 + 신원인증(KYC) 장벽. 그래서 **Make(Integromat)**가 아마존 OAuth를 쥐고 데이터만 뽑는다.
- **Make 커넥터 한계** — 실제 모듈은 `listOrders/getOrder/createReport/downloadFile/getReport/getCatalogItem` 뿐. **인벤토리 API·범용 API호출 모듈 없음** → 모든 데이터는 **Reports API 배치**로만 가능.
- **Make Data Store 1MB 상한**(무료 플랜, 증가 불가) → Make엔 최근 창만, 전체 히스토리는 **레포에 암호화 커밋으로 누적**.
- **GitHub 무료 + private 레포는 Pages 불가** → 대시보드는 **public 레포**. 대신 데이터를 **클라이언트 AES 암호화**해서 공개돼도 암호문만 노출.

## 3. 두 개의 레포
| 레포 | 공개 | 역할 |
|---|---|---|
| `vespexx-platform/vp-interndog-dashboard` (이 레포) | **PUBLIC** | 웹 대시보드(Pages) + 데이터 빌드/암호화/누적 |
| `vespexx-platform/amazon-sales-report` | PRIVATE | Slack 일간·주간 리포트 발송 |

## 4. 데이터 흐름
```
[Amazon SP-API]
     │  (OAuth 연결: Make의 Amazon Seller Central connection, id=10062314)
     ▼
[Make 시나리오]  ──▶  [Make Data Store id=121830]  키:
  · S&T Store (일 1회)         → 'latest'    (S&T 리포트 JSON, gzip→base64)
  · FBA Inventory+Listings(2회)→ 'inventory' (AFN 재고 TSV, 평문)
                               → 'listings'  (리스팅 TSV, gzip)
     ▲                                  │
     │ Make API로 읽기(토큰)             │
     │                                  ▼
[GitHub Actions + Python]  ─ 두 레포 각각의 워크플로가 store를 읽어 처리
  · amazon-sales-report:  amazon_report.py  → Slack (chat.postMessage + 파일업로드)
  · vp-interndog-dashboard:     build_data.py     → 히스토리 병합/암호화 → site/data.js 커밋 → Pages 배포
```
Make는 데이터 공급만. **집계·포맷·전송은 전부 Python**(과거 Make 수식으로 하려다 지옥을 봄, §9 참고).

## 5. Make 리소스 (ID는 시크릿 아님)
- Zone `us2.make.com`, Team `2595843`, Org `8450149` (무료 플랜)
- Amazon Seller Central connection: **10062314**
- Data Store: **121830** (structure 436773, maxSize 1MB)
- Marketplace(US): `ATVPDKIKX0DER`
- 시나리오:
  | id | 이름 | 리포트/동작 | 스케줄(KST) | 활성 |
  |---|---|---|---|---|
  | 5740661 | Amazon S&T Store (500d) | `GET_SALES_AND_TRAFFIC_REPORT`(DAY, 최근 500일, PARENT) → download → gunzip → store 'latest' | 매일 17:30 | ON |
  | 5743075 | Amazon FBA Inventory + Listings | `GET_AFN_INVENTORY_DATA`→'inventory' + `GET_MERCHANT_LISTINGS_ALL_DATA`→'listings' | 매일 09:00·17:00 | ON |
  | 5740344 | (구) Amazon Daily Sales Report | 폐기(Python으로 대체) | daily 10:00 | off |
  | 5740727 | fn test | 디버깅 잔재 | — | off |
- webhook hook 2609695: 동기 응답 시도했다 폐기(미사용).
- **store 정리 필요(선택)**: 'latest/inventory/listings' 외 옛 진단 키(`trend,fullbody,sums,fntest,raw,inv_raw`)가 남아있음. 무해하지만 삭제 가능.

## 6. GitHub Actions & 시크릿(이름만)
**vp-interndog-dashboard** — `.github/workflows/deploy.yml` (cron `22 9 * * *` = 18:22 KST, +commit-back)
- Secrets: `MAKE_API_TOKEN`, `MAKE_ZONE`, `MAKE_STORE_ID`, `DASHBOARD_PASSWORD`
- `permissions: contents:write`(data.js 커밋백) + `pages:write` + `id-token:write`

**amazon-sales-report** — `daily.yml`(cron `17 9 * * *`=18:17 KST), `weekly.yml`(cron `13 1 * * 1`=월 10:13 KST)
- Secrets: `MAKE_API_TOKEN`, `MAKE_ZONE`, `MAKE_STORE_ID`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL`, `SLACK_WEBHOOK_URL`, `DASHBOARD_PASSWORD`
- Variables: `DASHBOARD_URL`, `SELLER_CENTRAL_URL`
- 봇 앱 스코프: `chat:write`, `files:write`. 채널에 봇 초대돼 있어야 함.
- 봇 미설정 시 `SLACK_WEBHOOK_URL`로 폴백(텍스트만, 차트 없음).

> **크론 주의**: 정각(:00)은 GitHub 러너 부하로 예약 누락 잦음 → 홀수 분 사용 중. 그래도 best-effort라 가끔 누락됨. 놓치면 Actions 탭 → Run workflow.

## 7. 암호화 & 누적 (핵심 로직)
- `build_data.py`가 `DASHBOARD_PASSWORD`로 **PBKDF2-SHA256(200k) → AES-256-GCM** 암호화, `site/data.js`에 `window.__ENC__ = {salt,iv,iters,ct}` (전부 base64) 기록.
- 프론트(`index.html`)는 Web Crypto로 브라우저에서 복호화. **secure context 필요**(https/localhost).
- **누적**: build_data가 (1) Make 'latest' 최근치 + (2) 레포에 커밋된 기존 `site/data.js` 복호화본을 날짜로 병합 → `HISTORY_START`(기본 `2026-05-01`) 이후만 남김 → 재암호화 → 워크플로가 커밋(`chore: accumulate sales history`). Make에서 오래된 날짜가 빠져도 레포에 영구 누적.
- 비번 변경 시: 기존 data.js 복호화 실패 → 경고 후 최근 창으로 리셋(히스토리 유실). **두 레포의 `DASHBOARD_PASSWORD`를 항상 동일하게** 유지.

## 8. 파일 구조
```
vp-interndog-dashboard/
  build_data.py            store 읽기 → 병합/암호화 → site/data.js
  site/index.html          대시보드 SPA (게이트/복호화/차트/뷰)
  site/data.js             암호화된 누적 히스토리(커밋됨, 영속)
  .github/workflows/deploy.yml
amazon-sales-report/ (private)
  amazon_report.py         store 읽기 → 집계 → Slack(daily|weekly)
  .github/workflows/{daily,weekly}.yml
```
`site/index.html` 주요 함수: `decrypt`, `aggregate`(일/주/월/분기/년 버킷), `drawChart`, `buildView`, `renderKPIs`, `renderProducts`, `renderInventory`, `renderMonth`(날짜별 월 페이지네이션).

## 9. 함정 모음 (반복 삽질 방지)
- Make `map()`은 **중첩 경로 미지원** → `map(map(...))` 단계별. `avg()` 없음 → `sum/length`. `setTimezone()` 없음 → `formatDate/parseDate`에 TZ 인자.
- Make `formatNumber`는 로케일(콤마 소수점) → `formatNumber(x; n; "."; ",")`.
- Make Data Store에 **바이너리(gzip) blob은 base64**로 저장됨. 플랫파일 리포트는 gzip일 수도/아닐 수도 → Python `decode_blob()`가 base64/gzip/BOM 자동 처리.
- Make API는 **기본 python-urllib User-Agent를 WAF로 차단(403)** → UA 헤더 명시 필수.
- Slack: 업로드 이미지를 단일 blocks 메시지에 중복 없이 인라인 못 함 → 리포트는 "타이틀+차트 파일 메시지" + "지표+버튼 메시지" **2메시지**.
- 프론트: `requestAnimationFrame`은 **백그라운드 탭에서 fire 안 됨** → 뷰 전환은 `setTimeout`. 차트는 뷰 표시 후 lazy build(숨김 캔버스 폭 0 방지).
- data.js는 `?t=`(캐시버스터)로 로드(Pages `max-age=600` 캐시 회피).
- Amazon S&T는 **~2일 지연** → "최근일"은 항상 며칠 전. 정상. UI에 "지연 → 최신 가용일" 명시.
- FBA `GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA`는 Amazon fatal 잦음 → 안정적인 `GET_AFN_INVENTORY_DATA` 사용 중(가용수량만; 예약/입고중은 `-`). 파서는 양쪽 포맷 지원.

## 10. 로컬에서 만지는 법
```bash
pip install cryptography
export MAKE_API_TOKEN=... MAKE_ZONE=us2.make.com MAKE_STORE_ID=121830 DASHBOARD_PASSWORD=...
python build_data.py                 # site/data.js 생성
python -m http.server 8765 --directory site   # localhost(secure context)로 열어 복호화 테스트
```
Make 시나리오 수정/실행은 Make API(`/api/v2/scenarios/{id}` PATCH·`/run`)로 가능. blueprint를 통째로 PATCH하는 방식. 실행은 `/run {responsive:true}`.

## 11. 알려진 리스크 / TODO
- **DASHBOARD_PASSWORD가 임시·추측가능값이면** 공개 암호문에 대한 오프라인 브루트포스 여지 → 길고 무작위한 값으로 교체 권장(두 레포 동시).
- 재고 상세(예약/입고중/총재고)는 MYI 리포트가 안정화되면 자동 표시(파서 이미 대응).
- 광고(ACoS 등)는 SP-API 아님(별도 Amazon Ads API) → Make로 불가.
- "실시간 품절 알림"이 필요하면 Make를 벗어나 직접 SP-API + Notifications(SQS) 필요.
