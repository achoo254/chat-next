// What the residents say to each other, in Vietnamese (no model runs: the
// lines are written here and filled with facts the office already has,
// office-talk-facts.ts). A talk takes up to four lines in turn: the one who
// walked over opens, the other replies, the opener follows up, the other
// closes, sometimes with a line of their own character (QUIRKS, by agent
// type). Slots in braces take only normalized facts: a name, the kind and
// room of the last work, counts, durations, the meal, the hour; never a
// command, a path or a file name. A line whose slot has no fact is skipped.
import type { CastKey } from "./office-cast.ts";

/** The facts a line may name. */
export type DialogueSlot = "ten" | "viec" | "phong" | "lau" | "lan" | "cho" | "xong" | "dat" | "truot" | "bua" | "gio";

export const DIALOGUE_SLOTS: readonly DialogueSlot[] = ["ten", "viec", "phong", "lau", "lan", "cho", "xong", "dat", "truot", "bua", "gio"];

export type TalkTopic = "workDone" | "testsPass" | "testsFail" | "approvalWait" | "meal" | "gym" | "tv" | "evening" | "goodNight" | "morning" | "smallTalk";

export interface TopicLines {
	/** The visitor opens (to the host: {ten} is the host). */
	readonly opener: readonly string[];
	/** The host replies ({ten} is the visitor). */
	readonly reply: readonly string[];
	/** The visitor follows up. */
	readonly follow: readonly string[];
	/** The host closes. */
	readonly close: readonly string[];
}

