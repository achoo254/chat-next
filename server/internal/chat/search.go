package chat

import (
	"context"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/search"
)

// SearchMessages searches every chat me is a member of; exact-accent
// matches rank first (search.OrderRelevance).
func (s *Service) SearchMessages(ctx context.Context, me int64, req *appv1.SearchMessagesRequest) (*appv1.SearchMessagesResponse, error) {
	filter, err := searchFilter(req.GetFilter())
	if err != nil {
		return nil, err
	}
	if err := s.allow(limitMessageSearch, "search_messages", me); err != nil {
		return nil, err
	}
	page, err := s.searcher.Search(ctx, search.Request{
		TenantID: s.cfg.TenantID, UserID: me, Query: req.GetQuery(), Filter: filter,
		Order: search.OrderRelevance, Cursor: req.GetCursor(), Limit: int(req.GetLimit()),
	})
	if err != nil {
		return nil, searchError(err)
	}
	messages, users, chats, err := s.renderHits(ctx, me, page.Hits)
	if err != nil {
		return nil, err
	}
	return &appv1.SearchMessagesResponse{Messages: messages, Users: users, Chats: chats, NextCursor: page.NextCursor}, nil
}

// SearchChatMessages searches one chat (or one forum topic) of which me is a
// member, newest first.
func (s *Service) SearchChatMessages(ctx context.Context, me int64, req *appv1.SearchChatMessagesRequest) (*appv1.SearchChatMessagesResponse, error) {
	filter, err := searchFilter(req.GetFilter())
	if err != nil {
		return nil, err
	}
	if req.GetTopicId() < 0 {
		return nil, errInvalid("topic_id must not be negative")
	}
	c, _, err := s.activeChatFor(ctx, s.pool, req.GetChatId(), me, false)
	if err != nil {
		return nil, err
	}
	if req.GetTopicId() != 0 && !c.Forum {
		return nil, errInvalid("this chat has no topics")
	}
	if err := s.allow(limitMessageSearch, "search_messages", me); err != nil {
		return nil, err
	}
	page, err := s.searcher.Search(ctx, search.Request{
		TenantID: s.cfg.TenantID, UserID: me, ChatID: c.ID, TopicID: req.GetTopicId(), Query: req.GetQuery(), Filter: filter,
		Order: search.OrderNewest, Cursor: req.GetCursor(), Limit: int(req.GetLimit()),
	})
	if err != nil {
		return nil, searchError(err)
	}
	messages, users, chats, err := s.renderHits(ctx, me, page.Hits)
	if err != nil {
		return nil, err
	}
	return &appv1.SearchChatMessagesResponse{Messages: messages, Users: users, Chats: chats, NextCursor: page.NextCursor}, nil
}

func searchFilter(f *appv1.SearchFilter) (search.Filter, error) {
	out := search.Filter{FromID: f.GetFromId(), HasLink: f.GetHasLink()}
	if out.FromID < 0 {
		return search.Filter{}, errInvalid("from_id must not be negative")
	}
	kind := f.GetMediaKind()
	if _, known := appv1.MediaKind_name[int32(kind)]; !known {
		return search.Filter{}, errInvalid("unknown media_kind")
	}
	out.MediaKind = int16(kind)
	minDate, maxDate := f.GetMinDate(), f.GetMaxDate()
	if minDate < 0 || maxDate < 0 || (minDate > 0 && maxDate > 0 && maxDate < minDate) {
		return search.Filter{}, errInvalid("invalid date range")
	}
	if minDate > 0 {
		out.Since = time.Unix(minDate, 0)
	}
	if maxDate > 0 {
		// Inclusive: every message of that second.
		out.Until = time.Unix(maxDate, 0).Add(time.Second - time.Microsecond)
	}
	return out, nil
}

func searchError(err error) error {
	if search.IsInvalid(err) {
		return errInvalid("%s", err.Error())
	}
	return err
}

// renderHits renders the messages found, in hit order, with their senders
// and chats. A hit deleted since the search ran is dropped.
func (s *Service) renderHits(ctx context.Context, me int64, hits []search.Hit) ([]*appv1.Message, []*appv1.User, []*appv1.Chat, error) {
	keys := map[int64][]int64{}
	for _, h := range hits {
		keys[h.ChatID] = append(keys[h.ChatID], h.Seq)
	}
	loaded, err := loadMessages(ctx, s.pool, keys)
	if err != nil {
		return nil, nil, nil, err
	}
	rows := make([]*messageRow, 0, len(hits))
	ents := newEntitySet()
	for _, h := range hits {
		if m, ok := loaded[msgKey{h.ChatID, h.Seq}]; ok && !m.Deleted {
			rows = append(rows, m)
			ents.addChats(me, h.ChatID)
		}
	}
	messages, users, err := s.renderMessages(ctx, s.pool, me, rows)
	if err != nil {
		return nil, nil, nil, err
	}
	rendered, err := ents.render(ctx, s.pool, s.cfg.TenantID)
	if err != nil {
		return nil, nil, nil, err
	}
	chats := rendered.chats[me]
	// A private chat is shown under its peer's name.
	known := map[int64]bool{}
	for _, u := range users {
		known[u.GetId()] = true
	}
	peers := newEntitySet()
	for _, c := range chats {
		if id := c.GetPeerUserId(); id != 0 && !known[id] {
			known[id] = true
			peers.addUsers(me, id)
		}
	}
	if len(peers.users) > 0 {
		more, err := peers.render(ctx, s.pool, s.cfg.TenantID)
		if err != nil {
			return nil, nil, nil, err
		}
		users = append(users, more.users[me]...)
	}
	return messages, users, chats, nil
}
