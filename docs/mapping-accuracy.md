# React → backend 매핑 정확도 개선 (false external 감소)

대용량 React 프로젝트에서 endpoint가 backend에 매핑되지 못하고 **false external**로
분석되는 문제를 join/resolver 단계에서 개선한다. `fe.join.json#meta` 의
`ambiguous`/`unmatched` 가 클수록 false external 비율이 높다.

세 가지 원인(R-A/R-B/R-3)에 각각 대응한다.

| 코드 | 원인 | 대응 | 설정 |
| --- | --- | --- | --- |
| R-A | ambiguous — 같은 path를 여러 backend project가 제공(가장 흔함) | affinity 힌트로 후보를 좁혀 matched 확정 | `AFFINITY` (선택) |
| R-B | 내부 route — Next.js/Express/Vite 가 자체 제공하는 API | in-repo provider로 탐지 → `internal` 분류 | 없음(자동) |
| R-3 | env placeholder — `.env` 값 내부 변수 참조 미확장 | `$VAR`/`${VAR}` 재귀 확장(dotenv-expand) | 없음(자동) |

---

## 1. 변경 받기

`flowmap-react` 는 별도 저장소(`geeshow/flowmap-react`)다.

```bash
cd <…>/flowmap5/flowmap-react
git checkout main
git pull --ff-only origin main
```

> dist 는 `flowmap` 런처가 src 변경 시 자동 재빌드한다. 수동: `cd ts-analyzer && npm run build`.

## 2. 자동 적용 (설정 불필요)

`./flowmap pipeline` 재실행만으로 적용된다.

- **R-3 env 확장** — `.env` 값 내부 `$VAR`/`${VAR}` 참조 자동 확장
  (예: `VITE_API_URL=${VITE_BASE}/api`). 미지정 변수는 `${NAME}` placeholder 유지.
- **R-B 내부 route** — Next.js route handler + Express/connect 라우터(마운트
  프리픽스 포함) + Vite dev 미들웨어를 자동 탐지 → 해당 호출은 `internal` 로 분류되어
  false external 에서 빠진다.

## 3. R-A affinity 설정 (선택 — ambiguous 가 많을 때)

같은 REST path 를 여러 backend 가 제공해 생기는 ambiguous 를 해소한다.

### 3-1. 대상 찾기

파이프라인을 한 번 돌린 뒤, 각 서비스 join 메타에서 `ambiguous` 가 큰 것을 본다.

```bash
# 산출물: <OUT_DIR>/<svc>/<base>.join.json  (예: json/frontend/services-account/graph.join.json)
grep -o '"ambiguous":[0-9]*' json/frontend/*/*.join.json

# 후보 직접 보기:
jq '.links[] | select(.matchStatus=="ambiguous") | {frontendNodeId, candidates}' \
   json/frontend/<svc>/graph.join.json
```

`candidates` 의 backend 노드 `project` 중, 그 프론트 서비스가 **실제로 호출하는**
project 를 고른다.

### 3-2. affinity 파일 작성

`flowmap.affinity.json` 생성 (템플릿: `flowmap.affinity.example.json`).

```json
{
  "services-account":    ["account*", "isa*"],
  "services-collection": ["blackhole*"],
  "services-stock":      ["supernova*"]
}
```

- **키** = 프론트 서비스명 (= join 산출물 디렉터리명 = graph `meta.project`), `*` 와일드카드 가능
- **값** = 그 서비스가 호출하는 backend project glob 목록
- `{ "affinity": { … } }` 처럼 `affinity` 키 아래 중첩해도 된다

### 3-3. config 연결

`flowmap.config` 에 한 줄 추가 (머신별 설정, `.gitignore` 대상이라 운영 PC에서 직접 편집):

```
AFFINITY=flowmap.affinity.json
```

## 4. 실행

```bash
# flowmap-react 단독
./flowmap pipeline

# 전체 오케스트레이션(flowmap5) — 10 frontend-join 단계가 affinity 를 자동 사용
cd <…>/flowmap5 && ./sh/run-all.sh
```

## 5. 검증

join 로그에 신규 카운터가 찍힌다.

```
wrote …/graph.join.json: 92 matched (5 via gateway, 7 via affinity),
                         3 unmatched, 0 ambiguous, 4 internal
```

- `ambiguous` ↓, `viaAffinity` ↑ — affinity 가 동점을 풀어 matched 로 확정한 수
- `internal` — Next.js/Express/Vite 내부 route 로 분류되어 false external 에서 빠진 수
- 웹에서도 affinity 로 matched 된 호출은 front→backend join 엣지로 그려진다

## 주의사항

- **무동작 기본값**: affinity 미설정 · express 미사용 repo 는 기존과 100% 동일하게 동작(안전).
- **affinity 키는 정확한 서비스명**이어야 매칭된다. 헷갈리면 `ls json/frontend/` 의 디렉터리명을 그대로 쓴다.
- **affinity 로도 안 풀리는 ambiguous**(패턴에 0개 또는 2개+ 매칭)는 그대로 ambiguous 로 남는다 — 패턴을 더 좁힌다.
- 호환성: `fe.join.json` 의 `matchStatus` 에 `internal`, `via` 에 `internal`,
  `meta` 에 `internal`·`viaAffinity` 가 추가됐으나 모두 additive 라 기존 웹/소비자에 영향 없다.

## 관련

- 구현 PR: [#16 feat(analyzer): React→backend 매핑 정확도 개선](https://github.com/geeshow/flowmap-react/pull/16)
- 핵심 파일: `ts-analyzer/src/join.ts`(affinity·internal), `resolver/serverRoutes.ts`(Express/Vite 탐지), `resolver/envResolver.ts`(env 확장)
