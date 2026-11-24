<#
.SYNOPSIS
  Start the GANTRYLAB model-evaluation backend (FastAPI, http://127.0.0.1:8000).

.DESCRIPTION
  First run: creates backend/.venv (Python 3.12, via uv) and installs the pinned dependencies.
  Later runs: starts uvicorn straight away.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\backend.ps1
  powershell -ExecutionPolicy Bypass -File scripts\backend.ps1 -Port 8010 -Reload
  powershell -ExecutionPolicy Bypass -File scripts\backend.ps1 -Install   # force a dependency reinstall
  powershell -ExecutionPolicy Bypass -File scripts\backend.ps1 -Cpu       # CPU-only torch wheels
#>
param(
  [int]$Port = 8000,
  [string]$BindHost = "127.0.0.1",
  [switch]$Reload,
  [switch]$Install,
  [switch]$Cpu
)

$ErrorActionPreference = "Stop"
$backend = Join-Path (Split-Path -Parent $PSScriptRoot) "backend"
$python = Join-Path $backend ".venv\Scripts\python.exe"
Set-Location $backend

if (-not (Test-Path $python) -or $Install) {
  if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "uv not found. Install it: powershell -c `"irm https://astral.sh/uv/install.ps1 | iex`""
  }
  if (-not (Test-Path $python)) {
    Write-Host "Creating backend/.venv (Python 3.12)..."
    uv venv .venv --python 3.12
    if ($LASTEXITCODE -ne 0) { throw "uv venv failed" }
  }
  $gpu = (-not $Cpu) -and [bool](Get-Command nvidia-smi -ErrorAction SilentlyContinue)
  $index = if ($gpu) { "https://download.pytorch.org/whl/cu128" } else { "https://download.pytorch.org/whl/cpu" }
  Write-Host "Installing torch from $index ..."
  uv pip install --python $python torch==2.11.0 torchvision==0.26.0 --index-url $index
  if ($LASTEXITCODE -ne 0) { throw "torch install failed" }
  Write-Host "Installing backend dependencies..."
  uv pip install --python $python ultralytics==8.4.215 onnx==1.23.2 onnxruntime==1.32.0 `
    fastapi==0.165.0 "uvicorn[standard]==0.54.0" python-multipart==0.0.34 pydantic==2.14.4 numpy==2.5.4 `
    pillow==13.0.0 psutil==7.2.2 pyyaml==6.0.3 httpx==0.28.1 pytest==9.2.0 httpx2==2.16.2
  if ($LASTEXITCODE -ne 0) { throw "dependency install failed" }
}

$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) { throw "Port $Port is already in use (PID $($busy[0].OwningProcess)). Stop it or pass -Port." }

Write-Host "GANTRYLAB backend: http://${BindHost}:$Port  (API docs: http://${BindHost}:$Port/docs)  Ctrl+C to stop"
$uvArgs = @("-m", "uvicorn", "gantrylab.app:app", "--host", $BindHost, "--port", "$Port")
if ($Reload) { $uvArgs += @("--reload", "--reload-dir", "gantrylab") }
& $python @uvArgs
exit $LASTEXITCODE
