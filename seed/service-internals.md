# Service를 만들면 누가 처리하는가?

> 이 글은 [Minikube 네트워크 구조], [터널링 vs NodePort] 글을 읽은 뒤 보면 좋다.

`kubectl apply -f service.yaml`을 실행하면 "Created"라고 뜬다. 대답하는 건 API Server다. 하지만 **실제로 네트워크 규칙을 만들고, 로드밸런서를 주문하고, DNS를 등록하는 건 각각 다른 컴포넌트**다.

---

## Service 생성 후 벌어지는 일

```
kubectl apply -f service.yaml
    │
    ▼
[API Server] ──── etcd에 Service 오브젝트 저장
    │
    │  watch 이벤트 발생
    │
    ├──────────────────┬──────────────────┐
    ▼                  ▼                  ▼
[kube-proxy]    [Cloud Controller    [CoreDNS]
 (모든 Node)     Manager]             (kube-system Pod)
    │              │                    │
    │              │                    │
 iptables/IPVS   클라우드 LB 생성       DNS 레코드
 규칙 생성        (AWS NLB 등)          등록
```

3개 컴포넌트가 **독립적으로** API Server를 watch한다. Service type에 따라 **반응하는 컴포넌트가 다르다.**

---

## Category 1: kube-proxy가 혼자 처리하는 타입

kube-proxy는 **모든 Worker Node에서 실행되는 프로세스**다. API Server를 watch하다가 Service/Endpoints가 변경되면, 해당 노드의 iptables(또는 IPVS) 규칙을 업데이트한다.

별도의 서버나 외부 인프라가 **필요 없다**. 노드 안에서 커널 레벨 규칙만 설정하면 끝이다.

### ClusterIP (기본값)

kube-proxy가 각 노드에 **iptables DNAT 규칙**을 생성한다:

```
[kube-proxy가 만드는 iptables 규칙]

Chain KUBE-SERVICES:
  목적지가 10.96.0.100:8080이면 → KUBE-SVC-XXXX로 점프

Chain KUBE-SVC-XXXX (로드밸런싱):
  50% 확률 → KUBE-SEP-AAAA
  50% 확률 → KUBE-SEP-BBBB

Chain KUBE-SEP-AAAA:
  DNAT → 10.244.0.6:8080   (Pod #1)

Chain KUBE-SEP-BBBB:
  DNAT → 10.244.0.8:8080   (Pod #2)
```

패킷이 ClusterIP(10.96.0.100)로 향하면, 커널이 iptables 규칙에 따라 **목적지 IP를 Pod IP로 바꿔치기**(DNAT)한다. ClusterIP라는 가상 IP에 실제로 응답하는 서버는 없다 — iptables 규칙이 중간에서 주소를 바꿔버리는 것이다.

#### iptables 모드 vs IPVS 모드

kube-proxy에는 두 가지 모드가 있다:

| | iptables 모드 | IPVS 모드 |
|---|---|---|
| 규칙 구조 | 체인을 순차 탐색 | 해시 테이블 |
| Service 1000개일 때 | 느려짐 (O(n)) | 빠름 (O(1)) |
| 로드밸런싱 알고리즘 | 확률 기반 (random) | rr, lc, sh 등 선택 가능 |
| 기본값 여부 | 대부분의 클러스터 기본값 | 대규모 클러스터에서 권장 |

대부분의 소규모~중규모 클러스터는 iptables 모드로 충분하다.

### NodePort

NodePort는 **ClusterIP의 확장**이다. kube-proxy가 규칙을 **2겹**으로 만든다:

```
NodePort Service = ClusterIP + 노드 포트 개방

kube-proxy가 만드는 규칙:

  [1] ClusterIP 규칙 (내부용) — ClusterIP와 동일
      10.96.0.100:80 → Pod들

  [2] NodePort 규칙 (외부용) — 추가!
      <모든 노드 IP>:30080 → 10.96.0.100:80 → Pod들
```

역시 kube-proxy 혼자 iptables 규칙만 추가하면 끝이다. 별도 서버나 외부 인프라 불필요.

---

## Category 2: 외부 컴포넌트가 필요한 타입

