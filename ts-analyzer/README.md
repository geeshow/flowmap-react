# flowmap-react

React 프로젝트를 **정적 분석**해서 화면(screen)·컴포넌트·외부 API 호출·상태관리 스토어의
연결관계를 **node-link 그래프 JSON**으로 뽑아내고, 백엔드 분석기
[`flowmap-spring-kotlin`](../../flowmap-spring-kotlin)의 결과와 **조인 파일**로 잇는 도구입니다.

속도보다 **정밀도**를 우선합니다 — 백엔드가 Kotlin 컴파일러(K1) 프론트엔드로 정밀 분석하듯,
이 도구는 **TypeScript Compiler API(Program + TypeChecker)** 를 의미 분석의 토대로 사용합니다
(타입체커 = 백엔드의 `BindingContext` 대응). 정규식/Babel과 달리 import를 교차 파일로 따라가
`컴포넌트 → API 래퍼 함수 → axios 인스턴스(baseURL) → env 변수`까지 추적해 실제 URL을 복원합니다.

## 분석 결과에 담기는 것

- **화면/페이지**: react-router(`createBrowserRouter`/`<Route>`/lazy) 및 Next.js(`pages/`·`app/`) 라우팅
- **컴포넌트 연결관계**: 페이지→컴포넌트, 컴포넌트→컴포넌트 (JSX 렌더 + import), 컴포넌트→커스텀 훅
- **외부 API 호출**: axios/fetch/래퍼의 **HTTP 메서드 + URL**을 상수·env·baseURL·경로 파라미터까지 해석
  (`/users/${id}` → `/users/{}`), 해석도(`resolved`/`partial`/`unresolved`) 표기
- **상태관리 스토어**: Redux Toolkit 슬라이스, Zustand, React Context와 컴포넌트의 read/dispatch 연결

## 사용법

```bash
npm install
npm run build          # dist/ 생성 (또는 npm run cli -- <args> 로 ts-node 직접 실행)

# 분석: .repo/<project> 아래 React 프로젝트를 그래프로
node dist/cli.js analyze --repo ../.repo --project sample-shop-react --out ../json/front.json

# 백엔드 그래프와 조인 (별도 조인 파일 생성, 그래프는 병합하지 않음)
node dist/cli.js join --graph ../json/front.json \
  --backend ../../flowmap-spring-kotlin/kotlin-analyzer/json/_combined.json \
  --out ../json/join.json

# 커버리지/통계
node dist/cli.js stats --graph ../json/front.json

# 특정 노드의 호출/피호출 서브그래프 (BFS)
node dist/cli.js search --graph ../json/front.json --method UserPage --direction callees --depth 2

# 화면 와이어프레임 데이터 (영향도 분석 웹에서 화면 형태 그리기용)
node dist/cli.js screens --repo ../.repo --project sample-shop-react --out ../json/screens.json
```

분석 대상은 백엔드와 같은 관례로 `.repo/<project>/` 아래에 둡니다. React가 아닌 프로젝트
(예: Vue/Nuxt)는 자동으로 건너뜁니다.

## 출력 스키마 (백엔드와 호환)

백엔드와 동일한 envelope `{ directed, multigraph, meta, nodes[], edges[] }` 와 동일한
`MethodNode`/`CallEdge` 필드를 재사용합니다. 프론트엔드는 `layer` 어휘를 확장하고
(`SCREEN`/`COMPONENT`/`HOOK`/`STORE`/`API`/`EXTERNAL`) API/EXTERNAL 노드에 additive 키
`confidence`를 채웁니다. 엣지 `relation`: `route`/`render`/`call`/`dispatch`/`store:read`/`http`.

### 조인 키 (가장 중요)

프론트 API/EXTERNAL 노드는 `(httpMethod, 정규화 경로)`로 백엔드 CONTROLLER 노드와 매칭됩니다.
경로 정규화(`src/norm.ts`)는 백엔드 `RestDocs.normalize` / `CrossRun.normPath`를 **바이트 단위로
동일하게** 포팅했고, 골든 테이블 테스트로 드리프트를 막습니다. 매칭 불가(서드파티/verb 불일치)는
조인 파일에 `unmatched`로 **명시 나열**되어 커버리지를 감사할 수 있습니다.

