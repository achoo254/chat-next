#!/usr/bin/env node
// Regenerates spec/vi-fold/test-vectors.json from the inputs below.
// This implementation of SPEC.md uses Node built-ins only, but it is not
// independent of packages/core: it relies on the same Intl.Segmenter, regex
// tables and tailoring, so a mistake shared with the TS code flows into the
// vectors. The independent checks are the Go implementation (uniseg and
// golang.org/x/text) and the FTS5 parity test in packages/core.
// Run: node spec/vi-fold/generate-vectors.mjs

import { writeFileSync } from "node:fs";
import { join } from "node:path";

// --- Reference algorithm (SPEC.md, sections 2 and 3) -----------------------

function referenceFold(text) {
	let s = text.normalize("NFC"); // step 1
	s = s.toLowerCase(); // step 2: default full case mapping, no locale
	s = s.normalize("NFD"); // step 3
	s = s.replace(/\p{Mn}/gu, ""); // step 4
	s = s.replaceAll("\u0111", "d"); // step 5: đ
	s = s.replaceAll("\u03C2", "\u03C3"); // step 6: ς to σ
	s = s.normalize("NFC"); // step 7
	s = s.replace(/\p{White_Space}+/gu, " "); // step 8: collapse
	if (s.startsWith(" ")) s = s.slice(1); // step 8: trim
	if (s.endsWith(" ")) s = s.slice(0, -1);
	return s;
}

// Tokenization (SPEC.md section 3): Intl.Segmenter gives the UAX #29 default
// boundaries; the isolating-class tailoring then decides every position next
// to a Katakana, Hangul or single-character-script code point.
const KATAKANA =
	/[\u3031-\u3035\u309B\u309C\u30A0-\u30FA\u30FC-\u30FF\u31F0-\u31FF\u32D0-\u32FE\u3300-\u3357\uFF66-\uFF9D\u{1AFF0}-\u{1AFF3}\u{1AFF5}-\u{1AFFB}\u{1AFFD}\u{1AFFE}\u{1B000}\u{1B120}-\u{1B122}\u{1B155}\u{1B164}-\u{1B167}]/u;
const HANGUL = /\p{sc=Hangul}/u;
const SINGLE =
	/(?!\p{Nd})[\p{sc=Han}\p{sc=Hiragana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}\p{sc=Tai_Le}\p{sc=New_Tai_Lue}\p{sc=Tai_Tham}\p{sc=Tai_Viet}\p{sc=Ahom}]/u;
const ATTACHED = /[\p{Grapheme_Extend}\p{Mc}\p{Emoji_Modifier}\p{Cf}]/u;
const MIDDLE =
	/[\u0022\u0027\u002C\u002E\u003A\u003B\u00B7\u037E\u0387\u055F\u0589\u05F4\u060C\u060D\u066C\u07F8\u2018\u2019\u2024\u2027\u2044\uFE10\uFE13\uFE14\uFE50\uFE52\uFE54\uFE55\uFF07\uFF0C\uFF0E\uFF1A\uFF1B]/u;

const classOf = (ch) => (KATAKANA.test(ch) ? "K" : HANGUL.test(ch) ? "H" : SINGLE.test(ch) ? "S" : "");

function referenceTokens(text) {
	const folded = referenceFold(text);
	const cuts = new Set([folded.length]);
	for (const part of new Intl.Segmenter("en", { granularity: "word" }).segment(folded)) {
		cuts.add(part.index);
	}
	// Base characters: everything that does not attach to its predecessor.
	const bases = [];
	let at = 0;
	for (const ch of folded) {
		if (bases.length === 0 || ch === "\u200B" || !ATTACHED.test(ch)) {
			bases.push({ at, cls: classOf(ch), mid: MIDDLE.test(ch) });
		}
		at += ch.length;
	}
	for (let i = 1; i < bases.length; i++) {
		const prev = bases[i - 1];
		const cur = bases[i];
		const next = bases[i + 1];
		if (prev.cls !== "" || cur.cls !== "") {
			if (prev.cls === cur.cls && cur.cls !== "S") cuts.delete(cur.at);
			else cuts.add(cur.at);
		}
		if (cur.mid && (prev.cls !== "" || (next !== undefined && next.cls !== ""))) {
			cuts.add(cur.at);
			if (next !== undefined) cuts.add(next.at);
		}
	}
	const ordered = [...cuts].filter((c) => c > 0).sort((a, b) => a - b);
	const words = [];
	let start = 0;
	for (const end of ordered) {
		words.push(folded.slice(start, end));
		start = end;
	}
	return words.filter((w) => /[\p{L}\p{N}]/u.test(w));
}

