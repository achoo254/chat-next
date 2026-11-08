# Installs tunelo, the background process of "My machines" (ADR 0013),
# on Windows (Windows PowerShell 5.1 or PowerShell 7). The web app shows the
# command:
#
#   & ([scriptblock]::Create((irm https://<chat host>/agent/install.ps1))) <install code> <device key> [vi|en|zh-CN]
#
# A computer that still runs hda (the earlier name of tunelo) is moved to
# tunelo first, keeping the machine, its paired devices and sessions. Without
# an install code the script only does that move:
#
#   & ([scriptblock]::Create((irm https://<chat host>/agent/install.ps1))) [vi|en|zh-CN]
#
# then asks you to paste the pairing secret it shows, which this script
# reads with Read-Host -AsSecureString: the secret is never in a command
# line (argv, PSReadLine history). The install code (one-time, 10 minutes)
# and the device's public key are not secret.
#
# The release is pinned: version and SHA-256 are written into this script
# when the web app is built for a tunelo release, and the minisign
# signature is checked with the embedded public key when minisign is
# installed. A script whose pins were not filled in refuses to run.
param(
	[string]$Code = '',
	[string]$DeviceKey = '',
	[string]$Locale = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$TuneloVersion = '__TUNELO_VERSION__'
$Sha256WindowsX64 = '__SHA256_WINDOWS_X64__'
$MinisignPubKey = 'RWRFawlh5bQHAM2aPa3OjWqc80YoE0B31Rzcvz5QpG6J5R4vdgnJhf6D'
$Releases = 'https://github.com/achoo254/chat-next/releases/download'
$Asset = 'tunelo-windows-x64.exe'

# Only a language given (the command that moves hda): it arrives as the first argument.
if (-not $DeviceKey -and $Code -match '^(vi|en|zh)') {
	$Locale = $Code
	$Code = ''
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

function Stop-Install([string]$Vi, [string]$En, [string]$Zh) {
	throw (Get-Text "Lỗi: $Vi" "Error: $En" "错误：$Zh")
}

function Install-Tunelo {
	# hda keeps its config here; the marker means it has already moved to tunelo.
	$hdaDir = if ($env:CHAT_AGENT_HOME) { $env:CHAT_AGENT_HOME } else { Join-Path $env:APPDATA 'chat-agent' }
	$fromHda = (Test-Path (Join-Path $hdaDir 'config.json')) -and -not (Test-Path (Join-Path $hdaDir 'migrated-to-tunelo'))
	if ($Code -or -not $fromHda) {
		if ($Code -notmatch '^[A-Za-z0-9_-]{22}$' -or $DeviceKey -notmatch '^[A-Za-z0-9_-]{43}$') {
			Stop-Install 'thiếu hoặc sai mã cài/khoá thiết bị; hãy chép lại lệnh từ trang Chat.' `
				'missing or malformed install code or device key; copy the command from the Chat page again.' `
				'安装码或设备密钥缺失或格式不正确；请从 Chat 页面重新复制命令。'
		}
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
		$url = "$Releases/tunelo-v$TuneloVersion/$Asset"
		$file = Join-Path $tmp $Asset
		Write-Host (Get-Text "Đang tải tunelo $TuneloVersion…" "Downloading tunelo $TuneloVersion…" "正在下载 tunelo $TuneloVersion…")
		try {
			Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file
		} catch {
			Stop-Install "không tải được $url" "could not download $url" "无法下载 $url"
		}
		if ((Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLowerInvariant() -ne $Sha256WindowsX64.ToLowerInvariant()) {
			Stop-Install 'file tải về không khớp SHA-256 đã ghim; đã huỷ cài đặt.' `
				'the download does not match the pinned SHA-256; nothing was installed.' `
				'下载的文件与固定的 SHA-256 不符；未安装任何内容。'
		}
		$minisign = Get-Command minisign -ErrorAction SilentlyContinue
		if ($minisign) {
			try {
				Invoke-WebRequest -UseBasicParsing -Uri "$url.minisig" -OutFile "$file.minisig"
			} catch {
				Stop-Install 'không tải được chữ ký minisign.' 'could not download the minisign signature.' '无法下载 minisign 签名。'
			}
			& $minisign.Source -Vq -P $MinisignPubKey -m $file -x "$file.minisig"
			if ($LASTEXITCODE -ne 0) {
				Stop-Install 'chữ ký minisign không hợp lệ; đã huỷ cài đặt.' `
					'the minisign signature is invalid; nothing was installed.' 'minisign 签名无效；未安装任何内容。'
			}
		}

		$dir = Join-Path $env:LOCALAPPDATA 'tunelo'
		$exe = Join-Path $dir 'tunelo.exe'
		New-Item -ItemType Directory -Force -Path $dir | Out-Null
		# A running tunelo.exe cannot be overwritten, but it can be renamed.
		if (Test-Path $exe) {
			Remove-Item -Force -Path "$exe.old" -ErrorAction SilentlyContinue
			Move-Item -Force -Path $exe -Destination "$exe.old"
		}
		Move-Item -Force -Path $file -Destination $exe
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
		& npm ls -g tunelo --depth=0 *> $null
		if ($LASTEXITCODE -eq 0) {
			Write-Warning (Get-Text 'Gói npm tunelo 1.x cũ vẫn đang cài và có thể che lệnh tunelo mới. Gỡ nó bằng: npm uninstall -g tunelo' `
				'The old tunelo 1.x npm package is still installed and may hide the new tunelo command. Remove it with: npm uninstall -g tunelo' `
				'旧的 tunelo 1.x npm 包仍已安装，可能遮住新的 tunelo 命令。请运行 npm uninstall -g tunelo 卸载。')
		}
	}

	if ($fromHda) {
		Write-Host (Get-Text 'Tìm thấy hda trên máy; đang chuyển sang tunelo (giữ máy, thiết bị đã ghép và các phiên)…' `
			'Found hda on this computer; moving it to tunelo (the machine, paired devices and sessions stay)…' `
			'在这台电脑上找到 hda；正在迁移到 tunelo（保留电脑、已配对设备和会话）…')
		& $exe migrate-from-hda
		if ($LASTEXITCODE -ne 0) {
			Stop-Install 'chuyển hda sang tunelo không thành công; hda vẫn chạy như cũ.' `
				'moving hda to tunelo failed; hda keeps running as before.' 'hda 迁移到 tunelo 失败；hda 仍照常运行。'
		}
		if (-not $Code) { return }
	}

	$prompt = Get-Text 'Dán mã ghép đang hiện trên trang Chat rồi bấm Enter (chữ sẽ không hiện khi dán)' `
		'Paste the pairing secret shown on the Chat page and press Enter (it stays hidden)' `
		'粘贴 Chat 页面上显示的配对密钥并按回车（输入内容不会显示）'
	$secure = Read-Host -AsSecureString -Prompt $prompt
	$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
	try {
		$secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
	} finally {
		[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
	}
	if ($secret -notmatch '^[A-Za-z0-9_-]{43}$') {
		Stop-Install 'mã ghép không hợp lệ; chạy lại lệnh và dán đúng mã.' `
			'the pairing secret is malformed; run the command again and paste it.' `
			'配对密钥格式不正确；请重新运行命令并粘贴。'
	}
	# The secret reaches tunelo on stdin only.
	# Windows PowerShell may prefix piped text with a UTF-8 BOM; send plain UTF-8.
	$OutputEncoding = New-Object System.Text.UTF8Encoding $false
	$secret | & $exe install $Code --trust $DeviceKey
	if ($LASTEXITCODE -ne 0) {
		Stop-Install 'tunelo install không thành công.' 'tunelo install failed.' 'tunelo install 失败。'
	}
}

Install-Tunelo