export const DIALOGUE_VI: Readonly<Record<TalkTopic, TopicLines>> = {
	workDone: {
		opener: ["Vừa {viec} {phong} xong, mất {lau} đấy {ten} ạ.", "{ten} ơi, mình mới {viec} {phong} về, hôm nay là lần thứ {lan} rồi.", "Xong một vụ {viec} {phong}, nhẹ cả người!", "Hú hồn, {viec} {phong} mất {lau} mới xong."],
		reply: ["Giỏi thế! Nghỉ tay chút đi.", "Nghe vất vả ghê, uống miếng nước đã.", "Nhanh vậy à? Phục bạn luôn.", "Thế là gọn một việc rồi, tuyệt!"],
		follow: ["Ừ, đợi việc tiếp theo thôi.", "Chắc lát nữa còn việc nữa đấy."],
		close: ["Cố lên, có gì gọi mình phụ nhé.", "Mình cũng vừa xong phần của mình."],
	},
	testsPass: {
		opener: ["Kiểm thử qua {dat} lần rồi đấy {ten}!", "Bảng QA xanh hết, {dat} lần qua, sướng ghê.", "{ten} biết chưa, kiểm thử vừa qua hết!", "Hôm nay kiểm thử qua {dat} lần, đáng ăn mừng."],
		reply: ["Tuyệt vời, vỗ tay nào!", "Đúng là làm kỹ thì không lo.", "Thế thì tối nay ngủ ngon rồi.", "Công sức cả đội đấy!"],
		follow: ["Giữ phong độ này nhé!", "Lần sau cũng xanh như vậy là đẹp."],
		close: ["Nhất trí, cả nhà cố lên!", "Ăn mừng bằng cốc trà sữa nhé."],
	},
	testsFail: {
		opener: ["Kiểm thử trượt {truot} lần rồi {ten} ơi.", "Lại đỏ, hôm nay trượt {truot} lần.", "{ten} ơi, kiểm thử vừa hỏng mất rồi.", "Bảng QA còn {truot} lần trượt, hơi lo."],
		reply: ["Không sao, sửa từng chỗ một là được.", "Hỏng thì mới biết chỗ mà sửa chứ.", "Bình tĩnh, mình cùng soi lại nhé.", "Đừng nản, lần sau sẽ qua thôi."],
		follow: ["Ừ, để mình xem lại kỹ hơn.", "Cảm ơn nhé, mình thấy đỡ lo rồi."],
		close: ["Có gì cứ gọi, mình ở ngay đây.", "Sai thì sửa, chuyện thường mà."],
	},
	approvalWait: {
		opener: ["Hồi nãy mình đứng chờ duyệt ở phòng Bảo vệ mất {cho}.", "{ten} ơi, chờ duyệt {cho} mỏi cả chân.", "Chờ được duyệt mất {cho}, cuối cùng cũng xong.", "Phòng Bảo vệ hôm nay giữ mình {cho} luôn."],
		reply: ["Cẩn thận vẫn hơn mà.", "Chủ tịch bận đấy, thông cảm chút.", "Chờ lâu thế, ngồi nghỉ đi.", "Được duyệt là tốt rồi."],
		follow: ["Ừ, an toàn là trên hết.", "Lần sau mình chuẩn bị kỹ hơn."],
		close: ["Chuẩn, đúng quy trình thì yên tâm.", "Thôi kệ, giờ thong thả rồi."],
	},
	meal: {
		opener: ["Đến giờ {bua} rồi, {ten} ăn gì?", "{ten} ơi, {bua} nay có món gì ngon?", "Đói quá, đi {bua} thôi!", "Ngồi đây ăn {bua} cùng mình nhé {ten}."],
		reply: ["Cơm gà xối mỡ, thơm lắm!", "Mình ăn bún chả, ngon tuyệt.", "Bánh mì trứng cho nhanh gọn.", "Ăn gì cũng được, miễn ngồi cùng nhau."],
		follow: ["Nghe thèm quá, mai mình ăn thử.", "Ăn no rồi làm việc mới khoẻ."],
		close: ["Chúc ngon miệng nhé!", "Ăn xong làm cốc cà phê nhé."],
	},
	gym: {
		opener: ["{ten} tập được bao lâu rồi?", "Hôm nay mình chạy được kha khá đấy.", "Tập xong thấy người nhẹ hẳn, {ten} ạ.", "Ngồi máy cả ngày, phải vận động chút."],
		reply: ["Mới khởi động thôi, còn sung lắm.", "Mồ hôi nhễ nhại rồi đây.", "Chuẩn, khoẻ thì mới làm được lâu.", "Mai mình rủ thêm người tập cùng."],
		follow: ["Tập đều là khoẻ re ngay.", "Thêm một hiệp nữa rồi nghỉ nhé."],
		close: ["Ok, chơi tới bến!", "Nhớ uống đủ nước đấy."],
	},
	tv: {
		opener: ["Phim này hay ghê {ten} ạ.", "Tối nay tivi chiếu gì vậy {ten}?", "Trận bóng sắp bắt đầu rồi!", "Ngồi xem chung cho vui nhé."],
		reply: ["Hay thật, đoạn sau còn gay cấn hơn.", "Chắc chiếu phim hoạt hình, mình thích lắm.", "Mình cổ vũ đội áo đỏ.", "Ừ, nhích vào cho mình ngồi với."],
		follow: ["Đừng kể trước đoạn kết nhé!", "Lấy thêm bỏng ngô đi."],
		close: ["Hứa không tiết lộ đâu.", "Để mình đi lấy luôn."],
	},
	evening: {
		opener: ["Hôm nay cả văn phòng xong {xong} việc đấy {ten}.", "Mới {gio} thôi, còn sớm chán.", "Tối rồi, thư giãn chút đi {ten}.", "Một ngày dài ghê, {ten} thấy sao?"],
		reply: ["Năng suất ghê, đáng nghỉ ngơi.", "Ừ, tối nay chơi cờ không?", "Mệt nhưng vui, làm cùng mọi người mà.", "Nghe nhạc chút cho thư thái."],
		follow: ["Mai lại chiến tiếp nhé.", "Mình pha trà cho cả hai nhé."],
		close: ["Nhất trí, cảm ơn nha!", "Hẹn mai sáng sớm."],
	},
	goodNight: {
		opener: ["Khuya rồi, mình đi ngủ đây {ten}.", "{ten} ngủ sớm đi, mai còn làm.", "Buồn ngủ díp cả mắt rồi.", "Đã {gio} rồi, sắp tắt đèn thôi."],
		reply: ["Ngủ ngon nhé, mơ đẹp!", "Ừ, mình xem nốt chút rồi ngủ.", "Chúc ngủ ngon, mai gặp.", "Nhớ đắp chăn kẻo lạnh."],
		follow: ["Mai dậy sớm tập thể dục nhé.", "Đặt báo thức chưa đấy?"],
		close: ["Ok, mai gặp ở phòng gym.", "Đặt rồi, sáu giờ dậy."],
	},
	morning: {
		opener: ["Chào buổi sáng {ten}!", "Sáng nay trời đẹp ghê.", "{ten} ngủ ngon không?", "Dậy sớm thế, {ten} chăm quá."],
		reply: ["Chào nha, ngủ một mạch tới sáng.", "Ngon lắm, giờ đói bụng rồi.", "Sáng nào mình cũng dậy giờ này mà.", "Hôm nay chắc nhiều việc lắm đây."],
		follow: ["Ăn sáng rồi lên làm thôi.", "Cà phê trước đã nhé."],
		close: ["Đi, mình đi cùng.", "Hai cốc nhé, mình mời."],
	},
	smallTalk: {
		opener: ["{ten} đang rảnh à?", "Hôm nay văn phòng xong {xong} việc rồi đấy.", "Dạo này {ten} khoẻ không?", "Có việc gì cần mình phụ không {ten}?"],
		reply: ["Rảnh chút, chờ việc mới.", "Năng suất thật, cả đội giỏi ghê.", "Khoẻ, cảm ơn nhé!", "Tạm ổn, có gì mình gọi."],
		follow: ["Ừ, cứ thoải mái nhé.", "Thế ra pantry uống nước không?"],
		close: ["Đi luôn, mình khát rồi.", "Ok, cảm ơn nha."],
	},
};

