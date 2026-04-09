# Minikube 내부 네트워크 구조 설명

## 3개의 IP 계층

Minikube에는 **3가지 서로 다른 IP 대역**이 존재한다:

```
┌─────────────────────────────────────────────────────────┐
│  Windows Host (내 PC)                                    │
│  IP: 예) 192.168.0.10 (실제 LAN IP)                      │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Minikube Node (가상머신/Docker 컨테이너)              │ │
│  │  Node IP: 192.168.49.2 (minikube ip로 확인)          │ │
│  │                                                      │ │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ │ │
│  │  │  Pod: frontend│ │ Pod: backend │ │  Pod: db     │ │ │
│  │  │  10.244.0.5  │ │ 10.244.0.6  │ │ 10.244.0.7  │ │ │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ │ │
│  │                                                      │ │
│  │  ┌──────────────┐ ┌──────────────┐                  │ │
│  │  │ Pod: backend2│ │  Pod: redis  │                  │ │
│  │  │ 10.244.0.8  │ │ 10.244.0.9  │                  │ │
│  │  └──────────────┘ └──────────────┘                  │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 1층: Host IP (Windows)
- 내 PC의 실제 네트워크 IP
- Minikube와는 **가상 네트워크 브릿지**로 연결됨

### 2층: Node IP (192.168.49.x)
- `minikube ip` 명령으로 확인 가능
- Minikube가 만든 **가상머신(또는 Docker 컨테이너)**의 IP
- Windows와 Minikube Node 사이의 가상 네트워크 대역
- Docker 드라이버 사용 시: `192.168.49.2` (일반적)
- 이 IP로 NodePort 서비스에 접근 가능

### 3층: Pod IP (10.244.x.x)
- 각 Pod마다 **고유한 IP**가 부여됨
- Kubernetes 내부 가상 네트워크 (CNI 플러그인이 관리)
- Pod끼리는 이 IP로 직접 통신 가능
- **클러스터 외부에서는 접근 불가** (내부 전용)

---

## 왜 Pod IP가 전부 다른가?

Kubernetes는 **"IP-per-Pod" 모델**을 사용:

```
Pod 생성 시:
  CNI 플러그인 (kindnet/bridge) → Pod에 고유 IP 할당 (10.244.0.x)
  각 Pod = 독립된 네트워크 네임스페이스
  → 자체 IP, 자체 포트 공간
