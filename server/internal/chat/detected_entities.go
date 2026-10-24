package chat

import (
	"cmp"
	"slices"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/entities"
)

// containerEntityTypes are the style entities a detected link, e-mail,
// mention or hashtag may sit inside (entities.Taken.Container).
var containerEntityTypes = map[appv1.EntityType]bool{
	appv1.EntityType_ENTITY_TYPE_BOLD:      true,
	appv1.EntityType_ENTITY_TYPE_ITALIC:    true,
	appv1.EntityType_ENTITY_TYPE_UNDERLINE: true,
	appv1.EntityType_ENTITY_TYPE_STRIKE:    true,
	appv1.EntityType_ENTITY_TYPE_SPOILER:   true,
}

var detectedEntityTypes = map[entities.Kind]appv1.EntityType{
	entities.KindURL:     appv1.EntityType_ENTITY_TYPE_URL,
	entities.KindEmail:   appv1.EntityType_ENTITY_TYPE_EMAIL,
	entities.KindMention: appv1.EntityType_ENTITY_TYPE_MENTION,
	entities.KindHashtag: appv1.EntityType_ENTITY_TYPE_HASHTAG,
}

// withDetectedEntities appends url, email, mention and hashtag entities for
// the plain parts of text (entities.Detect), so a message shows its links
// whoever wrote it: a client, a bot or an integration. ents are the
// sender's, already valid; they are kept as they are, and the total stays
// within entitiesMax. The result is in one canonical order (offset, then
// the longer entity first, then type), so writing the same text and
// entities again, in any order, yields the same list and an unchanged edit
// stays unchanged.
func (s *Service) withDetectedEntities(text string, ents []*appv1.MessageEntity) []*appv1.MessageEntity {
	taken := make([]entities.Taken, len(ents))
	for i, e := range ents {
		taken[i] = entities.Taken{
			Span:      entities.Span{Offset: int(e.GetOffset()), Length: int(e.GetLength())},
			Container: containerEntityTypes[e.GetType()],
		}
	}
	for _, f := range entities.Detect(text, taken, s.cfg.AppScheme, entitiesMax-len(ents)) {
		ents = append(ents, &appv1.MessageEntity{
			Type:   detectedEntityTypes[f.Kind],
			Offset: int32(f.Offset), //nolint:gosec // bounded by the message length limit
			Length: int32(f.Length), //nolint:gosec // bounded by the message length limit
		})
	}
	slices.SortStableFunc(ents, func(a, b *appv1.MessageEntity) int {
		return cmp.Or(cmp.Compare(a.GetOffset(), b.GetOffset()), cmp.Compare(b.GetLength(), a.GetLength()), cmp.Compare(a.GetType(), b.GetType()))
	})
	return ents
}