/** Who says a quirk line: the director, a known cast member, or anyone else. */
export type QuirkKey = CastKey | "director" | "other";

/** A closing line in each character's own voice. */
export const QUIRKS: Readonly<Record<QuirkKey, readonly string[]>> = {
	director: ["Giám đốc thấy vui khi cả đội vui.", "Cứ thong thả, có việc tôi gọi.", "Làm tốt lắm, cảm ơn mọi người."],
	scout: ["Để mình đi dò thêm quanh đây.", "Có gì lạ là mình phát hiện ngay!", "Kính lúp lúc nào cũng trong túi."],
	explore: ["Đường nào mình cũng thuộc hết.", "Đi một vòng là biết ngay.", "Bản đồ nằm cả trong đầu mình đây."],
	generalPurpose: ["Cần gì cứ gọi, việc gì mình cũng làm.", "Hộp đồ nghề lúc nào cũng sẵn.", "Một tay mình lo được hết."],
	tester: ["Nhưng phải thử lại cho chắc đã.", "Không kiểm thì không yên tâm.", "Mũ bảo hộ đội rồi, sẵn sàng!"],
	codeReviewer: ["Để mình soát lại lần nữa cho chắc.", "Chi tiết nhỏ cũng phải đúng.", "Đeo kính vào là thấy lỗi ngay."],
	researcher: ["Để mình tra thêm tài liệu.", "Sách nói thế đấy, tin được.", "Biết càng nhiều càng vui."],
	planner: ["Mình ghi vào kế hoạch rồi nhé.", "Việc nào ra việc nấy, theo lịch.", "Mai mình cập nhật bảng kế hoạch."],
	debugger: ["Có con bọ nào là mình bắt liền.", "Đèn pin lúc nào cũng sáng.", "Lỗi khó cỡ nào cũng tìm ra."],
	other: ["Mình mới vào nhưng vui lắm.", "Ở đây ai cũng dễ thương.", "Học được nhiều thứ hay ghê."],
};

const SLOT_PATTERN = /\{([a-z]+)\}/g;

/** The slots a line uses. */
export function slotsOf(line: string): DialogueSlot[] {
	return [...line.matchAll(SLOT_PATTERN)].flatMap((m) => DIALOGUE_SLOTS.filter((s) => s === m[1]));
}

/** A line with its slots filled; a slot without a value stays as it is (callers pick only lines whose slots they have). */
export function fillLine(line: string, values: Readonly<Partial<Record<DialogueSlot, string>>>): string {
	return line.replace(SLOT_PATTERN, (whole, name: string) => DIALOGUE_SLOTS.flatMap((s) => (s === name ? [values[s] ?? whole] : []))[0] ?? whole);
}
