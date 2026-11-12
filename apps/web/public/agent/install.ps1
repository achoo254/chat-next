# Installs tunelo, the background process of "My machines" (ADR 0013) and
# the Tunelo CLI, on Windows (Windows PowerShell 5.1 or PowerShell 7).
# "Add this machine" in Chat shows:
#
#   & ([scriptblock]::Create((irm https://<chat host>/agent/install.ps1))) <device key> <pairing secret> [vi|en|zh-CN]
#
# which installs tunelo and runs `tunelo install`: you sign in with your
# account in the browser and the machine joins My machines by itself (no
# install code). The pairing secret is one-time and short-lived, so it rides
# in the one command the page shows. A command without it (an older page)
# asks for it. A command of an older page, with an install code before the
# device key, still works: the code is ignored.
#
# With only a language (or nothing), the script installs or updates the
# binary and runs `tunelo login`; this is what `tunelo update` of the Tunelo
# CLI 1.x runs:
#
#   & ([scriptblock]::Create((irm https://<chat host>/agent/install.ps1))) [vi|en|zh-CN]
#
# Two files are installed next to each other: tunelo.exe and
# tunelo-term-host.exe, the process that keeps the machine's terminals (a
# release from before the terminal has only tunelo). When `tunelo update`
# already put a terminal process into the config folder, the new one is also
# staged there; tunelo switches to it once no terminal is open.
#
# The release is pinned: version and SHA-256 are written into this script
# when the web app is built for a tunelo release, and the minisign
# signature is checked with the embedded public key when minisign is
# installed. A script whose pins were not filled in refuses to run.
param(
	[string]$First = '',
	[string]$Second = '',
	[string]$Third = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$TuneloVersion = '2.6.1'
$Sha256WindowsX64 = 'ebc0b6ba5d82fdad5bab3a4bb6886771690e553e5d2b249a0f7e5d1c41d338a3'
$Sha256TermHostWindowsX64 = 'cb299159676e771de4ee5c30af5e10e9ae65bee151c5fd9d188dea8b16ac6195'
$MinisignPubKey = 'RWRFawlh5bQHAM2aPa3OjWqc80YoE0B31Rzcvz5QpG6J5R4vdgnJhf6D'
$Releases = 'https://github.com/achoo254/chat-next/releases/download'
$Asset = 'tunelo-windows-x64.exe'
$TermHostAsset = 'tunelo-term-host-windows-x64.exe'

# <device key> [language], an older page's <install code> <device key>
# [language] (the code is ignored), or only [language].
$KeyPattern = '^[A-Za-z0-9_-]{43}$'
$DeviceKey = ''
$Locale = ''
$BadKey = $false
$Secret = ''
if ($First -match $KeyPattern) {
	$DeviceKey = $First
	if ($Second -match $KeyPattern) {
		$Secret = $Second
		$Locale = $Third
	} else {
		$Locale = $Second
	}
} elseif ($First -match '^[A-Za-z0-9_-]{22}$' -and $Second) {
	$DeviceKey = $Second
	$Locale = $Third
	$BadKey = $DeviceKey -notmatch $KeyPattern
} else {
	$Locale = $First
}
if (-not $Locale) { $Locale = (Get-Culture).Name }
$Lang = 'en'
if ($Locale -like 'vi*') { $Lang = 'vi' } elseif ($Locale -like 'zh*') { $Lang = 'zh-CN' }

function Get-Text([string]$Vi, [string]$En, [string]$Zh) {
	switch ($Lang) {
		'vi' { return $Vi }
		'zh-CN' { return $Zh }
		default { return $En }
	}
}

# Runs a native command with its output discarded and returns its exit code.
# Windows PowerShell 5.1 turns redirected stderr of a native command (npm
# warn …, "tunelo is not running") into errors that 'Stop' would end the
# script with, so this one call runs with 'Continue'.
function Invoke-Quiet([string]$Exe, [string[]]$Arguments) {
	$saved = $ErrorActionPreference
	try {
		$ErrorActionPreference = 'Continue'
		& $Exe @Arguments *> $null
		return $LASTEXITCODE
	} catch {
		return 1
	} finally {
		$ErrorActionPreference = $saved
	}
}

function Stop-Install([string]$Vi, [string]$En, [string]$Zh) {
	throw (Get-Text "Lỗi: $Vi" "Error: $En" "错误：$Zh")
}

# Downloads a file of the pinned release into $Dir and checks its SHA-256,
# and its signature when minisign is installed (or always fetches the
# signature with -WithSignature). Returns the file's path.
function Get-VerifiedFile([string]$Dir, [string]$Name, [string]$Sha256, [switch]$WithSignature) {
	$url = "$Releases/tunelo-v$TuneloVersion/$Name"
	$file = Join-Path $Dir $Name
	try {
		Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file
	} catch {
		Stop-Install "không tải được $url" "could not download $url" "无法下载 $url"
	}
	if ((Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLowerInvariant() -ne $Sha256.ToLowerInvariant()) {
		Stop-Install 'file tải về không khớp SHA-256 đã ghim; đã huỷ cài đặt.' `
			'the download does not match the pinned SHA-256; nothing was installed.' `
			'下载的文件与固定的 SHA-256 不符；未安装任何内容。'
	}
	$minisign = Get-Command minisign -ErrorAction SilentlyContinue
	if ($minisign -or $WithSignature) {
		try {
			Invoke-WebRequest -UseBasicParsing -Uri "$url.minisig" -OutFile "$file.minisig"
		} catch {
			Stop-Install 'không tải được chữ ký minisign.' 'could not download the minisign signature.' '无法下载 minisign 签名。'
		}
	}
	if ($minisign) {
		& $minisign.Source -Vq -P $MinisignPubKey -m $file -x "$file.minisig" | Out-Null
		if ($LASTEXITCODE -ne 0) {
			Stop-Install 'chữ ký minisign không hợp lệ; đã huỷ cài đặt.' `
				'the minisign signature is invalid; nothing was installed.' 'minisign 签名无效；未安装任何内容。'
		}
	}
	return $file
}

# Moves a downloaded file into place. A running .exe cannot be overwritten,
# but it can be renamed: the running one becomes .old (or another free name
# when an older .old still runs) and keeps running until it exits.
function Install-File([string]$From, [string]$To) {
	if (Test-Path $To) {
		$aside = "$To.old"
		Remove-Item -Force -Path $aside -ErrorAction SilentlyContinue
		if (Test-Path $aside) { $aside = "$To.old-" + [Guid]::NewGuid().ToString('N') }
		Move-Item -Force -Path $To -Destination $aside
	}
	Move-Item -Force -Path $From -Destination $To
}

function Install-Tunelo {
	if ($BadKey) {
		Stop-Install 'khoá thiết bị không hợp lệ; hãy chép lại lệnh từ trang Chat.' `
			'the device key is malformed; copy the command from the Chat page again.' `
			'设备密钥格式不正确；请从 Chat 页面重新复制命令。'
	}
	if ($TuneloVersion.StartsWith('__')) {
		Stop-Install 'chưa có bản phát hành tunelo.' 'no tunelo release is available yet.' 'tunelo 尚未发布。'
	}
	# x64 also runs on Windows on Arm through emulation.
	if ($env:PROCESSOR_ARCHITECTURE -notin @('AMD64', 'ARM64') -and $env:PROCESSOR_ARCHITEW6432 -notin @('AMD64', 'ARM64')) {
		Stop-Install 'tunelo cần Windows 64-bit.' 'tunelo needs 64-bit Windows.' 'tunelo 需要 64 位 Windows。'
	}
	# Windows PowerShell 5.1 may still default to older TLS versions.
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

	$tmp = Join-Path ([IO.Path]::GetTempPath()) ('tunelo-' + [Guid]::NewGuid().ToString('N'))
	New-Item -ItemType Directory -Path $tmp | Out-Null
	try {
		Write-Host (Get-Text "Đang tải tunelo $TuneloVersion…" "Downloading tunelo $TuneloVersion…" "正在下载 tunelo $TuneloVersion…")
		# Both files are checked before either is installed.
		$file = Get-VerifiedFile $tmp $Asset $Sha256WindowsX64
		$hostFile = ''
		if ($Sha256TermHostWindowsX64) {
			# Its signature names its version, which tunelo reads when it switches.
			$hostFile = Get-VerifiedFile $tmp $TermHostAsset $Sha256TermHostWindowsX64 -WithSignature
		}

		$dir = Join-Path $env:LOCALAPPDATA 'tunelo'
		$exe = Join-Path $dir 'tunelo.exe'
		New-Item -ItemType Directory -Force -Path $dir | Out-Null
		# tunelo first: if it cannot be put in place, no newer terminal process waits for it.
		Install-File $file $exe
		# What `tunelo update --rollback` would put back is not the release before this one any more.
		$config = if ($env:TUNELO_HOME) { $env:TUNELO_HOME } else { Join-Path $env:APPDATA 'tunelo' }
		Remove-Item -Force -Path (Join-Path $config 'update-rollback.json') -ErrorAction SilentlyContinue
		if ($hostFile) {
			# A terminal process `tunelo update` put into the config folder comes
			# before the one next to tunelo: stage the new one there too.
			$hostBins = Join-Path $config 'term-host\bin'
			if (Test-Path (Join-Path $hostBins 'current')) {
				$partial = Join-Path $hostBins 'next.partial'
				$next = Join-Path $hostBins 'next'
				Remove-Item -Recurse -Force -Path $partial -ErrorAction SilentlyContinue
				New-Item -ItemType Directory -Force -Path $partial | Out-Null
				Copy-Item -Path $hostFile -Destination (Join-Path $partial 'tunelo-term-host.exe')
				Copy-Item -Path "$hostFile.minisig" -Destination (Join-Path $partial 'tunelo-term-host.exe.minisig')
				Remove-Item -Recurse -Force -Path $next -ErrorAction SilentlyContinue
				Move-Item -Path $partial -Destination $next
			}
			# A running terminal process keeps running from its renamed file; open shells stay.
			Install-File $hostFile (Join-Path $dir 'tunelo-term-host.exe')
		}
		# Put tunelo on the user's PATH (no admin); new terminals see it.
		$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
		if (-not (($userPath -split ';') -contains $dir)) {
			$newPath = if ($userPath) { "$userPath;$dir" } else { $dir }
			[Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
		}
		if (-not (($env:Path -split ';') -contains $dir)) { $env:Path = "$env:Path;$dir" }
	} finally {
		Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
	}

	# The old Tunelo CLI from npm (1.x) is also called tunelo and may come first on PATH.
	if (Get-Command npm -ErrorAction SilentlyContinue) {
		if ((Invoke-Quiet 'npm' @('ls', '-g', 'tunelo', '--depth=0')) -eq 0) {
			Write-Warning (Get-Text 'Gói npm tunelo 1.x cũ vẫn đang cài và có thể che lệnh tunelo mới. Gỡ nó bằng: npm uninstall -g tunelo' `
				'The old tunelo 1.x npm package is still installed and may hide the new tunelo command. Remove it with: npm uninstall -g tunelo' `
				'旧的 tunelo 1.x npm 包仍已安装，可能遮住新的 tunelo 命令。请运行 npm uninstall -g tunelo 卸载。')
		}
	}

	if (-not $DeviceKey) {
		# A running background service still runs the previous file: restart it
		# on the new one.
		if ((Invoke-Quiet $exe @('status', '--json')) -eq 0) {
			Write-Host (Get-Text 'Đang khởi động lại tunelo chạy nền với bản mới…' `
				'Restarting the background tunelo on the new version…' '正在用新版本重启后台 tunelo…')
			Invoke-Quiet $exe @('stop') | Out-Null
			& $exe start
			if ($LASTEXITCODE -ne 0) {
				Write-Host (Get-Text 'Chưa khởi động lại được; chạy tunelo start.' 'Could not restart it; run tunelo start.' '无法重启；请运行 tunelo start。')
			}
		}
		# Binary only: one sign-in for the tunnel, Chat and Localman. A failed or
		# skipped sign-in leaves tunelo installed.
		Write-Host (Get-Text 'Đăng nhập tài khoản cho tunelo (tunnel, Chat, Localman)…' `
			'Signing tunelo in with your account (tunnel, Chat, Localman)…' '正在用你的账号登录 tunelo（隧道、Chat、Localman）…')
		& $exe login
		if ($LASTEXITCODE -ne 0) {
			Write-Host (Get-Text 'Chưa đăng nhập được; chạy lại tunelo login khi sẵn sàng.' `
				'Not signed in yet; run tunelo login when you are ready.' '尚未登录；准备好后请运行 tunelo login。')
		}
		return
	}

	$secret = $Secret
	if (-not $secret) {
		$prompt = Get-Text 'Dán mã ghép đang hiện trên trang Chat rồi bấm Enter' `
			'Paste the pairing secret shown on the Chat page and press Enter' `
			'粘贴 Chat 页面上显示的配对密钥并按回车'
		$secret = (Read-Host -Prompt $prompt).Trim()
	}
	if ($secret -notmatch '^[A-Za-z0-9_-]{43}$') {
		Stop-Install 'mã ghép không hợp lệ; chạy lại lệnh và dán đúng mã.' `
			'the pairing secret is malformed; run the command again and paste it.' `
			'配对密钥格式不正确；请重新运行命令并粘贴。'
	}
	# The secret reaches tunelo on stdin only.
	# Windows PowerShell may prefix piped text with a UTF-8 BOM; send plain UTF-8.
	$OutputEncoding = New-Object System.Text.UTF8Encoding $false
	$secret | & $exe install --trust $DeviceKey
	if ($LASTEXITCODE -ne 0) {
		Stop-Install 'tunelo install không thành công.' 'tunelo install failed.' 'tunelo install 失败。'
	}
}

Install-Tunelo
