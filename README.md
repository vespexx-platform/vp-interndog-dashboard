# Amazon 판매 대시보드 (비밀번호 보호)

아마존 셀러센트럴(Amazon US) 데이터를 보여주는 정적 웹 대시보드. GitHub Pages 호스팅, **클라이언트 AES 암호화**로 보호.

> **인수인계·전체 시스템 구조는 [AGENTS.md](./AGENTS.md) 참고.** (Make 토폴로지, ID, 시크릿, 데이터 흐름, 함정 포함)
> **이 레포는 PUBLIC — 시크릿 값을 코드/문서에 넣지 말 것.**

## 화면
- **개요** — 매출·세션(막대+선), KPI(최근일/최근7일, 기준 날짜 표시)
- **트래픽·전환** — 전환율/바이박스 별도 차트 + 퍼센티지 KPI
- **상품(ASIN)** — 상품별 매출·전환·바이박스 (상품명 3줄 클램프)
- **재고** — FBA 가용/품절/저재고 (SKU별, 저재고 강조)
- **날짜별** — 월 페이지네이션 표
- 상단 토글: **일·주·월·분기·년** 집계(모든 차트 공통, 기본 **일**)
- 그레이스케일 UI(차트만 색상), 라이트/다크·반응형

## 동작 요약
```
GitHub Actions (매일 18:22 KST, deploy.yml)
 → build_data.py: Make Data Store('latest'/'inventory'/'listings') 읽기
   → 레포에 커밋된 암호화 히스토리와 병합·누적(2026-05-01~)
   → PBKDF2(200k)+AES-256-GCM 암호화 → site/data.js 커밋(영속)
 → GitHub Pages 배포
브라우저: 비밀번호 입력 → Web Crypto 복호화 → 렌더
```
데이터 소스(아마존)는 **Make**가 SP-API 리포트로 수집(개발자 등록/KYC 회피). 상세는 AGENTS.md.

## 설정
### GitHub Secrets (Settings → Secrets and variables → Actions)
`MAKE_API_TOKEN`, `MAKE_ZONE`, `MAKE_STORE_ID`, `DASHBOARD_PASSWORD`

### Pages
Settings → Pages → Source: **GitHub Actions**

### 로컬 실행
```bash
pip install cryptography
export MAKE_API_TOKEN=... MAKE_ZONE=us2.make.com MAKE_STORE_ID=121830 DASHBOARD_PASSWORD=...
python build_data.py
python -m http.server 8765 --directory site   # localhost = secure context(Web Crypto 필요)
```

## 보안 메모
- 공개 URL엔 **암호문만** 노출. 보안 강도는 `DASHBOARD_PASSWORD`에 의존 → **길고 무작위한 값 권장**.
- 비번 변경 시 대시보드 레포 + `vp-interndog` 레포의 `DASHBOARD_PASSWORD`를 **동일하게** 바꾸고 각 워크플로 재실행.
- `robots noindex`로 검색 노출 차단.
