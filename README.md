# flowmap-react

**React** 와 **Vue 2 / Nuxt 2**(Pug + Vuex) 프론트엔드를 **정적 분석**해서 화면(screen)·컴포넌트·
외부 API 호출·상태관리 스토어의 연결관계를 그래프 JSON으로 뽑아내고, 백엔드 분석기
[`flowmap-spring`](../flowmap-spring)의 결과와 **조인**해 프론트엔드→백엔드 전체
영향도를 복원하는 도구입니다. 추가로 화면을 와이어프레임으로 그려내기 위한 **레이아웃 데이터**도
생성합니다. (프레임워크는 프로젝트별로 자동 감지 — 한 번의 `analyze`로 React/Vue 프로젝트를 함께 처리)

> 속도보다 **정밀도**가 목표입니다. 백엔드가 Kotlin 컴파일러(K1) 프론트엔드로 정밀 분석하듯,
> 이 도구는 **TypeScript Compiler API(Program + TypeChecker)** 를 의미 분석의 토대로 씁니다.
> 정규식/Babel로는 불가능한 **교차 파일 심볼 추적**으로
> `컴포넌트 → API 래퍼 함수 → axios 인스턴스(baseURL) → env 변수`까지 따라가 실제 호출 URL을 복원합니다.

---

## 무엇을 분석하나

| 분석 대상 | 내용 |
|---|---|
| **화면/페이지** | react-router(`createBrowserRouter`/`<Route>`/lazy)·Next.js(`pages/`·`app/`) 라우팅에서 화면 단위 추출 |
| **컴포넌트 연결관계** | 페이지→컴포넌트, 컴포넌트→컴포넌트(JSX 렌더 + import), 컴포넌트→커스텀 훅 |
| **외부 API 호출** | axios/fetch/래퍼의 **HTTP 메서드 + URL**을 상수·env·baseURL·경로 파라미터까지 해석. 해석도(`resolved`/`partial`/`unresolved`) 표기 |
| **상태관리 스토어** | Redux Toolkit 슬라이스·Zustand·React Context와 컴포넌트의 read/dispatch 연결 |
| **화면 레이아웃** | 화면별 JSX 트리(호스트 요소 중첩 + 자식 컴포넌트 + 텍스트 + 조건/리스트)로 와이어프레임 데이터 생성 |

핵심 연결 키: 프론트엔드의 API 호출은 `(httpMethod, 정규화 경로)`로 백엔드 CONTROLLER 노드와
매칭됩니다. 경로 정규화는 백엔드와 **바이트 단위로 동일**하게 포팅되어 두 그래프가 정확히 이어집니다.

### 프레임워크 지원

| 프레임워크 | 화면 | API 호출 | 스토어 | 컴포넌트 렌더그래프/화면 레이아웃 |
|---|---|---|---|---|
| **React** (TSX/JSX) | react-router·Next.js | axios/fetch/래퍼 | Redux·Zustand·Context | ✅ |
| **Vue 2 / Nuxt 2** (Pug) | Nuxt `pages/` | `this.$axios`·`$nuxt.$axios`·axios/래퍼 | Vuex(모듈+액션) | ⏳ Phase 2 |

Vue는 영향도 체인 **화면 → dispatch → Vuex 액션 → API 호출 → 백엔드 조인**을 추출합니다(Phase 1).
Vuex 액션을 그래프 노드로 만들어 `페이지 → 액션 → 엔드포인트` 경로를 복원합니다. 컴포넌트 렌더
그래프와 Pug 화면 와이어프레임은 Phase 2 예정입니다. `.vue` 스크립트는 커스텀 `ts.CompilerHost`로
가상 `.vue.ts`로 투영해 React와 동일한 TypeChecker 기반 정밀 해석(URL folding·래퍼 추적)을 적용합니다.

---

## 설정 (필수)

`flowmap.config.example` → `flowmap.config` 로 복사한 뒤 아래 키를 채운다. real `flowmap.config` 은
머신별 설정이라 **gitignore 대상**이고, 템플릿 `flowmap.config.example` 만 추적된다.

| 키 | 필수 | 설명 |
|---|:--:|---|
| `REPO` | ✅ | 분석 대상 소스 체크아웃 루트(`.repo/<project>/` 관례) |
| `BACKEND` | ✅ | join 입력 백엔드 결합 그래프(`_combined.json`, CSV 다중 가능) |
| `OUT_DIR` · `NAME` | | 출력 디렉터리/파일명 베이스 — `<OUT_DIR>/<service>/<NAME>.*.json` |
| `PROJECT` · `MODE` · `PULL` | | 단일 프로젝트 한정 / Vue env / 분석 전 git pull |
| `ENV_PROFILE` · `ENV` · `WORKERS` … | | 모노레포 env 프로파일 / 메모리 튜닝 |

