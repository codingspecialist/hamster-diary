# NodePort vs LoadBalancer vs Ingress — 외부 트래픽 진입 방식 비교

## 핵심 질문: 외부에서 클러스터 안 Pod에 어떻게 접근하는가?

방법이 여러 가지 있다. 크게 **프로덕션용**과 **개발/디버깅용**으로 나뉜다:

```
[프로덕션용 — 클러스터 설정을 변경한다]

  1. NodePort (L4)
     브라우저 → <노드IP>:30080 → kube-proxy → Pod
     모든 노드에 포트 개방. 서비스마다 포트 1개.

  2. LoadBalancer (L4)
     브라우저 → AWS NLB(공인IP) → NodePort → kube-proxy → Pod
     서비스마다 NLB 1개 생성. 비용 폭탄.

  3. Ingress (L7)   ← 프로덕션 표준
     브라우저 → ALB 또는 Nginx → 경로/도메인 보고 분기 → Pod
     LB 1개로 여러 서비스 라우팅.


[개발/디버깅용 — 클러스터 설정을 건드리지 않는다]

  4. kubectl port-forward
     내 PC:8080 → 특정 Pod 또는 Service로 직접 터널
     내 PC에서만 접근 가능. 다른 사람은 못 씀.

  5. minikube service <name>
     Minikube 전용. NodePort URL을 자동으로 브라우저에 열어줌.
     내부적으로는 NodePort 접근과 동일.

  6. minikube tunnel
     Minikube 전용. LoadBalancer의 EXTERNAL-IP를 127.0.0.1로 할당.
     LoadBalancer 타입을 로컬에서 시뮬레이션.
```

---

## 개발용 vs 프로덕션용 — 뭐가 다른가?

| 방법 | 본질 | 클러스터 설정 변경 | 접근 범위 | 환경 |
|---|---|---|---|---|
| **NodePort** | kube-proxy iptables 규칙 | Service 타입 변경 | 모든 노드 IP | 어디서든 |
| **LoadBalancer** | NodePort + 클라우드 LB | Service 타입 변경 | 공인 IP | 클라우드 |
| **Ingress** | Ingress Controller + 규칙 | Ingress 리소스 생성 | LB/NodePort 경유 | 어디서든 |
| **port-forward** | kubectl이 만드는 로컬 터널 | **아무것도 안 바꿈** | 내 PC에서만 | 개발용 |
| **minikube service** | NodePort URL 자동 열기 | **아무것도 안 바꿈** | 내 PC에서만 | Minikube |
| **minikube tunnel** | LoadBalancer IP 시뮬레이션 | **아무것도 안 바꿈** | 내 PC에서만 | Minikube |

### kubectl port-forward

Service 타입이 ClusterIP여도 **아무 변경 없이** 접근할 수 있다:

```bash
# Pod에 직접 연결
kubectl port-forward pod/frontend-abc12 8080:80 -n metacoding

# Service를 통해 연결 (로드밸런싱 안 됨 — Pod 1개에만 연결)
kubectl port-forward svc/frontend-svc 8080:80 -n metacoding

# 이제 브라우저에서 http://localhost:8080 으로 접근
```

```
동작 원리:

  kubectl (내 PC)
    │
    │ API Server를 통해 터널 생성
    │
    ▼
  API Server → kubelet → Pod
    │
    │ 내 PC의 localhost:8080 ↔ Pod의 :80 연결
    │
    ▼
  브라우저 → localhost:8080 → Pod

  kube-proxy 무관. iptables 무관. Service 타입 무관.
  kubectl 프로세스가 살아있는 동안만 동작.
```

**특징:**
- ClusterIP Service도 접근 가능 (타입 변경 불필요)
- kubectl 프로세스를 끄면 연결 끊김
- **내 PC에서만 접근 가능** (다른 사람은 못 씀)
- 로드밸런싱 안 됨 (Pod 1개에만 연결)
- 디버깅/테스트용. 프로덕션에서 쓰면 안 됨

### minikube service

```bash
minikube service frontend-svc -n metacoding --url
# → http://192.168.49.2:30080

minikube service frontend-svc -n metacoding
# → 브라우저가 자동으로 열림
```

