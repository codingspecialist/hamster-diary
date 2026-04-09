# ex08 : Minikube → AWS EKS 배포 가이드

## 1. 결론부터: Kind로 바꿔야 하나?

**아니다. Kind로 바꿀 필요 없다.**

Minikube에서 작성한 K8s 매니페스트(YAML)는 **표준 쿠버네티스 API**를 사용하므로, EKS에서도 거의 그대로 사용할 수 있다. 바꿔야 하는 건 **Minikube 전용 부분**뿐이다.

```
Minikube YAML ──(약간 수정)──▶ EKS YAML

바꿔야 하는 것:
  1. 이미지 경로: metacoding/backend:1 → ECR 주소로 변경
  2. PV (hostPath) → EBS StorageClass로 변경
  3. Service 타입 → LoadBalancer로 변경

안 바꿔도 되는 것:
  ✅ Deployment, ConfigMap, Secret, Namespace → 그대로 사용
```

---

## 2. 전체 배포 플로우

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    Minikube → EKS 배포 전체 흐름                          │
│                                                                          │
│  Step 1          Step 2           Step 3          Step 4                 │
│  ┌──────┐       ┌──────────┐     ┌──────────┐    ┌──────────┐           │
│  │ ECR  │       │ Docker   │     │ EKS      │    │ YAML     │           │
│  │ 저장소│──────▶│ 이미지    │────▶│ 클러스터  │───▶│ 배포     │           │
│  │ 생성  │       │ Push     │     │ 생성     │    │ (apply)  │           │
│  └──────┘       └──────────┘     └──────────┘    └──────────┘           │
│                                                                          │
│  Step 5          Step 6                                                  │
│  ┌──────────┐   ┌──────────┐                                            │
│  │ 접속     │   │ 도메인    │                                            │
│  │ 확인     │──▶│ 연결     │                                            │
│  └──────────┘   └──────────┘                                            │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 사전 준비 (AWS CLI + eksctl 설치)

### 3-1. AWS CLI 설치

```bash
# Windows (MSI 설치)
# https://aws.amazon.com/cli/ 에서 다운로드

# 설치 확인
aws --version
```

### 3-2. AWS 로그인 설정

```bash
aws configure
# AWS Access Key ID: (IAM에서 발급받은 키)
# AWS Secret Access Key: (IAM에서 발급받은 시크릿)
# Default region name: ap-northeast-2    ← 서울 리전
# Default output format: json
```

### 3-3. eksctl 설치

```bash
# Windows (Chocolatey)
choco install eksctl

# macOS
brew tap weaveworks/tap
brew install weaveworks/tap/eksctl

# 설치 확인
eksctl version
```

### 3-4. kubectl 설치 확인

```bash
# 이미 Minikube 실습 때 설치했으므로 확인만
kubectl version --client
```

---

## 4. Step 1 — ECR 저장소 생성

### Minikube vs EKS의 이미지 차이

```
Minikube:
  minikube image build -t metacoding/backend:1 ./backend
  → Minikube VM 안에 이미지가 저장됨 (로컬 전용)

EKS:
  docker build → ECR에 push → EKS가 ECR에서 pull
  → 클라우드 저장소(ECR)를 통해 이미지를 공유
```

**ECR (Elastic Container Registry)** = AWS의 Docker Hub. EKS가 이미지를 가져올 수 있는 클라우드 저장소이다.

### ECR 저장소 만들기

```bash
# 4개 서비스 각각 저장소 생성
aws ecr create-repository --repository-name metacoding/backend --region ap-northeast-2
aws ecr create-repository --repository-name metacoding/frontend --region ap-northeast-2
aws ecr create-repository --repository-name metacoding/db --region ap-northeast-2
aws ecr create-repository --repository-name metacoding/redis --region ap-northeast-2
```

생성 후 ECR 주소 형식:
```
{AWS계정ID}.dkr.ecr.ap-northeast-2.amazonaws.com/metacoding/backend
```

> 쉬운 예시: ECR은 **구글 드라이브**와 같다. 로컬 파일(이미지)을 드라이브(ECR)에 올려야 다른 컴퓨터(EKS)에서 다운받을 수 있다.

---

## 5. Step 2 — Docker 이미지 빌드 & ECR Push

### ECR 로그인

```bash
# ECR에 docker login (한 번만 실행)
aws ecr get-login-password --region ap-northeast-2 | docker login --username AWS --password-stdin {AWS계정ID}.dkr.ecr.ap-northeast-2.amazonaws.com
```

### 이미지 빌드 & 태그 & Push

```bash
# ── 변수 설정 (자기 AWS 계정 ID로 변경) ──
ECR_URI={AWS계정ID}.dkr.ecr.ap-northeast-2.amazonaws.com

# ── Backend ──
docker build -t metacoding/backend:1 ./backend
docker tag metacoding/backend:1 $ECR_URI/metacoding/backend:1
docker push $ECR_URI/metacoding/backend:1

# ── Frontend ──
docker build -t metacoding/frontend:1 ./frontend
docker tag metacoding/frontend:1 $ECR_URI/metacoding/frontend:1
docker push $ECR_URI/metacoding/frontend:1

# ── DB ──
docker build -t metacoding/db:1 ./db
docker tag metacoding/db:1 $ECR_URI/metacoding/db:1
docker push $ECR_URI/metacoding/db:1

# ── Redis ──
docker build -t metacoding/redis:1 ./redis
docker tag metacoding/redis:1 $ECR_URI/metacoding/redis:1
docker push $ECR_URI/metacoding/redis:1
```

