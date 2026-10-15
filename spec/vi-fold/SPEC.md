# Đặc tả fold tiếng Việt (ADR 0005)

Phiên bản đặc tả: **1**. Bảng Unicode chuẩn: **15.0** (bản mà Go `unicode`, `golang.org/x/text` và `github.com/rivo/uniseg` đang dùng).

Đặc tả này là nguồn sự thật cho việc chuẩn hoá văn bản phục vụ tìm kiếm. Hai bản cài đặt phải cho kết quả giống hệt nhau trên mọi vector trong [`test-vectors.json`](./test-vectors.json):

- TypeScript: [`packages/core/src/vifold`](../../packages/core/src/vifold/index.ts) (`fold`, `tokens`, `searchText`, `FTS5_TOKENIZE`)
- Go: [`server/internal/vifold`](../../server/internal/vifold/vifold.go) (`Fold`, `Tokens`, `SearchText`)

Mọi chuỗi được đánh chỉ mục và mọi truy vấn tìm kiếm đều phải đi qua `searchText` (mục 4). Đổi đặc tả nghĩa là tăng phiên bản ở trên và đánh chỉ mục lại toàn bộ dữ liệu tìm kiếm.

## 1. Đầu ra

| Hàm | Kết quả |
|---|---|
| `fold(text) → string` | Chuỗi đã chuẩn hoá theo mục 2. |
| `tokens(text) → string[]` | Các từ của `fold(text)` theo mục 3, giữ thứ tự xuất hiện, có thể lặp. |
| `searchText(text) → string` | `tokens(text)` nối bằng đúng một U+0020. Đây là chuỗi đưa cho search engine (mục 4). |

`fold` là idempotent: `fold(fold(x)) = fold(x)`.

## 2. Thuật toán `fold`

Thực hiện đúng thứ tự:

1. **NFC.**
2. **Chữ thường** theo default case mapping đầy đủ của Unicode, không theo locale (không có quy tắc riêng cho tiếng Thổ Nhĩ Kỳ hay Litva).
3. **NFD.**
4. **Bỏ mọi ký tự General Category `Mn`** (nonspacing mark). Bước này gỡ cả 5 dấu thanh (huyền U+0300, sắc U+0301, hỏi U+0309, ngã U+0303, nặng U+0323), dấu mũ U+0302 (â ê ô), dấu trăng U+0306 (ă) và dấu móc U+031B (ơ ư).
5. **`đ` (U+0111) → `d`.**
6. **Sigma cuối `ς` (U+03C2) → `σ` (U+03C3).**
7. **NFC.**
8. **Gộp khoảng trắng:** mỗi chuỗi liên tiếp ký tự có thuộc tính Unicode `White_Space` thành một U+0020, rồi bỏ khoảng trắng ở đầu và cuối.

### Vì sao `đ` cần bước riêng

`đ`/`Đ` là chữ cái độc lập (U+0111/U+0110), không có dạng phân tách chính tắc thành `d` + dấu, nên NFD và bước bỏ `Mn` không chạm tới nó. SQLite FTS5 với `remove_diacritics 2` cũng không fold `đ` (đã kiểm chứng bằng `sqlite3`). Không có bước 5 thì "Đà Nẵng" không khớp với truy vấn "da nang". Chữ hoa `Đ` được xử lý vì bước 2 đã đổi nó thành `đ`.

### Vì sao có bước sigma

JavaScript `toLowerCase()` áp dụng quy tắc ngữ cảnh Final_Sigma: `Σ` ở cuối từ thành `ς`, ở giữa từ thành `σ`. Go `strings.ToLower` dùng simple case mapping nên luôn ra `σ`. Bước 6 đưa cả hai về `σ`, đồng thời giúp truy vấn gõ `σ` khớp với văn bản có `ς`.

### Full mapping và simple mapping cho kết quả như nhau

Ngoài Final_Sigma, mapping chữ thường đầy đủ (SpecialCasing, không theo locale) chỉ khác simple mapping ở một ký tự: `İ` (U+0130) → `i` + U+0307. U+0307 là `Mn` nên bị bỏ ở bước 4, cho kết quả `i` giống simple mapping. Vì vậy Go được phép dùng `strings.ToLower`. Hệ quả: `İ` → `i`, còn `ı` (U+0131, i không chấm) giữ nguyên vì không có locale Thổ Nhĩ Kỳ.

