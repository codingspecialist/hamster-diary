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

## 핵심 요약

1. **192.168.49.x** = Minikube 노드(가상머신) IP. Host↔Minikube 통신용
2. **10.244.0.x** = Pod IP. Pod마다 다름. 클러스터 내부 전용
3. **10.96.x.x** = Service ClusterIP. Pod IP를 추상화하여 안정적 접근점 제공
4. Pod끼리는 Service DNS(`db-service:3306`)로 통신 → Pod IP 변경에 영향 안 받음