```
동작 원리:

  minikube service 명령
    │
    │ 1. Service의 NodePort 확인 (30080)
    │ 2. minikube ip 확인 (192.168.49.2)
    │ 3. http://192.168.49.2:30080 URL 생성
    │ 4. 브라우저 열기 (또는 --url로 출력만)
    │
    ▼
  결국 NodePort 접근과 동일!
  편의 명령일 뿐, 새로운 접근 방식이 아니다.
```

**특징:**
- Service가 **NodePort 타입이어야** 동작
- `minikube ip + NodePort`를 자동으로 조합해주는 편의 기능
- Docker 드라이버 사용 시 localhost로 직접 접근이 안 되는 문제를 해결

### minikube tunnel

```bash
minikube tunnel
# → LoadBalancer Service에 EXTERNAL-IP 할당 (127.0.0.1)
# → 별도 터미널에서 실행 상태 유지 필요
```

```
동작 원리:

  minikube tunnel
    │
    │ 1. LoadBalancer 타입 Service 감지
    │ 2. EXTERNAL-IP에 127.0.0.1 할당
    │ 3. 호스트 → Minikube VM 라우팅 설정
    │
    ▼
  이제 http://127.0.0.1 로 접근 가능

  실제 클라우드의 CCM(Cloud Controller Manager) 역할을 흉내낸다.
```

**특징:**
- Service가 **LoadBalancer 타입이어야** 동작
- `<pending>` 상태인 EXTERNAL-IP에 IP를 할당해줌
- tunnel 프로세스를 끄면 EXTERNAL-IP 다시 `<pending>`
- Ingress Controller가 LoadBalancer로 노출될 때도 필요

### 언제 뭘 쓰는가?

```
"혼자 디버깅 중, Pod 하나 빨리 확인하고 싶다"
  → kubectl port-forward

"Minikube에서 NodePort Service를 브라우저로 열고 싶다"
  → minikube service

"Minikube에서 LoadBalancer나 Ingress를 테스트하고 싶다"
  → minikube tunnel

"여러 사람이 접근해야 한다 / 프로덕션이다"
  → NodePort / LoadBalancer / Ingress
```

---

## 한눈에 비교

| | NodePort | LoadBalancer | Ingress |
|---|---|---|---|
| **OSI 계층** | L4 (TCP) | L4 (TCP) | L7 (HTTP/HTTPS) |
| **라우팅 기준** | 포트 번호 | 포트 번호 | 도메인 + URL 경로 |
| **외부 접근** | `노드IP:30080` | `공인IP:80` | `myapp.com/api` |
| **LB 개수** | 없음 | 서비스마다 1개 | 여러 서비스에 1개 |
| **SSL/HTTPS** | 직접 설정 | 직접 설정 | 간단 (ACM/cert-manager) |
| **경로 분기** | 불가 | 불가 | `/api`, `/admin` 등 가능 |
| **적합한 환경** | 개발/테스트 | 서비스 1~2개 | 프로덕션 |

---

## NodePort — L4, 포트로 구분

```
[외부]                          [클러스터]

브라우저                     Node1            Node2
                          :30080           :30080
    │                        │                │
    │  http://10.0.1.10:30080                 │
    │──────────────────→     │                │
    │                   kube-proxy            │
    │                   (iptables)            │
    │                        │                │
    │                        ▼                │
    │                   frontend Pod          │
```

- 모든 노드에 30000~32767 포트를 연다
- 포트 번호를 외워야 한다 (`http://노드IP:30080`)
- 서비스 3개면 포트 3개 (`30080`, `30081`, `30082`)
- **kube-proxy가 혼자 처리** — 외부 인프라 불필요

---

## LoadBalancer — L4, 클라우드 LB + NodePort

```
[외부]                          [클러스터]

브라우저
    │
    │  http://a1b2c3.elb.amazonaws.com
    │
    ▼
┌──────────────┐
│  AWS NLB     │  ← Cloud Controller Manager가 생성
│  공인 IP     │
└──────┬───────┘
       │
       ▼
  NodePort → kube-proxy → Pod
```