### Ví dụ

| Đầu vào | `fold` |
|---|---|
| `Người đẹp Đà Nẵng` | `nguoi dep da nang` |
| `Ưu đãi` | `uu dai` |
| `Ăn` | `an` |
| `ĐẠI HỌC QUỐC GIA` | `dai hoc quoc gia` |
| `Ưu` + U+00A0 + `đãi` | `uu dai` |
| `ΟΔΟΣ` | `οδοσ` |
| `İstanbul` | `istanbul` |

## 3. Thuật toán `tokens`

Tách `fold(text)` theo ranh giới từ của **UAX #29** (quy tắc mặc định, không dùng từ điển, không theo locale), sửa bởi tailoring "lớp cô lập" dưới đây, rồi **chỉ giữ đoạn có ít nhất một ký tự General Category `L*` hoặc `N*`**.

### 3.1. Ký tự gốc

Khi xét ranh giới, ký tự **gắn vào ký tự trước** (quy tắc WB4) được bỏ qua: Grapheme_Extend (`Mn`, `Me`, Other_Grapheme_Extend), `Mc`, Emoji_Modifier (U+1F3FB–U+1F3FF) và `Cf` trừ U+200B. Ký tự đầu tiên của chuỗi luôn là ký tự gốc. Các ký tự còn lại là **ký tự gốc**.

### 3.2. Lớp cô lập

| Lớp | Thành phần |
|---|---|
| Katakana | Word_Break=Katakana (U+3031–3035, U+309B–309C, U+30A0–30FA, U+30FC–30FF, U+31F0–31FF, U+32D0–32FE, U+3300–3357, U+FF66–FF9D, U+1AFF0–1AFF3, U+1AFF5–1AFFB, U+1AFFD–1AFFE, U+1B000, U+1B120–1B122, U+1B155, U+1B164–1B167) |
| Hangul | Script=Hangul |
| Từng ký tự | Script ∈ {Han, Hiragana, Thai, Lao, Khmer, Myanmar, Tai_Le, New_Tai_Lue, Tai_Tham, Tai_Viet, Ahom}, trừ `Nd` |

Thứ tự xét: Katakana, rồi Hangul, rồi Từng ký tự.

### 3.3. Tailoring

Với mỗi cặp ký tự gốc liền nhau `P` rồi `C`, ranh giới nằm ngay trước `C`:

1. Nếu `P` hoặc `C` thuộc một lớp cô lập: **nối** khi `P` và `C` cùng lớp Katakana hoặc cùng lớp Hangul; **tách** trong mọi trường hợp khác. Quy tắc mặc định không được xét ở vị trí này.
2. Nếu `C` thuộc Word_Break MidLetter, MidNum, MidNumLet, Single_Quote hoặc Double_Quote (bảng ở `MIDDLE`/`middle` trong mã nguồn), và ký tự gốc trước hoặc sau nó thuộc lớp cô lập: **tách** cả trước lẫn sau `C`. Các ký tự này chỉ nối chữ/số hai bên qua WB6, WB7, WB11, WB12, nên khi một bên là ký tự cô lập thì chúng đứng riêng.
3. Các vị trí khác: theo UAX #29.

Lý do: ICU (nền của `Intl.Segmenter`) tách tiếng Trung, Nhật, Thái, Lào, Khmer, Miến Điện bằng từ điển, ghép các chữ Đông Nam Á với chữ Latin, và tách Hangul khỏi chữ Latin. UAX #29 thuần thì ngược lại ở cả ba điểm. Tailoring chọn một hành vi xác định cho mọi vị trí có ký tự thuộc các hệ chữ này, để TS (ICU) và Go (uniseg) cho cùng kết quả. Hệ quả cho tìm kiếm: chữ Hán, Hiragana và chữ Đông Nam Á được đánh chỉ mục theo từng ký tự; một cụm Katakana hoặc Hangul liền nhau là một token.

`Intl.Segmenter` trong TS được tạo với locale cố định `"en"` để không phụ thuộc locale của thiết bị.

### Ví dụ

