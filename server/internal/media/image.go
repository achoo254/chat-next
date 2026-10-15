package media

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"slices"

	appv1 "app.local/server/gen/app/v1"
	"golang.org/x/image/webp"
	"golang.org/x/sync/semaphore"
)

// Image limits. Decoding allocates by the declared dimensions, so the
// dimensions are checked (DecodeConfig) before any pixel is decoded: a
// small file that claims a huge canvas (decompression bomb) is refused.
const (
	maxImagePixels = 40_000_000
	maxImageSide   = 16384
	// decodeBudget bounds the memory of all decodes running at once in the
	// process (the api runs under a pm2 memory cap).
	decodeBudget = 256 << 20
	// inlineThumbSide is the longest side of a server-made inline thumb.
	inlineThumbSide = 40
	// inlineThumbMax bounds an inline thumb (client or server).
	inlineThumbMax = 2048
	// clientThumbSide bounds the dimensions of a client inline thumb.
	clientThumbSide = 64
)

// renditionSides are the longest sides of the S, M and X renditions.
var renditionSides = []struct {
	typ  appv1.MediaSizeType
	side int
}{
	{appv1.MediaSizeType_MEDIA_SIZE_TYPE_S, 320},
	{appv1.MediaSizeType_MEDIA_SIZE_TYPE_M, 800},
	{appv1.MediaSizeType_MEDIA_SIZE_TYPE_X, 1280},
}

var (
	// errImageTooLarge reports an image above the pixel or side limits.
	errImageTooLarge = errors.New("media: image dimensions are too large")
	errNotImage      = errors.New("media: not a decodable image")
)

// decoder decodes untrusted images within a shared memory budget.
type decoder struct {
	budget *semaphore.Weighted
}

func newDecoder() *decoder {
	return &decoder{budget: semaphore.NewWeighted(decodeBudget)}
}

// imageConfig reads the dimensions without decoding pixels.
func imageConfig(mime string, data []byte) (image.Config, error) {
	r := bytes.NewReader(data)
	var (
		cfg image.Config
		err error
	)
	switch mime {
	case mimeJPEG:
		cfg, err = jpeg.DecodeConfig(r)
	case mimePNG:
		cfg, err = png.DecodeConfig(r)
	case mimeGIF:
		cfg, err = gif.DecodeConfig(r)
	case mimeWebP:
		cfg, err = webp.DecodeConfig(r)
	default:
		return image.Config{}, errNotImage
	}
	if err != nil {
		return image.Config{}, fmt.Errorf("%w: %w", errNotImage, err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return image.Config{}, errNotImage
	}
	if cfg.Width > maxImageSide || cfg.Height > maxImageSide || int64(cfg.Width)*int64(cfg.Height) > maxImagePixels {
		return image.Config{}, errImageTooLarge
	}
	return cfg, nil
}

// bytesPerPixel estimates the decoded size of a color model.
func bytesPerPixel(m color.Model) int64 {
	switch m {
	case color.RGBA64Model, color.NRGBA64Model:
		return 8
	case color.GrayModel:
		return 1
	case color.Gray16Model:
		return 2
	}
	return 4
}

// decode decodes the first frame within the memory budget (waiting for
// room, until ctx ends).
func (d *decoder) decode(ctx context.Context, mime string, data []byte) (image.Image, error) {
	cfg, err := imageConfig(mime, data)
	if err != nil {
		return nil, err
	}
	weight := int64(cfg.Width) * int64(cfg.Height) * bytesPerPixel(cfg.ColorModel)
	weight = min(weight, decodeBudget)
	if err := d.budget.Acquire(ctx, weight); err != nil {
		return nil, fmt.Errorf("media: waiting to decode: %w", err)
	}
	defer d.budget.Release(weight)
	r := bytes.NewReader(data)
	var img image.Image
	switch mime {
	case mimeJPEG:
		img, err = jpeg.Decode(r)
	case mimePNG:
		img, err = png.Decode(r)
	case mimeGIF:
		img, err = gif.Decode(r)
	case mimeWebP:
		img, err = webp.Decode(r)
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errNotImage, err)
	}
	return img, nil
}