- Cloud Controller Manager가 NLB를 자동 생성
- 깔끔한 공인 URL이 생긴다
- **문제: 서비스마다 NLB 1개**

```
서비스 3개를 외부 노출할 때:

  frontend-svc  (type: LoadBalancer) → NLB 1개 → 월 ~$20
  backend-svc   (type: LoadBalancer) → NLB 1개 → 월 ~$20
  admin-svc     (type: LoadBalancer) → NLB 1개 → 월 ~$20
                                       ─────────────────
                                       총: 월 ~$60 + 트래픽
```

---

## Ingress — L7, HTTP 경로로 분기

### NodePort/LoadBalancer와 근본적으로 다른 점

NodePort와 LoadBalancer는 **Service 타입**이다 (Service YAML의 `type` 필드).
Ingress는 **Service가 아니다** — 별도의 리소스(kind: Ingress)이며, 뒤에서 동작하는 **Ingress Controller**가 필요하다.

```
Service 타입 (L4):
  apiVersion: v1
  kind: Service          ← Service 오브젝트
  spec:
    type: NodePort       ← 또는 LoadBalancer

Ingress (L7):
  apiVersion: networking.k8s.io/v1
  kind: Ingress          ← Service가 아닌 별도 오브젝트
```

### Ingress = 규칙 + 실행자

Ingress가 동작하려면 **2가지**가 필요하다:

```
[1] Ingress Controller (실행자) — 직접 설치해야 함
    = 실제 트래픽을 처리하는 리버스 프록시 Pod
    
    종류:
    ├── AWS Load Balancer Controller → ALB 생성 (AWS 환경)
    ├── nginx-ingress-controller → Nginx Pod (범용)
    └── Traefik, HAProxy, Istio 등

[2] Ingress 리소스 (규칙) — YAML로 생성
    = "이 경로/도메인은 이 서비스로 보내라" 라우팅 규칙
```

### 트래픽 경로

```
[인터넷]
    │
    ▼
┌──────────────────────────┐
│ ALB 또는 Nginx Pod       │  ← Ingress Controller
│ (L7 리버스 프록시)         │
│                          │
│ 규칙 확인:                │  ← Ingress 리소스
│   myapp.com/             │
│     → frontend-svc       │
│   myapp.com/api          │
│     → backend-svc        │
│   myapp.com/admin        │
│     → admin-svc          │
└──┬──────────┬──────────┬─┘
   │          │          │
   ▼          ▼          ▼
frontend   backend     admin    ← 전부 ClusterIP Service
  Pod        Pod        Pod
```

- URL 경로(`/api`, `/admin`)를 보고 분기 — L7이라 가능
- **LB 1개로 여러 서비스**를 처리한다

### 비용 비교

```
서비스 3개를 외부 노출할 때:

  LoadBalancer 방식:
    frontend-svc → NLB 1개 → 월 ~$20
    backend-svc  → NLB 1개 → 월 ~$20
    admin-svc    → NLB 1개 → 월 ~$20
    총: 월 ~$60

  Ingress 방식:
    ALB 1개 → /     → frontend-svc
            → /api  → backend-svc
            → /admin → admin-svc
    총: 월 ~$20
```

---

## Ingress 설정 실전 가이드

### Step 1: Ingress Controller 설치

**Minikube:**

```bash
minikube addons enable ingress

# 확인
kubectl get pods -n ingress-nginx
```

**EKS (AWS Load Balancer Controller):**

```bash
# 1. IAM 정책 생성
curl -o iam_policy.json https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.7.1/docs/install/iam_policy.json

aws iam create-policy \
  --policy-name AWSLoadBalancerControllerIAMPolicy \
  --policy-document file://iam_policy.json

# 2. ServiceAccount 생성
eksctl create iamserviceaccount \
  --cluster=my-cluster \
  --namespace=kube-system \
  --name=aws-load-balancer-controller \
  --attach-policy-arn=arn:aws:iam::<ACCOUNT_ID>:policy/AWSLoadBalancerControllerIAMPolicy \
  --approve

# 3. Helm으로 컨트롤러 설치
helm repo add eks https://aws.github.io/eks-charts
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=my-cluster \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller

# 확인
kubectl get pods -n kube-system | grep aws-load-balancer
```

