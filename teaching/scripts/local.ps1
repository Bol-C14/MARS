param([int]$Port = 8765)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $root
try {
    if (-not (Get-Command java -ErrorAction SilentlyContinue)) { throw 'Install Java 17 or newer.' }
    if (Test-Path 'teaching/mars-trace.jar') {
        & java '-Djava.awt.headless=true' -cp 'teaching/mars-trace.jar' mars.ide.Server $Port
    } else {
        if (-not (Get-Command javac -ErrorAction SilentlyContinue)) { throw 'Source checkout needs JDK 17 or newer.' }
        New-Item -ItemType Directory -Force 'teaching/build/classes' | Out-Null
        $sources = @(Get-ChildItem mars,teaching/src -Recurse -Filter '*.java' | ForEach-Object { '"' + $_.FullName.Substring($root.Length + 1).Replace('\','/') + '"' })
        $sources += 'Mars.java'
        $sources | Set-Content -Encoding ascii 'teaching/build/sources-windows.txt'
        & javac --release 17 -encoding UTF-8 -nowarn -d teaching/build/classes '@teaching/build/sources-windows.txt'
        if ($LASTEXITCODE -ne 0) { throw 'Java compilation failed.' }
        Get-ChildItem -File *.properties,*.txt | Copy-Item -Destination teaching/build/classes
        Copy-Item images,help -Recurse -Force -Destination teaching/build/classes
        & java '-Djava.awt.headless=true' -cp teaching/build/classes mars.ide.Server $Port
    }
    if ($LASTEXITCODE -ne 0) { throw "Server exited with code $LASTEXITCODE" }
} finally { Pop-Location }
