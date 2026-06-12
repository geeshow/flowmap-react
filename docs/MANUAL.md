# flowmap-react 상세 매뉴얼

React 정적 분석기의 전체 명령어, 출력 스키마, 내부 동작, 한계, 확장 방법을 정리한 문서입니다.
개요와 빠른 시작은 [루트 README](../README.md), 분석기 설계 요약은
[ts-analyzer/README.md](../ts-analyzer/README.md)를 참고하세요.

## 목차

1. [철학과 동작 원리](#1-철학과-동작-원리)
2. [설치 및 요구사항](#2-설치-및-요구사항)
3. [분석 대상 배치](#3-분석-대상-배치)
4. [CLI 명령어](#4-cli-명령어)
5. [분석 파이프라인 (패스)](#5-분석-파이프라인-패스)
6. [출력 스키마 — 그래프](#6-출력-스키마--그래프)
7. [출력 스키마 — 조인 파일](#7-출력-스키마--조인-파일)
8. [출력 스키마 — 화면 레이아웃](#8-출력-스키마--화면-레이아웃)
9. [조인 키와 매칭 규칙](#9-조인-키와-매칭-규칙)
10. [정밀 URL/메서드 해석](#10-정밀-url메서드-해석)
11. [라우트 / 스토어 탐지](#11-라우트--스토어-탐지)
12. [한계](#12-한계)
13. [확장하기](#13-확장하기)
14. [테스트](#14-테스트)
15. [소스 구조](#15-소스-구조)

---

## 1. 철학과 동작 원리

자매 백엔드 도구 `flowmap-spring-kotlin`은 두 가지 구현을 둡니다 — 빠른 Python(정규식 휴리스틱)과
정밀한 Kotlin(컴파일러 K1 프론트엔드, PSI + BindingContext). 이 React 분석기는 **정밀도 우선**
철학을 따라, JS/TS의 실제 컴파일러인 **TypeScript Compiler API**를 사용합니다.

| | 정규식/Babel | **TypeScript Compiler API (이 도구)** |
|---|---|---|
| 심볼 해석 | 한 파일 한정, import 추적 불가 | `getSymbolAtLocation` + `getAliasedSymbol`로 **교차 파일** 선언까지 추적 |
| 클라이언트 식별 | 텍스트 매칭 | `getTypeAtLocation`으로 별칭된 인스턴스(`const http = axios.create()`)까지 식별 |
| 상수/URL folding | 불가 | 리터럴 타입 + 구조적 folding으로 `const`·템플릿·연결 해석 |

`TypeChecker`가 백엔드의 `BindingContext`에 대응합니다. 이 덕분에
`컴포넌트 → API 래퍼 함수 → axios 인스턴스(baseURL) → env 변수` 같은 **다단계 추적**이 가능합니다.

순수 계층(`model`/`graphBuilder`/`join`/`norm`)에는 `ts.*` 타입이 새지 않습니다. 파서를 교체해도
`Resolver` 인터페이스 구현만 바꾸면 됩니다(백엔드의 `Ir.kt` 격리 경계와 동일).

---

## 2. 설치 및 요구사항

- Node.js ≥ 18 (개발/검증은 Node 20에서 수행)
- 의존성: `typescript`(런타임 분석에 사용), 개발: `vitest`, `ts-node`, `@types/node`

```bash
cd ts-analyzer
npm install
npm run build          # dist/ 생성
# 또는 빌드 없이: npm run cli -- <command> <args>   (ts-node)
```

> **분석 대상의 `node_modules`는 설치 불필요**합니다. 프로젝트 내부 심볼은 소스만으로 해석되고,
> 서드파티(axios/fetch)는 라이브러리 타입이 아니라 **import 소스 문자열 + 호출 형태**로 탐지합니다.

---

## 3. 분석 대상 배치

백엔드와 같은 관례로 `.repo/` 아래에 둡니다.

```
.repo/<project>/<module?>/.../*.tsx | *.ts | *.jsx | *.js
```

- 각 노드에 `project`(= 경로 첫 세그먼트), `module`(= 두 번째 세그먼트, 모듈형 구조일 때)이 기록됩니다.
- **React 프로젝트 자동 판별**: `package.json`에 `react`/`next` 의존성이 있거나 `.tsx/.jsx` 파일이
  존재하면 분석, `vue`/`nuxt`/`@angular/core`가 있으면 건너뜁니다.
- `node_modules`/`dist`/`build`/`.next`/`coverage`/`out`/`.turbo`/`.git`은 탐색에서 제외합니다.
- 경로 별칭(`@/...`)은 대상의 `tsconfig.json`(`baseUrl`/`paths`)을 읽어 해석하고, 없으면
  `vite.config.*`의 `resolve.alias`를 best-effort 파싱합니다.

---

## 4. CLI 명령어

```
flowmap-react <command> [options]
```

공통: 출력은 `--out <file>` 지정 시 파일로, 없으면 stdout으로 나갑니다(진행 메시지는 stderr).

### analyze — 그래프 생성

```bash
node dist/cli.js analyze --repo <dir> [--project P] [--out f.json] [--env kv.txt]
```

| 옵션 | 설명 |
|---|---|
| `--repo <dir>` | 분석 대상 루트(기본 `../.repo`) |
| `--project P` | 특정 프로젝트만 분석(`.repo/P`) |
| `--out f.json` | 출력 파일(미지정 시 stdout) |
| `--env kv.txt` | 추가 env 값 파일(`KEY=VALUE` 줄 단위). `.env` 파일보다 우선 적용 |

### join — 백엔드와 연결

```bash
node dist/cli.js join --graph front.json --backend backend.json [--out join.json]
```

프론트 그래프의 API/EXTERNAL 노드를 백엔드 그래프의 CONTROLLER 노드에 `(httpMethod, 정규화 경로)`로
매칭합니다. 백엔드 그래프는 `flowmap-spring-kotlin`의 `analyze`/`combine` 산출물(예: `_combined.json`).

### screens — 화면 와이어프레임 데이터

```bash
node dist/cli.js screens --repo <dir> [--project P] [--out f.json]
```

화면별 JSX 레이아웃 트리를 추출합니다([8장](#8-출력-스키마--화면-레이아웃)).

### search — 서브그래프 추출 (BFS)

```bash
node dist/cli.js search --method M [--graph g.json | --repo <dir>] \
  [--direction both|callers|callees] [--depth N] [--out f.json]
```

`--method`는 노드 id 정확 일치 → 메서드명 일치 → 부분 일치 순으로 매칭하고, 매칭된 노드에서
지정 방향으로 깊이 `N`(기본 3)까지 BFS 서브그래프를 뽑습니다.

### stats — 통계/커버리지

```bash
node dist/cli.js stats [--graph g.json | --repo <dir>]
```

레이어별 노드 수, 엣지 kind/relation 분포, API/EXTERNAL 노드의 해석도(`confidence`) 분포를 출력합니다.

---

## 5. 분석 파이프라인 (패스)

`analyze`는 프로젝트별로 `ts.Program`을 한 번 만들고 다음 패스를 수행합니다.

1. **라우트/화면 탐색** — react-router(AST) + Next.js(파일시스템). 화면 컴포넌트 id와 경로 수집.
2. **컴포넌트/훅 발견** — export/선언된 함수·화살표·클래스 컴포넌트와 커스텀 훅(`use*`)을 노드로.
   심볼→컴포넌트 인덱스를 만들어 교차 파일 호출을 해석.
3. **스토어 수집** — Redux 슬라이스/Zustand/Context 정의와 사용 바인딩(프로젝트 전역).
4. **본문 walk** — 각 컴포넌트/훅 본문에서:
   - JSX 렌더 사용(자식 컴포넌트) → `render` 엣지
   - 호출 분류: 스토어 사용 → `store:read`/`dispatch`, HTTP 호출(래퍼 추적 포함) → `http`,
     추적 대상 컴포넌트/훅 호출 → `call`
5. **그래프 조립** — 순수 변환. 노드 first-seen 순서, 엣지 `(source,target,relation,line)` dedup.

`screens`는 같은 Program/라우트 정보를 재사용하되, 본문 대신 **반환 JSX 트리**를 추출합니다.

---

## 6. 출력 스키마 — 그래프

백엔드와 동일한 envelope와 `MethodNode`/`CallEdge` 필드를 재사용합니다(기존 뷰어/툴 공유).

```jsonc
{
  "directed": true,
  "multigraph": true,
  "meta": { "command": "analyze", "repo": "../.repo", "project": "...", "files": N, "nodes": N, "edges": N },
  "nodes": [ /* MethodNode */ ],
  "edges": [ /* CallEdge */ ]
}
```

### MethodNode

| 필드 | 의미 |
|---|---|
| `id` | 노드 식별자(아래 규칙) |
| `fqcn` | 파일/모듈 한정자(프론트엔드는 repo 상대 경로) |
| `method` | 함수/훅/액션/HTTP 메서드명 |
| `layer` | `SCREEN`·`COMPONENT`·`HOOK`·`STORE`·`API`·`EXTERNAL`(+ 백엔드 그래프 읽기용 `CONTROLLER` 등) |
| `visibility` | `exported` \| `local` |
| `async` | async 함수/비동기 컨텍스트 여부 |
| `httpMethod`, `endpoint` | API/EXTERNAL의 메서드와 **정규화 경로**(조인 근거) / SCREEN의 라우트 경로 |
| `externalService` | axios 인스턴스명 / 호스트 / 래퍼 |
| `externalUrl` | 표시용 원본 URL(값 포함) |
| `urlPlaceholder` | 잔여 `${...}` |
| `clientPackage` | 래퍼/인스턴스 모듈 경로 |
| `resourceType` | STORE의 종류(`redux-slice`/`zustand`/`context`) |
| `confidence` | API/EXTERNAL의 URL 해석도(additive 키) |
| `file`, `line`, `project`, `module` | 코드 위치/출처 |

**노드 id 규칙**

| 종류 | id 예시 |
|---|---|
| 컴포넌트/훅/화면 | `sample-shop-react/src/pages/UserPage.tsx::UserPage` |
| API(상대 경로, 자사 백엔드 추정) | `ext:GET /orders` |
| EXTERNAL(절대 호스트) | `ext:GET api.shop.com/internal/users/{}` |
| 스토어 | `store:redux:user` · `store:zustand:useCartStore` · `store:context:AuthContext` |
| 미해석 호출 | `ext:<service>#unresolved` |

### CallEdge

| 필드 | 의미 |
|---|---|
| `source`, `target` | 노드 id |
| `mode` | `sync` \| `async` |
| `kind` | `internal` \| `external` (+ 백엔드 `s2s`/`batch`/`resource`) |
| `relation` | `route` \| `render` \| `call` \| `dispatch` \| `store:read` \| `http` |
| `callSiteFile`, `callSiteLine` | 호출 지점 |

엣지 dedup 키: `(source, target, relation, callSiteLine)` — 백엔드와 동일.

---

## 7. 출력 스키마 — 조인 파일

`join`은 그래프를 **병합하지 않고** 별도 링크 파일을 만듭니다.

```jsonc
{
  "meta": { "command": "join", "frontendGraph": "...", "backendGraph": "...",
            "matched": 3, "unmatched": 2, "ambiguous": 1 },
  "links": [
    {
      "frontendNodeId": "ext:GET api.shop.com/internal/users/{}",
      "httpMethod": "GET",
      "normalizedPath": "/internal/users/{}",
      "rawUrl": "https://api.shop.com/internal/users/{}",
      "confidence": "resolved",
      "backendNodeId": "com.acme.user.UserController#getUser",   // 미매칭이면 null
      "backendProject": "user-service",                          // 미매칭이면 null
      "matchStatus": "matched",                                  // matched | unmatched | ambiguous
      "candidates": []                                           // ambiguous일 때 후보 id 목록
    }
  ]
}
```

- **matched**: 단일 백엔드 컨트롤러와 매칭.
- **ambiguous**: 여러 백엔드가 같은 `(verb, path)`를 제공. 서비스 힌트(`externalService`/`${...}`
  토큰)로 우선순위를 정하고, 정해지면 `matched`로, 아니면 `ambiguous`로 후보를 나열.
- **unmatched**: 매칭 없음(서드파티 API, verb 불일치, 백엔드 미분석). **명시적으로 나열**되어
  커버리지 감사가 가능합니다.

---

## 8. 출력 스키마 — 화면 레이아웃

`screens`는 화면을 **구조적 와이어프레임**으로 그리기 위한 데이터를 만듭니다. 픽셀 단위 레이아웃은
CSS·런타임이 필요해 범위 밖이며, 요소 중첩 구조까지 제공합니다.

```jsonc
{
  "meta": { "command": "screens", "screens": 3, "components": 5 },
  "screens": [
    { "id": "...::UserPage", "name": "UserPage", "route": "/users/{}", "file": "..." }
  ],
  "components": {
    "...::UserCard": {
      "id": "...::UserCard", "name": "UserCard", "kind": "component", "file": "...", "line": 4,
      "root": { /* LayoutNode */ }
    }
  }
}
```

### LayoutNode

| 필드 | 의미 |
|---|---|
| `tag` | `div`/`button`/… 또는 컴포넌트명, 또는 `#text`/`#fragment`/`#list`/`#cond`/`#expr` |
| `kind` | `host` · `component` · `text` · `fragment` · `list` · `conditional` · `expression` |
| `componentId` | `component`일 때 다른 컴포넌트 트리 id(드릴다운용) |
| `lazy` | `React.lazy`로 로드되는 컴포넌트 |
| `text` | 정적 텍스트, 또는 조건/리스트/표현식의 라벨(소스 일부) |
| `props` | 화이트리스트 prop(문자열 리터럴): className/id/type/name/placeholder/href/src/role/alt/label/title/htmlFor/aria-label |
| `children` | 자식 노드 |
| `line` | 소스 라인 |

**소비 시나리오**: 화면 목록(route) → 각 화면 컴포넌트의 `root`를 박스 중첩으로 렌더 →
`component` 노드 클릭 시 `componentId`로 해당 컴포넌트 트리를 펼침. `id`가 그래프/조인 노드 id와
동일하므로 **화면(박스) → API → 백엔드 컨트롤러**까지 한 id로 연결됩니다.

> 조건부(`a ? <X/> : <Y/>`, `cond && <X/>`)는 `conditional`, 리스트(`items.map(...)`)는 `list`로
> 표현하며 동적 값은 `expression` placeholder로 둡니다.

---

## 9. 조인 키와 매칭 규칙

프론트와 백엔드를 잇는 핵심은 경로 정규화 함수입니다. `src/norm.ts`는 백엔드의
`RestDocs.normalize`와 `CrossRun.normPath`를 **바이트 단위로 동일하게** 포팅했고, 골든 테이블
테스트(`test/norm.spec.ts`)로 드리프트를 막습니다.

- `normalize(path)` — 세그먼트 단위로 분리, `{...}`로 시작하거나 id 형태(전부 숫자 또는 UUID)면
  `{}`로 치환. 예: `/users/123` → `/users/{}`, `/users/{id}/profile` → `/users/{}/profile`.
- `normPath(path)` — 매칭 시점용. 쿼리 제거, `{...}` → `{}`, 끝 슬래시 제거.
- `verbOk(provider, call)` — `null`/`ANY`는 와일드카드, 그 외에는 정확히 일치해야 함.

매칭: 프론트 API/EXTERNAL 노드의 `(httpMethod, normPath(endpoint))`로 백엔드 CONTROLLER 노드를
인덱싱·조회. 여러 후보면 서비스 힌트로 우선순위 결정([7장](#7-출력-스키마--조인-파일)).

---

## 10. 정밀 URL/메서드 해석

axios/fetch/래퍼 호출마다 `(httpMethod, fullPath)` + 해석도를 계산합니다(백엔드
`ConstantEvaluator` + `ExternalResolver` 대응).

**HTTP 메서드**
- `axios.get/post/...` → 프로퍼티명
- `axios({ method })` / `fetch(url, { method })` → method 초기자 folding
- `instance.get(...)`(= `axios.create()` 결과) → 인스턴스 심볼 해석 후 프로퍼티명
- 래퍼 함수 → 본문이 최종 호출하는 verb
- 옵션 없는 `fetch(url)` → 기본 `GET`(해석도 `partial`로 표시)

**문자열 folding (`evalString`, 깊이 ≤ 16)**
1. 타입체커 리터럴 타입(`const`/`as const`/상수 결합 자동 folding, 교차 파일 포함)
2. 템플릿 리터럴 — 텍스트 + 각 `${expr}` 재귀, 미해석 스팬(경로 파라미터)은 `{}`로 치환
3. 이항 `+` 연결
4. Identifier/PropertyAccess → 선언 초기자 재귀
5. `import.meta.env.X` / `process.env.X` → env 해석(없으면 `${X}` placeholder 보존)

**교차 함수 래퍼 추적** — `컴포넌트 → getUser(id) → http.get(\`/users/${id}\`)` 패턴:
1. 호출 callee 심볼 해석(별칭 포함)
2. 프로젝트 함수면 본문의 내부 HTTP 호출을 찾아 URL/메서드 해석
3. 래퍼의 URL이 파라미터 자체면 호출자 인자를 바인딩해 재해석(`request(path)` 패턴)
4. `wrapperChain`에 추적 경로 기록(예: `["getUser","http.get"]`)

**baseURL + env** — receiver가 `axios.create({ baseURL: X })`면 `X`를 folding해 `base + path` 합성
(끝 `/` 제거, path 앞 `/` 보장). env는 `.env`/`.env.<mode>`/`.env.local`(`VITE_*`/`REACT_APP_*`/
`NEXT_PUBLIC_*`)에서 로드하며 키는 canonical화(소문자, `-`/`_` 제거).

**해석도(confidence)**
- `resolved` — 리터럴 완전 해석, 잔여 `${...}` 없음, verb 확정
- `partial` — 잔여 placeholder 또는 verb 기본값(예: bare `fetch`)
- `unresolved` — HTTP성이나 URL folding 실패(`endpoint: null` 노드로 가시화, 조인 제외)

---

## 11. 라우트 / 스토어 탐지

**react-router**
- JSX: `<Route path="..." element={<Comp/>} | component={Comp} />`(중첩 시 경로 compose)
- 객체형: `createBrowserRouter([...])` / `useRoutes([...])`(`path` + `element`/`Component` + `children`)
- lazy: `React.lazy(() => import('./X'))` / 라우트객체 `lazy` → 동적 import의 default export를 화면으로 해석

**Next.js**(해당 프로젝트에 `next` 의존성이 있을 때만 적용)
- `pages/**`(`_app`/`_document`/`api` 제외) → 화면. `pages/users/[id].tsx` → `/users/{}`,
  `[...slug]` → catch-all
- `app/**/page.tsx` → 화면(라우트 그룹 `(group)` 제거)

**스토어**(각 라이브러리의 import 출처까지 확인해 오탐 방지 — 예: `axios.create`는 zustand가 아님)
- Redux Toolkit: `createSlice({ name, reducers })` → `store:redux:<name>`, `createAsyncThunk('user/...')`
  → 슬라이스 키 매핑. `useSelector(s => s.key)` → read, `dispatch(action())` → dispatch(thunk면 async)
- Zustand: `const useX = create(...)` → `store:zustand:useX`, 반환 객체의 함수형 키를 actions로
- Context: `createContext()` → `store:context:<name>`, `useContext(X)` → read

---

## 12. 한계

- **픽셀 레이아웃 불가** — `screens`는 구조 와이어프레임까지. 위치/크기/정렬은 CSS·런타임 필요.
- **완전 동적 URL** — 런타임 계산 경로(`buildPath(opts)`)는 `partial`/`unresolved`로만 표기되고
  조인에서 unmatched로 나열됩니다.
- **bare fetch verb** — 메서드를 다른 곳에서 설정하면 오라벨 가능(→ `partial`).
- **자사 vs 서드파티 구분** — 절대 URL 호스트로만 구분합니다. baseURL이 해석되면 자사 호출도 호스트가
  붙어 EXTERNAL로 분류될 수 있으나, 조인은 경로로 매칭되므로 연결에는 영향 없습니다.
- **과도 래핑된 클라이언트** — 재export가 깊은 커스텀 클라이언트는 놓칠 수 있음(→ classify 테이블 보강).
- **Next 비표준 라우팅** — custom server / `basePath` / i18n prefix는 추가 설정이 필요.

---

## 13. 확장하기

- **클라이언트/시그니처 테이블** — `src/classify.ts`에서 axios 모듈명, 라우터/스토어 팩토리,
  prop 화이트리스트, skip 디렉토리 등을 편집(백엔드 `Classify.kt`의 `EXTERNAL_PREFIXES` 대응).
- **파서 교체** — `Resolver` 인터페이스(`src/ir.ts`)만 새로 구현하면 순수 계층은 그대로.
- **새 노드/엣지 종류** — `src/model.ts`의 `Layer`/`relation`에 추가하고 `graphBuilder.ts`에서 emit.
- **출력 소비 형태 변경** — 예: 화면 레이아웃을 트리 대신 평면 노드+엣지로 내보내기 등은
  `screens.ts`/`layoutTree.ts`만 수정.

---

## 14. 테스트

```bash
cd ts-analyzer && npm test     # vitest, 36 tests
```

| 스펙 | 검증 내용 |
|---|---|
| `norm.spec` | 조인 키 정규화의 백엔드 바이트 동일성(골든 테이블) |
| `graphBuilder.spec` | 순수 IR→그래프: 레이어·엣지·dedup |
| `join.spec` | matched/unmatched/ambiguous, verb 불일치, 힌트 우선순위 |
| `screens.spec` | 화면 레이아웃 트리: 라우트·자식 컴포넌트 링크·host/prop/조건 캡처 |
| `e2e.spec` | `.repo/sample-shop-react` 전체 파이프라인 + 백엔드 `_combined.json` 조인 |

`e2e.spec`는 백엔드 그래프(`../../flowmap-spring-kotlin/.../_combined.json`)가 있으면 조인까지
검증하고, 없으면 해당 단언을 건너뜁니다.

---

## 15. 소스 구조

```
ts-analyzer/src/
  norm.ts            # 조인 키 정규화 (백엔드와 동일)        ← 가장 중요
  model.ts           # node-link 스키마 (Model.kt)
  ir.ts              # IR 타입 + Resolver 인터페이스 (Ir.kt)
  classify.ts        # 클라이언트/스토어/라우터 시그니처 테이블 (Classify.kt)
  jsonOutput.ts      # 그래프 읽기/쓰기 (JsonOutput.kt)
  graphBuilder.ts    # 순수 IR → 그래프 (GraphBuilder.kt)
  join.ts            # 프론트 → 백엔드 조인 (CrossRun.kt 매칭)
  screens.ts         # 화면 레이아웃 추출 오케스트레이션
  bfs.ts             # search 서브그래프 (Bfs.kt)
  cli.ts             # analyze/join/search/stats/screens (Cli.kt)
  resolver/
    program.ts          # ts.Program + TypeChecker 구성 (AnalysisSession.kt)
    constantEvaluator.ts# 문자열/URL folding (ConstantEvaluator.kt)   ← 정밀도 핵심
    apiCallResolver.ts  # axios/fetch + 래퍼 추적 (ExternalResolver.kt) ← 핵심
    envResolver.ts      # .env / import.meta.env (YamlPropertyResolver.kt)
    routeResolver.ts    # react-router + Next.js 라우트
    storeResolver.ts    # Redux/Zustand/Context
    layoutTree.ts       # JSX → 화면 레이아웃 노드
    context.ts          # 심볼/컴포넌트 id/모듈 해석 공용
    irBuilder.ts        # 패스 오케스트레이션 → IrFile[]
```

각 모듈의 헤더 주석에 백엔드 대응 파일이 명시되어 있습니다.