// fit returns w x h scaled down so the longest side is at most side.
func fit(w, h, side int) (int, int) {
	if w <= side && h <= side {
		return w, h
	}
	if w >= h {
		return side, max(1, h*side/w)
	}
	return max(1, w*side/h), side
}

// orientedSize is the display size of a w x h image with EXIF orientation.
func orientedSize(w, h, orientation int) (int, int) {
	if orientation >= 5 && orientation <= 8 {
		return h, w
	}
	return w, h
}

// downscale resizes src to w x h (no larger than src) by averaging the
// source pixels each target pixel covers. Memory is the target image plus
// one row of sums, whatever the source size.
func downscale(src image.Image, w, h int) *image.RGBA {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	sums := make([][4]uint64, w)
	counts := make([]uint64, w)
	at := pixelReader(src)
	for y := range h {
		y0, y1 := y*sh/h, max((y+1)*sh/h, y*sh/h+1)
		clear(sums)
		clear(counts)
		for sy := y0; sy < y1; sy++ {
			for x := range w {
				x0, x1 := x*sw/w, max((x+1)*sw/w, x*sw/w+1)
				for sx := x0; sx < x1; sx++ {
					r, g, bl, a := at(b.Min.X+sx, b.Min.Y+sy)
					sums[x][0] += uint64(r)
					sums[x][1] += uint64(g)
					sums[x][2] += uint64(bl)
					sums[x][3] += uint64(a)
					counts[x]++
				}
			}
		}
		row := dst.Pix[y*dst.Stride:]
		for x := range w {
			n := counts[x]
			a := sums[x][3] / n
			// Composite over white, so transparent images get a light
			// background in JPEG renditions.
			for c := range 3 {
				v := sums[x][c]/n + (0xFFFF - a)
				row[x*4+c] = uint8(min(v, 0xFFFF) >> 8)
			}
			row[x*4+3] = 0xFF
		}
	}
	return dst
}

// pixelReader returns a premultiplied 16-bit RGBA reader with fast paths
// for the decoders' common image types.
func pixelReader(src image.Image) func(x, y int) (r, g, b, a uint32) {
	switch img := src.(type) {
	case *image.YCbCr:
		return func(x, y int) (uint32, uint32, uint32, uint32) {
			yi, ci := img.YOffset(x, y), img.COffset(x, y)
			r, g, b := color.YCbCrToRGB(img.Y[yi], img.Cb[ci], img.Cr[ci])
			return uint32(r) * 0x101, uint32(g) * 0x101, uint32(b) * 0x101, 0xFFFF
		}
	case *image.RGBA:
		return func(x, y int) (uint32, uint32, uint32, uint32) {
			i := img.PixOffset(x, y)
			p := img.Pix[i : i+4]
			return uint32(p[0]) * 0x101, uint32(p[1]) * 0x101, uint32(p[2]) * 0x101, uint32(p[3]) * 0x101
		}
	case *image.NRGBA:
		return func(x, y int) (uint32, uint32, uint32, uint32) {
			i := img.PixOffset(x, y)
			p := img.Pix[i : i+4]
			a := uint32(p[3]) * 0x101
			return uint32(p[0]) * a / 0xFF, uint32(p[1]) * a / 0xFF, uint32(p[2]) * a / 0xFF, a
		}
	case *image.Gray:
		return func(x, y int) (uint32, uint32, uint32, uint32) {
			v := uint32(img.Pix[img.PixOffset(x, y)]) * 0x101
			return v, v, v, 0xFFFF
		}
	}
	return func(x, y int) (uint32, uint32, uint32, uint32) { return src.At(x, y).RGBA() }
}

