# Kubernetes Selector 이해하기

## Selector란?

Deployment가 **"어떤 Pod가 내 것인지"** 식별하는 이름표 매칭 시스템이다.

---

## 비유: 학교 선생님과 학생 이름표

학교에 두 반이 있다고 하자.

| 선생님 (Deployment) | 이름표 조건 (selector) | 학생 (Pod) |
|---|---|---|
| 김선생님 (v1) | 학교=A, 반=1 | 철수 (학교=A, 반=1) |
| 박선생님 (v2) | 학교=A, 반=2 | 영희 (학교=A, 반=2) |

- 김선생님은 `학교=A, 반=1` 이름표를 단 학생만 관리한다.
- 박선생님은 `학교=A, 반=2` 이름표를 단 학생만 관리한다.

**만약 이름표에 "반" 정보가 없다면?**

두 선생님 모두 `학교=A`인 학생을 전부 "내 반 학생"이라고 착각한다.
김선생님이 "내 반은 3명인데 5명이 있네? 2명은 나가!" → 박선생님 반 학생을 쫓아냄.
박선생님도 같은 행동 → **서로의 학생을 쫓아내는 혼란 발생!**

---

## Selector ↔ Template 연결 구조

Deployment YAML에서 selector와 template.labels는 **반드시 일치**해야 한다.

```
Deployment YAML 구조
┌─────────────────────────────────────────┐
│ spec:                                   │
│   selector:                             │
│     matchLabels:          ◄─── "이 라벨을 가진 Pod가 내 것"
│       app: nginx                        │
│       version: v1                       │
│                    ┌──── 반드시 일치 ────┐
│   template:        │                    │
│     metadata:      │                    │
│       labels:      ▼                    │
│         app: nginx        ◄─── "이 라벨로 Pod를 생성해라"
│         version: v1                     │
│     spec:                               │
│       containers:                       │
│         - name: ...                     │
│           image: ...                    │
└─────────────────────────────────────────┘
```

> selector.matchLabels ⊆ template.metadata.labels 이어야 한다.
> 불일치하면 Deployment 생성 자체가 거부된다.

---

## 실제 YAML 전체 예시

### 문제 상황: selector가 겹칠 때

```yaml
# ❌ v1-deploy.yml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-v1
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nginx          # ⚠️ app만 있음
  template:
    metadata:
      labels:
        app: nginx        # selector와 일치
    spec:
      containers:
        - name: nginx
          image: nginx:1.20
---
# ❌ v2-deploy.yml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-v2
spec:
  replicas: 1
  selector:
    matchLabels:
      app: nginx          # ⚠️ v1과 완전히 동일!
  template:
    metadata:
      labels:
        app: nginx        # selector와 일치
    spec:
      containers:
        - name: nginx
          image: nginx:1.21
```

이 상태에서 벌어지는 일:

```
nginx-v1 Deployment (replicas: 3)        nginx-v2 Deployment (replicas: 1)
selector: app=nginx                      selector: app=nginx
    │                                        │
    │  "app=nginx Pod가 4개?                 │  "app=nginx Pod가 4개?
    │   난 3개만 필요하니 1개 삭제!"           │   난 1개만 필요하니 3개 삭제!"
    ▼                                        ▼
┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
│ Pod    │ │ Pod    │ │ Pod    │ │ Pod    │
│app=nginx│ │app=nginx│ │app=nginx│ │app=nginx│
│ (1.20) │ │ (1.20) │ │ (1.20) │ │ (1.21) │
└────────┘ └────────┘ └────────┘ └────────┘
        ▲ 서로가 서로의 Pod를 삭제 ▲
              → 무한 충돌! 💥
```

### 해결: version 라벨 추가

```yaml
# ✅ v1-deploy.yml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-v1
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nginx
      version: v1        # ✅ 내 Pod만 식별
  template:
    metadata:
      labels:
        app: nginx
        version: v1      # ✅ selector와 일치
    spec:
      containers:
        - name: nginx
          image: nginx:1.20
---
# ✅ v2-deploy.yml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-v2
spec:
  replicas: 1
  selector:
    matchLabels:
      app: nginx
      version: v2        # ✅ 내 Pod만 식별
  template:
    metadata:
      labels:
        app: nginx
        version: v2      # ✅ selector와 일치
    spec:
      containers:
        - name: nginx
          image: nginx:1.21
```

해결된 구조:

```
nginx-v1 Deployment (replicas: 3)         nginx-v2 Deployment (replicas: 1)
selector: app=nginx, version=v1           selector: app=nginx, version=v2
    │                                         │
    │  "version=v1인 Pod만 내 것"              │  "version=v2인 Pod만 내 것"
    ▼                                         ▼
┌────────┐ ┌────────┐ ┌────────┐       ┌────────┐
│ Pod    │ │ Pod    │ │ Pod    │       │ Pod    │
│app=nginx│ │app=nginx│ │app=nginx│       │app=nginx│
│ver=v1  │ │ver=v1  │ │ver=v1  │       │ver=v2  │
│ (1.20) │ │ (1.20) │ │ (1.20) │       │ (1.21) │
└────────┘ └────────┘ └────────┘       └────────┘
     ← v1 영역 (3개) →                  ← v2 영역 →
              서로 간섭 없음 ✅
```

---

## 카나리 배포에서의 활용

신규 버전을 소수에게만 먼저 배포하는 전략이다.

### 전체 YAML: Deployment + Service

```yaml
# v1-deploy.yml — 기존 안정 버전 (90% 트래픽)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-v1
spec:
  replicas: 9
  selector:
    matchLabels:
      app: nginx
      version: v1          # Deployment는 version까지 봄 (좁게)
  template:
    metadata:
      labels:
        app: nginx          # ← Service가 이걸로 찾음
        version: v1         # ← Deployment가 이걸로 구분함
    spec:
      containers:
        - name: nginx
          image: nginx:1.20
---
# v2-deploy.yml — 신규 카나리 버전 (10% 트래픽)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-v2
spec:
  replicas: 1
  selector:
    matchLabels:
      app: nginx
      version: v2          # Deployment는 version까지 봄 (좁게)
  template:
    metadata:
      labels:
        app: nginx          # ← Service가 이걸로 찾음
        version: v2         # ← Deployment가 이걸로 구분함
    spec:
      containers:
        - name: nginx
          image: nginx:1.21
---
# service.yml — 양쪽 모두에 트래픽 전달
apiVersion: v1
kind: Service
metadata:
  name: nginx-svc
spec:
  selector:
    app: nginx              # app만 봄 (넓게) → v1, v2 Pod 모두 매칭
  ports:
    - port: 80
      targetPort: 80
```

### 구조 그림: 누가 누구를 선택하는가

```
                         ┌─────────────────┐
                         │  nginx-svc      │
                         │  (Service)      │
                         │                 │
                         │  selector:      │
                         │    app: nginx   │  ← app만 봄 (넓게)
                         └────────┬────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                             ▼
    app=nginx? ✅ version 상관없음      app=nginx? ✅ version 상관없음
                    │                             │
  ┌─────────────────┴───────────┐          ┌─────┴─────┐
  │      Deployment nginx-v1    │          │ Deployment │
  │      selector:              │          │ nginx-v2   │
  │        app: nginx           │          │ selector:  │
  │        version: v1 ← 좁게   │          │  app: nginx│
  │      replicas: 9            │          │  version:v2│
  │                             │          │ replicas: 1│
  └──────────┬──────────────────┘          └─────┬─────┘
             │                                    │
             ▼                                    ▼
  ┌───┐┌───┐┌───┐┌───┐┌───┐              ┌───┐
  │Pod││Pod││Pod││Pod││Pod│ ...×9         │Pod│ ×1
  │v1 ││v1 ││v1 ││v1 ││v1 │              │v2 │
  └───┘└───┘└───┘└───┘└───┘              └───┘

  ◄──── 90% 트래픽 (9/10) ────►          ◄10%►
```

### 핵심 포인트

```
           selector 범위 비교
  ┌──────────────────────────────────────┐
  │  Service selector: { app: nginx }   │  ← 넓게: 모든 Pod에 트래픽
  │  ┌────────────────┐ ┌─────────────┐ │
  │  │ Deployment-v1  │ │Deployment-v2│ │
  │  │ selector:      │ │selector:    │ │
  │  │  app: nginx    │ │ app: nginx  │ │  ← 좁게: 자기 Pod만 관리
  │  │  version: v1   │ │ version: v2 │ │
  │  └────────────────┘ └─────────────┘ │
  └──────────────────────────────────────┘
```

비유로 다시 보면:

- **선생님(Deployment)**: 반(version)까지 확인해서 자기 학생만 관리
- **급식실(Service)**: 학교(app) 이름표만 확인 → 모든 반 학생에게 밥 배급

이렇게 **관리 범위와 트래픽 범위를 독립적으로 제어**할 수 있다.

---

## Selector가 같아도 하는 일이 다르다 — Deployment vs Service 역할 비교

Deployment와 Service 둘 다 selector로 Pod을 찾는다. 하지만 **찾은 다음에 하는 일**이 완전히 다르다.