```

- backend replica 2개 → 각각 다른 Pod IP를 가짐
- 같은 포트(8080)를 써도 IP가 다르므로 충돌 없음

---

## Service의 역할 (ClusterIP)

Pod IP는 **임시적**(Pod 재시작 시 변경됨). 그래서 **Service**가 필요:

```
                    ┌─────────────────────┐
                    │  backend-service     │
                    │  ClusterIP: 10.96.x.x│
                    │  Port: 8080          │
                    └──────┬──────────────┘
                           │ (로드밸런싱)
                    ┌──────┴──────┐
                    ▼             ▼
              Pod 10.244.0.6  Pod 10.244.0.8
              (backend #1)   (backend #2)
```

- Service도 자체 IP(ClusterIP, 10.96.x.x 대역)를 가짐
- 하지만 실제로는 **DNS 이름**으로 접근: `backend-service.metacoding.svc.cluster.local`
- ConfigMap에서 `db-service:3306`, `redis-service:6379`로 쓰는 이유가 이것

### ClusterIP는 왜 Pod와 대역이 다른가?

Pod는 죽으면 IP가 바뀐다. ClusterIP는 **"변하지 않는 대표 번호"**:

```
frontend Pod → 10.96.0.100 (backend-service) ← 이 IP는 절대 안 바뀜
                     │
              kube-proxy (iptables DNAT)
              가상 IP → 실제 Pod IP로 변환
                     │
              ┌──────┴──────┐
              ▼             ▼
        10.244.0.6    10.244.0.8    ← 이 IP들은 바뀔 수 있음
```

대역을 분리하는 이유:

| | Pod IP (10.244.x.x) | Service IP (10.96.x.x) |
|---|---|---|
| 할당 주체 | kubelet (Pod 생성 시) | API server (Service 생성 시) |
| 수명 | Pod와 함께 생성/소멸 | Service 삭제 전까지 영구 |
| 실체 | 실제 네트워크 인터페이스(veth) | iptables 규칙 (가상) |
| 충돌 방지 | Pod끼리 겹치면 안 됨 | Pod IP와 겹치면 안 됨 |

대역이 분리되어야 Pod가 수백 개씩 생겼다 죽어도 Service IP와 충돌하지 않는다.

---

## IP 대역 정리

| 계층 | 대역 (예시) | 용도 | 확인 방법 |
|------|------------|------|----------|
| Host (Windows) | 192.168.0.x | 내 PC 실제 IP | `ipconfig` |
| Node (Minikube) | 192.168.49.x | Minikube VM IP | `minikube ip` |
| Pod | 10.244.0.x | 개별 Pod IP | `kubectl get pods -o wide` |
| Service (ClusterIP) | 10.96.x.x | 서비스 가상 IP | `kubectl get svc` |

---

## 현재 프로젝트(ex08)의 네트워크 흐름

```
[Windows 브라우저]
       │
       │ minikube service 또는 port-forward
       ▼
[Minikube Node: 192.168.49.2]
       │
       │ NodePort / kubectl port-forward
       ▼
[frontend-service] ──→ [frontend Pod :80]
       │
       │ HTTP 요청
       ▼
[backend-service] ──→ [backend Pod #1 :8080]
       │                [backend Pod #2 :8080]  ← 로드밸런싱
       │
       ├──→ [db-service] ──→ [db Pod :3306]  (MySQL + PV)
       └──→ [redis-service] ──→ [redis Pod :6379]
```

모든 Service가 **ClusterIP** 타입이므로, 외부 접근을 위해서는:
- `kubectl port-forward`
- `minikube service <name> -n metacoding`
- 또는 NodePort/Ingress 설정이 필요

---

## Service 종류별 동작 원리

### 전체 그림: 외부 → 내부 트래픽 흐름

```
[인터넷]
    │
    ▼
┌──────────────────────────────────────────────────────────────────┐
│ LoadBalancer (클라우드가 제공하는 외부 LB)                          │
│ External IP: 52.14.x.x                                          │
│ ※ kube-proxy 아님! 클라우드 자체 로드밸런서 서버                     │
└──────────┬───────────────────────────────────────────────────────┘
           ▼
┌──────────────────────────────────────────────────────────────────┐
│ Minikube Node (192.168.49.2)                                     │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │ kube-proxy (iptables 규칙 관리자)                         │     │
│  │                                                          │     │
│  │  NodePort 규칙: 192.168.49.2:30080 → Service             │     │
│  │  ClusterIP 규칙: 10.96.x.x → Pod IP들 (DNAT)            │     │
│  └─────────────────────────────────────────────────────────┘     │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐                      │
│  │ ClusterIP        │  │ Headless Service │                      │
│  │ 10.96.0.100:8080 │  │ ClusterIP: None  │                      │
│  │ kube-proxy가 제어 │  │ DNS가 직접 연결   │                      │
│  └────────┬─────────┘  └───────┬──────────┘                      │
│           │                    │                                  │
│    ┌──────┴──────┐      DNS가 Pod IP 목록 직접 반환               │
│    ▼             ▼             │                                  │
│  Pod 10.244.0.6  Pod .0.8     ▼                                  │
│  (backend #1)   (backend #2)  Pod 10.244.0.7 (StatefulSet 등)    │
└──────────────────────────────────────────────────────────────────┘
```

### Service 종류 비교

| 타입 | 접근 범위 | 트래픽 처리 | 고정 IP |
|------|----------|-----------|---------|
| **ClusterIP** | 클러스터 내부만 | kube-proxy (iptables DNAT) | 있음 (10.96.x.x) |
| **NodePort** | 외부 → Node IP:Port | kube-proxy (iptables) | ClusterIP + NodePort |
| **LoadBalancer** | 외부 → 외부 IP | **클라우드 LB** → NodePort → kube-proxy | 외부 IP + ClusterIP |
| **ExternalName** | 클러스터 내부 | **DNS CNAME** (kube-proxy 안 씀) | 없음 |
| **Headless** | 클러스터 내부 | **DNS 직접 반환** (kube-proxy 안 씀) | 없음 (ClusterIP: None) |

### 1. ClusterIP (기본값) — kube-proxy 제어

```yaml
apiVersion: v1
kind: Service
metadata:
  name: backend-service
spec:
  type: ClusterIP          # 기본값, 생략 가능
  selector:
    app: backend
  ports:
    - port: 8080
      targetPort: 8080
```

- 가상 IP(10.96.x.x)를 iptables 규칙으로 Pod에 연결
- **kube-proxy가 iptables 규칙을 생성/관리**
- 클러스터 외부에서 접근 불가

### 2. NodePort — kube-proxy 제어

```yaml
spec:
  type: NodePort
  ports:
    - port: 8080
      targetPort: 8080
      nodePort: 30080      # 30000-32767 범위
```

- ClusterIP 기능 **포함** + Node IP:30080으로 외부 접근 가능
- **kube-proxy가 NodePort → ClusterIP → Pod 전체 iptables 규칙 관리**
- `192.168.49.2:30080` → `10.96.x.x:8080` → `10.244.0.6:8080`

### 3. LoadBalancer — 클라우드 자체 서버 + kube-proxy

```yaml
spec:
  type: LoadBalancer
  ports:
    - port: 80
      targetPort: 8080
```

- **클라우드 제공자(AWS ALB/NLB, GCP LB)**가 외부 IP를 할당하고 자체 서버로 로드밸런싱
- 클라우드 LB → NodePort → kube-proxy → Pod
- kube-proxy는 **Node 내부 구간만** 담당, 외부 LB는 클라우드가 관리
- Minikube에서는 `minikube tunnel`로 시뮬레이션

### 4. ExternalName — kube-proxy 사용 안 함

```yaml
spec:
  type: ExternalName
  externalName: my-database.aws.amazon.com
```

- iptables 규칙 없음, ClusterIP 없음
- **CoreDNS가 CNAME 레코드만 반환** → 클러스터 내부에서 외부 서비스를 DNS 별칭으로 접근
- 용도: 외부 DB나 API를 Service 이름으로 추상화

### 5. Headless Service — kube-proxy 사용 안 함

```yaml
spec:
  clusterIP: None           # 핵심: ClusterIP를 명시적으로 None
  selector:
    app: db
  ports:
    - port: 3306
```

- ClusterIP 없음 → kube-proxy가 관여하지 않음
- **DNS 조회 시 Pod IP 목록을 직접 반환** (A 레코드)
- StatefulSet과 함께 사용 → 각 Pod에 고유 DNS: `db-0.db-service`, `db-1.db-service`
- 용도: 클라이언트가 직접 Pod를 선택해야 할 때 (DB 리더/팔로워 등)

---

## kube-proxy 정리

```
kube-proxy의 역할:
  Service 생성 감지 → iptables 규칙 자동 생성/갱신
  Pod 추가/삭제 감지 → 라우팅 대상 자동 업데이트
```

| kube-proxy가 제어 | kube-proxy 안 씀 |
|---|---|
| ClusterIP | ExternalName (DNS CNAME) |
| NodePort | Headless (DNS A 레코드) |
| LoadBalancer (Node 내부 구간) | LoadBalancer (외부 LB 구간) |

---

## 핵심 요약

1. **192.168.49.x** = Minikube 노드(가상머신) IP. Host↔Minikube 통신용
2. **10.244.0.x** = Pod IP. Pod마다 다름. 클러스터 내부 전용
3. **10.96.x.x** = Service ClusterIP. Pod IP를 추상화하여 안정적 접근점 제공. 대역이 다른 이유는 Pod와 독립적으로 관리하기 위함
4. Pod끼리는 Service DNS(`db-service:3306`)로 통신 → Pod IP 변경에 영향 안 받음
5. **kube-proxy** = ClusterIP/NodePort의 iptables 규칙 관리자. 모든 Service를 제어하는 것은 아님
6. **ExternalName/Headless** = DNS 기반으로 동작, kube-proxy 없이 CoreDNS가 직접 처리
