package media

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"github.com/jackc/pgx/v5"
)

// Worker limits. One job runs at a time per process, so ffmpeg never takes
// more than one core's worth of the shared server.
const (
	workerPoll      = 2 * time.Second
	jobTimeout      = 2 * time.Minute
	jobAttemptsMax  = 3
	jobRetryAfter   = 10 * time.Minute
	posterMaxBytes  = 10 << 20
	stderrMax       = 64 << 10
	waveformSamples = 100
	pcmRate         = 8000
	// pcmMaxSeconds bounds the decoded audio of one waveform (19 MB); a
	// longer file takes its duration from the container.
	pcmMaxSeconds = 1200
)

// ffmpegFormat is the demuxer forced for a stored type, so ffmpeg never
// probes a playlist or concat format that could make it open other URLs;
// "" when ffmpeg is not used for the type.
func ffmpegFormat(mime string) string {
	switch mime {
	case mimeMP4, mimeQuickTime, mimeAudioMP4:
		return "mov"
	case mimeWebM, mimeAudioWebM:
		return "matroska"
	case mimeOgg:
		return "ogg"
	case mimeMPEG:
		return "mp3"
	case mimeAAC:
		return "aac"
	case mimeWAV:
		return "wav"
	case mimeFLAC:
		return "flac"
	}
	return ""
}

