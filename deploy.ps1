# PC에서 실행: 코드를 라즈베리파이로 올리고 서비스를 재시작한다.
# 사용법:  powershell -ExecutionPolicy Bypass -File .\deploy.ps1
#          내 파이 주소·아이디는 deploy.local.ps1에 적어 둔다 (깃허브에 안 올라감, deploy.local.example.ps1을 복사해서)
#          한 번만 다른 곳으로 올릴 때는 -PiHost <주소> -User <아이디> [-Port <SSH 포트>]
param(
    [string]$PiHost = "",
    [int]$Port = 0,
    [string]$User = ""
)
$ErrorActionPreference = "Stop"
$local = Join-Path $PSScriptRoot "deploy.local.ps1"
if (Test-Path $local) { . $local }  # $DeployHost, $DeployUser, $DeployPort
if (-not $PiHost) { $PiHost = $DeployHost }
if (-not $User) { $User = $DeployUser }
if (-not $Port) { $Port = $(if ($DeployPort) { $DeployPort } else { 22 }) }
if (-not $PiHost -or -not $User) {
    throw "파이 주소와 아이디를 몰라요. deploy.local.example.ps1을 deploy.local.ps1로 복사해서 적거나, -PiHost <주소> -User <아이디>를 붙여 주세요."
}
$target = "$User@$PiHost"
$archive = Join-Path $env:TEMP "mypie-deploy.tar.gz"

Write-Host "1/3 압축하는 중..."
tar -czf $archive -C $PSScriptRoot --exclude=__pycache__ mypie tests deploy config.example.toml README.md INSTALL.md
if ($LASTEXITCODE) { throw "압축 실패" }

Write-Host "2/3 파이로 올리는 중..."
scp -q -P $Port $archive "${target}:/tmp/mypie-deploy.tar.gz"
if ($LASTEXITCODE) { throw "업로드 실패" }

Write-Host "3/3 설치하고 재시작하는 중..."
# 코드 폴더만 새로 바꾸고, 설정(config.toml)·키(.env)·기록(data/)은 그대로 둔다
ssh -p $Port $target "cd ~/My_Pie 2>/dev/null || mkdir -p ~/My_Pie; rm -rf ~/My_Pie/mypie ~/My_Pie/tests ~/My_Pie/deploy && tar -xzf /tmp/mypie-deploy.tar.gz -C ~/My_Pie --warning=no-unknown-keyword && rm /tmp/mypie-deploy.tar.gz && bash ~/My_Pie/deploy/install.sh"
if ($LASTEXITCODE) { throw "설치 실패" }

Remove-Item $archive -ErrorAction SilentlyContinue
Write-Host "완료! 모니터링: http://${PiHost}:8000 (집 안에서)"