**범용 (Nginx Ingress Controller):**

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.9.6/deploy/static/provider/cloud/deploy.yaml

# 확인
kubectl get pods -n ingress-nginx
```

### Step 2: 백엔드 Service는 ClusterIP로

Ingress를 쓸 때 뒤에 있는 Service는 **ClusterIP**(기본값)이면 된다. NodePort나 LoadBalancer로 만들 필요 없다.

```yaml
# frontend-service.yml
apiVersion: v1
kind: Service
metadata:
  name: frontend-svc
  namespace: metacoding
spec:
  # type: ClusterIP (기본값, 생략 가능)
  selector:
    app: frontend
  ports:
    - port: 80
      targetPort: 80
---
# backend-service.yml
apiVersion: v1
kind: Service
metadata:
  name: backend-svc
  namespace: metacoding
spec:
  selector:
    app: backend
  ports:
    - port: 8080
      targetPort: 8080
```

### Step 3: Ingress 리소스 생성

**Nginx Ingress (Minikube / 범용):**

```yaml
# ingress.yml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: metacoding-ingress
  namespace: metacoding
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx        # 어떤 Ingress Controller를 쓸지
  rules:
    - host: myapp.com            # 도메인 (없으면 모든 요청)
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend-svc
                port:
                  number: 80
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: backend-svc
                port:
                  number: 8080
```

**AWS ALB Ingress:**

```yaml
# ingress-alb.yml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: metacoding-ingress
  namespace: metacoding
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing     # 외부 공개
    alb.ingress.kubernetes.io/target-type: ip              # Pod IP 직접 라우팅
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:...  # HTTPS 인증서
spec:
  rules:
    - host: myapp.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend-svc
                port:
                  number: 80
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: backend-svc
                port:
                  number: 8080
```

### Step 4: 확인

```bash
# Ingress 상태 확인
kubectl get ingress -n metacoding

NAME                 CLASS   HOSTS       ADDRESS                                    PORTS   AGE
metacoding-ingress   nginx   myapp.com   a1b2c3.ap-northeast-2.elb.amazonaws.com   80      5m

# ADDRESS가 나오면 성공
# Minikube에서는 minikube ip로 나오는 IP 사용

# 테스트
curl http://myapp.com/           # → frontend-svc → frontend Pod
curl http://myapp.com/api        # → backend-svc → backend Pod
```

---

## Ingress Controller도 결국 Pod이다

Ingress Controller는 마법이 아니다. **kube-system이나 ingress-nginx 네임스페이스에서 실행되는 일반 Pod**이다.

```
kubectl get pods -n ingress-nginx

NAME                                        READY   STATUS
ingress-nginx-controller-5d88495688-abc12   1/1     Running
```

이 Pod 안에 Nginx(또는 다른 리버스 프록시)가 돌고 있고, Ingress 리소스를 watch해서 라우팅 규칙을 자동 반영한다.

```
Ingress 리소스 생성/수정
    │
    ▼
Ingress Controller Pod (watch 중)
    │
    │ "새 경로 규칙이 추가됐다"
    │
    ▼
내부 Nginx 설정 자동 갱신
    │
    ▼
트래픽 라우팅 시작
```

CoreDNS가 DNS를 처리하는 일반 Pod이듯, Ingress Controller도 HTTP 라우팅을 처리하는 일반 Pod이다.

---

## Ingress가 있으면 NodePort 없어도 되나?

**아니다.** Ingress Controller는 클러스터 **안에서** 라우팅하는 리버스 프록시일 뿐, 외부에서 이 Pod에 도달하려면 **진입점이 여전히 필요하다.**

### Ingress Controller 자체도 외부에 노출되어야 한다

```
흔한 오해:
  "Ingress를 쓰면 NodePort/LoadBalancer 없이 외부 접근 가능하다"

현실:
  Ingress Controller Pod 자체가 NodePort 또는 LoadBalancer로 외부에 노출된다.
  Ingress는 NodePort를 대체하는 게 아니라, NodePort 위에 올라탄다.
