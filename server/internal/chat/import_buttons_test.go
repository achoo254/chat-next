package chat

import "testing"

func TestImportKeyboardDropsButtonsChatDoesNotAllow(t *testing.T) {
	s := &Service{}
	if s.importKeyboard(nil) != nil {
		t.Fatal("no buttons must give no keyboard")
	}
	kb := s.importKeyboard([][]IntegrationButton{
		{{Text: "Mở", URL: "https://example.com/a"}, {Text: "Xấu", URL: "javascript:alert(1)"}, {Text: "", URL: "https://example.com/b"}},
		{{Text: "Telegram", URL: "tg://resolve?domain=x"}},
	}).GetInlineKeyboard()
	if len(kb.GetRows()) != 1 || len(kb.GetRows()[0].GetButtons()) != 1 || kb.GetRows()[0].GetButtons()[0].GetUrl() != "https://example.com/a" {
		t.Fatalf("keyboard = %v", kb)
	}
	if s.importKeyboard([][]IntegrationButton{{{Text: "Xấu", URL: "ftp://example.com"}}}) != nil {
		t.Fatal("a keyboard with no allowed button must be dropped")
	}
}