| Đầu vào | `tokens` |
|---|---|
| `Người đẹp Đà Nẵng` | `["nguoi", "dep", "da", "nang"]` |
| `Giá: 1.250.000₫` | `["gia", "1.250.000"]` |
| `don't stop` | `["don't", "stop"]` |
| `Tuyệt 👍🏽 lắm` | `["tuyet", "lam"]` |
| `日本語のテキスト` | `["日", "本", "語", "の", "テキスト"]` |
| `한국어abc 123한글` | `["한국어", "abc", "123", "한글"]` |
| `o'한 d:ไทย` | `["o", "한", "d", "ไ", "ท", "ย"]` |

## 4. Dùng với search engine

Search engine không nhận danh sách token mà tự tách lại chuỗi được đưa vào. Tách lại `fold(text)` thì không ra `tokens(text)`: FTS5 `unicode61` mặc định tách `1.250.000` ở dấu chấm, tách `don't` ở dấu nháy, nhưng giữ `日本語` thành một token (đã kiểm chứng bằng `sqlite3`; index `fold` của bộ vector bằng `unicode61` mặc định thì 39 vector lệch). Vì vậy:

- **Cột được đánh chỉ mục và mọi truy vấn đều dùng `searchText(text)`**, không dùng `fold(text)` hay văn bản gốc. `searchText` chỉ chứa nội dung token và U+0020: dấu câu, emoji và mọi ký tự nằm giữa các token đã bị bỏ, và văn bản đã fold không còn khoảng trắng nào khác (bước 8 của `fold`).
- Engine phải được cấu hình sao cho token của `searchText(x)` đúng bằng `tokens(x)`: chỉ U+0020 là ký tự tách, mọi ký tự khác là ký tự token.

### 4.1. SQLite FTS5 (DB local)

Bảng FTS5 dùng đúng tokenizer sau (hằng `FTS5_TOKENIZE` trong TS):

```sql
CREATE VIRTUAL TABLE message_fts USING fts5(
  body,
  tokenize = "unicode61 remove_diacritics 0 categories 'L* N* M* P* S* C*' tokenchars '<U+180E>'"
);
```

`<U+180E>` là chính ký tự U+180E (MONGOLIAN VOWEL SEPARATOR), không phải chuỗi chữ.

- `remove_diacritics 0`: `fold` đã bỏ dấu; FTS5 không được bỏ thêm.
- `categories 'L* N* M* P* S* C*'`: mọi General Category trừ `Z*` là ký tự token. Danh sách ký tự có thể nằm trong một token được dẫn ra từ chính bản cài đặt (dò mọi code point qua `tokens` ở các ngữ cảnh: đầu/cuối chuỗi, chữ Latin, chữ số, Hebrew, Katakana, Hangul, Hán, Thái, `_` và sau ZWJ), rồi so với cách `unicode61` mặc định phân loại. Kết quả: **1765 code point** có thể nằm trong token nhưng `unicode61` mặc định coi là ký tự tách, gồm `Po` (`.` `,` `'` `"` `:` `;` `·` `٫` `‼` ...), `Pc` (`_` ...), `Pd`, `Pi`/`Pf` (`‘` `’`), `Sk`, `Sm`, `So` (emoji sau ZWJ, chữ khoanh tròn), `Mc`, `Me`, `Cf`. Liệt kê chừng đó ký tự trong `tokenchars` vừa khó đọc vừa vỡ mỗi khi Unicode thêm emoji hay dấu `Mc` mới, nên đặc tả dùng `categories`. Cách này an toàn vì `searchText` không chứa ký tự nào nằm ngoài token ngoài U+0020.
- `tokenchars '<U+180E>'`: bảng của SQLite (Unicode 6.1) xếp U+180E vào `Zs`, còn Unicode hiện hành xếp vào `Cf` (không phải `White_Space`), nên `fold` giữ nó và nó có thể nằm trong token. Sau khi thêm, các ký tự tách còn lại đúng bằng các ký tự `White_Space` mà bảng SQLite xếp vào `Z*`.
- Quy tắc trích dẫn: giá trị `tokenize` là một chuỗi SQL bọc bằng `"`, mỗi `"` bên trong viết thành `""`. Đối số của tokenizer bọc bằng `'`, mỗi `'` bên trong viết thành `''`. Ví dụ `tokenize = "unicode61 tokenchars '''.""'"` cho các ký tự token `'`, `.` và `"` (đã kiểm chứng). Cấu hình ở trên không cần `'` hay `"` trong `tokenchars` vì `P*` đã gồm chúng.

