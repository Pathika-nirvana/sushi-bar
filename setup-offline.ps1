# One-time download of the browser's 3D runtime. Thereafter offline.html works without a connection.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$dir=Join-Path $PSScriptRoot 'vendor'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
function Download-File($name, [string[]]$urls) {
  $destination=Join-Path $dir $name
  if ((Test-Path $destination) -and (Get-Item $destination).Length -gt 1000) { Write-Host "$name already ready"; return }
  foreach($url in $urls) {
    try {
      Write-Host "Downloading $name..."
      Invoke-WebRequest -Uri $url -OutFile $destination -UseBasicParsing -TimeoutSec 35
      if ((Get-Item $destination).Length -lt 1000) {throw 'File is unexpectedly small'}
      Write-Host "Ready: $name"
      return
    } catch { Write-Warning "Download failed from $url : $_" }
  }
  throw "Could not download $name. Check the internet connection and retry."
}
Download-File 'three.min.js' @('https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js','https://unpkg.com/three@0.128.0/build/three.min.js')
Download-File 'OrbitControls.js' @('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js','https://unpkg.com/three@0.128.0/examples/js/controls/OrbitControls.js')
Write-Host ''
Write-Host 'Setup complete! Double-click offline.html to play without a server or internet.'
