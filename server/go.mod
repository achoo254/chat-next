module app.local/server

go 1.26.4

require (
	github.com/rivo/uniseg v0.4.7
	golang.org/x/text v0.43.0
	google.golang.org/protobuf v1.36.12
)

tool google.golang.org/protobuf/cmd/protoc-gen-go
