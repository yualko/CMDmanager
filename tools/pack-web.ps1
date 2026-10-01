# Упаковывает папку web в один бинарный файл, который вшивается в exe как ресурс (RCDATA 101).
# Формат: "CMDW", u32 число файлов, затем для каждого: u16 длина имени, имя (UTF-8, через «/»), u32 размер, данные.
param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Out)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path $Source).Path.TrimEnd('\')
$files = Get-ChildItem -Path $root -Recurse -File | Where-Object { $_.Extension -notin '.map' } | Sort-Object FullName
$utf8 = New-Object System.Text.UTF8Encoding $false
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null
$stream = [System.IO.File]::Create($Out)
$w = New-Object System.IO.BinaryWriter $stream
try {
    $w.Write([byte[]][char[]]'CMDW')
    $w.Write([uint32]$files.Count)
    foreach ($f in $files) {
        $name = $utf8.GetBytes($f.FullName.Substring($root.Length + 1).Replace('\', '/'))
        $data = [System.IO.File]::ReadAllBytes($f.FullName)
        $w.Write([uint16]$name.Length); $w.Write($name)
        $w.Write([uint32]$data.Length); $w.Write($data)
    }
} finally { $w.Dispose() }
Write-Host "web: $($files.Count) files -> $Out"
