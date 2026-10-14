package protoids

import (
	"errors"
	"strings"
	"testing"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/internal/ids"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
)

const tooBig = ids.MaxSafeID + 1

// Every 64-bit integer field of the client contract must be generated as a JS
// number; a field without the option would reach TypeScript as bigint.
func TestEveryContract64BitFieldIsJSNumber(t *testing.T) {
	// Referencing the package ensures its descriptors are registered.
	_ = appv1.File_app_v1_messages_proto

	var files, fields int
	protoregistry.GlobalFiles.RangeFilesByPackage("app.v1", func(fd protoreflect.FileDescriptor) bool {
		files++
		forEachMessage(fd.Messages(), func(md protoreflect.MessageDescriptor) {
			for i := range md.Fields().Len() {
				f := md.Fields().Get(i)
				if !is64BitInteger(f.Kind()) {
					continue
				}
				fields++
				opts, _ := f.Options().(*descriptorpb.FieldOptions)
				if opts.GetJstype() != descriptorpb.FieldOptions_JS_NUMBER {
					t.Errorf("%s (%s): 64-bit integer field lacks [jstype = JS_NUMBER]", f.FullName(), fd.Path())
				}
			}
		})
		return true
	})
	if files < 10 || fields == 0 {
		t.Fatalf("scanned %d files and %d 64-bit fields; contract descriptors not registered", files, fields)
	}
}

func forEachMessage(mds protoreflect.MessageDescriptors, visit func(protoreflect.MessageDescriptor)) {
	for i := range mds.Len() {
		md := mds.Get(i)
		visit(md)
		forEachMessage(md.Messages(), visit)
	}
}

func is64BitInteger(k protoreflect.Kind) bool {
	switch k {
	case protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind,
		protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
		return true
	default:
		return false
	}
}

func TestCheckFindsDeepRepeatedViolation(t *testing.T) {
	m := &appv1.GetHistoryResponse{
		Messages: []*appv1.Message{
			{ChatId: 1, Seq: 1},
			{ChatId: 1, Seq: 2, Action: &appv1.MessageAction{
				Kind: &appv1.MessageAction_MembersAdded{MembersAdded: &appv1.ActionMembersAdded{
					UserIds: []int64{7, tooBig},
				}},
			}},
		},
	}
	wantViolation(t, m, "app.v1.GetHistoryResponse: messages[1].action.members_added.user_ids[1] = 9007199254740992")
}

func TestCheckFindsViolationInsideOneof(t *testing.T) {
	m := &appv1.GetDifferenceResponse{
		State: &appv1.State{Pts: 10},
		Result: &appv1.GetDifferenceResponse_Full{Full: &appv1.DifferenceUpdates{
			Updates: []*appv1.Update{{
				Pts: 10,
				Kind: &appv1.Update_MessageNew{MessageNew: &appv1.UpdateMessageNew{
					Message: &appv1.Message{ChatId: 3, Seq: -tooBig},
				}},
			}},
		}},
	}
	wantViolation(t, m, "full.updates[0].message_new.message.seq = -9007199254740992")
}

func TestCheckFindsViolationInLargeChats(t *testing.T) {
	m := &appv1.GetDifferenceResponse{
		Result: &appv1.GetDifferenceResponse_Slice{Slice: &appv1.DifferenceUpdates{
			LargeChats: []*appv1.LargeChatState{{ChatId: 1, ChatPts: 2, TopSeq: tooBig}},
		}},
	}
	wantViolation(t, m, "slice.large_chats[0].top_seq")
}

func TestCheckPassesValidMessages(t *testing.T) {
	for _, m := range []proto.Message{
		nil,
		(*appv1.Message)(nil),
		&appv1.Message{},
		&appv1.GetHistoryResponse{Messages: []*appv1.Message{{
			ChatId: ids.MaxSafeID, Seq: ids.MaxSafeID, FromId: -ids.MaxSafeID, Date: 1_760_000_000,
			Action: &appv1.MessageAction{Kind: &appv1.MessageAction_MemberRemoved{
				MemberRemoved: &appv1.ActionMemberRemoved{UserId: ids.MaxSafeID, By: 1},
			}},
		}}},
		&appv1.GetDifferenceResponse{
			State: &appv1.State{Pts: ids.MaxSafeID, ServerEpoch: 1},
			Result: &appv1.GetDifferenceResponse_Full{Full: &appv1.DifferenceUpdates{
				Updates:    []*appv1.Update{{Pts: 5, Kind: &appv1.Update_MessageDelete{MessageDelete: &appv1.UpdateMessageDelete{ChatId: 1, Seqs: []int64{1, ids.MaxSafeID}}}}},
				LargeChats: []*appv1.LargeChatState{{ChatId: 9, ChatPts: 4, TopSeq: 100}},
			}},
		},
	} {
		if err := Check(m); err != nil {
			t.Errorf("Check(%T) = %v, want nil", m, err)
		}
	}
}

