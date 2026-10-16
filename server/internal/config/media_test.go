package config

import (
	"strings"
	"testing"
)

func mediaEnv() map[string]string {
	env := validEnv()
	env["MEDIA_PUBLIC_URL"] = "https://media-chat.hoandat.com"
	return env
}

func s3Env() map[string]string {
	env := mediaEnv()
	env["MEDIA_STORAGE"] = "s3"
	env["MEDIA_S3_ENDPOINT"] = "https://drive-storagehns3st.000nethost.com"
	env["MEDIA_S3_REGION"] = "hn-storage"
	env["MEDIA_S3_BUCKET"] = "chat-media"
	env["S3_ACCESS_KEY"] = "AKIA"
	env["S3_SECRET_KEY"] = secret
	return env
}

func TestMediaDisabledByDefault(t *testing.T) {
	c, err := Load(lookupFrom(validEnv()))
	if err != nil || c.Media != nil {
		t.Fatalf("media = %+v, %v", c.Media, err)
	}
}

func TestMediaFilesystemDefaults(t *testing.T) {
	c, err := Load(lookupFrom(mediaEnv()))
	if err != nil {
		t.Fatal(err)
	}
	m := c.Media
	if m == nil || m.Storage != StorageFilesystem || m.Root != DefaultMediaRoot || m.MinFreeBytes != DefaultMinFreeBytes ||
		m.UploadMode != UploadProxy || m.UploadMaxBytes != DefaultUploadMaxBytes || m.UserQuotaBytes != DefaultUserQuotaBytes ||
		m.PublicOrigin() != "https://media-chat.hoandat.com" {
		t.Fatalf("media = %+v", m)
	}
	if m.ExportDir != DefaultMediaRoot+"/exports" {
		t.Fatalf("export dir = %q", m.ExportDir)
	}
	env := mediaEnv()
	env["MEDIA_ROOT"] = "/srv/chat-media"
	env["MEDIA_MIN_FREE_BYTES"] = "1073741824"
	env["MEDIA_UPLOAD_MAX_BYTES"] = "536870912"
	c, err = Load(lookupFrom(env))
	if err != nil || c.Media.Root != "/srv/chat-media" || c.Media.MinFreeBytes != 1<<30 || c.Media.UploadMaxBytes != 512<<20 {
		t.Fatalf("overrides: %+v %v", c.Media, err)
	}
}

func TestMediaS3(t *testing.T) {
	env := s3Env()
	env["MEDIA_UPLOAD_MODE"] = "direct"
	c, err := Load(lookupFrom(env))
	if err != nil {
		t.Fatal(err)
	}
	m := c.Media
	if m.Storage != StorageS3 || !m.PathStyle || m.Region != "hn-storage" || m.UploadMode != UploadDirect ||
		m.PublicEndpoint.Host != "drive-storagehns3st.000nethost.com" || m.Bucket != "chat-media" {
		t.Fatalf("media = %+v", m)
	}
}

func TestMediaConfigErrors(t *testing.T) {
	cases := map[string]struct {
		base func() map[string]string
		mod  func(map[string]string)
	}{
		"MEDIA_PUBLIC_URL":       {mediaEnv, func(e map[string]string) { e["MEDIA_PUBLIC_URL"] = "https://chat.hoandat.com" }},
		"MEDIA_STORAGE":          {mediaEnv, func(e map[string]string) { e["MEDIA_STORAGE"] = "nfs" }},
		"MEDIA_ROOT":             {mediaEnv, func(e map[string]string) { e["MEDIA_ROOT"] = "media" }},
		"MEDIA_MIN_FREE_BYTES":   {mediaEnv, func(e map[string]string) { e["MEDIA_MIN_FREE_BYTES"] = "-1" }},
		"MEDIA_UPLOAD_MODE":      {mediaEnv, func(e map[string]string) { e["MEDIA_UPLOAD_MODE"] = "direct" }},
		"MEDIA_UPLOAD_MAX_BYTES": {mediaEnv, func(e map[string]string) { e["MEDIA_UPLOAD_MAX_BYTES"] = "6000000000" }},
		"MEDIA_FFMPEG_PATH":      {mediaEnv, func(e map[string]string) { e["MEDIA_FFMPEG_PATH"] = "ffmpeg" }},
		"MEDIA_S3_BUCKET":        {s3Env, func(e map[string]string) { delete(e, "MEDIA_S3_BUCKET") }},
		"S3_SECRET_KEY":          {s3Env, func(e map[string]string) { delete(e, "S3_SECRET_KEY") }},
		"MEDIA_S3_ENDPOINT":      {s3Env, func(e map[string]string) { e["MEDIA_S3_ENDPOINT"] = "http://s3.example.com" }},
		"MEDIA_S3_PREFIX":        {s3Env, func(e map[string]string) { e["MEDIA_S3_PREFIX"] = "../x" }},
	}
	for name, c := range cases {
		env := c.base()
		c.mod(env)
		_, err := Load(lookupFrom(env))
		if err == nil || !strings.Contains(err.Error(), name) || strings.Contains(err.Error(), secret) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestDataExportDir(t *testing.T) {
	env := s3Env()
	c, err := Load(lookupFrom(env))
	if err != nil || c.Media.ExportDir != "" {
		t.Fatalf("s3 without DATA_EXPORT_DIR: %q %v", c.Media.ExportDir, err)
	}
	env["DATA_EXPORT_DIR"] = "/srv/chat-exports"
	if c, err = Load(lookupFrom(env)); err != nil || c.Media.ExportDir != "/srv/chat-exports" {
		t.Fatalf("explicit: %+v %v", c.Media, err)
	}
	env["DATA_EXPORT_DIR"] = "exports"
	if _, err := Load(lookupFrom(env)); err == nil || !strings.Contains(err.Error(), "DATA_EXPORT_DIR") {
		t.Fatalf("relative: %v", err)
	}
}