> 쉬운 예시: 사진을 폰에서 찍고(build), 이름을 붙이고(tag), 클라우드에 올리는(push) 것과 같다.

---

## 6. Step 3 — EKS 클러스터 생성

```bash
eksctl create cluster \
  --name metacoding-cluster \
  --region ap-northeast-2 \
  --version 1.31 \
  --nodegroup-name metacoding-nodes \
  --node-type t3.medium \
  --nodes 2 \
  --nodes-min 1 \
  --nodes-max 3
```

**약 15~20분** 소요된다. CloudFormation으로 VPC, 서브넷, 보안그룹, EC2 노드가 자동 생성된다.

```
eksctl이 자동으로 만들어주는 것:
┌─────────────────────────────────────────┐
│  AWS 클라우드                            │
│                                         │
│  VPC (가상 네트워크)                      │
│  ├── 서브넷 (퍼블릭/프라이빗)             │
│  ├── 보안그룹 (방화벽)                    │
│  ├── Master Node (AWS가 관리 = 무료)     │
│  └── Worker Node x2 (t3.medium EC2)     │
│      ├── Node 1: Pod들이 실행됨          │
│      └── Node 2: Pod들이 실행됨          │
└─────────────────────────────────────────┘
```

### 클러스터 확인

```bash
# kubectl이 EKS를 가리키는지 확인
kubectl cluster-info

# 노드 확인
kubectl get nodes
```

> 쉬운 예시: Minikube는 **내 노트북에 연습장**을 만든 것이고, EKS는 **AWS에 진짜 서버**를 빌린 것이다. 둘 다 kubectl로 동일하게 조작한다.

---

## 7. Step 4 — YAML 수정 & 배포

### 바꿔야 하는 파일 목록

| 파일 | 변경 내용 | 이유 |
|------|----------|------|
| `backend-deploy.yml` | 이미지 경로 → ECR 주소 | Minikube 로컬 이미지 → ECR |
| `frontend-deploy.yml` | 이미지 경로 → ECR 주소 | 동일 |
| `db-deploy.yml` | 이미지 경로 → ECR 주소 | 동일 |
| `redis-deploy.yml` | 이미지 경로 → ECR 주소 | 동일 |
| `db-pv.yml` | hostPath → EBS StorageClass | Minikube VM 경로는 EKS에 없음 |
| `db-pvc.yml` | storageClassName 변경 | EBS를 사용하도록 |
| `frontend-service.yml` | type: LoadBalancer 추가 | 외부에서 접속 가능하게 |

### 7-1. Deployment 이미지 경로 변경

**Minikube (기존)**:
```yaml
# backend-deploy.yml
image: metacoding/backend:1
```

**EKS (변경)**:
```yaml
# backend-deploy.yml
image: {AWS계정ID}.dkr.ecr.ap-northeast-2.amazonaws.com/metacoding/backend:1
```

4개 Deployment 파일 모두 동일하게 ECR 주소로 변경한다.

### 7-2. PV/PVC 변경 (DB 영구 저장소)

**Minikube (기존)** — hostPath 사용:
```yaml
# db-pv.yml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: db-pv
spec:
  capacity:
    storage: 1Gi
  accessModes:
    - ReadWriteOnce
  hostPath:           # ← Minikube VM의 로컬 경로
    path: /data/mysql
```

**EKS (변경)** — PV를 삭제하고 PVC만 사용 (EBS가 자동 생성):
```yaml
# db-pv.yml → 삭제 (EBS가 자동으로 PV를 생성해줌)

# db-pvc.yml (수정)
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: db-pvc
  namespace: metacoding
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  storageClassName: gp2    # ← EKS 기본 EBS 스토리지 클래스
  # volumeName: db-pv      ← 삭제 (자동 바인딩)
```

```
Minikube:
  PV (hostPath: /data/mysql) ←── PVC ←── Pod
  └ Minikube VM 안의 폴더에 저장

EKS:
  EBS (AWS 디스크) ←── PVC ←── Pod    (PV는 자동 생성됨)
  └ AWS의 가상 디스크(EBS)에 저장
```

> 쉬운 예시: Minikube의 hostPath는 **내 노트북의 USB**에 저장하는 것이고, EKS의 EBS는 **클라우드 외장하드**에 저장하는 것이다.

### 7-3. Frontend Service 변경 (외부 접속)

**Minikube (기존)** — ClusterIP (기본):
```yaml
# frontend-service.yml
apiVersion: v1
kind: Service
metadata:
  name: frontend-service
  namespace: metacoding
spec:
  selector:
    app: frontend
  ports:
    - port: 80
      targetPort: 80
  # type이 없으면 기본값 ClusterIP → 외부 접속 불가
```

**EKS (변경)** — LoadBalancer 추가:
```yaml
# frontend-service.yml
apiVersion: v1
kind: Service
metadata:
  name: frontend-service
  namespace: metacoding
spec:
  type: LoadBalancer    # ← 추가! AWS ELB가 자동 생성됨
  selector:
    app: frontend
  ports:
    - port: 80
      targetPort: 80
```

```
Minikube:
  브라우저 → minikube service → NodePort → Pod
  (minikube가 터널링해줌)

EKS:
  브라우저 → AWS LoadBalancer(자동 생성) → Service → Pod
  (진짜 공인 URL이 생김)
```

### 7-4. 배포 실행

```bash
# Namespace 먼저
kubectl apply -f k8s/namespace.yml

# 전체 배포
kubectl apply -f k8s/ --recursive
```

**Minikube 때와 명령어가 완전히 동일하다!** kubectl은 현재 연결된 클러스터(Minikube든 EKS든)에 배포한다.

