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

## HPA는 자동으로 생기지 않는다

Deployment에 `replicas: 3`을 설정하면 ReplicaSet이 3개를 유지해준다. 하지만 **부하에 따라 자동으로 늘리고 줄이는 오토스케일링은 별도로 설정해야 한다.**

### Deployment만 있을 때 vs HPA를 추가했을 때

```
Deployment만 있을 때:

  replicas: 3 (고정)
  │
  ▼
  ReplicaSet: "항상 3개 유지"
  │
  ├── Pod 죽음 → 새로 만들어서 3개 복구 (셀프힐링)
  └── 트래픽 폭주 → 여전히 3개 (스케일링 안 함!)


HPA를 추가했을 때:

  HPA: "CPU 50% 넘으면 늘려, min=3 max=10"
  │
  │ metrics-server에서 CPU/메모리 수집
  │
  ▼
  Deployment의 replicas를 3→5→8 자동 변경
  │
  ▼
  ReplicaSet: "8개 유지" → Pod 추가 생성
  │
  │ 부하 줄면
  ▼
  HPA: replicas를 8→5→3 자동 축소
```

### HPA 설정 실전 가이드

HPA Controller는 kube-controller-manager에 **이미 내장**되어 있다. 설치할 필요 없다. 해야 할 건 2가지: **metrics-server 설치**와 **HPA 리소스 생성**.

#### Step 1: metrics-server 설치

HPA가 판단하려면 "지금 CPU가 몇 %인지" 알아야 한다. 이 데이터를 수집하는 게 metrics-server다.

```bash
# Minikube
minikube addons enable metrics-server

# EKS (보통 기본 포함, 없으면 설치)
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# 설치 확인 (Pod이 Running인지)
kubectl get pods -n kube-system | grep metrics-server

# 동작 확인 (메트릭이 수집되는지)
kubectl top pods -n metacoding
```

```
kubectl top pods 결과 예시:

NAME                        CPU(cores)   MEMORY(bytes)
nginx-v1-7d4f8b6c9-abc12   3m           24Mi
nginx-v1-7d4f8b6c9-def34   5m           22Mi
nginx-v1-7d4f8b6c9-ghi56   4m           23Mi

→ 이게 나오면 metrics-server가 정상 동작 중
→ "error: Metrics API not available" 나오면 미설치 상태
```

#### Step 2: Deployment에 리소스 요청(requests) 설정

HPA는 **"requests 대비 실제 사용량"**으로 퍼센트를 계산한다. requests가 없으면 퍼센트를 계산할 수 없다.

```yaml
# deployment.yml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-v1
  namespace: metacoding
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nginx
      version: v1
  template:
    metadata:
      labels:
        app: nginx
        version: v1
    spec:
      containers:
        - name: nginx
          image: nginx:1.20
          resources:
            requests:              # ← 이게 있어야 HPA가 %를 계산할 수 있다
              cpu: 100m            # 100 밀리코어 요청
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
```

```
HPA의 CPU % 계산 방식:

  requests.cpu = 100m
  실제 사용량  = 78m

  CPU 사용률 = 78m / 100m = 78%

  → requests가 없으면 "78m / ???" → 계산 불가!
```

#### Step 3: HPA 리소스 생성

**방법 1: 명령어 (간단)**

```bash
kubectl autoscale deployment nginx-v1 \
  --cpu-percent=50 \
  --min=3 \
  --max=10 \
  -n metacoding

# 확인
kubectl get hpa -n metacoding
```

**방법 2: YAML (상세 설정)**

```yaml
# hpa.yml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: nginx-v1-hpa
  namespace: metacoding
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: nginx-v1              # ← 이 Deployment의 replicas를 조절
  minReplicas: 3                # 최소 Pod 수
  maxReplicas: 10               # 최대 Pod 수
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 50  # CPU 평균 50% 넘으면 스케일 아웃
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 70  # 메모리 평균 70% 넘으면 스케일 아웃
  behavior:                       # 스케일링 속도 제어 (선택)
    scaleUp:
      stabilizationWindowSeconds: 30    # 30초 관찰 후 스케일 아웃
    scaleDown:
      stabilizationWindowSeconds: 300   # 5분 관찰 후 스케일 인 (급격한 축소 방지)
```

```bash
kubectl apply -f hpa.yml
```

#### Step 4: 확인 및 모니터링

```bash
# HPA 상태 확인
kubectl get hpa -n metacoding

NAME            REFERENCE             TARGETS   MINPODS   MAXPODS   REPLICAS   AGE
nginx-v1-hpa   Deployment/nginx-v1   23%/50%   3         10        3          5m

# TARGETS 읽는 법:
#   23%/50% = "현재 23% 사용 중 / 50% 넘으면 스케일 아웃"
#   <unknown>/50% = metrics-server 미설치 또는 requests 미설정

# 상세 이벤트 확인
kubectl describe hpa nginx-v1-hpa -n metacoding

# 실시간 변화 관찰
kubectl get hpa -n metacoding -w
```

#### 전체 흐름 한눈에 보기

```
[설치/설정]                          [자동 동작]

Step 1                              metrics-server
metrics-server 설치 ──────────────→ kubelet에서 메트릭 수집
                                         │
Step 2                                   ▼
Deployment에                        HPA Controller (15초마다 체크)
resources.requests 설정                  │
                                         │ "CPU 평균 78%? 목표 50% 초과!"
Step 3                                   │
HPA 리소스 생성 ─────────────────→       ▼
  (scaleTargetRef: nginx-v1)        Deployment replicas 3→5로 변경
  (averageUtilization: 50%)              │
                                         ▼
                                    Deployment Controller
                                    → ReplicaSet → Pod 2개 추가
                                         │
                                         ▼
                                    Endpoints Controller
                                    → 새 Pod IP 추가 → kube-proxy iptables 갱신
                                         │
                                         ▼
                                    트래픽이 5개 Pod에 분산됨
```

### 자동으로 생기는 것 vs 직접 만들어야 하는 것

| 리소스 | 자동 생성? | 누가 만드나 |
|---|---|---|
| **ReplicaSet** | ✅ 자동 | Deployment가 자동 생성 |
| **Endpoints** | ✅ 자동 | Endpoints Controller가 자동 생성 |
| **HPA** | ❌ 수동 | `kubectl autoscale` 또는 HPA YAML로 직접 생성 |
| **metrics-server** | ❌ 수동 | 클러스터에 별도 설치 필요 (EKS는 보통 기본 포함) |

```
Deployment를 만들면 자동으로 따라오는 것:
  ✅ ReplicaSet (Deployment Controller가 생성)
  ✅ Pod (ReplicaSet이 생성)
  ✅ Endpoints (Endpoints Controller가 생성, Service 있을 때)

직접 만들어야 오토스케일링이 되는 것:
  ❌ HPA (별도 리소스, kubectl autoscale 또는 YAML)
  ❌ metrics-server (클러스터 애드온, 별도 설치)
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
