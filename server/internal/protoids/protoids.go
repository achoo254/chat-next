// Package protoids guards the JavaScript safe-integer contract of the wire
// protocol: every 64-bit integer the server serializes must fit in a JS
// number, i.e. lie within [-(2^53-1), 2^53-1].
//
// Check walks a message with protoreflect, so it covers every generated type
// without per-message code. The walk allocates only when it finds a
// violation.
package protoids

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"app.local/server/internal/ids"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// maxSafe is ids.MaxSafeID as an unsigned bound for uint64/fixed64 fields.
const maxSafe = uint64(ids.MaxSafeID)

// ErrUnsafeInteger reports a 64-bit integer field outside the JS safe range.
var ErrUnsafeInteger = errors.New("protoids: 64-bit integer outside the JS safe range ±(2^53-1)")

// Check returns an error wrapping ErrUnsafeInteger that names the field path
// (for example "messages[1].action.members_added.user_ids[0]") of the first
// int64, sint64, sfixed64, uint64 or fixed64 value found outside
// [-(2^53-1), 2^53-1]. Nested messages, repeated fields, map keys and values,
// oneofs and extensions are all visited. A nil message passes.
func Check(m proto.Message) error {
	if m == nil {
		return nil
	}
	msg := m.ProtoReflect()
	v := checkMessage(msg)
	if v == nil {
		return nil
	}
	return fmt.Errorf("%s: %s = %s: %w", msg.Descriptor().FullName(), v.path(), v.value, ErrUnsafeInteger)
}

// violation records the offending value; path segments are pushed while the
// recursion unwinds, so they are stored innermost first.
type violation struct {
	value    string
	segments []string
}

func (v *violation) push(segment string) {
	v.segments = append(v.segments, segment)
}

// path joins the segments outermost first: field names are separated by
// dots, index and key segments ("[3]") attach to the preceding name.
func (v *violation) path() string {
	var b strings.Builder
	for i := len(v.segments) - 1; i >= 0; i-- {
		seg := v.segments[i]
		if b.Len() > 0 && !strings.HasPrefix(seg, "[") {
			b.WriteByte('.')
		}
		b.WriteString(seg)
	}
	return b.String()
}

// checkMessage visits the populated fields of m. Range skips unset fields and
// unset oneof members, which hold no value to check.
func checkMessage(m protoreflect.Message) *violation {
	var bad *violation
	m.Range(func(fd protoreflect.FieldDescriptor, v protoreflect.Value) bool {
		bad = checkField(fd, v)
		if bad != nil {
			bad.push(fd.TextName())
		}
		return bad == nil
	})
	return bad
}

func checkField(fd protoreflect.FieldDescriptor, v protoreflect.Value) *violation {
	switch {
	case fd.IsList():
		list := v.List()
		for i := range list.Len() {
			if bad := checkValue(fd, list.Get(i)); bad != nil {
				bad.push("[" + strconv.Itoa(i) + "]")
				return bad
			}
		}
		return nil
	case fd.IsMap():
		var bad *violation
		v.Map().Range(func(k protoreflect.MapKey, mv protoreflect.Value) bool {
			bad = checkValue(fd.MapKey(), k.Value())
			if bad == nil {
				bad = checkValue(fd.MapValue(), mv)
			}
			if bad != nil {
				bad.push(fmt.Sprintf("[%v]", k.Interface()))
			}
			return bad == nil
		})
		return bad
	default:
		return checkValue(fd, v)
	}
}

// checkValue checks one singular value of the field's kind.
func checkValue(fd protoreflect.FieldDescriptor, v protoreflect.Value) *violation {
	switch fd.Kind() {
	case protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind:
		if n := v.Int(); n > ids.MaxSafeID || n < -ids.MaxSafeID {
			return &violation{value: strconv.FormatInt(n, 10)}
		}
	case protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
		if n := v.Uint(); n > maxSafe {
			return &violation{value: strconv.FormatUint(n, 10)}
		}
	case protoreflect.MessageKind, protoreflect.GroupKind:
		return checkMessage(v.Message())
	default:
		// Other kinds cannot exceed the JS safe range.
	}
	return nil
}