```bash
cp flowmap.config.example flowmap.config   # REPO·BACKEND 등 값 작성 후 ./flowmap pipeline
```

## 빠른 시작

```bash
cd ts-analyzer
npm install
npm run build

# 1) 분석: .repo/<project> → 그래프 JSON (React/Vue 자동 감지; --project 생략 시 전체).
#    --out 은 템플릿이고, 실제 산출은 서비스(프로젝트 루트)별 디렉터리: <dir>/<service>/<base>.json
node dist/cli.js analyze --repo ../.repo --project sample-shop-react --out ../json/frontend/graph.json
node dist/cli.js analyze --repo ../.repo --project sample-shop-nuxt  --out ../json/frontend/graph.json   # Vue/Nuxt

# 2) 조인: 백엔드 그래프와 연결 (별도 조인 파일, 그래프는 병합하지 않음)
node dist/cli.js join --graph ../json/frontend/sample-shop-react/graph.json \
  --backend ../../flowmap-spring/json/_combined.json \
  --out ../json/frontend/sample-shop-react/graph.join.json

# 3) 화면 와이어프레임 데이터
node dist/cli.js screens --repo ../.repo --project sample-shop-react --out ../json/frontend/graph.screens.json

# 통계 / 서브그래프 탐색
node dist/cli.js stats  --graph ../json/frontend/sample-shop-react/graph.json
node dist/cli.js search --graph ../json/frontend/sample-shop-react/graph.json --method UserPage --direction callees --depth 2
```

분석 대상은 백엔드와 같은 관례로 `.repo/<project>/` 아래에 둡니다. 각 프로젝트의 `package.json`으로
React/Vue를 자동 판별해 알맞은 리졸버를 적용합니다. Vue/Nuxt는 `--mode development|production`으로
`config/<mode>.json`의 env(API_HOST/API_VERSION)를 선택합니다(기본 development).

### 레포 루트에서 바로 실행

`ts-analyzer/`로 들어가지 않고 **flowmap-react 루트**에서 실행할 수 있습니다.

```bash
npm run build            # ts-analyzer 설치 + 빌드
./flowmap analyze --repo .repo --project <P> --out json/frontend/graph.json   # → json/frontend/<service>/graph.json
./flowmap screens --repo .repo --project <P> --out json/frontend/graph.screens.json
./flowmap join --graph json/frontend/<service>/graph.json --backend <backend>.json --out json/frontend/<service>/graph.join.json
# npm 스크립트로도 가능: npm run analyze -- --repo .repo --project <P> --out ...
```

### 한 번에 실행 — `pipeline` (repo 최신화 → analyze → screens → join)

매번 3개 명령을 치는 대신, 옵션을 **설정파일**에 적어두고 한 번에 실행합니다.

```bash
cp flowmap.config.example flowmap.config   # 값을 환경에 맞게 수정
./flowmap pipeline                          # flowmap.config 자동 로드
# 또는: npm run pipeline / ./flowmap pipeline --config 다른경로.config
```

설정파일(`flowmap.config`)은 `KEY=VALUE` 형식이며 `${VAR}` 치환을 지원합니다. 출력은
**서비스(프로젝트 루트)별 디렉터리**로 나뉩니다 — `<OUT_DIR>/<service>/<NAME>.json`,
`.screens.json`, `.join.json`, `.impact.json` (+ `<NAME>.impact/<n>.json` 샤드). 전체 카탈로그
`_manifest.json` 은 `<OUT_DIR>` 최상위 1개로, 각 항목 경로를 `<service>/<file>` 로 가리킵니다.

| 키 | 설명 |
|---|---|
| `REPO` | 분석 대상 소스 체크아웃 루트 (`.repo/<project>/`) |
| `PROJECT` | 분석할 프로젝트(=출력 파일명 베이스); 생략 시 전체 |
| `OUT_DIR` | 결과 JSON 디렉터리(없으면 생성) |
| `BACKEND` | 백엔드 결합 그래프(join 입력); 없으면 join 자동 스킵 |
| `MODE` | Vue/Nuxt env(`development`/`production`) |
| `PULL` | 분석 전 `git pull --ff-only` 로 체크아웃 최신화 (`true`/`false`) |
| `WORKERS`, `MAX_OLD_SPACE`, `NO_SPLIT`, `ENV` | (선택) 메모리/동시성 튜닝 |