Truy vấn: lấy `searchText(query)`, tách theo U+0020, đặt mỗi token vào biểu thức `MATCH` dưới dạng chuỗi FTS5 `"..."` (mỗi `"` trong token viết thành `""`), nối các chuỗi bằng khoảng trắng (AND ngầm định). Không đưa văn bản người dùng gõ trực tiếp vào `MATCH`.

Kiểm chứng: [`packages/core/test/vifold-fts5.test.ts`](../../packages/core/test/vifold-fts5.test.ts) chạy `node:sqlite` (SQLite 3.53.1 trong Node 24.18) với ba bài: index `searchText` của mọi vector và đòi token FTS5 (bảng `fts5vocab` kiểu `instance`) bằng `tokens`; tìm lại mọi vector bằng truy vấn dựng như trên; quét mọi code point không phải `White_Space` để chắc chắn nó là ký tự token dưới cấu hình này. Mỗi bản SQLite đóng gói cho web, iOS, Android và desktop phải qua cùng bài kiểm này trước khi dùng (cần FTS5 và tuỳ chọn `categories` của `unicode61`).

Sai khác còn lại (đã đo trên toàn bộ code point có thể nằm trong token): `unicode61` tự gập chữ theo bảng Unicode 6.1 và đổi 9 ký tự mà `fold` giữ nguyên: U+00B5 `µ`→`μ`, U+017F `ſ`→`s`, U+03D0 `ϐ`→`β`, U+03D1 `ϑ`→`θ`, U+03D5 `ϕ`→`φ`, U+03D6 `ϖ`→`π`, U+03F0 `ϰ`→`κ`, U+03F1 `ϱ`→`ρ`, U+03F5 `ϵ`→`ε`. Term FTS5 của token chứa các ký tự này khác chuỗi trong `tokens`, nhưng index và truy vấn đi qua cùng tokenizer nên việc khớp không bị ảnh hưởng. Bộ vector không chứa các ký tự này.

### 4.2. Postgres (server)

Server lưu `Tokens` của chữ, chú thích và tên file thành tsvector bằng `array_to_tsvector(string_to_array(SearchText, ' '))`: không qua parser hay từ điển của Postgres, nên lexeme đúng bằng token (mỗi token cắt còn tối đa 255 byte, vì lexeme của tsvector có giới hạn độ dài). Truy vấn là tsquery dạng nhập (ép kiểu `::tsquery`, không dùng `to_tsquery`) của `Tokens(query)`, mỗi token đặt trong nháy đơn, token cuối khớp tiền tố (`:*`). Kiểm chứng: [`server/internal/search/postgres_test.go`](../../server/internal/search/postgres_test.go) (`TestLexemesFollowSharedVectors`) đòi lexeme Postgres lưu bằng `tokens` và truy vấn của mỗi vector tìm lại được chính nó trên mọi vector. Nếu sau này thay Postgres bằng search engine khác (Meilisearch, OpenSearch), engine đó phải được cấu hình sao cho token của nó khớp `tokens` và qua cùng bài kiểm này.

### 4.3. Phiên bản fold trong DB local

`tokens` phụ thuộc bảng Unicode và ICU của runtime (`Intl.Segmenter`, regex `\p{…}`), và ICU của WebView được cập nhật theo hệ điều hành chứ không theo app. DB local lưu một chuỗi phiên bản fold gồm:

- phiên bản đặc tả (ở đầu file này);
- phiên bản Unicode/ICU của runtime: Node và Electron dùng `process.versions.unicode` và `process.versions.icu`; web và WebView không có API nào trả về phiên bản ICU (`Intl` cũng không), nên dùng phiên bản engine trong user agent và chấp nhận dựng lại thừa khi engine cập nhật; runtime native xác định khi có app native.

Khi mở DB, nếu chuỗi đã lưu khác chuỗi hiện tại thì tính lại `searchText` cho mọi dòng và dựng lại bảng FTS5 trước khi cho tìm kiếm, rồi lưu chuỗi mới.

## 5. Hệ quả đã biết

