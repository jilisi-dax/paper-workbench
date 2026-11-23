# Rebuild the browser catalog from the UTF-8 JSON source.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dataRoot = Join-Path $root 'data'
$cacheRoot = Join-Path $root 'cache'
$inputPath = Join-Path $dataRoot 'catalog.json'
$outputPath = Join-Path $cacheRoot 'catalog.js'
if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) {
    [System.IO.Directory]::CreateDirectory((Join-Path $dataRoot '论文/原始pdf')) | Out-Null
    [System.IO.File]::Copy((Join-Path $root 'catalog.example.json'), $inputPath, $false)
}
$raw = [System.IO.File]::ReadAllText($inputPath)
$jsonOptions = @{ InputObject = $raw }
if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
    $jsonOptions.DateKind = 'String'
}
$catalog = ConvertFrom-Json @jsonOptions

function Assert-Id($value, $context) {
    if ($value -isnot [string] -or $value -cnotmatch '^[a-z0-9][a-z0-9._-]*$') {
        throw "无效 ID（$context）：$value"
    }
}

function Test-PositiveInteger($value) {
    return ($value -is [int] -or $value -is [long]) -and $value -gt 0
}

function Test-PdfPath($value) {
    return $value -is [string] -and $value -match '^论文(?:/[^/\\:*?"<>|]+)+\.pdf$' -and
        ($value -split '/') -notcontains '..' -and ($value -split '/') -notcontains '.'
}

if (-not (Test-PositiveInteger $catalog.schemaVersion) -or $catalog.schemaVersion -ne 1 -or $catalog.categories -isnot [array] -or $catalog.papers -isnot [array]) {
    throw '目录需要 schemaVersion: 1，以及 categories 和 papers 数组。'
}

$categories = @{}
foreach ($category in $catalog.categories) {
    Assert-Id $category.id '分类'
    if ($category.id -eq 'uncategorized' -or $categories.ContainsKey($category.id) -or
        $category.label -isnot [string] -or -not $category.label.Trim()) {
        throw "分类 ID 重复、保留或缺少名称：$($category.id)"
    }
    if ($null -ne $category.shortLabel -and $category.shortLabel -isnot [string]) {
        throw "分类简称必须是字符串：$($category.id)"
    }
    $categories[$category.id] = $true
}