// --- Inputs ------------------------------------------------------------------

const VOWELS = [
	["a", ""],
	["a", "\u0306"], // ă
	["a", "\u0302"], // â
	["e", ""],
	["e", "\u0302"], // ê
	["i", ""],
	["o", ""],
	["o", "\u0302"], // ô
	["o", "\u031B"], // ơ
	["u", ""],
	["u", "\u031B"], // ư
	["y", ""],
];
// No tone, huyền, sắc, hỏi, ngã, nặng.
const TONES = ["", "\u0300", "\u0301", "\u0309", "\u0303", "\u0323"];

const nfd = (s) => s.normalize("NFD");

const inputs = [];
for (const [base, shape] of VOWELS) {
	for (const tone of TONES) {
		const lower = (base + shape + tone).normalize("NFC");
		inputs.push(lower, lower.toUpperCase());
	}
}

const PHRASES = [
	"Người đẹp Đà Nẵng",
	"Ưu đãi",
	"Ăn",
	"Đ",
	"đ",
	"Đường Đinh Tiên Hoàng",
	"Thành phố Hồ Chí Minh",
	"Hà Nội mùa thu",
	"Việt Nam",
	"Tiếng Việt có dấu",
	"Nghiêng ngả",
	"Khuyến mãi đặc biệt",
	"Phở bò tái",
	"Bánh mì Sài Gòn",
	"Cà phê sữa đá",
	"Huế thương",
	"Quảng Ngãi",
	"Đắk Lắk",
	"Ơn giời cậu đây rồi",
	"Ừ, được thôi!",
	"Gửi lời chào đến mọi người",
	"Tôi yêu Việt Nam",
	"Chúc mừng năm mới",
	"Hẹn gặp lại",
	"Xin chào",
	"Cảm ơn bạn rất nhiều",
	"Thứ Hai, ngày 14 tháng 10 năm 2026",
	"Nguyễn Văn Ánh",
	"Trần Thị Thuỷ",
	"Lê Thị Thủy",
	"Phạm Ngọc Thạch",
	"Đặng Thị Điệp",
	"Võ Nguyên Giáp",
	"Hoàng Sa, Trường Sa",
	"Ngoằn ngoèo",
	"Khuỷu tay",
	"Nguyễn Ái Quốc",
	"Ngưỡng cửa",
	"Thuở ấy",
	"Tuyệt vời ông mặt trời",
	"Hướng dẫn sử dụng",
	"Giỏ hàng (3 sản phẩm)",
	"Giá: 1.250.000₫",
	"Tổng cộng 99,5%",
	"Mã đơn #DH-2026-0001",
	"Email: hỗ.trợ@ví-dụ.vn",
	"https://ví-dụ.vn/đường-dẫn?q=tìm+kiếm",
	"Gọi 0901 234 567 nhé",
	"10:30 sáng mai",
	"3.14 và 2,71",
	"Tôi đi học lúc 7h30",
	"iPhone 17 Pro Max giá bao nhiêu?",
	"Họp team lúc 9am",
	"Deadline là thứ Sáu",
	"Check-in khách sạn",
	"OK em nhé",
	"ĐẠI HỌC QUỐC GIA HÀ NỘI",
	"CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM",
	"ƯU TIÊN",
	"ĂN UỐNG",
	"ÂM NHẠC",
	"ÊM ĐỀM",
	"ÔNG BÀ",
	"ƠI",
	"Hòa hay Hoà",
	"Thúy hay Thuý",
	"don't stop",
	"e.g. u.s.a",
	"foo_bar baz-qux",
	"example.com",
	"Hello, World!",
	"The quick brown fox jumps over the lazy dog",
	"naïve café résumé",
	"Straße STRASSE ẞ",
	"Ångström",
	"ÆØÅ æøå",
	"Łódź",
	"Ñandú",
	"Ça va?",
	"Œuvre",
	"ﬁle",
];

for (const phrase of PHRASES) {
	inputs.push(phrase);
}
// Same phrases in decomposed form, and a few in upper case.
for (const phrase of PHRASES.slice(0, 40)) {
	inputs.push(nfd(phrase));
}
for (const phrase of PHRASES.slice(5, 25)) {
	inputs.push(phrase.toUpperCase());
}