- Mọi `Mn` đều bị bỏ, không riêng tiếng Việt: dấu dakuten tiếng Nhật (`ガ` → `カ`), dấu nguyên âm `Mn` của chữ Devanagari (`नमस्ते` → `नमसत`), variation selector U+FE0F của emoji.
- Chỉ dùng NFC/NFD, không dùng NFKC: chữ toàn khổ (`Ｆ` → `ｆ`), chữ ghép `ﬁ` và chữ khoanh tròn (`Ⓐ` → `ⓐ`) không được đưa về ASCII. Chữ khoanh tròn thuộc `So` nên không tạo token.
- `ß` giữ nguyên (`ẞ` → `ß`); `STRASSE` và `Straße` không khớp nhau.
- `ø`, `ł`, `æ` không bị fold (không có dạng phân tách chính tắc); chỉ `đ` được xử lý riêng vì đó là chữ tiếng Việt.
- Ký tự `Cf` (ZWJ, U+00AD, dấu điều khiển hướng chữ) và `Cc` không phải khoảng trắng được giữ trong `fold`.

## 6. Phạm vi đồng nhất và các trường hợp loại trừ

Hai bản cài đặt chỉ được đảm bảo giống nhau trong phạm vi sau; test vector không chứa các trường hợp ngoài phạm vi.

- **Ký tự được gán sau Unicode 15.0.** Go dùng bảng 15.0, trình duyệt và Node dùng bản mới hơn (Node 24: Unicode 17). Khi Go nâng bảng (x/text đã có bảng 17.0 cho Go ≥ 1.27) thì xét lại phạm vi này.
- **Ký tự Prepend thuộc `Cf`**: U+0600–0605, U+06DD, U+070F, U+0890–0891, U+08E2, U+110BD, U+110CD (dấu số Ả Rập, Syriac, Kaithi). uniseg (Unicode 15.0) coi chúng là Format, gắn vào ký tự trước; ICU 78 thì không. Kiểm thử đối chiếu 200.000 chuỗi ngẫu nhiên giữa TS và Go chỉ lệch ở các chuỗi chứa nhóm ký tự này. Chúng hầu như không xuất hiện trong tin nhắn.
- **Chuỗi không hợp lệ**: surrogate lẻ trong JS, byte UTF-8 hỏng trong Go. Go thay byte hỏng bằng U+FFFD; JS giữ surrogate lẻ. Văn bản đi qua protobuf luôn là UTF-8 hợp lệ.

## 7. Test vector

`test-vectors.json` là mảng `{ "input": string, "fold": string, "tokens": string[] }` (hiện có 390 vector). Nhóm vector:

- 12 nguyên âm `a ă â e ê i o ô ơ u ư y` × (không dấu + 5 thanh) × chữ thường/chữ hoa;
- câu tiếng Việt, cùng các câu đó ở dạng NFD và chữ hoa; `đ`/`Đ`;
- chuỗi lẫn tiếng Anh, chữ số, dấu câu, URL, email;
- emoji: skin tone, chuỗi ZWJ, cờ, keycap;
- khoảng trắng: tab, xuống dòng, CRLF, NBSP U+00A0, U+0085, U+2028/2029, U+3000, U+FEFF (không phải khoảng trắng);
- tiếng Hy Lạp có sigma cuối, `İ` tiếng Thổ Nhĩ Kỳ, Cyrillic, Do Thái, Ả Rập, Devanagari;
- tiếng Trung, Nhật (Kanji, Hiragana, Katakana toàn khổ và bán khổ), Hàn, Thái, Lào, Khmer, Miến Điện, cùng các trường hợp tailoring ở mục 3.3.

Tạo lại bằng `node spec/vi-fold/generate-vectors.mjs`. Script này chỉ dùng built-in của Node và tự kiểm tra ba ví dụ bắt buộc, nhưng **không độc lập với bản TS**: nó dùng cùng `Intl.Segmenter`, cùng bảng regex và cùng cách tailoring như `packages/core`, nên một lỗi chung của hai bên sẽ đi thẳng vào vector. Phép kiểm độc lập là bản Go (uniseg và `golang.org/x/text`) và bài kiểm FTS5 ở mục 4.1. Sau khi tạo lại, chạy cả hai bộ test:

```sh
cd packages/core && pnpm exec vitest run
cd server && go test ./internal/vifold/...
```

Cả hai bộ test còn kiểm `searchText(input) = tokens.join(" ")` trên mọi vector.

Không sửa tay giá trị mong đợi trong `test-vectors.json`. Nếu TS và Go lệch nhau ở một vector, sửa đặc tả hoặc bản cài đặt. Chỉ được bỏ vector khi trường hợp đó thật sự nằm ngoài phạm vi, và phải ghi vào mục 6.