### LoadBalancer — Cloud Controller Manager 필요

LoadBalancer Service를 만들면, kube-proxy는 **ClusterIP + NodePort까지만 처리**한다. 여기까지는 NodePort와 동일하다.

진짜 차이는 **Cloud Controller Manager (CCM)**가 반응한다는 것이다:

```
kubectl apply -f svc-lb.yaml
    │
    ▼
[API Server]
    │
    ├─── kube-proxy: ClusterIP + NodePort 규칙 생성 (여기까지는 NodePort와 같다)
    │
    └─── Cloud Controller Manager (CCM)
              │
              │ "type: LoadBalancer 감지!"
              │
              ▼
         [클라우드 API 호출]
         (AWS API / GCP API / Azure API)
              │
              ▼
         로드밸런서 생성 (예: AWS NLB)
              │
              ▼
         Service.status.loadBalancer.ingress에 외부 IP/URL 기록
              │
              ▼
         kubectl get svc에서 EXTERNAL-IP 표시됨
```

CCM은 **클라우드 제공자(AWS, GCP, Azure)의 API를 호출해서 진짜 로드밸런서를 생성**하는 컴포넌트다. Control Plane에서 실행되며, `type: LoadBalancer` Service를 감지하면 자동으로 해당 클라우드의 LB를 주문한다.

#### Minikube에서 EXTERNAL-IP가 `<pending>`인 이유

Minikube에는 CCM이 없다 (클라우드 환경이 아니므로). kube-proxy는 ClusterIP + NodePort 규칙까지 만들었지만, 외부 LB를 만들어줄 CCM이 없어서 EXTERNAL-IP가 영원히 `<pending>` 상태로 남는다.

```
EKS (CCM 있음):
  EXTERNAL-IP = a1b2c3.ap-northeast-2.elb.amazonaws.com  ✅

Minikube (CCM 없음):
  EXTERNAL-IP = <pending>  ← LB를 만들어줄 사람이 없다
```

bare-metal 환경에서 LoadBalancer를 쓰고 싶다면 **MetalLB** 같은 프로젝트가 CCM 역할을 대신한다.

### ExternalName — CoreDNS만 관여

ExternalName은 **가장 특이한 타입**이다. kube-proxy가 **아무것도 하지 않는다**:

- iptables 규칙 없음
- ClusterIP 없음
- 트래픽 라우팅 없음

오직 **CoreDNS만 CNAME 레코드를 등록**한다:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-db
spec:
  type: ExternalName
  externalName: my-rds.abc123.ap-northeast-2.rds.amazonaws.com
```

```
Pod 안에서:
  nslookup my-db.default.svc.cluster.local

CoreDNS 응답:
  my-db.default.svc.cluster.local
    → CNAME → my-rds.abc123.ap-northeast-2.rds.amazonaws.com

kube-proxy: (아무것도 안 함)
```

사용 사례: 클러스터 외부의 RDS, 외부 API 등을 **Service 이름으로 추상화**할 때. Pod 코드에서 `my-db`라는 이름만 쓰면, 나중에 외부 DB에서 클러스터 내부 DB로 전환할 때 Service만 바꾸면 된다.

---

## DNS는 어디에? — CoreDNS

`backend-service:8080`으로 접근하면 DNS가 알아서 IP를 찾아주는데, 이 DNS는 어디에 있는가?

### CoreDNS = kube-system의 일반 Pod

```
kubectl get pods -n kube-system | grep coredns

NAME                       READY   STATUS    RESTARTS
coredns-5dd5756b68-abc12   1/1     Running   0
coredns-5dd5756b68-def34   1/1     Running   0
```

CoreDNS는 kube-system 네임스페이스에서 **Deployment로 실행되는 일반 Pod**이다. 그리고 이 Pod에 접근하기 위한 **Service(kube-dns)**도 존재한다:

```
kubectl get svc -n kube-system