### 배포 상태 확인

```bash
kubectl get deploy,pod,svc -n metacoding
```

---

## 8. Step 5 — 접속 확인

```bash
# Frontend Service의 EXTERNAL-IP 확인
kubectl get svc frontend-service -n metacoding

# 출력 예시:
# NAME               TYPE           CLUSTER-IP     EXTERNAL-IP                                         PORT(S)
# frontend-service   LoadBalancer   10.100.45.12   a1b2c3-1234567890.ap-northeast-2.elb.amazonaws.com  80:31234/TCP
```

`EXTERNAL-IP`에 나온 주소를 브라우저에 입력하면 접속된다.

> `<pending>` 상태면 1~2분 기다리면 된다. AWS가 ELB를 생성하는 중이다.

---

## 9. Step 6 — (선택) 도메인 연결

Route 53이나 외부 DNS에서 도메인을 ELB 주소에 연결할 수 있다.

```bash
# Route 53에서 CNAME 레코드 추가
# myapp.example.com → a1b2c3-1234567890.ap-northeast-2.elb.amazonaws.com
```

---

## 10. Minikube vs EKS 명령어 비교 총정리

| 작업 | Minikube | EKS |
|------|----------|-----|
| **클러스터 생성** | `minikube start` | `eksctl create cluster --name metacoding-cluster ...` |
| **이미지 빌드** | `minikube image build -t app:1 .` | `docker build -t app:1 .` |
| **이미지 등록** | 빌드하면 자동 등록 | `docker tag` + `docker push` (ECR) |
| **배포** | `kubectl apply -f k8s/ --recursive` | `kubectl apply -f k8s/ --recursive` (동일!) |
| **상태 확인** | `kubectl get pods -n metacoding` | `kubectl get pods -n metacoding` (동일!) |
| **로그 확인** | `kubectl logs deploy/backend-deploy -n metacoding` | `kubectl logs deploy/backend-deploy -n metacoding` (동일!) |
| **서비스 접속** | `minikube service frontend-service -n metacoding` | `kubectl get svc` → EXTERNAL-IP로 접속 |
| **클러스터 삭제** | `minikube delete` | `eksctl delete cluster --name metacoding-cluster` |
| **비용** | 무료 | **유료** (EC2 + ELB + EBS 과금) |

---

## 11. AI로 배포할 때의 플로우

Claude 같은 AI에게 EKS 배포를 시킬 때는 이런 흐름으로 진행된다:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      AI 활용 EKS 배포 플로우                             │
│                                                                         │
│  1. "ex08 프로젝트를 EKS에 올려줘"                                       │
│      │                                                                  │
│      ▼                                                                  │
│  2. AI가 기존 YAML을 읽고 EKS용으로 수정                                  │
│     ├── 이미지 경로 → ECR 주소로 변경                                    │
│     ├── hostPath PV → EBS StorageClass로 변경                           │
│     └── Service → LoadBalancer 타입 추가                                │
│      │                                                                  │
│      ▼                                                                  │
│  3. AI가 AWS CLI 명령어를 실행                                           │
│     ├── ECR 저장소 생성                                                  │
│     ├── Docker 이미지 빌드 & Push                                       │
│     └── eksctl로 EKS 클러스터 생성                                       │
│      │                                                                  │
│      ▼                                                                  │
│  4. AI가 kubectl apply로 배포                                            │
│      │                                                                  │
│      ▼                                                                  │
│  5. AI가 Pod 상태 확인 & 문제 있으면 로그 분석 후 자동 수정                  │
│      │                                                                  │
│      ▼                                                                  │
│  6. EXTERNAL-IP 확인 후 접속 URL 전달                                     │
└─────────────────────────────────────────────────────────────────────────┘
```

### AI에게 요청하는 예시

```
사용자: "ex08 프로젝트를 AWS EKS에 배포해줘. 리전은 서울(ap-northeast-2)이고, 
        AWS 계정 ID는 123456789012야."

AI가 하는 일:
  1. ex08/k8s/ 안의 YAML 파일을 읽는다
  2. k8s-eks/ 폴더를 만들어 EKS용 YAML을 생성한다
  3. ECR 저장소를 생성한다 (aws ecr create-repository ...)
  4. Docker 이미지를 빌드하고 ECR에 Push한다
  5. eksctl로 EKS 클러스터를 생성한다
  6. kubectl apply로 배포한다
  7. Pod 상태를 확인하고 문제가 있으면 수정한다
  8. 접속 URL을 알려준다
```

### 주의: AI한테 맡기기 전에 해야 할 것

```bash
# 1. AWS CLI가 설정되어 있어야 한다
aws sts get-caller-identity   # ← 이게 되면 준비 완료

# 2. eksctl이 설치되어 있어야 한다
eksctl version

# 3. Docker Desktop이 실행 중이어야 한다
docker info
```

이 3가지가 준비되면, AI에게 "EKS에 올려줘"라고 말하면 된다.

---

## 12. 정리 & 삭제

### EKS 리소스 삭제 (과금 방지!)

```bash
# 1. K8s 리소스 삭제 (LoadBalancer, EBS 등 AWS 리소스 정리)
kubectl delete -f k8s/ --recursive

# 2. EKS 클러스터 삭제 (EC2 노드, VPC 등 전부 삭제)
eksctl delete cluster --name metacoding-cluster --region ap-northeast-2

