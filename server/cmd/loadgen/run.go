package main

import (
	"context"
	"flag"
	"fmt"
	"math/rand/v2"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"connectrpc.com/connect"
	"golang.org/x/sync/errgroup"
)

// samples collects latencies of one kind during a step.
type samples struct {
	mu   sync.Mutex
	list []time.Duration
}

func (s *samples) add(d time.Duration) {
	s.mu.Lock()
	s.list = append(s.list, d)
	s.mu.Unlock()
}

// take returns the samples so far and starts over.
func (s *samples) take() []time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.list
	s.list = nil
	slices.Sort(out)
	return out
}

func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	i := int(float64(len(sorted)-1) * p)
	return sorted[i]
}

func ms(d time.Duration) string { return strconv.FormatFloat(float64(d)/float64(time.Millisecond), 'f', 1, 64) }

// rssMB is the resident memory of process pid (ps works on macOS and Linux).
func rssMB(pid int) string {
	if pid == 0 {
		return "-"
	}
	out, err := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return "?"
	}
	kb, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return "?"
	}
	return strconv.Itoa(kb / 1024)
}

type runner struct {
	api      string
	group    int
	interval time.Duration
	pid      int

	transport http.RoundTripper
	people    []*person
	chatOf    map[int]int64 // person index -> its group

	// base makes random_ids unique across runs against the same server
	// (16 bits of the start time, then the person and the person's count).
	base int64

	measuring atomic.Bool
	ack       samples
	delivered samples
	search    samples
	errors    atomic.Int64
	// firstError is printed once per step.
	firstError atomic.Value
}

func (r *runner) fail(what string, err error) {
	r.errors.Add(1)
	r.firstError.CompareAndSwap(nil, what+": "+err.Error())
}

func runMain(args []string) int {
	flags := flag.NewFlagSet("run", flag.ContinueOnError)
	r := &runner{chatOf: map[int]int64{}, base: time.Now().Unix() & 0xffff}
	flags.StringVar(&r.api, "api", "http://127.0.0.1:4700", "the server's public origin")
	steps := flags.String("steps", "100,300,1000", "number of people online at each step")
	flags.IntVar(&r.group, "group", 10, "people per group")
	flags.DurationVar(&r.interval, "interval", 10*time.Second, "time between two messages of one person")
	duration := flags.Duration("duration", time.Minute, "measured time per step")
	warmup := flags.Duration("warmup", 10*time.Second, "unmeasured time after a step's people are online")
	searchEvery := flags.Duration("search-every", time.Second, "one search by someone this often (0: none)")
	flags.IntVar(&r.pid, "server-pid", 0, "server process whose memory is reported")
	parallel := flags.Int("parallel", 20, "sign-ins and setup calls at once")
	minFree := flags.Int("min-free-pct", 0, "stop when the machine's available memory falls below this percentage (Linux; 0: no guard)")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	var targets []int
	for _, s := range strings.Split(*steps, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(s))
		if err != nil || n < r.group {
			fmt.Fprintf(os.Stderr, "loadgen run: bad step %q\n", s)
			return 2
		}
		targets = append(targets, n/r.group*r.group)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	r.transport = &http.Transport{MaxIdleConnsPerHost: 1000, MaxConnsPerHost: 0, IdleConnTimeout: 90 * time.Second}

	fmt.Printf("loadgen: %s, groups of %d, one message per person every %s, %s measured per step\n", r.api, r.group, r.interval, *duration)
	fmt.Println("people  msg/s  sent  ack_p50  ack_p99  delivered  deliv_p50  deliv_p99  search_p50  search_p99  errors  server_rss_MB")
	if *minFree > 0 {
		// A shared machine: give the memory back as soon as it runs short.
		guarded, cancel := context.WithCancel(ctx)
		defer cancel()
		go guardMemory(guarded, cancel, *minFree)
		ctx = guarded
	}
	for _, n := range targets {
		if err := r.grow(ctx, n, *parallel); err != nil {
			fmt.Fprintln(os.Stderr, "loadgen run:", err)
			return 1
		}
		fmt.Fprintf(os.Stderr, "loadgen: %d people online at %s\n", len(r.people), time.Now().Format(time.TimeOnly))
		stepCtx, stepStop := context.WithCancel(ctx)
		var wg sync.WaitGroup
		for _, p := range r.people {
			wg.Add(1)
			go func() { defer wg.Done(); r.post(stepCtx, p) }()
		}
		if *searchEvery > 0 {
			wg.Add(1)
			go func() { defer wg.Done(); r.searches(stepCtx, *searchEvery) }()
		}
		sleep(ctx, *warmup)
		r.ack.take()
		r.delivered.take()
		r.search.take()
		r.errors.Store(0)
		r.measuring.Store(true)
		sleep(ctx, *duration)
		r.measuring.Store(false)
		ack, del, srch := r.ack.take(), r.delivered.take(), r.search.take()
		rate := float64(len(r.people)) / r.interval.Seconds()
		fmt.Printf("%6d  %5.1f  %4d  %7s  %7s  %9d  %9s  %9s  %10s  %10s  %6d  %13s\n",
			len(r.people), rate, len(ack), ms(percentile(ack, 0.5)), ms(percentile(ack, 0.99)),
			len(del), ms(percentile(del, 0.5)), ms(percentile(del, 0.99)),
			ms(percentile(srch, 0.5)), ms(percentile(srch, 0.99)), r.errors.Load(), rssMB(r.pid))
		if e, ok := r.firstError.Swap("").(string); ok && e != "" {
			fmt.Printf("        first error: %s\n", e)
		}
		stepStop()
		wg.Wait()
		if ctx.Err() != nil {
			return 1
		}
	}
	return 0
}

