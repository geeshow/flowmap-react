# flowmap-react

React 프로젝트를 **정적 분석**해서 화면(screen)·컴포넌트·외부 API 호출·상태관리 스토어의
연결관계를 그래프 JSON으로 뽑아내고, 백엔드 분석기
[`flowmap-spring-kotlin`](../flowmap-spring-kotlin)의 결과와 **조인**해 프론트엔드→백엔드 전체
영향도를 복원하는 도구입니다. 추가로 화면을 와이어프레임으로 그려내기 위한 **레이아웃 데이터**도
생성합니다.

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

---

## 빠른 시작

```bash
cd ts-analyzer
npm install
npm run build

# 1) 분석: .repo/<project> 아래 React 프로젝트 → 그래프 JSON
node dist/cli.js analyze --repo ../.repo --project sample-shop-react --out ../json/front.json

# 2) 조인: 백엔드 그래프와 연결 (별도 조인 파일, 그래프는 병합하지 않음)
node dist/cli.js join --graph ../json/front.json \
  --backend ../../flowmap-spring-kotlin/kotlin-analyzer/json/_combined.json \
  --out ../json/join.json

# 3) 화면 와이어프레임 데이터
node dist/cli.js screens --repo ../.repo --project sample-shop-react --out ../json/screens.json

# 통계 / 서브그래프 탐색
node dist/cli.js stats  --graph ../json/front.json
node dist/cli.js search --graph ../json/front.json --method UserPage --direction callees --depth 2
```

분석 대상은 백엔드와 같은 관례로 `.repo/<project>/` 아래에 둡니다. React가 아닌 프로젝트
(예: Vue/Nuxt)는 자동으로 건너뜁니다.

---

## 저장소 구성

```
flowmap-react/
├── ts-analyzer/              # 분석기 (TypeScript / Node)
│   ├── src/                  # 소스 (resolver / graphBuilder / join / screens / cli ...)
│   ├── test/                 # vitest 테스트 (norm 골든 / graph / join / screens / e2e)
│   └── README.md             # 분석기 사용/설계 요약
├── .repo/
│   └── sample-shop-react/    # 데모 픽스처 (백엔드 sample-shop과 엔드포인트 공유)
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
cd ts-analyzer && npm test     # 36 tests
```

- `norm.spec` — 조인 키 정규화의 백엔드 바이트 동일성(골든 테이블)
- `graphBuilder.spec` / `join.spec` — 순수 로직(레이어·엣지·dedup, matched/unmatched/ambiguous)
- `screens.spec` — 화면 레이아웃 트리 추출
- `e2e.spec` — `.repo/sample-shop-react`에 전체 파이프라인 실행 후 백엔드 `_combined.json`과 조인까지 검증

---

## 라이선스

내부 학습/도구용.