### 전체 구조: 누가 뭘 하는가

```
kubectl apply
    │
    ▼
[API Server]
    │
    ├──── Deployment Controller (kube-controller-manager 안)
    │         │
    │         │ selector로 Pod 찾기 → "내 Pod이 몇 개지?"
    │         │
    │         ▼
    │     ReplicaSet 생성/관리
    │         │
    │         ├── replica 수 유지 (Pod 죽으면 재생성)
    │         ├── Rolling Update (새 ReplicaSet으로 점진 교체)
    │         └── Rollback (이전 ReplicaSet으로 복귀)
    │
    ├──── Endpoints Controller (kube-controller-manager 안)
    │         │
    │         │ Service의 selector로 Pod 찾기 → "IP가 뭐지?"
    │         │
    │         ▼
    │     Endpoints 오브젝트 갱신
    │         │
    │         ├── kube-proxy → iptables 규칙 갱신 (트래픽 라우팅)
    │         └── CoreDNS → DNS 응답 갱신
    │
    └──── HPA Controller (Horizontal Pod Autoscaler)
              │
              │ Deployment의 metrics 확인 → "CPU가 80% 넘었나?"
              │
              ▼
          Deployment의 replicas 수 변경
              → Deployment Controller가 Pod 추가/제거
```

### 역할 비교표

| 구분 | Deployment의 selector | Service의 selector |
|---|---|---|
| **목적** | "이 Pod들의 **상태를 관리**해라" | "이 Pod들에게 **트래픽을 보내**라" |
| **찾은 뒤 하는 일** | replica 수 유지, 업데이트, 롤백 | Pod IP 수집 → Endpoints → iptables |
| **실행 주체** | Deployment Controller → ReplicaSet | Endpoints Controller → kube-proxy |
| **Pod 죽었을 때** | 새 Pod 재생성 (상태 복구) | Endpoints에서 제거 (트래픽 차단) |
| **스케일링** | HPA가 replicas 변경 → Pod 추가/제거 | 관여 안 함 (Pod 수는 모른다) |
| **업데이트** | Rolling Update (이미지 교체) | 관여 안 함 (버전은 모른다) |
| **롤백** | 이전 ReplicaSet으로 복귀 | 관여 안 함 |

### 같은 Pod, 다른 관심사

```
Pod이 죽었을 때:

  Deployment Controller: "내 Pod이 3개여야 하는데 2개밖에 없다 → 1개 새로 만들자"
                         (상태 복구)

  Endpoints Controller:  "죽은 Pod IP를 Endpoints에서 빼자"
           → kube-proxy: "iptables에서 그 IP 제거"
                         (트래픽 차단)

  둘 다 같은 Pod을 selector로 찾지만, 반응이 다르다.
```

```
HPA가 스케일 아웃할 때:

  HPA:                   "CPU 80% 초과 → replicas 3→5로 변경"
  Deployment Controller: "Pod 2개 추가 생성"
  Endpoints Controller:  "새 Pod 2개의 IP를 Endpoints에 추가"
           → kube-proxy: "iptables에 새 IP 2개 추가"

  Deployment 쪽 체인이 Pod을 만들고,
  Service 쪽 체인이 트래픽을 연결한다.
```

### 비유: 학교로 다시 보기

```
Deployment = 담임선생님
  - 출석 체크 (replica 수 확인)
  - 학생 빠지면 전학생 데려옴 (Pod 재생성)
  - 교과서 바꿈 (Rolling Update)
  - 교과서 원복 (Rollback)
  - 학급 정원 조절 (HPA 스케일링)

Service = 급식실
  - 학생 명단(Endpoints)만 관리
  - 명단에 있는 학생에게만 밥 배급 (트래픽 전달)
  - 전학 간 학생은 명단에서 삭제 (죽은 Pod 제거)
  - 교과서가 뭔지, 정원이 몇 명인지 모름 (버전/스케일 무관)
```

---

## 정리

| 구분 | selector 역할 | 라벨 범위 | 뒤에서 작동하는 컨트롤러 |
|---|---|---|---|
| Deployment | 자기 Pod만 관리 (상태) | 좁게 (app + version) | Deployment Controller → ReplicaSet |
| Service | 트래픽 보낼 Pod 선택 | 넓게 (app만) | Endpoints Controller → kube-proxy |
| HPA | 스케일 대상 지정 | Deployment를 직접 지정 | HPA Controller → Deployment replicas 변경 |

> selector = "이 이름표 조합을 가진 Pod만 내 것이다"
> 하지만 **Deployment는 상태를 관리**하고, **Service는 트래픽을 연결**한다. 같은 selector, 다른 책임.
