# Minimal statisk filserver för lokal test (http://localhost:8000/index.html).
# Kör: powershell -ExecutionPolicy Bypass -File serve.ps1   (Ctrl+C för att stoppa)
$root = $PSScriptRoot
$port = 8000
$mime = @{
  ".html"="text/html; charset=utf-8"; ".js"="text/javascript; charset=utf-8";
  ".json"="application/json"; ".css"="text/css"; ".png"="image/png";
  ".webp"="image/webp"; ".svg"="image/svg+xml"; ".ico"="image/x-icon";
  ".webmanifest"="application/manifest+json"
}
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serverar $root pa http://localhost:$port/  (Ctrl+C for att stoppa)"
try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = "index.html" }
    $path = Join-Path $root $rel
    if (Test-Path $path -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($path)
      $ext = [System.IO.Path]::GetExtension($path).ToLower()
      if ($mime.ContainsKey($ext)) { $ctx.Response.ContentType = $mime[$ext] }
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404: $rel")
      $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
    }
    $ctx.Response.Close()
  }
} finally { $listener.Stop() }
