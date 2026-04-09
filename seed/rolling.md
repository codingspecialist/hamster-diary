# Kubernetes Deployment Strategy 정리

## strategy.rollingUpdate 핵심 파라미터

| 파라미터 | 설명 |
|----------|------|
| `maxSurge` | 업데이트 중 replicas 수 대비 **추가로 생성**할 수 있는 최대 Pod 수 |
| `maxUnavailable` | 업데이트 중 **동시에 종료**할 수 있는 최대 Pod 수 |

---

## 조합별 동작 비교 (replicas: 4 기준)

| maxSurge | maxUnavailable | 동작 | 최대 Pod 수 | 최소 Pod 수 | 다운타임 |
|----------|---------------|------|------------|------------|---------|
| 1 | 0 | 1개 새로 띄우고 Ready 되면 1개 제거 반복 | 5 | 4 | 없음 |
| 4 | 0 | 신버전 4개 전부 띄운 후 구버전 제거 (Blue-Green) | 8 | 4 | 없음 |
| 0 | 1 | 1개 죽이고 1개 띄우고 반복 (느린 롤링) | 4 | 3 | 없음 |
| 4 | 4 | 전부 동시에 죽이고 동시에 생성 | 8 | 0 | 있을 수 있음 |

---

## 배포 전략별 설정

### 1. Rolling Update (점진적 교체) - 가장 안전

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1
    maxUnavailable: 0
```

- 구버전과 신버전이 공존하면서 점진적으로 교체
- 새 Pod가 Ready 되어야 구 Pod 제거 -> 무중단 보장
- K8s 기본값: `maxSurge: 25%, maxUnavailable: 25%`

### 2. Blue-Green (즉시 전환)

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 4        # replicas와 동일
    maxUnavailable: 0  # 신버전 전부 Ready 될 때까지 구버전 유지
```

- 신버전 Pod 전체를 먼저 띄운 뒤 구버전을 한꺼번에 제거
- 순간적으로 Pod가 2배(8개) 존재 -> 리소스 여유 필요
- 무중단 보장

### 3. Recreate (전체 교체)

```yaml
strategy:
  type: Recreate
```

- 구버전 전부 종료 후 신버전 생성
- 다운타임 발생
- `maxSurge: 4, maxUnavailable: 4`도 비슷한 효과

### 4. Canary (소량 먼저 배포)

단일 Deployment의 `maxSurge`/`maxUnavailable`만으로는 구현 불가.
한번 시작하면 끝까지 진행하기 때문.

#### Canary 구현 방법

| 방법 | 설명 |
|------|------|
| Deployment 2개 + Service | stable(4 replicas) + canary(1 replica)를 같은 Service label로 묶음 |
| Istio / Linkerd | VirtualService로 weight 기반 트래픽 분배 (예: 90:10) |
| Argo Rollouts | `strategy: canary`로 step별 weight, pause, analysis 지원 |
| Flagger | 자동 canary 분석 + 점진적 트래픽 이동 |

---

## 요약

- **안전한 무중단**: `maxSurge: 1, maxUnavailable: 0` (Rolling)
- **빠른 무중단**: `maxSurge: replicas, maxUnavailable: 0` (Blue-Green)
- **빠른 교체 (다운타임 허용)**: `type: Recreate` 또는 `maxSurge/maxUnavailable` 둘 다 높게
- **Canary**: 별도 도구(Argo Rollouts, Istio 등) 또는 Deployment 분리 필요
