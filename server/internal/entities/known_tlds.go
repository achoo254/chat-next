package entities

// knownTLDs are the top-level domains that make a bare domain a link
// (Detect). It holds the country-code TLDs, except those that are also
// common file extensions (am cc md mk ml pl pm ps py rs sh so tf: "run.sh"
// and "README.md" stay text), and a short list of widely used generic TLDs.
// "file.txt", "v1.2" and "e.g" are not links because their last label is
// not here. The TypeScript twin (packages/core/src/entities/known-tlds.ts)
// holds the same list; both test suites compare theirs with the "tlds" of
// spec/entities/detect-vectors.json.
var knownTLDs = map[string]bool{
	"ac": true, "academy": true, "ad": true, "ae": true, "af": true, "ag": true, "agency": true, "ai": true,
	"al": true, "ao": true, "app": true, "aq": true, "ar": true, "art": true, "as": true, "asia": true,
	"at": true, "au": true, "aw": true, "ax": true, "az": true, "ba": true, "bank": true, "bb": true,
	"bd": true, "be": true, "bf": true, "bg": true, "bh": true, "bi": true, "biz": true, "bj": true,
	"blog": true, "bm": true, "bn": true, "bo": true, "br": true, "bs": true, "bt": true, "bw": true,
	"by": true, "bz": true, "ca": true, "cd": true, "center": true, "cf": true, "cg": true, "ch": true,
	"ci": true, "ck": true, "cl": true, "cloud": true, "club": true, "cm": true, "cn": true, "co": true,
	"com": true, "company": true, "cr": true, "cu": true, "cv": true, "cw": true, "cx": true, "cy": true,
	"cz": true, "de": true, "dev": true, "digital": true, "dj": true, "dk": true, "dm": true, "do": true,
	"dz": true, "ec": true, "edu": true, "ee": true, "eg": true, "er": true, "es": true, "et": true, "eu": true,
	"fi": true, "finance": true, "fj": true, "fk": true, "fm": true, "fo": true, "fr": true, "fun": true,
	"ga": true, "games": true, "gd": true, "ge": true, "gf": true, "gg": true, "gh": true, "gi": true,
	"gl": true, "global": true, "gm": true, "gn": true, "gov": true, "gp": true, "gq": true, "gr": true,
	"group": true, "gs": true, "gt": true, "gu": true, "gw": true, "gy": true, "hk": true, "hm": true,
	"hn": true, "hr": true, "ht": true, "hu": true, "id": true, "ie": true, "il": true, "im": true, "in": true,
	"info": true, "int": true, "io": true, "iq": true, "ir": true, "is": true, "it": true, "je": true,
	"jm": true, "jo": true, "jp": true, "ke": true, "kg": true, "kh": true, "ki": true, "km": true, "kn": true,
	"kp": true, "kr": true, "kw": true, "ky": true, "kz": true, "la": true, "lb": true, "lc": true, "li": true,
	"link": true, "live": true, "lk": true, "lr": true, "ls": true, "lt": true, "lu": true, "lv": true,
	"ly": true, "ma": true, "mc": true, "me": true, "media": true, "mg": true, "mh": true, "mil": true,
	"mm": true, "mn": true, "mo": true, "mobi": true, "mp": true, "mq": true, "mr": true, "ms": true,
	"mt": true, "mu": true, "music": true, "mv": true, "mw": true, "mx": true, "my": true, "mz": true,
	"na": true, "name": true, "nc": true, "ne": true, "net": true, "network": true, "news": true, "nf": true,
	"ng": true, "ni": true, "nl": true, "no": true, "np": true, "nr": true, "nu": true, "nz": true, "om": true,
	"online": true, "org": true, "pa": true, "page": true, "pe": true, "pf": true, "pg": true, "ph": true,
	"pk": true, "pn": true, "pr": true, "pro": true, "pt": true, "pw": true, "qa": true, "re": true, "ro": true,
	"ru": true, "rw": true, "sa": true, "sb": true, "sc": true, "sd": true, "se": true, "sg": true,
	"shop": true, "si": true, "site": true, "sk": true, "sl": true, "sm": true, "sn": true, "social": true,
	"software": true, "solutions": true, "space": true, "sr": true, "ss": true, "st": true, "store": true,
	"studio": true, "su": true, "sv": true, "sx": true, "sy": true, "systems": true, "sz": true, "tc": true,
	"td": true, "tech": true, "tg": true, "th": true, "tj": true, "tk": true, "tl": true, "tm": true,
	"tn": true, "to": true, "today": true, "tools": true, "top": true, "tr": true, "travel": true, "tt": true,
	"tv": true, "tw": true, "tz": true, "ua": true, "ug": true, "uk": true, "us": true, "uy": true, "uz": true,
	"va": true, "vc": true, "ve": true, "vg": true, "vi": true, "video": true, "vip": true, "vn": true,
	"vu": true, "website": true, "wf": true, "ws": true, "xyz": true, "ye": true, "yt": true, "za": true,
	"zm": true, "zone": true, "zw": true,
}
