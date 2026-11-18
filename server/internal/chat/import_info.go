package chat

import (
	"context"
	"fmt"
)

// SetInfo makes the title and the description of the chat what the other app says
// they are, and reports whether either changed. It asks for no right and posts no
// service message: the other app does not say who changed it, and a line saying the
// owner did would be wrong. A title the other app gave that Chat finds unusable is
// kept out and the old one stays.
func (it *ImportTx) SetInfo(ctx context.Context, title, about string) (bool, error) {
	if it.c.Type == typePrivate {
		return false, nil
	}
	newTitle := it.c.Title
	if cleaned, err := cleanTitle(title); err == nil {
		newTitle = cleaned
	}
	newAbout := it.c.About
	if cleaned, err := cleanAbout(about); err == nil {
		newAbout = cleaned
	}
	if newTitle == it.c.Title && newAbout == it.c.About {
		return false, nil
	}
	it.c.Title, it.c.About = newTitle, newAbout
	if _, err := it.t.tx.Exec(ctx, `UPDATE chats SET title = $2, about = $3, updated_at = now() WHERE id = $1`, it.c.ID, newTitle, newAbout); err != nil {
		return false, fmt.Errorf("chat: set imported info: %w", err)
	}
	if err := it.t.chatChanged(ctx, it.c, it.owner); err != nil {
		return false, err
	}
	return true, nil
}
