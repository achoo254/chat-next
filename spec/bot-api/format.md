# Bot API text formatting (`parse_mode`)

`POST /bot/v1/messages` (and `sendMessage` in a webhook answer) takes either `entities` (ADR 0004: offsets and lengths in UTF-16 code units) or `parse_mode`, never both. With `parse_mode` the server parses `text` into plain text plus entities ([`server/internal/botapi/format`](../../server/internal/botapi/format)) and then checks the result like every message: at most 4096 characters (code points) and 100 entities, entities nested but never partially overlapping, links only to `http`, `https`, `mailto` and the app's own scheme.

Whichever way the entities arrive, the server then adds `url`, `email`, `mention` and `hashtag` entities for bare links (`https://…` or a domain with a known TLD such as `hoandat.com/abc`), e-mail addresses, `@username` and `#hashtag` in the text no entity covers (bold, italic, underline, strike and spoiler excepted), as Telegram does; nothing inside `code`, `pre` or a link is touched, and the bot's own entities stay as sent. Rules and vectors: [`server/internal/entities/detect.go`](../../server/internal/entities/detect.go), [`spec/entities/detect-vectors.json`](../entities/detect-vectors.json).

Parsing is strict. An unclosed or mis-nested marker, an unknown tag or attribute, or a link to another scheme answers `400 bad_request` with the byte offset of the problem; the server never guesses what was meant. Empty formatting (`**`) is dropped.

Later versions may add markers and tags; existing ones keep their meaning.

## `markdown`

| Write | Entity |
|---|---|
| `*text*` | `bold` |
| `_text_` | `italic` |
| `__text__` | `underline` |
| `~text~` | `strike` |
| `\|\|text\|\|` | `spoiler` |
| `` `text` `` | `code` |
| ```` ```lang⏎text``` ```` | `pre` with `language` = `lang`; the first line is the language only when it is a valid name (letters, digits, `_+-#.`, up to 32) followed by a line break |
| `[text](url)` | `text_link`; the text may hold other formatting |
| `\c` | the character `c` itself |

- Every one of `*`, `_`, `~`, `|`, `[`, `` ` `` and `\` that should appear as itself must be escaped with `\` (a lone `|`, and `]`, `(` and `)` outside a link, are plain text). For example `snake\_case` or `2 \* 3`.
- Formatting nests (`*bold _and italic_*`); the same marker cannot open inside itself, and markers must close in reverse order (`*a _b* c_` is an error). A link cannot contain a link.
- Inside `code` and code blocks only `` ` `` and `\` are special (`\`` and `\\`); everything else is literal.
- In a link URL, `\)` and `\\` stand for `)` and `\`.

## `html`

| Write | Entity |
|---|---|
| `<b>`, `<strong>` | `bold` |
| `<i>`, `<em>` | `italic` |
| `<u>`, `<ins>` | `underline` |
| `<s>`, `<strike>`, `<del>` | `strike` |
| `<span class="spoiler">`, `<spoiler>` | `spoiler` |
| `<code>` | `code` |
| `<pre>`, `<pre><code class="language-lang">` | `pre` (with `language`) |
| `<a href="url">` | `text_link` |

- Tag and attribute names are case-insensitive; attribute values are quoted with `"` or `'` (or unquoted without spaces). No other tag or attribute is accepted.
- Character references: `&lt;` `&gt;` `&amp;` `&quot;` `&apos;` and numeric `&#NN;` / `&#xHH;`. A literal `<` or `>` must be written `&lt;` / `&gt;`. A `&` that cannot read as a reference is itself, as in browsers (`AT&T`, `a & b`, `?a=1&b=2`); text shaped like a reference, `&` then letters, digits or `#` up to a `;`, must be one of the references above (`&nbsp;` or `&copy;` answer `400`), so write `&amp;` there. References work in attribute values too.
- Tags nest but must close in order (`<b><i>x</b></i>` is an error); the same formatting cannot open inside itself. No tag opens inside `<code>` or `<pre>`, except one `<code class="language-…">` right at the start of `<pre>`, which only names the language.
- Line breaks are written as line breaks (no `<br>`).

## Examples

| `parse_mode` | `text` | Result |
|---|---|---|
| `markdown` | `*Đơn* #42 đã giao, xem [chi tiết](https://shop.example/o/42)` | `Đơn #42 đã giao, xem chi tiết` with `bold` 0+3 and `text_link` 21+8 |
| `html` | `<b>Đơn</b> #42 &amp; <code>ok</code>` | `Đơn #42 & ok` with `bold` 0+3 and `code` 10+2 |
| `markdown` | `[x](javascript:alert(1))` | `400 bad_request` (scheme not allowed) |
