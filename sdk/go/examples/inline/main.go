// Command inline answers every inline query with one article: the query in
// capitals as the title and the query itself as the message.
package main

import (
	"context"
	"strings"

	chatbot "github.com/achoo254/chat-next/sdk/go"
	"github.com/achoo254/chat-next/sdk/go/examples/internal/run"
)

func main() {
	run.Main(func(_ context.Context, _ *chatbot.Client, r *chatbot.Router) error {
		r.InlineQuery(func(ctx context.Context, c *chatbot.Context) error {
			query := c.Update.InlineQuery.Query
			var results []chatbot.InlineQueryResult
			// An article needs a title and a text, so an empty query gets no result.
			if query != "" {
				results = append(results, chatbot.InlineQueryResult{
					Type: "article", ID: "1", Title: strings.ToUpper(query), Text: query,
				})
			}
			// One second: 0 would mean the server's default of 300.
			return c.AnswerInline(ctx, results, &chatbot.AnswerInlineQueryRequest{CacheTime: 1})
		})
		return nil
	})
}