NAME       TYPE        CLUSTER-IP   PORT(S)
kube-dns   ClusterIP   10.96.0.10   53/UDP,53/TCP
```

### DNS 질의 과정

```
┌──────────────────────────────────────────────┐
│  Worker Node                                  │
│                                               │
│  ┌──────────┐     ┌───────────────────────┐   │
│  │ App Pod  │     │  kube-system NS       │   │
│  │          │     │                       │   │
│  │ /etc/    │     │  ┌─────────────────┐  │   │
│  │ resolv   │────▶│  │  CoreDNS Pod    │  │   │
│  │ .conf    │     │  │  (Deployment)   │  │   │
│  │          │     │  └────────┬────────┘  │   │
│  │ nameserver│     │          │            │   │
│  │ 10.96.0.10│    │  kube-dns Service    │   │
│  └──────────┘     │  ClusterIP:10.96.0.10│   │
│                   └───────────────────────┘   │
└──────────────────────────────────────────────┘
```

1. Pod이 `backend-service`에 접근하려 한다
2. Pod의 `/etc/resolv.conf`에 nameserver로 **CoreDNS의 ClusterIP**(10.96.0.10)가 적혀 있다
3. CoreDNS는 API Server를 watch해서 모든 Service 정보를 알고 있다
4. `backend-service.metacoding.svc.cluster.local → 10.96.45.12` 라고 응답한다

### 닭과 달걀 문제

"CoreDNS도 ClusterIP Service(kube-dns)를 통해 접근하는데, 그 ClusterIP는 누가 알려주나?"

답: **kubelet이 Pod 생성 시 `/etc/resolv.conf`에 하드코딩**한다. kubelet 설정(`--cluster-dns` 플래그)에 CoreDNS Service의 ClusterIP가 미리 지정되어 있다. DNS로 찾는 게 아니라 설정값으로 주입되는 것이다.

### CoreDNS가 하는 일 정리

| Service 타입 | CoreDNS가 등록하는 레코드 |
|---|---|
| ClusterIP | A 레코드: `서비스명.NS.svc.cluster.local → ClusterIP` |
| NodePort | A 레코드: ClusterIP와 동일 (NodePort 정보는 DNS에 없음) |
| LoadBalancer | A 레코드: ClusterIP와 동일 (EXTERNAL-IP는 DNS에 없음) |
| ExternalName | CNAME 레코드: `서비스명 → externalName 값` |

---

## 전체 정리

### Service 타입별 처리 주체

| Service 타입 | kube-proxy | Cloud Controller Manager | CoreDNS |
|---|---|---|---|
| **ClusterIP** | iptables/IPVS 규칙 생성 | 관여 안 함 | A 레코드 등록 |
| **NodePort** | ClusterIP 규칙 + NodePort 규칙 | 관여 안 함 | A 레코드 등록 |
| **LoadBalancer** | ClusterIP + NodePort 규칙 | 클라우드 LB 생성 | A 레코드 등록 |
| **ExternalName** | 아무것도 안 함 | 관여 안 함 | CNAME 레코드 등록 |

### Service 타입의 포함 관계

```
LoadBalancer
┌─────────────────────────────────────────────────┐
│  Cloud Controller Manager: 외부 LB 생성          │
│                                                  │
│  NodePort                                        │
│  ┌────────────────────────────────────────────┐  │
│  │  kube-proxy: 모든 노드에 포트 개방          │  │
│  │                                             │  │
│  │  ClusterIP                                  │  │
│  │  ┌───────────────────────────────────────┐  │  │
│  │  │  kube-proxy: iptables/IPVS 규칙 생성  │  │  │
│  │  └───────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘

ExternalName (완전히 별개)
┌──────────────────────────────┐
│  CoreDNS만 관여 (CNAME)       │
│  kube-proxy 무관              │
│  ClusterIP 없음               │
└──────────────────────────────┘
```

### 한 줄 요약

- **ClusterIP, NodePort**: kube-proxy가 iptables 규칙만으로 처리. 외부 인프라 불필요.
- **LoadBalancer**: kube-proxy(ClusterIP+NodePort) + Cloud Controller Manager가 클라우드 LB 생성.
- **ExternalName**: kube-proxy 무관. CoreDNS만 CNAME 등록.
- **DNS(CoreDNS)**: kube-system에서 일반 Pod으로 실행되며, 모든 Service의 DNS 이름을 관리한다.