const MISC = [
	"",
	" ",
	"\t\n\r",
	"   Người   đẹp   ",
	"Người\tđẹp\nĐà\r\nNẵng",
	"Ưu\u00A0đãi",
	"Ưu\u2003đãi\u3000Đà Nẵng",
	"a\u0085b",
	"a\u2028b\u2029c",
	"a\u000Bb\u000Cc",
	"a\u202Fb\u205Fc",
	"\u00A0\u00A0leading and trailing\u00A0",
	"a\u200Bb",
	"a\u200Db",
	"a\uFEFFb",
	"\uFEFFbom",
	"...",
	"!!!???",
	"--- *** ---",
	"(Đà Lạt)",
	"«Hà Nội»",
	"“Sài Gòn”",
	"tag:#hànội",
	"@nguyễn_văn_a",
	"a:b",
	"a.b.c.",
	"1,000,000",
	"123",
	"0123456789",
	"v1.2.3",
	"COVID-19",
	"H2O",
	"x²",
	"½ cái bánh",
	"Ⅻ",
	"١٢٣",
	"๑๒๓",
	"👍",
	"👍🏽",
	"Tuyệt 👍🏽 lắm",
	"👨\u200D👩\u200D👧\u200D👦 gia đình",
	"👩🏻\u200D💻 lập trình",
	"🇻🇳 Việt Nam 🇻🇳",
	"❤\uFE0F yêu",
	"1\uFE0F\u20E3 một",
	"#\uFE0F\u20E3",
	"😀😃😄",
	"Đà Nẵng🏖\uFE0Fbiển",
	"ok👌",
	"ΟΔΟΣ",
	"Οδός",
	"ὅσος",
	"ΣΊΣΥΦΟΣ",
	"σοφός ς",
	"Αθήνα",
	"İstanbul",
	"İ",
	"ISTANBUL ıstanbul",
	"DİYARBAKIR",
	"Москва",
	"Ёлка",
	"Київ",
	"שלום עולם",
	"مرحبا بالعالم",
	"नमस्ते",
	"日本語のテキスト",
	"中文分词测试",
	"東京タワー",
	"ラーメン",
	"カタカナテスト",
	"ガギグゲゴ",
	"ﾊﾝｶｸｶﾀｶﾅ",
	"ひらがな",
	"한국어 텍스트",
	"서울",
	"ภาษาไทย",
	"abc日本",
	"Việt Nam 越南",
	"한국어abc 123한글",
	"한_국 한'국 대한민국만세",
	"서울🏽시",
	"abcไทย123",
	"ไทย_a",
	"a_カタ カタ_a",
	"日本_a",
	"のーカタ",
	"ｶﾞｷﾞ",
	"မြန်မာ",
	"ខ្មែរ",
	"ລາວ",
	"o'한 d:ไทย ไทย'a t‘ภ 3,中",
	"Ⓐⓑⓒ",
	"ＦＵＬＬＷＩＤＴＨ",
	"Ǆemal ǅemal",
	"ǈ ǋ",
];

for (const item of MISC) {
	inputs.push(item);
}
// Decomposed and mixed-normalization inputs that differ from their NFC form.
inputs.push(
	"Nguye\u0302\u0303n",
	"Nguye\u0303\u0302n",
	"ư\u0301",
	"u\u031B\u0301",
	"U\u031B\u0300",
	"a\u0306\u0323",
	"A\u0323\u0306",
	"o\u031B\u0309",
	"D\u0335",
	"e\u0301\u0301",
	"\u0300leading mark",
	"x\u0336\u0336",
);

// --- Output ------------------------------------------------------------------

const seen = new Set();
const vectors = [];
for (const input of inputs) {
	if (seen.has(input)) continue;
	seen.add(input);
	vectors.push({ input, fold: referenceFold(input), tokens: referenceTokens(input) });
}

const assertFold = (input, expected) => {
	const actual = referenceFold(input);
	if (actual !== expected) {
		throw new Error(`fold(${JSON.stringify(input)}) = ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
	}
};
assertFold("Người đẹp Đà Nẵng", "nguoi dep da nang");
assertFold("Ưu đãi", "uu dai");
assertFold("Ăn", "an");

const body = vectors.map((v) => `  ${JSON.stringify(v)}`).join(",\n");
const target = join(import.meta.dirname, "test-vectors.json");
writeFileSync(target, `[\n${body}\n]\n`);
console.log(`wrote ${vectors.length} vectors to ${target}`);
