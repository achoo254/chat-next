package watch

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Thresholds. Memory follows the rule of the shared server: keep 30% free.
const (
	memoryWarnPct    = 30
	memoryCritPct    = 15
	diskWarnPct      = 15
	diskCritPct      = 5
	backupMaxAge     = 26 * time.Hour
	certWarn         = 14 * 24 * time.Hour
	certCrit         = 3 * 24 * time.Hour
	outboxMaxWait    = 2 * time.Minute
	errorsWindow     = 5 * time.Minute
	errorsThreshold  = 10
	certDialTimeout  = 10 * time.Second
	severityWarning  = "warning"
	severityCritical = "critical"
	meminfoPath      = "/proc/meminfo"
)

func severity(critical bool) string {
	if critical {
		return severityCritical
	}
	return severityWarning
}

// Memory reports the machine short of available memory (Linux; elsewhere
// nothing).
func Memory() Check {
	return func(context.Context) ([]Problem, error) {
		f, err := os.Open(meminfoPath)
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		defer func() { _ = f.Close() }()
		var total, available int64
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			fields := strings.Fields(scanner.Text())
			if len(fields) < 2 {
				continue
			}
			v, _ := strconv.ParseInt(fields[1], 10, 64)
			switch fields[0] {
			case "MemTotal:":
				total = v
			case "MemAvailable:":
				available = v
			}
		}
		if total == 0 {
			return nil, nil
		}
		pct := available * 100 / total
		if pct >= memoryWarnPct {
			return nil, nil
		}
		return []Problem{{
			Key: "memory_low", Name: "MemoryLow", Severity: severity(pct < memoryCritPct),
			Summary: fmt.Sprintf("Máy còn %d%% RAM khả dụng (%d MB)", pct, available/1024),
			Detail:  fmt.Sprintf("Ngưỡng: giữ ít nhất %d%% RAM trống trên máy dùng chung.", memoryWarnPct),
		}}, nil
	}
}

// Disk reports file systems holding paths that are nearly full.
func Disk(paths ...string) Check {
	return func(context.Context) ([]Problem, error) {
		var out []Problem
		for _, path := range paths {
			if path == "" {
				continue
			}
			var st syscall.Statfs_t
			if err := syscall.Statfs(path, &st); err != nil {
				continue
			}
			total := float64(st.Blocks) * float64(st.Bsize)
			if total == 0 {
				continue
			}
			free := float64(st.Bavail) * float64(st.Bsize)
			pct := int(free * 100 / total)
			if pct >= diskWarnPct {
				continue
			}
			out = append(out, Problem{
				Key: "disk_low:" + path, Name: "DiskLow", Severity: severity(pct < diskCritPct),
				Summary: fmt.Sprintf("Ổ chứa %s còn %d%% trống (%.1f GB)", path, pct, free/(1<<30)),
			})
		}
		return out, nil
	}
}

// Backup reports the newest dump in dir (chat-*.dump) older than a day and
// two hours; nothing when dir does not exist (not this machine).
func Backup(dir string, now func() time.Time) Check {
	return func(context.Context) ([]Problem, error) {
		files, err := filepath.Glob(filepath.Join(dir, "chat-*.dump"))
		if err != nil {
			return nil, err
		}
		if _, err := os.Stat(dir); errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		var newest time.Time
		for _, f := range files {
			if info, err := os.Stat(f); err == nil && info.ModTime().After(newest) {
				newest = info.ModTime()
			}
		}
		if !newest.IsZero() && now().Sub(newest) < backupMaxAge {
			return nil, nil
		}
		summary := "Chưa có bản backup DB nào"
		if !newest.IsZero() {
			summary = fmt.Sprintf("Bản backup DB mới nhất đã %.0f giờ", now().Sub(newest).Hours())
		}
		return []Problem{{Key: "backup_stale", Name: "BackupStale", Severity: severityCritical, Summary: summary,
			Detail: "Backup chạy lúc 02:50 mỗi ngày (cron, infra/chat/backup-chat-db.sh)."}}, nil
	}
}