```

### 환경별 진입 경로

```
[클라우드 — EKS]

  인터넷
    │
    ▼
  ALB (Ingress Controller가 자동 생성)   ← LoadBalancer가 진입점
    │
    ▼
  Ingress Controller Pod
    │
    ├── /     → frontend-svc → Pod
    └── /api  → backend-svc → Pod


[로컬 — Minikube]

  방법 1: minikube tunnel

  브라우저
    │
    │  http://127.0.0.1
    │
    ▼
  minikube tunnel (LoadBalancer 시뮬레이션)  ← tunnel이 진입점
    │
    ▼
  Ingress Controller Pod
    │
    ├── /     → frontend-svc → Pod
    └── /api  → backend-svc → Pod


  방법 2: Ingress Controller의 NodePort 직접 사용

  브라우저
    │
    │  http://192.168.49.2:30080
    │
    ▼
  Ingress Controller의 NodePort           ← NodePort가 진입점
    │
    ▼
  Ingress Controller Pod
    │
    ├── /     → frontend-svc → Pod
    └── /api  → backend-svc → Pod
```

### Minikube에서 Ingress 접근하는 실전 방법

```bash
# 1. Ingress Controller 설치
minikube addons enable ingress

# 2. Ingress Controller가 어떻게 노출되어 있는지 확인
kubectl get svc -n ingress-nginx

NAME                       TYPE       CLUSTER-IP     PORT(S)
ingress-nginx-controller   NodePort   10.96.xxx.xx   80:30080/TCP,443:30443/TCP
                           ↑ NodePort로 노출되어 있다!

# 3. 접근 방법 A: minikube tunnel (권장)
minikube tunnel
# → 이제 http://127.0.0.1 로 접근 가능

# 3. 접근 방법 B: NodePort 직접 사용
minikube ip
# → 192.168.49.2
# → http://192.168.49.2:30080 으로 접근
```

### 결론: 진입점 없이는 아무것도 안 된다

| 환경 | Ingress Controller의 진입점 | 접근 방법 |
|---|---|---|
| **EKS** | ALB (자동 생성) | `http://ALB주소/api` |
| **Minikube** | NodePort + tunnel | `http://127.0.0.1/api` |
| **bare-metal** | NodePort 또는 MetalLB | `http://노드IP:30080/api` |

```
계층 구조:

  [진입점]          NodePort / LoadBalancer / tunnel
      │             ← 외부 → 클러스터 경계를 넘는 역할
      ▼
  [라우팅]          Ingress Controller (Nginx/ALB)
      │             ← 경로/도메인 보고 분기하는 역할
      ▼
  [서비스]          ClusterIP Service → Pod
                    ← 클러스터 내부 트래픽 전달
```

Ingress는 **"어디로 보낼지"를 결정**하고, NodePort/LoadBalancer는 **"외부에서 들어올 문"을 연다.** 둘은 대체 관계가 아니라 **각자 다른 레이어**다.

---

## 전체 비교 정리

### 뭘 써야 하는가?

| 상황 | 추천 | 이유 |
|---|---|---|
| 로컬 개발/테스트 | NodePort | 설정 간단, 외부 인프라 불필요 |
| 서비스 1개 외부 노출 | LoadBalancer | YAML 한 줄로 공인 IP |
| 서비스 여러 개 + 도메인 | **Ingress** | LB 1개로 경로 분기, 비용 절약 |
| HTTPS 필요 | **Ingress** | ACM/cert-manager로 간단 설정 |

### 컴포넌트 관여 비교

| | 누가 처리하는가 | 설치 필요? |
|---|---|---|
| **NodePort** | kube-proxy (iptables) | 없음 (기본 내장) |
| **LoadBalancer** | kube-proxy + Cloud Controller Manager | CCM (EKS 기본 포함) |
| **Ingress** | Ingress Controller Pod + (선택적으로) 클라우드 LB | Ingress Controller 별도 설치 |

### 한 줄 요약

- **NodePort/LoadBalancer**: "포트 번호"로 서비스 구분 (L4). 서비스마다 포트 or LB가 따로 필요하다.
- **Ingress**: "URL 경로/도메인"으로 서비스 구분 (L7). LB 1개로 여러 서비스를 처리한다. 프로덕션 표준.
