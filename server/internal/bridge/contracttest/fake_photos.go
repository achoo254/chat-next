package contracttest

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strconv"

	"app.local/server/internal/bridge"
	"app.local/server/internal/bridge/feature"
)

// fakePhotoRef starts the media ref of a group's photo in the fake.
const fakePhotoRef = "group-photo:"

type fakeStream struct {
	*bytes.Reader
	size int64
}

func (s *fakeStream) Close() error     { return nil }
func (s *fakeStream) MimeType() string { return "image/jpeg" }
func (s *fakeStream) Size() int64      { return s.size }

// SetGroupPhotoRemotely makes data the photo of a group in the app, as if somebody
// there had changed it (nil removes it); GroupInfos then names it by id.
func (f *Fake) SetGroupPhotoRemotely(conv, id string, data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	info := f.infos[conv]
	info.PhotoID, info.PhotoRef = id, ""
	if data != nil {
		info.PhotoRef = fakePhotoRef + conv
	}
	f.infos[conv] = info
	f.photoBytes[conv] = data
}

// PhotoCalls lists the calls Chat made to change a group photo, as "<conv>:<size>" (0 to remove).
func (f *Fake) PhotoCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.photoCalls...)
}

// PhotoFetches is how many times the bytes of a group photo were read.
func (f *Fake) PhotoFetches() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.photoFetches
}

// SetGroupPhoto implements bridge.PhotoWriter.
func (f *Fake) SetGroupPhoto(_ context.Context, _ bridge.Account, conv string, photo *bridge.OutMedia) (string, error) {
	var data []byte
	if photo != nil {
		rc, err := photo.Open()
		if err != nil {
			return "", err
		}
		data, err = io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			return "", err
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.support[feature.Info].Out {
		return "", fmt.Errorf("%w: this app does not take the info of a group from Chat", bridge.ErrNotAllowed)
	}
	if err := f.nextPinFailure(); err != nil {
		return "", err
	}
	f.photoCalls = append(f.photoCalls, conv+":"+strconv.Itoa(len(data)))
	info := f.infos[conv]
	info.PhotoID, info.PhotoRef = "", ""
	if data != nil {
		f.nextID++
		info.PhotoID, info.PhotoRef = "p"+strconv.Itoa(f.nextID), fakePhotoRef+conv
	}
	f.infos[conv] = info
	f.photoBytes[conv] = data
	return info.PhotoID, nil
}

var _ bridge.PhotoWriter = (*Fake)(nil)

// SetPersonPhoto stores the bytes FetchMedia gives for a person's photo ref (a
// Participant's PhotoRef); nil data makes the fetch fail.
func (f *Fake) SetPersonPhoto(ref string, data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.personPhotos == nil {
		f.personPhotos = map[string][]byte{}
	}
	f.personPhotos[ref] = data
}

// SetPersonPhotoReadError makes the stream of a person's photo ref fail with err once it
// is read, as a download that streams does (the call itself succeeds).
func (f *Fake) SetPersonPhotoReadError(ref string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.personPhotoReadErrs == nil {
		f.personPhotoReadErrs = map[string]error{}
	}
	f.personPhotoReadErrs[ref] = err
}

// failingStream is a download that fails when read.
type failingStream struct{ err error }

func (s *failingStream) Read([]byte) (int, error) { return 0, s.err }
func (s *failingStream) Close() error             { return nil }
func (s *failingStream) MimeType() string         { return "image/jpeg" }
func (s *failingStream) Size() int64              { return 0 }