// Cert reports the TLS certificate of host expiring soon. It reads the
// certificate the origin serves at origin (nginx on this machine): behind
// Cloudflare the public address shows Cloudflare's own certificate, which
// renews itself, and the origin's would expire unseen. Without a server at
// origin it reads the one at host's public address.
func Cert(host, origin string, now func() time.Time) Check {
	return func(ctx context.Context) ([]Problem, error) {
		if host == "" {
			return nil, nil
		}
		dialer := &tls.Dialer{NetDialer: &net.Dialer{Timeout: certDialTimeout}, Config: &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}}
		conn, err := dialer.DialContext(ctx, "tcp", origin)
		if errors.Is(err, syscall.ECONNREFUSED) {
			conn, err = dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, "443"))
		}
		if err != nil {
			return []Problem{{Key: "cert:" + host, Name: "CertUnreachable", Severity: severityWarning,
				Summary: "Không kiểm được chứng chỉ TLS của " + host, Detail: err.Error()}}, nil
		}
		defer func() { _ = conn.Close() }()
		certs := conn.(*tls.Conn).ConnectionState().PeerCertificates
		if len(certs) == 0 {
			return nil, nil
		}
		left := certs[0].NotAfter.Sub(now())
		if left >= certWarn {
			return nil, nil
		}
		return []Problem{{Key: "cert:" + host, Name: "CertExpiring", Severity: severity(left < certCrit),
			Summary: fmt.Sprintf("Chứng chỉ TLS của %s còn %.0f ngày", host, left.Hours()/24),
			Detail:  "Gia hạn: infra/chat/issue-cert.sh (certbot, DNS Cloudflare)."}}, nil
	}
}

// Outbox reports updates of tenant waiting longer than two minutes for one
// of its consumers (the outbox_cursors rows named in consumers). Each
// consumer reads its own tenant's rows only, so rows of any other
// tenant_id past a cursor wait for nobody.
func Outbox(pool *pgxpool.Pool, tenant string, consumers []string, now func() time.Time) Check {
	return func(ctx context.Context) ([]Problem, error) {
		rows, err := pool.Query(ctx, `
			SELECT c.consumer, (SELECT o.created_at FROM outbox o WHERE o.id > c.last_id AND o.tenant_id = $1 ORDER BY o.id LIMIT 1)
			FROM outbox_cursors c WHERE c.consumer = ANY($2)`, tenant, consumers)
		if err != nil {
			return nil, fmt.Errorf("watch: outbox: %w", err)
		}
		type row struct {
			consumer string
			oldest   *time.Time
		}
		list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (row, error) {
			var x row
			return x, r.Scan(&x.consumer, &x.oldest)
		})
		if err != nil {
			return nil, fmt.Errorf("watch: outbox: %w", err)
		}
		var out []Problem
		for _, x := range list {
			if x.oldest == nil || now().Sub(*x.oldest) < outboxMaxWait {
				continue
			}
			out = append(out, Problem{Key: "outbox_backlog:" + x.consumer, Name: "OutboxBacklog", Severity: severityCritical,
				Summary: fmt.Sprintf("Update chờ %s đã %.0f phút", x.consumer, now().Sub(*x.oldest).Minutes()),
				Detail:  "Người dùng có thể không nhận được tin realtime, thông báo hoặc update của bot."})
		}
		return out, nil
	}
}

// Errors reports at least ten error log lines in five minutes.
func Errors(counter *ErrorCounter) Check {
	return func(context.Context) ([]Problem, error) {
		n := counter.Recent(errorsWindow)
		if n < errorsThreshold {
			return nil, nil
		}
		return []Problem{{Key: "errors", Name: "ErrorsInLog", Severity: severityWarning,
			Summary: fmt.Sprintf("%d lỗi trong log 5 phút qua", n),
			Detail:  "Xem: pm2 logs chat-api --lines 200 --nostream (bỏ qua mức WARN)."}}, nil
	}
}