## 화면 와이어프레임 (`screens`)

`screens` 명령은 영향도 분석 웹에서 **화면 형태를 간단히 그려내기 위한 구조 데이터**를 만듭니다.
JSX를 AST로 파싱해 화면별 레이아웃 트리(호스트 요소 중첩 + 자식 컴포넌트 + 정적 텍스트 +
조건/리스트 렌더)를 추출합니다. 픽셀 단위 레이아웃(위치/크기)은 CSS·런타임이 필요해 범위 밖이며,
**구조적 와이어프레임**까지 제공합니다.

```jsonc
{
  "meta": { "command": "screens", "screens": 3, "components": 5 },
  "screens": [ { "id": "...::UserPage", "name": "UserPage", "route": "/users/{}", "file": "..." } ],
  "components": {
    "...::UserCard": {
      "id": "...::UserCard", "name": "UserCard", "kind": "component", "file": "...", "line": 4,
      "root": {
        "tag": "div", "kind": "host", "props": { "className": "user-card" },
        "children": [
          { "tag": "span", "kind": "host", "children": [ { "tag": "#expr", "kind": "expression", "text": "name" } ] },
          { "tag": "#cond", "kind": "conditional", "text": "auth.token",
            "children": [ { "tag": "em", "kind": "host", "children": [ { "tag": "#text", "kind": "text", "text": "authed" } ] } ] }
        ]
      }
    }
  }
}
```

노드 `kind`: `host`(div/button/…) · `component`(자식 컴포넌트, `componentId`로 드릴다운) ·
`text` · `fragment` · `list`(`.map`) · `conditional`(`?:`/`&&`) · `expression`(동적 `{값}`).
`screens[].id` / `components` 키 / `componentId`는 그래프·조인 출력의 노드 id와 동일해서,
화면 와이어프레임 ↔ 호출 그래프 ↔ 백엔드 영향도를 한 id로 연결할 수 있습니다.

## 설계 (백엔드 구조를 미러링)

```
src/
  norm.ts            # 조인 키 정규화 (백엔드와 동일)  ← 가장 중요
  model.ts           # node-link 스키마 (Model.kt)
  ir.ts              # IR 타입 + Resolver 인터페이스 (Ir.kt)
  classify.ts        # 클라이언트/스토어/라우터 시그니처 테이블 (Classify.kt)
  jsonOutput.ts      # 그래프 읽기/쓰기 (JsonOutput.kt)
  graphBuilder.ts    # 순수 IR → 그래프 (GraphBuilder.kt)
  join.ts            # 프론트 → 백엔드 조인 (CrossRun.kt의 매칭 로직)
  bfs.ts             # search 서브그래프 (Bfs.kt)
  cli.ts             # analyze/join/search/stats (Cli.kt)
  resolver/
    program.ts          # ts.Program + TypeChecker 구성 (AnalysisSession.kt)
    constantEvaluator.ts# 문자열/URL folding (ConstantEvaluator.kt)   ← 정밀도 핵심
    apiCallResolver.ts  # axios/fetch + 래퍼 추적 (ExternalResolver.kt) ← 핵심
    envResolver.ts      # .env / import.meta.env (YamlPropertyResolver.kt)
    routeResolver.ts    # react-router + Next.js 라우트
    storeResolver.ts    # Redux/Zustand/Context
    context.ts          # 심볼/컴포넌트 id/모듈 해석 공용
    irBuilder.ts        # 패스 오케스트레이션 → IrFile[]
```

순수 계층(`model`/`graphBuilder`/`join`/`norm`)에는 `ts.*` 타입이 새지 않습니다 — 파서를 교체해도
`Resolver`만 갈아끼우면 됩니다.

## 테스트

```bash
npm test
```

- `norm.spec` — 백엔드 골든 테이블로 조인 키 바이트 동일성
- `graphBuilder.spec` / `join.spec` — 순수 로직 (레이어·엣지·dedup, matched/unmatched/ambiguous)
- `e2e.spec` — `.repo/sample-shop-react` 픽스처에 전체 파이프라인 실행 후 백엔드 `_combined.json`과
  조인까지 검증 (래퍼 추적·env·baseURL·라우트·스토어 end-to-end)