> 단계별 동작은 위 개별 명령과 동일합니다. `pipeline`도 힙 자동 확장·프로젝트 분할이 그대로 적용됩니다.
> CLI 플래그(`--repo` 등)를 같이 주면 설정파일 값을 덮어씁니다.

### 대용량 저장소 / 메모리 (OOM 방지)

수천 개 컴포넌트 규모의 워크스페이스는 단일 `ts.Program`이 Node 기본 힙(~2–4GB)을 넘겨
`JavaScript heap out of memory`로 죽을 수 있습니다. 분석기는 이를 두 방식으로 자동 처리합니다.

- **힙 자동 확장**: `analyze`/`screens`/`search`/`stats`는 힙 플래그가 없으면 물리 RAM의 ~75%
  (최소 4GB)로 자기 자신을 재실행합니다. 별도 플래그 불필요.
- **프로젝트 루트 분할**: 저장소/모노레포 워크스페이스를 (디렉터리 구조와 무관하게 `package.json`의
  `workspaces`·프레임워크 의존성 기준으로) 하위 프로젝트 루트로 분해해 **각 루트를 별도 자식
  프로세스**로 분석합니다. 거대한 `ts.Program`의 메모리가 프로세스 종료 시 회수되고, 부모는 가벼운
  IR만 병합해 그래프를 한 번 만듭니다. 결과 그래프는 단일 프로세스 분석과 바이트 단위로 동일합니다.

```bash
FLOWMAP_MAX_OLD_SPACE=12288 ./flowmap analyze ...   # 프로세스당 힙(MB) 직접 지정
./flowmap analyze ... --workers 4                    # 동시 실행 자식 프로세스 수
./flowmap analyze ... --no-split                      # 분할 끄고 단일 프로세스로
```

> 워크스페이스가 단일 패키지(하위 멤버 없음)라 분할이 안 되는 경우에는 힙 자동 확장만으로 처리합니다.
> RAM이 부족하면 `--workers`를 줄이고 `FLOWMAP_MAX_OLD_SPACE`로 프로세스당 힙을 조절하세요.

---

## 저장소 구성

```
flowmap-react/
├── ts-analyzer/              # 분석기 (TypeScript / Node)
│   ├── src/                  # 소스 (resolver / graphBuilder / join / screens / cli ...)
│   ├── test/                 # vitest 테스트 (norm 골든 / graph / join / screens / e2e)
│   └── README.md             # 분석기 사용/설계 요약
├── .repo/
│   ├── sample-shop-react/    # React 데모 픽스처 (백엔드 sample-shop과 엔드포인트 공유)
│   └── sample-shop-nuxt/     # Vue2/Nuxt2 데모 픽스처 (동일 엔드포인트)
├── json/                     # 분석 산출물 (gitignore)
├── docs/
│   └── MANUAL.md             # 상세 매뉴얼 (명령어·스키마·내부 동작·한계)
└── README.md                 # 이 파일
```

> `.repo/`에는 데모 픽스처만 커밋됩니다. 실제 분석 대상(내부/외부 소스)은 로컬에만 두고 공개하지 않습니다.

---

## 문서

- **[ts-analyzer/README.md](ts-analyzer/README.md)** — 분석기 사용법 + 설계 개요(백엔드 구조 미러링)
- **[docs/MANUAL.md](docs/MANUAL.md)** — 상세 매뉴얼: 모든 CLI 명령·옵션, 출력 스키마(그래프/조인/화면),
  정밀 분석 파이프라인, 노드/엣지 종류, 조인 키, 한계와 확장 방법

---

## 검증

```bash
cd ts-analyzer && npm test     # 150 tests
```

- `norm.spec` — 조인 키 정규화의 백엔드 바이트 동일성(골든 테이블)
- `graphBuilder.spec` / `join.spec` — 순수 로직(레이어·엣지·dedup, matched/unmatched/ambiguous)
- `screens.spec` — 화면 레이아웃 트리 추출
- `e2e.spec` — React `.repo/sample-shop-react` 전체 파이프라인 + 백엔드 조인
- `impact.spec` — PR 변경 영향도(변경 노드→도달 SCREEN, 샤드 생성/프루닝)
- `sfc.spec` / `vue-e2e.spec` — Vue SFC 분리(라인 정렬) + `.repo/sample-shop-nuxt` 전체 파이프라인(라우트·$axios·env·래퍼 추적·Vuex 액션 노드) + 백엔드 조인

---

## 라이선스

내부 학습/도구용.