$papers = @{}
foreach ($paper in $catalog.papers) {
    Assert-Id $paper.id '论文'
    if ($papers.ContainsKey($paper.id)) { throw "论文 ID 重复：$($paper.id)" }
    $papers[$paper.id] = $true
    if ($paper.category -and -not $categories.ContainsKey($paper.category)) {
        throw "论文 $($paper.id) 的分类不存在：$($paper.category)"
    }
    if ($null -ne $paper.addedAt -and $paper.addedAt -ne '') {
        $addedAt = [DateTimeOffset]::MinValue
        # Older PowerShell 7 releases may already have converted the ISO timestamp.
        $isConvertedDate = $paper.addedAt -is [DateTime] -and $paper.addedAt.Kind -ne [DateTimeKind]::Unspecified
        $isValidTimestamp = $paper.addedAt -is [string] -and
            $paper.addedAt -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$' -and
            [DateTimeOffset]::TryParse($paper.addedAt, [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::None, [ref]$addedAt)
        if (-not ($isConvertedDate -or $isValidTimestamp)) {
            throw "论文 $($paper.id) 的入库时间应为带时区的日期和时间，例如 2026-11-21T16:39:00+08:00。"
        }
    }
    if ($null -ne $paper.impact) {
        $count = $paper.impact.citationCount
        $checkedOn = [DateTime]::MinValue
        if (($count -isnot [int] -and $count -isnot [long]) -or $count -lt 0 -or
            $paper.impact.openAlexId -cnotmatch '^W[0-9]+$' -or -not [DateTime]::TryParseExact(
                $paper.impact.checkedOn, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::None, [ref]$checkedOn)) {
            throw "论文 $($paper.id) 的 impact 需要非负整数 citationCount、有效 openAlexId 和 YYYY-MM-DD 格式的 checkedOn。"
        }
    }
    if ($paper.versions -isnot [array]) { throw "论文 $($paper.id) 需要 versions 数组。" }
    if ($null -ne $paper.tags -and $paper.tags -isnot [array]) { throw "论文 $($paper.id) 的 tags 必须是数组。" }

    if ($null -ne $paper.overview) {
        if ($paper.overview -isnot [array]) { throw "论文 $($paper.id) 的 overview 需要是数组。" }
        foreach ($section in $paper.overview) {
            if ($section.title -isnot [string] -or -not $section.title.Trim() -or
                $section.text -isnot [string] -or -not $section.text.Trim()) {
                throw "论文 $($paper.id) 的每条详细介绍都需要标题和正文。"
            }
        }
    }

    $versions = @{}
    foreach ($version in $paper.versions) {
        Assert-Id $version.id "论文 $($paper.id) 的版本"
        if ($versions.ContainsKey($version.id)) { throw "版本 ID 重复：$($paper.id)/$($version.id)" }
        $versions[$version.id] = $true
        $file = $version.file
        if (-not (Test-PdfPath $file)) {
            throw "请使用论文目录下的相对 PDF 路径：$file"
        }
        if (-not (Test-Path -LiteralPath (Join-Path $dataRoot $file) -PathType Leaf)) {
            throw "找不到 PDF：$file"
        }
        $sourceFile = $version.sourceFile
        if ($null -ne $sourceFile) {
            if (-not (Test-PdfPath $sourceFile) -or -not $sourceFile.StartsWith('论文/原始pdf/', [StringComparison]::OrdinalIgnoreCase) -or
                $file.StartsWith('论文/原始pdf/', [StringComparison]::OrdinalIgnoreCase)) {
                throw "请分别填写分类 PDF 路径和原始pdf 目录下的归档路径：$file / $sourceFile"
            }
            if (-not (Test-Path -LiteralPath (Join-Path $dataRoot $sourceFile) -PathType Leaf)) {
                throw "找不到归档原件：$sourceFile"
            }
        }
        if ($version.language -notin @('zh', 'en')) { throw "请为 $file 指定语言 zh 或 en。" }
        if ($null -ne $version.pages -and -not (Test-PositiveInteger $version.pages)) {
            throw "PDF 总页数无效：$file"
        }
        if ($version.translatedFrom -or $null -ne $version.translationPages) {
            $original = @($paper.versions | Where-Object { $_.id -ceq $version.translatedFrom -and $_.language -eq 'en' })
            if ($version.language -ne 'zh' -or $original.Count -ne 1 -or -not (Test-PositiveInteger $version.pages)) {
                throw "译本原文版本或页数不一致：$file"
            }
            if ($version.pageLayout -eq 'source') {
                if ($original[0].pages -ne $version.pages -or $null -ne $version.translationPages) {
                    throw "原位译本应沿用英文原文的页数：$file"
                }
                foreach ($mappedPage in $version.legacyPageMap) {
                    if (-not (Test-PositiveInteger $mappedPage) -or $mappedPage -gt $version.pages) {
                        throw "旧译本的页码映射无效：$file"
                    }
                }
            } elseif (-not (Test-PositiveInteger $version.translationPages) -or
                $version.translationPages + $original[0].pages -ne $version.pages) {
                throw "译本原文版本或页数不一致：$file"
            }
        }
        if ($null -ne $version.toc -and $version.toc -isnot [array]) { throw "章节目录需要是数组：$file" }
        foreach ($entry in $version.toc) {
            if ($entry.title -isnot [string] -or -not $entry.title.Trim() -or -not (Test-PositiveInteger $entry.page) -or
                ($version.pages -and $entry.page -gt $version.pages) -or
                ($null -ne $entry.level -and -not (Test-PositiveInteger $entry.level))) {
                throw "章节标题或页码无效：$file / $($entry.title)"
            }
        }
    }
}

$cacheDirectory = Join-Path $cacheRoot 'pdf-data'
[System.IO.Directory]::CreateDirectory($cacheDirectory) | Out-Null
$encoding = [System.Text.UTF8Encoding]::new($false)
$packedFiles = @{}
foreach ($paper in $catalog.papers) {
    foreach ($version in $paper.versions) {
        $pdfPath = Join-Path $dataRoot $version.file
        if (-not $packedFiles.ContainsKey($version.file)) {
            $packedFiles[$version.file] = (Get-FileHash -LiteralPath $pdfPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        $hash = $packedFiles[$version.file]
        if ($version.sourceFile) {
            $sourcePath = Join-Path $dataRoot $version.sourceFile
            $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
            if ($sourceHash -ne $hash) {
                throw "归档原件和分类 PDF 内容不同：$($version.sourceFile) / $($version.file)"
            }
        }
        $packedPath = Join-Path $cacheDirectory ($hash + '.js')
        if ([System.IO.File]::Exists($packedPath)) { continue }

        $tempPdf = Join-Path $cacheDirectory ([guid]::NewGuid().ToString('N') + '.tmp')
        try {
            $base64 = [System.Convert]::ToBase64String([System.IO.File]::ReadAllBytes($pdfPath))
            $stream = [System.IO.StreamWriter]::new($tempPdf, $false, $encoding)
            try {
                $stream.Write('window.deliverPaperPdf("' + $hash + '","')
                $stream.Write($base64)
                $stream.WriteLine('");')
            } finally {
                $stream.Dispose()
            }
            [System.IO.File]::Move($tempPdf, $packedPath)
        } catch [System.IO.IOException] {
            if (-not [System.IO.File]::Exists($packedPath)) { throw }
        } finally {
            if (Test-Path -LiteralPath $tempPdf) { Remove-Item -LiteralPath $tempPdf }
        }
    }
}

$staged = Join-Path $cacheRoot ('catalog-' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
    $script = "// Generated by temp/同步论文目录.ps1. Edit data/catalog.json." + [Environment]::NewLine +
        'window.PAPER_CATALOG = ' + $raw.Trim() + ';' + [Environment]::NewLine +
        'window.PAPER_PDF_FILES = ' + (ConvertTo-Json -InputObject $packedFiles -Compress) + ';' + [Environment]::NewLine
    [System.IO.File]::WriteAllText($staged, $script, $encoding)
    if ([System.IO.File]::Exists($outputPath)) {
        [System.IO.File]::Replace($staged, $outputPath, [NullString]::Value)
    } else {
        [System.IO.File]::Move($staged, $outputPath)
    }
} finally {
    if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged }
}
Write-Output "已同步 $($catalog.papers.Count) 篇论文。刷新论文阅读.html 即可查看。"
