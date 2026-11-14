# Installs tunelo, the background process of "My machines" (ADR 0013) and
# the Tunelo CLI, on Windows (Windows PowerShell 5.1 or PowerShell 7).
# "Add this machine" in Chat shows one fixed command, without arguments, in
# PowerShell:
#
#   irm https://<chat host>/agent/install.ps1 | iex
#
# and in cmd:
#
#   powershell -NoProfile -c "irm https://<chat host>/agent/install.ps1 | iex"
#
# It downloads the release archive, checks it, puts tunelo.exe and
# tunelo-term-host.exe (the process that keeps the machine's terminals) into
# %LOCALAPPDATA%\tunelo and runs `tunelo login`: you approve in the browser,
# and tunelo signs in, starts in the background and joins My machines by
# itself. The same command updates an installed tunelo. Messages follow the
# Windows display language.
#
# `iex` runs this text in the caller's own session, so everything below runs
# inside `& { … }`: no variable, function or preference setting outlives it.
#
# When `tunelo update` already put a terminal process into the config folder,
# the new one is also staged there; tunelo switches to it once no terminal is
# open.
#
# The release is pinned: version and SHA-256 of the archive are written into
# this script when the web app is built for a tunelo release, and the
# minisign signatures (of the archive and of each file in it) are checked
# with the embedded public key when minisign is installed. A script whose
# pins were not filled in refuses to run.
& {
	$ErrorActionPreference = 'Stop'
	$ProgressPreference = 'SilentlyContinue'

	$TuneloVersion = '3.3.5'
	$Sha256WindowsX64 = 'cb016bc18dcc03026ba18e2b351ae319abf0c7a82f303e0c1de8757cd3f0d5aa'
	$MinisignPubKey = 'RWRFawlh5bQHAM2aPa3OjWqc80YoE0B31Rzcvz5QpG6J5R4vdgnJhf6D'
	$Releases = 'https://github.com/achoo254/chat-next/releases/download'
	$Archive = 'tunelo-windows-x64.zip'
	$Asset = 'tunelo-windows-x64.exe'
	$TermHostAsset = 'tunelo-term-host-windows-x64.exe'

	$Locale = (Get-UICulture).Name
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

	# Downloads a file of the pinned release into $Dir; returns its path.
	function Get-ReleaseFile([string]$Dir, [string]$Name) {
		$url = "$Releases/tunelo-v$TuneloVersion/$Name"
		$file = Join-Path $Dir $Name
		try {
			Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file
		} catch {
			Stop-Install "không tải được $url" "could not download $url" "无法下载 $url"
		}
		return $file
	}

	# Checks a file against its minisign signature (<file>.minisig next to it).
	function Test-Signature([string]$Minisign, [string]$File) {
		& $Minisign -Vq -P $MinisignPubKey -m $File -x "$File.minisig" | Out-Null
		if ($LASTEXITCODE -ne 0) {
			Stop-Install 'chữ ký minisign không hợp lệ; đã huỷ cài đặt.' `
				'the minisign signature is invalid; nothing was installed.' 'minisign 签名无效；未安装任何内容。'
		}
	}

	# Downloads the archive, checks it and unpacks tunelo, its terminal process
	# and their signatures into $Dir\unpacked; returns that folder. Nothing is
	# installed before this ends.
	function Get-VerifiedRelease([string]$Dir) {
		$zip = Get-ReleaseFile $Dir $Archive
		if ((Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant() -ne $Sha256WindowsX64.ToLowerInvariant()) {
			Stop-Install 'file tải về không khớp SHA-256 đã ghim; đã huỷ cài đặt.' `
				'the download does not match the pinned SHA-256; nothing was installed.' `
				'下载的文件与固定的 SHA-256 不符；未安装任何内容。'
		}
		$unpacked = Join-Path $Dir 'unpacked'
		try {
			Expand-Archive -Path $zip -DestinationPath $unpacked
		} catch {
			Stop-Install "không giải nén được $Archive; đã huỷ cài đặt." "could not unpack $Archive; nothing was installed." "无法解压 $Archive；未安装任何内容。"
		}
		foreach ($name in @($Asset, "$Asset.minisig", $TermHostAsset, "$TermHostAsset.minisig")) {
			if (-not (Test-Path -LiteralPath (Join-Path $unpacked $name))) {
				Stop-Install "$Archive thiếu $name; đã huỷ cài đặt." "$Archive has no $name; nothing was installed." "$Archive 中缺少 $name；未安装任何内容。"
			}
		}
		$minisign = Get-Command minisign -ErrorAction SilentlyContinue
		if ($minisign) {
			Get-ReleaseFile $Dir "$Archive.minisig" | Out-Null
			Test-Signature $minisign.Source $zip
			Test-Signature $minisign.Source (Join-Path $unpacked $Asset)
			Test-Signature $minisign.Source (Join-Path $unpacked $TermHostAsset)
		}
		return $unpacked
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

	if ($TuneloVersion.StartsWith('__')) {
		Stop-Install 'chưa có bản phát hành tunelo.' 'no tunelo release is available yet.' 'tunelo 尚未发布。'
	}
	# x64 also runs on Windows on Arm through emulation.
	if ($env:PROCESSOR_ARCHITECTURE -notin @('AMD64', 'ARM64') -and $env:PROCESSOR_ARCHITEW6432 -notin @('AMD64', 'ARM64')) {
		Stop-Install 'tunelo cần Windows 64-bit.' 'tunelo needs 64-bit Windows.' 'tunelo 需要 64 位 Windows。'
	}
	# Windows PowerShell 5.1 may still default to older TLS versions.
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

	$dir = Join-Path $env:LOCALAPPDATA 'tunelo'
	$exe = Join-Path $dir 'tunelo.exe'
	$tmp = Join-Path ([IO.Path]::GetTempPath()) ('tunelo-' + [Guid]::NewGuid().ToString('N'))
	New-Item -ItemType Directory -Path $tmp | Out-Null
	try {
		Write-Host (Get-Text "Đang tải tunelo $TuneloVersion…" "Downloading tunelo $TuneloVersion…" "正在下载 tunelo $TuneloVersion…")
		$unpacked = Get-VerifiedRelease $tmp
		$hostFile = Join-Path $unpacked $TermHostAsset

		New-Item -ItemType Directory -Force -Path $dir | Out-Null
		# tunelo first: if it cannot be put in place, no newer terminal process waits for it.
		Install-File (Join-Path $unpacked $Asset) $exe
		# What `tunelo update --rollback` would put back is not the release before this one any more.
		$config = if ($env:TUNELO_HOME) { $env:TUNELO_HOME } else { Join-Path $env:APPDATA 'tunelo' }
		Remove-Item -Force -Path (Join-Path $config 'update-rollback.json') -ErrorAction SilentlyContinue
		# A terminal process `tunelo update` put into the config folder comes
		# before the one next to tunelo: stage the new one there too, with its
		# signature, which names its version.
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

	# A running background service still runs the previous file: restart it
	# on the new one.
	if ((Invoke-Quiet $exe @('status', '--json')) -eq 0) {
		Write-Host (Get-Text 'Đang khởi động lại tunelo chạy nền với bản mới…' `
			'Restarting the background tunelo on the new version…' '正在用新版本重启后台 tunelo…')
		Invoke-Quiet $exe @('stop') | Out-Null
		& $exe start
		if ($LASTEXITCODE -ne 0) {
			Write-Host (Get-Text 'Chưa khởi động lại được; chạy tunelo login.' 'Could not restart it; run tunelo login.' '无法重启；请运行 tunelo login。')
		}
	}

	# One sign-in for the tunnel, Chat and Localman; it also starts tunelo in
	# the background and adds the machine. A failed or skipped sign-in leaves
	# tunelo installed.
	Write-Host (Get-Text 'Đăng nhập tài khoản cho tunelo (tunnel, Chat, Localman)…' `
		'Signing tunelo in with your account (tunnel, Chat, Localman)…' '正在用你的账号登录 tunelo（隧道、Chat、Localman）…')
	& $exe login
	if ($LASTEXITCODE -ne 0) {
		Write-Host (Get-Text 'Chưa kết nối xong máy này; xem lý do ở trên, hoặc chạy tunelo status.' `
			'This machine is not connected yet; see the reason above, or run tunelo status.' '此机器尚未连接完成；原因见上方，或运行 tunelo status。')
	}
}