// The contract has no unsigned 64-bit or int64-map fields today; a dynamic
// message covers those branches so a future field is guarded too.
func TestCheckUnsignedAndMapFields(t *testing.T) {
	md := dynamicDescriptor(t)
	newMsg := func() *dynamicpb.Message { return dynamicpb.NewMessage(md) }

	valid := newMsg()
	valid.Set(md.Fields().ByName("size"), protoreflect.ValueOfUint64(uint64(ids.MaxSafeID)))
	valid.Mutable(md.Fields().ByName("counts")).Map().Set(
		protoreflect.ValueOfString("a").MapKey(), protoreflect.ValueOfInt64(-ids.MaxSafeID))
	if err := Check(valid); err != nil {
		t.Fatalf("Check(valid) = %v", err)
	}

	unsigned := newMsg()
	unsigned.Set(md.Fields().ByName("size"), protoreflect.ValueOfUint64(uint64(tooBig)))
	wantViolation(t, unsigned, "test.Probe: size = 9007199254740992")

	mapValue := newMsg()
	mapValue.Mutable(md.Fields().ByName("counts")).Map().Set(
		protoreflect.ValueOfString("k").MapKey(), protoreflect.ValueOfInt64(tooBig))
	wantViolation(t, mapValue, "counts[k] = 9007199254740992")

	mapKey := newMsg()
	mapKey.Mutable(md.Fields().ByName("by_id")).Map().Set(
		protoreflect.ValueOfInt64(-tooBig).MapKey(), protoreflect.ValueOfString("x"))
	wantViolation(t, mapKey, "by_id[-9007199254740992] = -9007199254740992")
}

// dynamicDescriptor builds:
//
//	message Probe { uint64 size = 1; map<string, int64> counts = 2; map<int64, string> by_id = 3; }
func dynamicDescriptor(t *testing.T) protoreflect.MessageDescriptor {
	t.Helper()
	optional := descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum()
	repeated := descriptorpb.FieldDescriptorProto_LABEL_REPEATED.Enum()
	scalar := func(name string, num int32, typ descriptorpb.FieldDescriptorProto_Type) *descriptorpb.FieldDescriptorProto {
		return &descriptorpb.FieldDescriptorProto{
			Name: proto.String(name), Number: proto.Int32(num), Label: optional, Type: typ.Enum(),
		}
	}
	mapField := func(name string, num int32, entry string) *descriptorpb.FieldDescriptorProto {
		return &descriptorpb.FieldDescriptorProto{
			Name: proto.String(name), Number: proto.Int32(num), Label: repeated,
			Type:     descriptorpb.FieldDescriptorProto_TYPE_MESSAGE.Enum(),
			TypeName: proto.String(".test.Probe." + entry),
		}
	}
	entry := func(name string, key, value descriptorpb.FieldDescriptorProto_Type) *descriptorpb.DescriptorProto {
		return &descriptorpb.DescriptorProto{
			Name:    proto.String(name),
			Field:   []*descriptorpb.FieldDescriptorProto{scalar("key", 1, key), scalar("value", 2, value)},
			Options: &descriptorpb.MessageOptions{MapEntry: proto.Bool(true)},
		}
	}
	file := &descriptorpb.FileDescriptorProto{
		Name:    proto.String("protoids_probe.proto"),
		Package: proto.String("test"),
		Syntax:  proto.String("proto3"),
		MessageType: []*descriptorpb.DescriptorProto{{
			Name: proto.String("Probe"),
			Field: []*descriptorpb.FieldDescriptorProto{
				scalar("size", 1, descriptorpb.FieldDescriptorProto_TYPE_UINT64),
				mapField("counts", 2, "CountsEntry"),
				mapField("by_id", 3, "ByIdEntry"),
			},
			NestedType: []*descriptorpb.DescriptorProto{
				entry("CountsEntry", descriptorpb.FieldDescriptorProto_TYPE_STRING, descriptorpb.FieldDescriptorProto_TYPE_INT64),
				entry("ByIdEntry", descriptorpb.FieldDescriptorProto_TYPE_INT64, descriptorpb.FieldDescriptorProto_TYPE_STRING),
			},
		}},
	}
	fd, err := protodesc.NewFile(file, nil)
	if err != nil {
		t.Fatalf("build probe descriptor: %v", err)
	}
	return fd.Messages().ByName("Probe")
}

func wantViolation(t *testing.T, m proto.Message, want string) {
	t.Helper()
	err := Check(m)
	if !errors.Is(err, ErrUnsafeInteger) {
		t.Fatalf("Check() = %v, want ErrUnsafeInteger", err)
	}
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("Check() = %q, want it to contain %q", err, want)
	}
}
