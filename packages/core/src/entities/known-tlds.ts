// Top-level domains that make a bare domain a link (detectEntities): the
// country-code TLDs, except those that are also common file extensions
// (am cc md mk ml pl pm ps py rs sh so tf: "run.sh" and "README.md" stay
// text), and a short list of widely used generic TLDs. The Go twin is
// server/internal/entities/known_tlds.go; both test suites compare their
// list with the "tlds" of spec/entities/detect-vectors.json.
export const KNOWN_TLDS: ReadonlySet<string> = new Set([
	"ac", "academy", "ad", "ae", "af", "ag", "agency", "ai", "al", "ao", "app", "aq", "ar", "art", "as", "asia", "at",
	"au", "aw", "ax", "az", "ba", "bank", "bb", "bd", "be", "bf", "bg", "bh", "bi", "biz", "bj", "blog", "bm", "bn", "bo",
	"br", "bs", "bt", "bw", "by", "bz", "ca", "cd", "center", "cf", "cg", "ch", "ci", "ck", "cl", "cloud", "club", "cm",
	"cn", "co", "com", "company", "cr", "cu", "cv", "cw", "cx", "cy", "cz", "de", "dev", "digital", "dj", "dk", "dm",
	"do", "dz", "ec", "edu", "ee", "eg", "er", "es", "et", "eu", "fi", "finance", "fj", "fk", "fm", "fo", "fr", "fun",
	"ga", "games", "gd", "ge", "gf", "gg", "gh", "gi", "gl", "global", "gm", "gn", "gov", "gp", "gq", "gr", "group", "gs",
	"gt", "gu", "gw", "gy", "hk", "hm", "hn", "hr", "ht", "hu", "id", "ie", "il", "im", "in", "info", "int", "io", "iq",
	"ir", "is", "it", "je", "jm", "jo", "jp", "ke", "kg", "kh", "ki", "km", "kn", "kp", "kr", "kw", "ky", "kz", "la",
	"lb", "lc", "li", "link", "live", "lk", "lr", "ls", "lt", "lu", "lv", "ly", "ma", "mc", "me", "media", "mg", "mh",
	"mil", "mm", "mn", "mo", "mobi", "mp", "mq", "mr", "ms", "mt", "mu", "music", "mv", "mw", "mx", "my", "mz", "na",
	"name", "nc", "ne", "net", "network", "news", "nf", "ng", "ni", "nl", "no", "np", "nr", "nu", "nz", "om", "online",
	"org", "pa", "page", "pe", "pf", "pg", "ph", "pk", "pn", "pr", "pro", "pt", "pw", "qa", "re", "ro", "ru", "rw", "sa",
	"sb", "sc", "sd", "se", "sg", "shop", "si", "site", "sk", "sl", "sm", "sn", "social", "software", "solutions",
	"space", "sr", "ss", "st", "store", "studio", "su", "sv", "sx", "sy", "systems", "sz", "tc", "td", "tech", "tg", "th",
	"tj", "tk", "tl", "tm", "tn", "to", "today", "tools", "top", "tr", "travel", "tt", "tv", "tw", "tz", "ua", "ug", "uk",
	"us", "uy", "uz", "va", "vc", "ve", "vg", "vi", "video", "vip", "vn", "vu", "website", "wf", "ws", "xyz", "ye", "yt",
	"za", "zm", "zone", "zw",
]);
