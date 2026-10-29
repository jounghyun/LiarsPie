# deploy.ps1이 읽는 내 파이 정보. 이 파일을 deploy.local.ps1로 복사해서 고쳐 쓰세요 (deploy.local.ps1은 깃허브에 안 올라가요).
$DeployHost = "192.168.0.10"   # 파이 주소 (같은 공유기 안 IP). 집 밖에서는 DDNS 주소
$DeployUser = "pi"             # 파이에 SSH로 들어가는 아이디
$DeployPort = 22               # SSH 포트 (집 밖에서 포트포워딩했다면 그 외부 포트)