# 3. ECR 이미지 삭제 (선택)
aws ecr delete-repository --repository-name metacoding/backend --force --region ap-northeast-2
aws ecr delete-repository --repository-name metacoding/frontend --force --region ap-northeast-2
aws ecr delete-repository --repository-name metacoding/db --force --region ap-northeast-2
aws ecr delete-repository --repository-name metacoding/redis --force --region ap-northeast-2
```

> **반드시 삭제하자!** EKS 클러스터를 켜두면 시간당 과금된다. 실습 끝나면 바로 삭제!

---

## 13. 한 줄 요약

| 질문 | 답변 |
|------|------|
| Kind로 바꿔야 하나? | **아니다.** YAML은 표준이므로 그대로 사용 |
| 뭘 바꿔야 하나? | 이미지 경로(ECR), PV(EBS), Service(LoadBalancer) 3가지만 |
| kubectl 명령어가 달라지나? | **동일하다.** 클러스터만 다를 뿐 명령어는 같다 |
| AI가 대신 해줄 수 있나? | **가능하다.** AWS CLI 설정만 되어 있으면 전부 자동화 가능 |
| 비용이 드나? | **드다.** 실습 후 반드시 `eksctl delete cluster`로 삭제 |

---

## 14. Kind/kubeadm은 EKS에 필요 없는데, 왜 배우나?

**맞다. EKS 배포에 Kind와 kubeadm은 전혀 필요 없다.** 하지만 각각 쓰이는 곳이 다르다.

```
EKS 배포에 필요한 것:
  ✅ kubectl      → 배포 명령어
  ✅ eksctl       → EKS 클러스터 생성
  ✅ AWS CLI      → ECR 로그인, 이미지 Push
  ✅ Docker       → 이미지 빌드

  ❌ Kind         → 필요 없음
  ❌ kubeadm      → 필요 없음
  ❌ Minikube     → 필요 없음 (학습 때만 사용)
```

### 그럼 언제 쓰는가?

| 도구 | EKS 배포에 필요? | 실제로 쓰이는 곳 |
|------|:-:|------|
| **Minikube** | ❌ | K8s **입문 학습** — 대시보드, 애드온이 편리해서 처음 배울 때 좋다 |
| **Kind** | ❌ | **CI/CD 파이프라인** — GitHub Actions에서 K8s 테스트 클러스터를 30초 만에 띄우고 테스트 후 삭제 |
| **kubeadm** | ❌ | **CKA/CKAD 자격증 시험** — 시험에서 직접 클러스터를 구축해야 하므로 kubeadm 필수 |

```
커리어 경로별 필요 도구:

  "나는 백엔드 개발자야, EKS에 배포만 하면 돼"
  → Minikube(학습) + eksctl/kubectl(배포) 만 알면 충분

  "나는 DevOps 엔지니어가 될 거야"
  → Kind(CI/CD) + kubeadm(자격증) + eksctl(AWS) 전부 필요

  "나는 CKA 자격증을 딸 거야"
  → kubeadm 필수 (시험에서 직접 클러스터 구축함)
```

> **한 줄 요약**: EKS 배포만 하면 Kind/kubeadm은 몰라도 된다. 하지만 CI/CD 구축(Kind)이나 자격증(kubeadm)을 위해선 필요하다.

### 잠깐 — Kind 안 쓰면 CI/CD가 안 되나?

**아니다. Kind 없이 CI/CD 완벽히 가능하다.**

이 문서의 섹션 16(GitHub Actions CI/CD)을 보면 Kind를 **전혀 사용하지 않는다.**

```
대부분의 CI/CD 파이프라인 (Kind 없음):

  git push
    │
    ▼
  GitHub Actions
    ├── docker build     ← 이미지 빌드
    ├── docker push      ← ECR에 Push
    └── kubectl apply    ← EKS에 직접 배포
    
  → Kind가 어디에도 없다!
  → 빌드하고 바로 EKS에 배포하면 끝이다.
```

**그럼 Kind는 CI/CD에서 언제 쓰나?**

"EKS에 배포하기 **전에**, CI에서 K8s 환경 테스트를 하고 싶을 때"만 쓴다.

```
Kind를 쓰는 CI/CD (선택적, 대기업에서):

  git push
    │
    ▼
  GitHub Actions
    ├── docker build
    ├── kind create cluster          ← CI 서버에 임시 K8s 클러스터 생성
    ├── kind load docker-image       ← 이미지 로드
    ├── kubectl apply (Kind에)       ← Kind 클러스터에 배포해서 테스트
    ├── 테스트 실행 (curl, pytest 등) ← "이 YAML이 정상 작동하는지?" 검증
    ├── kind delete cluster          ← 테스트 끝, 클러스터 삭제
    │
    │   테스트 통과하면 ↓
    │
    ├── docker push (ECR)            ← 진짜 배포 시작
    └── kubectl apply (EKS)          ← 프로덕션에 배포
```

```
정리:

  Kind 없는 CI/CD = "빌드하고 바로 배포" ← 대부분 이걸로 충분
  Kind 있는 CI/CD = "빌드하고 테스트하고 배포" ← 대기업/금융권에서 안전하게

  Kind는 CI/CD의 "필수"가 아니라 "선택적 테스트 단계"이다.
```

---

## 15. Service LoadBalancer vs Ingress — 왜 Service로 LB를 만드나?

**지적이 맞다.** Ingress를 설정하면 AWS ALB(Application Load Balancer)가 자동 생성된다. 그런데 이 문서에서 Service LoadBalancer를 쓴 이유가 있다.

### 둘 다 로드밸런서를 만든다 — 하지만 종류가 다르다

```
방법 1: Service (type: LoadBalancer)
  → AWS NLB (Network Load Balancer, L4) 생성
  → TCP/UDP 레벨 로드밸런싱
  → 설정이 간단 (YAML 한 줄 추가)

