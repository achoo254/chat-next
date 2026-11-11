# Giấy phép thư viện của `tunelo-term-host`

Kiểm ngày 11/11/2026 trên `apps/term-host/Cargo.lock` (crate `tunelo-term-host` 0.1.0). Máy kiểm không có `cargo-deny` hay
`cargo-about`, nên giấy phép đọc từ trường `license` của từng crate:

```sh
cd apps/term-host
cargo tree --offline --locked -e normal,build --target <đích> --prefix none --format "{p}|{l}"
```

chạy cho cả năm đích phát hành (`aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`,
`x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`). Gộp lại, kể cả phụ thuộc lúc build: 133 crate (chưa kể chính nó); chỉ tính phụ thuộc chạy
(`-e normal`) thì 105 crate cho macOS và Linux, 88 cho Windows. Phụ thuộc chỉ dùng khi test (`tempfile`) không vào binary.

## Kết quả

Không có crate nào dùng giấy phép copyleft (GPL, LGPL, AGPL, MPL, EUPL) hay không ghi giấy phép. Tất cả là giấy phép dễ dãi:

| Giấy phép | Số crate |
|---|---|
| MIT hoặc Apache-2.0 (mọi cách viết) | 108 |
| MIT | 16 |
| Apache-2.0 | 1 (`flagset`) |
| BSD-3-Clause | 1 (`subtle`) |
| BSD-2-Clause hoặc Apache-2.0 (hoặc MIT) | 2 (`serial2`, `zerocopy`) |
| Unlicense hoặc MIT | 1 (`memchr`) |
| CC0-1.0 hoặc MIT-0 hoặc Apache-2.0 | 1 (`dunce`) |
| (MIT hoặc Apache-2.0) và Unicode-3.0 | 1 (`unicode-ident`, chỉ dùng lúc build macro) |
| ISC và (Apache-2.0 hoặc ISC) | 1 (`aws-lc-rs`) |
| ISC, Apache-2.0, MIT, BSD-3-Clause và các tổ hợp | 1 (`aws-lc-sys`, mã C của AWS-LC nhúng tĩnh) |

Các thư viện chính:

| Crate | Phiên bản | Giấy phép | Vai trò |
|---|---|---|---|
| `str0m` | 0.25.0 | MIT hoặc Apache-2.0 | WebRTC (data channel, ICE, DTLS) |
| `aws-lc-rs`, `aws-lc-sys` | 1.19.0, 0.47.0 | ISC, Apache-2.0, MIT, BSD-3-Clause | Mật mã cho DTLS trên macOS và Linux (Windows dùng `wincrypto` của hệ điều hành) |
| `portable-pty` | 0.9.0 | MIT | PTY (ConPTY trên Windows) |
| `vt100` | 0.16.2 | MIT | Ảnh chụp màn hình terminal khi mở lại phiên |
| `nix` | 0.28.0 | MIT | Socket, tín hiệu, quyền tệp trên POSIX |
| `windows-sys` | 0.61.2 | MIT hoặc Apache-2.0 | API Windows |
| `serde`, `serde_json`, `base64`, `crossbeam-channel`, `getrandom`, `signal-hook` | | MIT hoặc Apache-2.0 | Tiện ích |

## Nghĩa vụ khi phát hành

MIT, BSD, ISC và Apache-2.0 cho phép phát hành binary đóng, với điều kiện kèm thông báo bản quyền và văn bản giấy phép của
các thư viện. Bản phát hành hiện chỉ có binary, `.minisig` và `SHA256SUMS`, chưa kèm tệp thông báo bên thứ ba cho
`tunelo-term-host`. Cách làm gọn: sinh tệp đó bằng `cargo about generate` (hoặc `cargo deny check licenses` để chặn giấy phép
ngoài danh sách cho phép) trong job build của `agent-release.yml` và đính kèm vào Release.

`apps/term-host/Cargo.toml` chưa có trường `license` cho chính crate (`publish = false`, nên không chặn build).

Kiểm lại khi đổi `Cargo.lock`: chạy lại lệnh trên và so với bảng.

**Quyết định (11/11/2026, Jev 0,78):** hoãn tệp thông báo bên thứ ba. Hiện chưa có người dùng ngoài chủ dự án; thêm bước sinh tệp này vào `agent-release.yml` trước khi `tunelo-term-host` được đưa cho người dùng bên ngoài.
