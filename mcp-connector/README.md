# vp-interndog 원격 MCP 커넥터 (Cloudflare Worker)

대시보드의 매출·재고·VOC 데이터를 **원격 MCP 서버**로 노출한다. Claude(claude.ai · Desktop)에
**커스텀 커넥터**로 URL만 넣으면 붙는다. 로컬 stdio 서버(`../mcp_server.py`)와 동일한 6개 도구를
제공하되, 복호화는 **Worker 서버에서** 일어나고 키는 밖으로 나가지 않는다.

## 도구
`get_summary` · `get_sales_series` · `get_products` · `get_inventory` · `forecast_depletion` · `get_voc_summary`

## 배포 (Cloudflare 계정 필요)

```bash
cd mcp-connector
npm install
npx wrangler login                     # 최초 1회
npx wrangler secret put DASHBOARD_PASSWORD   # 대시보드 비밀번호 입력
npx wrangler secret put MCP_BEARER           # (선택) Access 미사용 시 최소 인증 토큰
npx wrangler deploy
```

배포되면 엔드포인트는 `https://vp-interndog-mcp.<너의-서브도메인>.workers.dev/mcp` 형태.

## Claude에 커넥터로 추가

- **claude.ai**: 설정 → 커넥터 → "커스텀 커넥터 추가" → 위 `/mcp` URL 입력.
- **Claude Desktop**: 설정 → 커넥터에서 원격 MCP URL 추가.
- `MCP_BEARER`를 설정했다면 커넥터의 인증 헤더에 `Authorization: Bearer <토큰>`을 넣는다
  (헤더 지정이 안 되는 UI라면 아래 Access 방식을 쓸 것).

## 권장 인증: Cloudflare Access (Google + @vespexx.com)

Bearer 토큰 대신 **Cloudflare Access**를 Worker 앞단에 두면, 구글 SSO + `@vespexx.com`
정책으로 커넥터 접근을 통제할 수 있다(대시보드 구글 로그인과 동일 메커니즘). 이 경우
Worker의 `MCP_BEARER`는 비워 두고, Claude는 Access의 OAuth 흐름으로 인증한다.

1. Cloudflare Zero Trust → Access → 이 Worker(커스텀 도메인 라우트)에 애플리케이션 추가
2. IdP=Google, 정책: 이메일 도메인 = `vespexx.com`
3. MCP용 OAuth를 허용하도록 Access 애플리케이션 설정

> 참고: `docs`의 "Securing MCP servers"(`@cloudflare/workers-oauth-provider`)로 Worker 자체에
> OAuth를 붙이는 방법도 있으나, 이미 Cloudflare를 쓰면 Access가 가장 적은 코드로 안전하다.

## 로컬 개발

```bash
echo "DASHBOARD_PASSWORD=..." > .dev.vars   # .dev.vars 는 gitignore됨
npx wrangler dev
```

## 보안 메모
- 공개 Pages의 암호문을 fetch해 **Worker에서만** 복호화 → 키(DASHBOARD_PASSWORD)는 클라이언트에 노출 안 됨.
- 단, 암호문이 공개인 한 **약한 비밀번호는 오프라인 크랙 위험** → 강한 랜덤 키 사용 권장(대시보드와 공유).
- 인증 없이 배포하면 URL을 아는 누구나 데이터를 받으므로, `MCP_BEARER` 또는 Access를 반드시 건다.