// orient applies an EXIF orientation (2..8) to a small image.
func orient(src *image.RGBA, orientation int) *image.RGBA {
	if orientation < 2 || orientation > 8 {
		return src
	}
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	ow, oh := orientedSize(w, h, orientation)
	dst := image.NewRGBA(image.Rect(0, 0, ow, oh))
	for y := range h {
		for x := range w {
			var dx, dy int
			switch orientation {
			case 2:
				dx, dy = w-1-x, y
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dx, dy = x, h-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			}
			si, di := src.PixOffset(x, y), dst.PixOffset(dx, dy)
			copy(dst.Pix[di:di+4], src.Pix[si:si+4])
		}
	}
	return dst
}

func encodeJPEG(img image.Image, quality int) ([]byte, error) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, fmt.Errorf("media: encode jpeg: %w", err)
	}
	return buf.Bytes(), nil
}

// rendition is an encoded downscaled copy of an image.
type rendition struct {
	typ  appv1.MediaSizeType
	w, h int
	data []byte
}

// imageDerivatives are what a decoded image yields: renditions smaller
// than the original, and the inline thumb.
type imageDerivatives struct {
	width, height int // display size
	renditions    []rendition
	inlineThumb   []byte
}

// derive makes the renditions up to maxType (S, M or X) and the inline
// thumb of a decoded image shown with orientation. The largest target is
// scaled from the source and each smaller one from the previous result, so
// a big photo is read once.
func derive(img image.Image, orientation int, maxType appv1.MediaSizeType) (*imageDerivatives, error) {
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	dw, dh := orientedSize(w, h, orientation)
	out := &imageDerivatives{width: dw, height: dh}
	type target struct {
		typ  appv1.MediaSizeType
		side int
	}
	var targets []target
	for _, r := range renditionSides {
		if r.typ > maxType || (dw <= r.side && dh <= r.side) {
			break // later sizes are larger still
		}
		targets = append(targets, target{r.typ, r.side})
	}
	base := img
	thumbBase := img
	for i := len(targets) - 1; i >= 0; i-- {
		tw, th := fit(w, h, targets[i].side)
		small := downscale(base, tw, th)
		base, thumbBase = small, small
		shown := orient(small, orientation)
		data, err := encodeJPEG(shown, 85)
		if err != nil {
			return nil, err
		}
		out.renditions = append(out.renditions, rendition{typ: targets[i].typ, w: shown.Bounds().Dx(), h: shown.Bounds().Dy(), data: data})
	}
	slices.Reverse(out.renditions)
	tw, th := fit(w, h, inlineThumbSide)
	thumb, err := encodeJPEG(orient(downscale(thumbBase, tw, th), orientation), 40)
	if err != nil {
		return nil, err
	}
	if len(thumb) <= inlineThumbMax {
		out.inlineThumb = thumb
	}
	return out, nil
}

// normalizeClientThumb checks a client inline thumb (a tiny raster image)
// and re-encodes it as JPEG, dropping anything but pixels. nil input or an
// unusable thumb yields nil.
func normalizeClientThumb(data []byte) []byte {
	if len(data) == 0 || len(data) > inlineThumbMax {
		return nil
	}
	mime := Sniff(data)
	cfg, err := imageConfig(mime, data)
	if err != nil || cfg.Width > clientThumbSide || cfg.Height > clientThumbSide {
		return nil
	}
	var img image.Image
	r := bytes.NewReader(data)
	switch mime {
	case mimeJPEG:
		img, err = jpeg.Decode(r)
	case mimePNG:
		img, err = png.Decode(r)
	case mimeWebP:
		img, err = webp.Decode(r)
	default:
		return nil
	}
	if err != nil {
		return nil
	}
	out, err := encodeJPEG(downscale(img, cfg.Width, cfg.Height), 40)
	if err != nil || len(out) > inlineThumbMax {
		return nil
	}
	return out
}
