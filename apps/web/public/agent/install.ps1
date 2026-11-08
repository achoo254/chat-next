# Installs hda, the background process of "My machines" (ADR 0013),
# on Windows (Windows PowerShell 5.1 or PowerShell 7). The web app shows the
# command:
#
#   & ([scriptblock]::Create((irm https://<chat host>/agent/install.ps1))) <install code> <device key> [vi|en|zh-CN]
#
# then asks you to paste the pairing secret it shows, which this script
# reads with Read-Host -AsSecureString: the secret is never in a command
# line (argv, PSReadLine history). The install code (one-time, 10 minutes)
# and the device's public key are not secret.
#
# The release is pinned: version and SHA-256 are written into this script
# when the web app is built for a hda release, and the minisign
# signature is checked with the embedded public key when minisign is
# installed. A script whose pins were not filled in refuses to run.
param(
	[string]$Code = '',
	[string]$DeviceKey = '',
	[string]$Locale = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$AgentVersion = '0.2.2'
$Sha256WindowsX64 = '594b7e505454377cb08a075954ba647da1eaa7fd5ab2989d57a8589c8846baef'
$MinisignPubKey = 'RWRFawlh5bQHAM2aPa3OjWqc80YoE0B31Rzcvz5QpG6J5R4vdgnJhf6D'
$Releases = 'https://github.com/achoo254/chat-next/releases/download'
$Asset = 'hda-windows-x64.exe'

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

function Install-ChatAgent {
	if ($Code -notmatch '^[A-Za-z0-9_-]{22}$' -or $DeviceKey -notmatch '^[A-Za-z0-9_-]{43}$') {
		Stop-Install 'thiếu hoặc sai mã cài/khoá thiết bị; hãy chép lại lệnh từ trang Chat.' `
			'missing or malformed install code or device key; copy the command from the Chat page again.' `
			'安装码或设备密钥缺失或格式不正确；请从 Chat 页面重新复制命令。'
	}
	if ($AgentVersion.StartsWith('__')) {
		Stop-Install 'chưa có bản phát hành hda.' 'no hda release is available yet.' 'hda 尚未发布。'
	}
	# x64 also runs on Windows on Arm through emulation.
	if ($env:PROCESSOR_ARCHITECTURE -notin @('AMD64', 'ARM64') -and $env:PROCESSOR_ARCHITEW6432 -notin @('AMD64', 'ARM64')) {
		Stop-Install 'hda cần Windows 64-bit.' 'hda needs 64-bit Windows.' 'hda 需要 64 位 Windows。'
	}
	# Windows PowerShell 5.1 may still default to older TLS versions.
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

	$tmp = Join-Path ([IO.Path]::GetTempPath()) ('hda-' + [Guid]::NewGuid().ToString('N'))
	New-Item -ItemType Directory -Path $tmp | Out-Null
	try {
		$url = "$Releases/agent-v$AgentVersion/$Asset"
		$file = Join-Path $tmp $Asset
		Write-Host (Get-Text "Đang tải hda $AgentVersion…" "Downloading hda $AgentVersion…" "正在下载 hda $AgentVersion…")
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

		$dir = Join-Path $env:LOCALAPPDATA 'hda'
		$exe = Join-Path $dir 'hda.exe'
		New-Item -ItemType Directory -Force -Path $dir | Out-Null
		Move-Item -Force -Path $file -Destination $exe
		# Put hda on the user's PATH (no admin); new terminals see it.
		$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
		if (-not (($userPath -split ';') -contains $dir)) {
			$newPath = if ($userPath) { "$userPath;$dir" } else { $dir }
			[Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
		}
		if (-not (($env:Path -split ';') -contains $dir)) { $env:Path = "$env:Path;$dir" }
	} finally {
		Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
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
	# The secret reaches hda on stdin only.
	# Windows PowerShell may prefix piped text with a UTF-8 BOM; send plain UTF-8.
	$OutputEncoding = New-Object System.Text.UTF8Encoding $false
	$secret | & $exe install $Code --trust $DeviceKey
	if ($LASTEXITCODE -ne 0) {
		Stop-Install 'hda install không thành công.' 'hda install failed.' 'hda install 失败。'
	}
}

Install-ChatAgent