방법 2: Ingress + AWS Load Balancer Controller
  → AWS ALB (Application Load Balancer, L7) 생성
  → HTTP/HTTPS 레벨 로드밸런싱
  → 경로 기반 라우팅 가능 (/api → backend, / → frontend)
  → 설정이 복잡 (컨트롤러 설치 + Ingress YAML 필요)
```

### 비교표

| 항목 | Service LoadBalancer | Ingress (ALB) |
|------|---------------------|---------------|
| **AWS 리소스** | NLB (L4) | ALB (L7) |
| **프로토콜** | TCP/UDP | HTTP/HTTPS |
| **경로 라우팅** | 불가능 | `/api`, `/admin` 등 경로별 분기 가능 |
| **SSL 인증서** | 별도 설정 | ACM 인증서 쉽게 연동 |
| **설정 난이도** | 쉬움 (한 줄 추가) | 복잡 (컨트롤러 설치 필요) |
| **비용** | LB당 1개 NLB 과금 | 여러 서비스를 1개 ALB로 공유 가능 |
| **적합한 경우** | 서비스 1~2개 외부 노출 | 서비스 여러 개 + 도메인/경로 라우팅 |

### 그림으로 비교

**방법 1: Service LoadBalancer (이 문서에서 사용한 방식)**

```
  브라우저
    │
    ▼
  ┌─────────────┐
  │ AWS NLB     │  ← Service(type:LoadBalancer)가 자동 생성
  │ (L4, TCP)   │
  └──────┬──────┘
         │
         ▼
  frontend-service (port 80)
         │
         ▼
  Frontend Pod
```

설정이 간단하다 — Service YAML에 `type: LoadBalancer` 한 줄만 추가:

```yaml
spec:
  type: LoadBalancer    # ← 이게 끝