// guardMemory cancels the run once MemAvailable drops below minPct of
// MemTotal (/proc/meminfo), checking every 5 seconds.
func guardMemory(ctx context.Context, stop context.CancelFunc, minPct int) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if pct, ok := availablePct(); ok && pct < minPct {
			fmt.Printf("stopped: available memory %d%% < %d%%\n", pct, minPct)
			stop()
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func availablePct() (int, bool) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, false
	}
	var total, available int
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		v, _ := strconv.Atoi(f[1])
		switch f[0] {
		case "MemTotal:":
			total = v
		case "MemAvailable:":
			available = v
		}
	}
	if total == 0 {
		return 0, false
	}
	return available * 100 / total, true
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// grow signs people in up to n, puts each new full group together and
// opens their sockets.
func (r *runner) grow(ctx context.Context, n, parallel int) error {
	first := len(r.people)
	fresh := make([]*person, n-first)
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(parallel)
	for k := range fresh {
		g.Go(func() error {
			p, err := signIn(gctx, r.api, r.transport, first+k+1)
			fresh[k] = p
			return err
		})
	}
	if err := g.Wait(); err != nil {
		return err
	}
	r.people = append(r.people, fresh...)
	g, gctx = errgroup.WithContext(ctx)
	g.SetLimit(parallel)
	for start := first; start < n; start += r.group {
		members := r.people[start : start+r.group]
		g.Go(func() error { return r.makeGroup(gctx, members) })
	}
	if err := g.Wait(); err != nil {
		return err
	}
	g, gctx = errgroup.WithContext(ctx)
	g.SetLimit(parallel)
	for _, p := range fresh {
		g.Go(func() error { return p.connectSocket(ctx, r.api, r.onFrame(p)) })
	}
	return g.Wait()
}

func (r *runner) makeGroup(ctx context.Context, members []*person) error {
	owner := members[0]
	created, err := owner.chats.CreateGroup(ctx, connect.NewRequest(&appv1.CreateGroupRequest{Title: fmt.Sprintf("Nhóm tải %d", owner.index)}))
	if err != nil {
		return fmt.Errorf("create group: %w", err)
	}
	chatID := created.Msg.GetChat().GetId()
	link, err := owner.chats.ExportInviteLink(ctx, connect.NewRequest(&appv1.ExportInviteLinkRequest{ChatId: chatID}))
	if err != nil {
		return fmt.Errorf("invite link: %w", err)
	}
	for _, m := range members[1:] {
		if _, err := m.chats.JoinByInvite(ctx, connect.NewRequest(&appv1.JoinByInviteRequest{Link: link.Msg.GetInvite().GetLink()})); err != nil {
			return fmt.Errorf("join: %w", err)
		}
	}
	r.setChats(members, chatID)
	return nil
}

var chatMu sync.Mutex

func (r *runner) setChats(members []*person, chatID int64) {
	chatMu.Lock()
	defer chatMu.Unlock()
	for _, m := range members {
		r.chatOf[m.index] = chatID
	}
}

func (r *runner) chat(p *person) int64 {
	chatMu.Lock()
	defer chatMu.Unlock()
	return r.chatOf[p.index]
}

// onFrame measures the delivery of others' load messages to p.
func (r *runner) onFrame(p *person) func(*appv1.ServerFrame) {
	return func(f *appv1.ServerFrame) {
		if !r.measuring.Load() {
			return
		}
		now := time.Now()
		for _, u := range f.GetUpdate().GetUpdates() {
			m := u.GetMessageNew().GetMessage()
			if m == nil || m.GetFromId() == p.userID {
				continue
			}
			if at, ok := parseStamp(m.GetText()); ok {
				r.delivered.add(now.Sub(at))
			}
		}
	}
}

// post sends p's messages at the step's pace, from a random phase.
func (r *runner) post(ctx context.Context, p *person) {
	chatID := r.chat(p)
	sleep(ctx, time.Duration(rand.Int64N(int64(r.interval))))
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for ctx.Err() == nil {
		seq := p.sent.Add(1)
		at := time.Now()
		_, err := p.messages.SendMessage(ctx, connect.NewRequest(&appv1.SendMessageRequest{
			ChatId: chatID, Text: stamp(p.index, at), RandomId: r.base<<36 | int64(p.index)<<20 | seq&(1<<20-1),
		}))
		switch {
		case err == nil && r.measuring.Load():
			r.ack.add(time.Since(at))
		case err != nil && ctx.Err() == nil:
			r.fail("send", err)
		}
		select {
		case <-ctx.Done():
		case <-ticker.C:
		}
	}
}

// searches runs one message search of a random person every period.
func (r *runner) searches(ctx context.Context, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		p := r.people[rand.IntN(len(r.people))]
		at := time.Now()
		_, err := p.search.SearchMessages(ctx, connect.NewRequest(&appv1.SearchMessagesRequest{Query: "load " + strconv.Itoa(p.index), Limit: 20}))
		switch {
		case err == nil && r.measuring.Load():
			r.search.add(time.Since(at))
		case err != nil && ctx.Err() == nil:
			r.fail("search", err)
		}
	}
}
