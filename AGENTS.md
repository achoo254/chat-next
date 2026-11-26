# AGENTS.md

Chat (`chat-next`): ứng dụng chat của hệ sinh thái hoandat tại `chat.hoandat.com`, đăng nhập qua IdP `auth-next`. Đọc `README.md`, rồi `docs/README.md` để biết nơi từng quyết định, đặc tả và hướng dẫn vận hành.

## Gate trước khi báo xong

`pnpm lint` (gồm `check:brand`, `check:forbidden`) → `pnpm typecheck` → `pnpm test`. Máy dev dùng chung: local chỉ chạy lint, typecheck và test của đúng gói liên quan; bộ đầy đủ chạy trên CI (push `main` rồi `gh run watch`). Chỉ dùng `pnpm`, không dùng npm.

## Deploy prod

Không có môi trường dev hay staging: xong việc, push hết lên `main`, kiểm `ci`, rồi `bash ../tools/deploy-prod.sh chat-next` (script của workspace `hoandat-app`). Không cần hỏi trước. Vẫn hỏi trước khi ghi dữ liệu tay, restore, sửa bí mật/OAuth, đổi tường lửa hay chạy script setup. Build chạy trong workflow, không build trên server. Chuẩn chung: `../docs/deploy-standard.md`; riêng repo này: `docs/deployment-guide.md` và skill `chat-ops-prod`.

## Repo công khai

Không commit IP, cổng SSH, user máy chủ, secret hay file env. Env production nằm ngoài repo ở iCloud `ENV production/<tên dự án>/`. Tên sản phẩm chỉ khai ở `brand.config.json`; `pnpm check:brand` chặn viết cứng.