```

**방법 2: Ingress + ALB (프로덕션 권장 방식)**

```
  브라우저
    │
    ▼
  ┌──────────────────┐
  │ AWS ALB          │  ← Ingress가 자동 생성
  │ (L7, HTTP/HTTPS) │
  └──┬───────────┬───┘
     │           │
  /api/*      /*
     │           │
     ▼           ▼
  backend     frontend
  -service    -service
     │           │
     ▼           ▼
  Backend    Frontend
  Pod        Pod
```

설정이 복잡하다 — 컨트롤러 설치 + Ingress YAML 필요:

```bash
# 1. AWS Load Balancer Controller 설치 (Helm 사용)
helm repo add eks https://aws.github.io/eks-charts
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=metacoding-cluster \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller
```

```yaml
# 2. Ingress YAML 작성
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: metacoding-ingress
  namespace: metacoding
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
spec:
  rules:
    - http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: backend-service
                port:
                  number: 8080
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend-service
                port:
                  number: 80
```

### 잠깐 — Pod가 1개면 LoadBalancer 필요 없지 않나?

**"로드밸런싱"만 보면 맞다. Pod 1개에 부하 분산은 의미 없다.**

하지만 Service LoadBalancer는 **2가지 역할**을 한다:

```
Service (type: LoadBalancer)의 역할:

  역할 1: 부하 분산 (Round Robin)
    → Pod가 여러 개일 때 트래픽을 골고루 분배
    → Pod 1개면 이 기능은 의미 없음 ← 맞다!

  역할 2: 외부 접속용 공인 IP 생성 ← 이게 진짜 이유!
    → AWS에서 NLB를 만들어서 EXTERNAL-IP를 부여
    → 이게 없으면 외부에서 접속 자체가 불가능
```

```
EKS에서 외부 접속하는 방법은 3가지뿐:

  1. Service (type: LoadBalancer) → NLB 생성 → 공인 IP 부여
  2. Ingress                     → ALB 생성 → 공인 URL 부여
  3. NodePort + 보안그룹 수동 설정 → 복잡하고 비추천

  ClusterIP (기본값)는?
  → 클러스터 내부에서만 접근 가능
  → 외부에서 절대 접속 불가!
```

```
그림으로 보면:

  ClusterIP (기본값):
    인터넷 ──✖──▶ [EKS 클러스터 내부] ──▶ Pod
                   접근 불가!

  LoadBalancer:
    인터넷 ──▶ [NLB: 공인IP] ──▶ [EKS 클러스터] ──▶ Pod (1개든 10개든)
               여기가 핵심!       이제 접근 가능!
```

**결론:**

| Pod 개수 | 로드밸런싱 필요? | LoadBalancer 필요? | 이유 |
|:--------:|:---------------:|:-----------------:|------|
| 1개 | ❌ 불필요 | ✅ **필요** | 외부 접속용 공인 IP를 받으려면 |
| 여러 개 | ✅ 필요 | ✅ **필요** | 부하 분산 + 외부 접속 둘 다 |

> **한 줄 요약**: LoadBalancer = "부하 분산" + "외부 접속 문을 여는 것". Pod가 1개여도 문은 열어야 접속할 수 있다.

### 이 문서에서 Service LoadBalancer를 쓴 이유

```
ex08 프로젝트의 상황:
  - 외부에 노출할 서비스: Frontend 1개뿐
  - 경로 라우팅: 필요 없음 (Frontend가 내부에서 Backend 호출)
  - SSL 인증서: 학습용이라 불필요
  - 설정 난이도: 최대한 간단하게

  → Service LoadBalancer로 충분!
  → Ingress는 오버엔지니어링
```

```
하지만 실무에서는?
  - 서비스가 여러 개 (Frontend, Backend API, Admin 등)
  - 도메인 라우팅 필요 (api.myapp.com, admin.myapp.com)
  - HTTPS 필수 (ACM 인증서 연동)
  - LB 비용 절약 (서비스마다 NLB 만들면 비용 폭탄)

  → Ingress + ALB가 정답!
```

> **한 줄 요약**: 서비스 1개면 `type: LoadBalancer`(NLB)가 간단하고, 서비스 여러 개 + 도메인/경로 라우팅이 필요하면 Ingress(ALB)를 쓴다.

---

## 16. CI/CD 구축 — GitHub Actions로 EKS 자동 배포

**가능하다.** git push만 하면 자동으로 빌드 → ECR Push → EKS 배포까지 된다.

### CI/CD 전체 플로우

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    GitHub Actions CI/CD 파이프라인                       │
│                                                                         │
│  개발자                                                                  │
│    │                                                                    │
│    │ git push (main 브랜치)                                              │
│    ▼                                                                    │
│  ┌──────────────────┐                                                   │
│  │  GitHub Actions   │  ← 자동 실행                                     │
│  │                   │                                                   │
│  │  1. 코드 체크아웃  │                                                   │
│  │  2. AWS 로그인     │                                                   │
│  │  3. ECR 로그인     │                                                   │
│  │  4. Docker Build   │                                                   │
│  │  5. ECR Push       │                                                   │
│  │  6. kubectl apply  │                                                   │
│  └────────┬─────────┘                                                   │
│           │                                                              │
│     ┌─────┴──────┐                                                      │
│     ▼            ▼                                                      │
│  ┌──────┐   ┌──────────┐                                                │
│  │ ECR  │   │ EKS      │                                                │
│  │이미지 │──▶│ 클러스터  │──▶ Pod 자동 업데이트 (롤링 배포)                │
│  └──────┘   └──────────┘                                                │
└─────────────────────────────────────────────────────────────────────────┘
```

### 사전 준비

```
1. GitHub 리포지토리에 AWS 자격증명을 Secrets로 등록:
   - Settings → Secrets and variables → Actions → New repository secret
   
   AWS_ACCESS_KEY_ID      = (IAM 발급 키)
   AWS_SECRET_ACCESS_KEY  = (IAM 시크릿)
   AWS_ACCOUNT_ID         = (12자리 계정 ID)
```

### GitHub Actions 워크플로우 파일

```yaml
# .github/workflows/deploy-eks.yml

name: Deploy to EKS

on:
  push:
    branches: [ main ]    # main에 push하면 자동 실행

env:
  AWS_REGION: ap-northeast-2
  CLUSTER_NAME: metacoding-cluster

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      # 1. 코드 체크아웃
      - name: Checkout
        uses: actions/checkout@v4

      # 2. AWS 자격증명 설정
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      # 3. ECR 로그인
      - name: Login to ECR
        id: ecr-login
        uses: aws-actions/amazon-ecr-login@v2

      # 4. Docker 이미지 빌드 & Push (4개 서비스)
      - name: Build and push Backend
        run: |
          ECR_URI=${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.${{ env.AWS_REGION }}.amazonaws.com
          docker build -t $ECR_URI/metacoding/backend:${{ github.sha }} ./backend
          docker push $ECR_URI/metacoding/backend:${{ github.sha }}

      - name: Build and push Frontend
        run: |
          ECR_URI=${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.${{ env.AWS_REGION }}.amazonaws.com
          docker build -t $ECR_URI/metacoding/frontend:${{ github.sha }} ./frontend
          docker push $ECR_URI/metacoding/frontend:${{ github.sha }}

      - name: Build and push DB
        run: |
          ECR_URI=${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.${{ env.AWS_REGION }}.amazonaws.com
          docker build -t $ECR_URI/metacoding/db:${{ github.sha }} ./db
          docker push $ECR_URI/metacoding/db:${{ github.sha }}

      - name: Build and push Redis
        run: |
          ECR_URI=${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.${{ env.AWS_REGION }}.amazonaws.com
          docker build -t $ECR_URI/metacoding/redis:${{ github.sha }} ./redis
          docker push $ECR_URI/metacoding/redis:${{ github.sha }}

      # 5. kubectl 설정 (EKS 클러스터 연결)
      - name: Update kubeconfig
        run: |
          aws eks update-kubeconfig --name ${{ env.CLUSTER_NAME }} --region ${{ env.AWS_REGION }}

      # 6. YAML의 이미지 태그를 현재 커밋 해시로 교체 & 배포
      - name: Deploy to EKS
        run: |
          ECR_URI=${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.${{ env.AWS_REGION }}.amazonaws.com
          
          # 이미지 태그 교체
          sed -i "s|metacoding/backend:1|$ECR_URI/metacoding/backend:${{ github.sha }}|g" k8s/backend/backend-deploy.yml
          sed -i "s|metacoding/frontend:1|$ECR_URI/metacoding/frontend:${{ github.sha }}|g" k8s/frontend/frontend-deploy.yml
          sed -i "s|metacoding/db:1|$ECR_URI/metacoding/db:${{ github.sha }}|g" k8s/db/db-deploy.yml
          sed -i "s|metacoding/redis:1|$ECR_URI/metacoding/redis:${{ github.sha }}|g" k8s/redis/redis-deploy.yml
          
          # 배포
          kubectl apply -f k8s/ --recursive

      # 7. 배포 확인
      - name: Verify deployment
        run: |
          kubectl rollout status deploy/backend-deploy -n metacoding --timeout=120s
          kubectl rollout status deploy/frontend-deploy -n metacoding --timeout=120s
          kubectl get pods -n metacoding
```

### 이미지 태그 전략

```
왜 이미지 태그를 :1 대신 :커밋해시를 쓰나?

  태그 :1 (고정 태그)
  → kubectl apply 해도 "이미지가 같으니 변경 없음" → Pod 안 바뀜 💀

  태그 :abc123f (커밋 해시)
  → 매번 새 태그 → kubectl apply하면 새 이미지로 롤링 업데이트 ✅
  → 어떤 커밋의 코드가 배포됐는지 추적 가능

  ${{ github.sha }} = git 커밋 해시 (예: a1b2c3d4e5f6...)
```

### CI/CD 실행 확인

```bash
# GitHub에서 확인
# 리포지토리 → Actions 탭 → 워크플로우 실행 상태 확인

# 터미널에서 배포 상태 확인
kubectl get pods -n metacoding
kubectl rollout status deploy/backend-deploy -n metacoding
```

### 전체 흐름 요약

```
개발자가 코드 수정
    │
    ▼
git push origin main
    │
    ▼
GitHub Actions 자동 실행
    │
    ├── Docker Build (4개 이미지)
    ├── ECR Push (4개 이미지)
    ├── sed로 YAML 이미지 태그 교체
    └── kubectl apply (EKS에 배포)
    │
    ▼
EKS가 새 이미지로 롤링 업데이트
    │
    ▼
무중단 배포 완료! ✅
```

> **한 줄 요약**: git push만 하면 GitHub Actions가 빌드 → ECR Push → EKS 배포를 자동으로 해준다.

---

## 17. Helm은 왜 배우나? — 지금 프로세스에 없는데?

**맞다. 지금 ex08 프로세스에 Helm은 없다.** 그리고 없어도 배포가 된다. 그럼 왜 배우나?

### 지금 방식의 문제점 — YAML 지옥

ex08은 서비스가 4개(Frontend, Backend, DB, Redis)뿐이라 YAML이 14개다. 관리할 만하다.

```
ex08의 YAML 파일 수:
  k8s/
  ├── namespace.yml
  ├── backend/  (4개: deploy, service, configmap, secret)
  ├── db/       (5개: deploy, service, secret, pv, pvc)
  ├── frontend/ (2개: deploy, service)
  └── redis/    (2개: deploy, service)
  
  총 14개 → 아직 관리 가능 ✅
```

하지만 실무에서는?

```
실무 프로젝트의 YAML 파일 수:
  k8s/
  ├── namespace.yml
  ├── user-service/      (deploy, service, configmap, secret, hpa, ingress)
  ├── order-service/     (deploy, service, configmap, secret, hpa, ingress)
  ├── payment-service/   (deploy, service, configmap, secret, hpa, ingress)
  ├── notification-service/ (...)
  ├── auth-service/      (...)
  ├── gateway/           (...)
  ├── db-master/         (deploy, service, secret, pv, pvc, statefulset)
  ├── db-slave/          (...)
  ├── redis-cluster/     (...)
  ├── kafka/             (...)
  ├── monitoring/        (prometheus, grafana, alertmanager)
  └── ...

  총 80~100개 이상 → YAML 지옥 💀
```

### 문제 1: 환경별로 YAML이 복붙된다

```
개발 환경 (dev):
  backend-deploy.yml → replicas: 1, image: backend:dev

스테이징 환경 (staging):
  backend-deploy.yml → replicas: 2, image: backend:staging

프로덕션 환경 (prod):
  backend-deploy.yml → replicas: 5, image: backend:prod

→ 같은 파일을 3벌 만들어야 한다!
→ prod에서 replicas를 바꾸려면 3개 파일을 다 찾아서 수정해야 한다!
```

### 문제 2: 서비스 추가할 때마다 5~6개 YAML 복붙

```
새 서비스 "notification-service"를 추가하려면:
  1. notification-deploy.yml     ← backend에서 복붙 후 이름 수정
  2. notification-service.yml    ← backend에서 복붙 후 이름 수정
  3. notification-configmap.yml  ← backend에서 복붙 후 값 수정
  4. notification-secret.yml     ← backend에서 복붙 후 값 수정
  5. notification-hpa.yml        ← backend에서 복붙 후 값 수정
  
  → 복붙하다가 이름 하나 안 바꾸면? 장애 발생 💀
```

### Helm이 해결하는 것 — YAML의 "템플릿화"

Helm은 **K8s의 패키지 매니저**이다. YAML을 템플릿으로 만들어서 **변수만 바꿔서 배포**할 수 있게 해준다.

```
쉬운 비유:

  YAML 직접 관리 = 편지를 한 장씩 손으로 쓰는 것
    "김철수님 안녕하세요, 3월 회의에 참석해주세요..."
    "이영희님 안녕하세요, 3월 회의에 참석해주세요..."
    "박민수님 안녕하세요, 3월 회의에 참석해주세요..."
    → 100명이면 100장을 일일이 수정

  Helm = 메일머지 (편지 템플릿 + 주소록)
    템플릿: "{{이름}}님 안녕하세요, {{날짜}} 회의에 참석해주세요..."
    주소록: 김철수, 이영희, 박민수...
    → 한 번에 100장 자동 생성
```

### ex08을 Helm으로 바꾸면?

**기존 (YAML 14개 직접 관리)**:

```
k8s/
├── backend/
│   ├── backend-deploy.yml        ← image: metacoding/backend:1 하드코딩
│   ├── backend-service.yml       ← port: 8080 하드코딩
│   ├── backend-configmap.yml     ← DB URL 하드코딩
│   └── backend-secret.yml        ← 비밀번호 하드코딩
├── frontend/
│   ├── frontend-deploy.yml
│   └── frontend-service.yml
└── ...
```

**Helm (템플릿 + 값 파일)**:

```
helm-chart/
├── Chart.yaml                    ← 차트 이름, 버전
├── values.yaml                   ← 변수 값 (여기만 수정!)
├── values-dev.yaml               ← 개발 환경 값
├── values-prod.yaml              ← 프로덕션 환경 값
└── templates/                    ← 템플릿 ({{ .Values.xxx }} 사용)
    ├── backend-deploy.yaml
    ├── backend-service.yaml
    ├── frontend-deploy.yaml
    └── ...
```

**templates/backend-deploy.yaml (템플릿)**:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend-deploy
  namespace: {{ .Values.namespace }}
spec:
  replicas: {{ .Values.backend.replicas }}
  template:
    spec:
      containers:
        - name: backend-server
          image: {{ .Values.backend.image }}:{{ .Values.backend.tag }}
          ports:
            - containerPort: {{ .Values.backend.port }}
```

**values.yaml (기본값)**:

```yaml
namespace: metacoding

backend:
  image: metacoding/backend
  tag: "1"
  replicas: 2
  port: 8080

frontend:
  image: metacoding/frontend
  tag: "1"
  replicas: 1
  port: 80

db:
  image: metacoding/db
  tag: "1"
  storage: 1Gi
```

**values-prod.yaml (프로덕션 오버라이드)**:

```yaml
namespace: metacoding

backend:
  image: 123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/metacoding/backend
  tag: "v2.1.0"
  replicas: 5

frontend:
  replicas: 3

db:
  storage: 50Gi
```

### Helm 명령어 비교

```bash
# ══════════════════════════════════════
# 기존 방식 (kubectl)
# ══════════════════════════════════════

# 개발 환경 배포 — YAML을 직접 수정해야 함
vi k8s/backend/backend-deploy.yml   # replicas: 1로 변경
vi k8s/backend/backend-deploy.yml   # image 태그 변경
kubectl apply -f k8s/ --recursive

# 프로덕션 배포 — 또 다른 YAML 폴더 필요
kubectl apply -f k8s-prod/ --recursive

# ══════════════════════════════════════
# Helm 방식
# ══════════════════════════════════════

# 개발 환경 배포 — values 파일만 다르게
helm install metacoding ./helm-chart -f values-dev.yaml -n metacoding

# 프로덕션 배포 — 같은 템플릿, 다른 values
helm install metacoding ./helm-chart -f values-prod.yaml -n metacoding

# 업그레이드 (이미지 태그만 변경)
helm upgrade metacoding ./helm-chart --set backend.tag=v2.1.0

# 롤백 (이전 버전으로 되돌리기)
helm rollback metacoding 1

# 삭제
helm uninstall metacoding -n metacoding

# 배포 목록 확인
helm list -n metacoding

# 배포 히스토리 (몇 번째 배포인지, 언제 했는지)
helm history metacoding -n metacoding
```

### Helm이 추가로 해주는 것

```
1. 롤백
   helm rollback metacoding 1
   → 이전 배포로 한 방에 되돌리기 (kubectl에는 없는 기능)

2. 버전 관리
   helm history metacoding
   → 언제, 무엇을 배포했는지 히스토리 추적

3. 다른 사람이 만든 차트 설치 (마치 npm install처럼)
   helm install prometheus prometheus-community/kube-prometheus-stack
   → Prometheus + Grafana 모니터링을 한 줄로 설치

4. 의존성 관리
   Chart.yaml에 dependencies로 MySQL, Redis 등을 선언하면 자동 설치
```

### 그래서 언제 Helm을 도입하나?

| 상황 | Helm 필요? | 이유 |
|------|:-:|------|
| ex08 학습 (서비스 4개) | ❌ | YAML 14개, 환경 1개 → 직접 관리 가능 |
| 환경이 2개 이상 (dev/prod) | ✅ | values 파일만 바꾸면 됨, YAML 복붙 불필요 |
| 서비스가 10개 이상 | ✅ | 템플릿으로 반복 제거, 실수 방지 |
| 롤백이 필요한 프로덕션 | ✅ | `helm rollback` 한 줄로 이전 상태 복원 |
| 모니터링/로깅 도구 설치 | ✅ | 남이 만든 차트를 `helm install`로 바로 설치 |

### 위치 정리 — Helm은 배포 프로세스 어디에 들어가나?

```
기존 프로세스 (Helm 없음):
  Docker Build → ECR Push → kubectl apply -f k8s/

Helm 도입 후:
  Docker Build → ECR Push → helm upgrade metacoding ./helm-chart --set tag=$COMMIT_SHA

  바뀌는 건 마지막 배포 명령어뿐!
  이미지 빌드, ECR Push는 동일하다.
```

```
CI/CD에서의 위치:

  GitHub Actions:
    1. Docker Build        ← 동일
    2. ECR Push            ← 동일
    3. sed로 YAML 수정      ← 삭제!
    4. kubectl apply        ← helm upgrade로 교체!
    
  → sed로 YAML을 하드코딩 수정하던 것이
  → helm upgrade --set tag=xxx 로 깔끔하게 바뀐다
```

> **한 줄 요약**: ex08 규모에서는 Helm이 필요 없다. 하지만 서비스가 늘어나고, 환경이 여러 개 생기고, 롤백이 필요해지는 순간 Helm 없이는 YAML 지옥에 빠진다.