// RunWorker processes media jobs until ctx ends; it returns at once when
// ffmpeg is not configured.
func (s *Service) RunWorker(ctx context.Context) {
	if s.cfg.FFmpegPath == "" {
		return
	}
	ticker := time.NewTicker(workerPoll)
	defer ticker.Stop()
	for {
		for {
			worked, err := s.RunJob(ctx)
			if err != nil && ctx.Err() == nil {
				s.logger.Error("media job failed", "err", err)
			}
			if !worked || ctx.Err() != nil {
				break
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// RunJob claims and runs one due job; worked is false when none was due.
func (s *Service) RunJob(ctx context.Context) (worked bool, err error) {
	var fileID int64
	var attempts int
	err = s.pool.QueryRow(ctx, `
		UPDATE media_jobs SET attempts = attempts + 1, run_after = now() + $1::interval
		WHERE file_id = (SELECT file_id FROM media_jobs WHERE run_after <= now() ORDER BY run_after
			FOR UPDATE SKIP LOCKED LIMIT 1)
		RETURNING file_id, attempts`, jobRetryAfter).Scan(&fileID, &attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("media: claim job: %w", err)
	}
	jobCtx, cancel := context.WithTimeout(ctx, jobTimeout)
	defer cancel()
	jobErr := s.runJob(jobCtx, fileID)
	if jobErr != nil && attempts < jobAttemptsMax {
		if _, err := s.pool.Exec(ctx, `UPDATE media_jobs SET last_error = $2 WHERE file_id = $1`, fileID, truncate(jobErr.Error(), 500)); err != nil {
			return true, fmt.Errorf("media: record job error: %w", err)
		}
		return true, fmt.Errorf("media: job of file %d (attempt %d): %w", fileID, attempts, jobErr)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM media_jobs WHERE file_id = $1`, fileID); err != nil {
		return true, fmt.Errorf("media: finish job: %w", err)
	}
	if jobErr != nil {
		return true, fmt.Errorf("media: job of file %d gave up: %w", fileID, jobErr)
	}
	return true, nil
}

func (s *Service) runJob(ctx context.Context, fileID int64) error {
	f, err := ScanFile(s.pool.QueryRow(ctx, `SELECT `+FileColumns+` FROM files f WHERE f.id = $1`, fileID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("media: load file: %w", err)
	}
	format := ffmpegFormat(f.MIME)
	if format == "" {
		return nil
	}
	url, err := s.objects.PresignGet(ctx, f.Key, jobTimeout+time.Minute)
	if err != nil {
		return err
	}
	switch f.Kind {
	case appv1.MediaKind_MEDIA_KIND_VIDEO:
		err = s.videoJob(ctx, f, url, format)
	case appv1.MediaKind_MEDIA_KIND_VOICE, appv1.MediaKind_MEDIA_KIND_AUDIO:
		err = s.audioJob(ctx, f, url, format)
	default:
		return nil
	}
	if err != nil {
		return err
	}
	if r := s.refresherOf(); r != nil {
		if err := r.RefreshFile(ctx, f.ID); err != nil {
			return fmt.Errorf("media: refresh messages: %w", err)
		}
	}
	return nil
}

// ffmpeg runs the configured binary with a clean environment, network
// limited to the presigned URL's protocols, and returns stdout (bounded)
// and stderr.
func (s *Service) ffmpeg(ctx context.Context, maxOut int64, input string, args ...string) ([]byte, string, error) {
	// Only the protocol of the one input: a local file, or the presigned
	// storage URL.
	protocols := "http,https,tcp,tls"
	if strings.HasPrefix(input, "file:") {
		protocols = "file"
	}
	base := []string{"-nostdin", "-hide_banner", "-protocol_whitelist", protocols}
	cmd := exec.CommandContext(ctx, s.cfg.FFmpegPath, append(base, args...)...)
	cmd.Env = []string{}
	var stderr limitedBuffer
	stderr.max = stderrMax
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, "", fmt.Errorf("media: ffmpeg pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, "", fmt.Errorf("media: start ffmpeg: %w", err)
	}
	out, readErr := io.ReadAll(io.LimitReader(stdout, maxOut))
	_, _ = io.Copy(io.Discard, stdout)
	waitErr := cmd.Wait()
	if readErr != nil {
		return nil, stderr.String(), fmt.Errorf("media: read ffmpeg: %w", readErr)
	}
	if waitErr != nil {
		return out, stderr.String(), fmt.Errorf("media: ffmpeg: %w: %s", waitErr, truncate(stderr.String(), 300))
	}
	return out, stderr.String(), nil
}

// limitedBuffer keeps the first max bytes written.
type limitedBuffer struct {
	bytes.Buffer
	max int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := b.max - b.Len(); room > 0 {
		b.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

var durationLine = regexp.MustCompile(`Duration: (\d+):(\d{2}):(\d{2})\.(\d{2})`)

func parseDuration(stderr string) int32 {
	m := durationLine.FindStringSubmatch(stderr)
	if m == nil {
		return 0
	}
	h, _ := strconv.Atoi(m[1])
	mi, _ := strconv.Atoi(m[2])
	sec, _ := strconv.Atoi(m[3])
	cs, _ := strconv.Atoi(m[4])
	ms := int64(h)*3600000 + int64(mi)*60000 + int64(sec)*1000 + int64(cs)*10
	if ms <= 0 || ms > durationMax {
		return 0
	}
	return int32(ms)
}

// videoJob takes a poster frame (at 1 s, or the first frame of a shorter
// video) and makes its renditions and inline thumb; it fills duration and
// dimensions when the upload had none.
func (s *Service) videoJob(ctx context.Context, f *File, url, format string) error {
	var poster []byte
	var stderr string
	for _, at := range []string{"1", "0"} {
		out, errText, err := s.ffmpeg(ctx, posterMaxBytes, url, "-loglevel", "info", "-ss", at, "-f", format, "-i", url,
			"-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "3", "pipe:1")
		stderr = errText
		if err == nil && len(out) > 0 {
			poster = out
			break
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	if f.DurationMS == 0 {
		f.DurationMS = parseDuration(stderr)
	}
	if len(poster) > 0 {
		img, err := s.decode.decode(ctx, mimeJPEG, poster)
		if err != nil {
			return fmt.Errorf("media: decode poster: %w", err)
		}
		d, err := derive(img, 1, appv1.MediaSizeType_MEDIA_SIZE_TYPE_M)
		if err != nil {
			return err
		}
		if f.Width == 0 || f.Height == 0 {
			f.Width, f.Height = int32(d.width), int32(d.height)
		}
		if len(f.InlineThumb) == 0 {
			f.InlineThumb = d.inlineThumb
		}
		// The poster itself is the largest rendition when the frame is
		// small; renditions keep their own keys.
		sizes := []rendition{}
		sizes = append(sizes, d.renditions...)
		if len(sizes) == 0 {
			sizes = append(sizes, rendition{typ: appv1.MediaSizeType_MEDIA_SIZE_TYPE_S, w: d.width, h: d.height, data: poster})
		}
		f.Sizes = nil
		for _, r := range sizes {
			key := f.Key + sizeSuffix[r.typ]
			if err := s.objects.Put(ctx, key, r.data, mimeJPEG); err != nil {
				return err
			}
			f.Sizes = append(f.Sizes, Rendition{Type: r.typ, Width: int32(r.w), Height: int32(r.h), Size: int64(len(r.data)), Key: key})
		}
	}
	return s.saveEnriched(ctx, f)
}

// audioJob decodes the audio to 8 kHz mono PCM for the waveform and the
// exact duration.
func (s *Service) audioJob(ctx context.Context, f *File, url, format string) error {
	pcm, stderr, err := s.ffmpeg(ctx, pcmRate*2*pcmMaxSeconds, url, "-loglevel", "info", "-f", format, "-i", url,
		"-vn", "-ac", "1", "-ar", strconv.Itoa(pcmRate), "-t", strconv.Itoa(pcmMaxSeconds), "-f", "s16le", "pipe:1")
	if err != nil {
		return err
	}
	samples := len(pcm) / 2
	if samples == 0 {
		return errors.New("media: no audio decoded")
	}
	f.DurationMS = int32(int64(samples) * 1000 / pcmRate)
	if samples >= pcmRate*pcmMaxSeconds {
		if d := parseDuration(stderr); d > 0 {
			f.DurationMS = d
		}
	}
	f.Waveform = waveform(pcm, waveformSamples)
	return s.saveEnriched(ctx, f)
}

// waveform reduces s16le PCM to n peaks scaled to 0..255.
func waveform(pcm []byte, n int) []byte {
	samples := len(pcm) / 2
	n = min(n, samples)
	peaks := make([]int, n)
	top := 1
	r := bufio.NewReader(bytes.NewReader(pcm))
	for i := range samples {
		var v int16
		if err := binary.Read(r, binary.LittleEndian, &v); err != nil {
			break
		}
		a := int(v)
		if a < 0 {
			a = -a
		}
		b := i * n / samples
		peaks[b] = max(peaks[b], a)
		top = max(top, a)
	}
	out := make([]byte, n)
	for i, p := range peaks {
		out[i] = byte(p * 255 / top)
	}
	return out
}

func (s *Service) saveEnriched(ctx context.Context, f *File) error {
	sizes, err := marshalSizes(f.Sizes)
	if err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE files SET width = $2, height = $3, duration_ms = $4, inline_thumb = $5, waveform = $6, sizes = $7 WHERE id = $1`,
		f.ID, f.Width, f.Height, f.DurationMS, nilIfEmpty(f.InlineThumb), nilIfEmpty(f.Waveform), sizes); err != nil {
		return fmt.Errorf("media: save enriched file: %w", err)
	}
	return nil
}
