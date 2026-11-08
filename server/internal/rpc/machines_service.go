package rpc

import (
	"context"
	"errors"
	"log/slog"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
)

// machinesService implements MachinesService: the caller's directory of
// machines running chat-agent (ADR 0013). The agent's own calls are served
// by package machineapi.
type machinesService struct {
	appv1connect.UnimplementedMachinesServiceHandler
	store    *store.Store
	tenantID string
	logger   *slog.Logger
}

func errMachineNotFound() error {
	return connect.NewError(connect.CodeNotFound, errors.New("machine not found"))
}

func errBadMachineName() error {
	return connect.NewError(connect.CodeInvalidArgument, errors.New("name must be 1 to 64 characters without control characters"))
}

func (s *machinesService) CreateInstallCode(ctx context.Context, req *connect.Request[appv1.CreateInstallCodeRequest]) (*connect.Response[appv1.CreateInstallCodeResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	code, expires, err := s.store.CreateInstallCode(ctx, s.tenantID, sess.UserID)
	switch {
	case errors.Is(err, store.ErrTooManyInstallCodes):
		return nil, connect.NewError(connect.CodeResourceExhausted,
			errors.New("too_many_install_codes: use or let expire an earlier install code first"))
	case err != nil:
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.CreateInstallCodeResponse{Code: code, ExpiresAt: expires.Unix()}), nil
}

func (s *machinesService) ListMachines(ctx context.Context, req *connect.Request[appv1.ListMachinesRequest]) (*connect.Response[appv1.ListMachinesResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	machines, err := s.store.ListMachines(ctx, s.tenantID, sess.UserID)
	if err != nil {
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	out := make([]*appv1.Machine, len(machines))
	for i, m := range machines {
		out[i] = machineProto(m)
	}
	return connect.NewResponse(&appv1.ListMachinesResponse{Machines: out}), nil
}

func (s *machinesService) RenameMachine(ctx context.Context, req *connect.Request[appv1.RenameMachineRequest]) (*connect.Response[appv1.RenameMachineResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	name, ok := store.CleanMachineName(req.Msg.GetName())
	if !ok {
		return nil, errBadMachineName()
	}
	m, err := s.store.RenameMachine(ctx, s.tenantID, sess.UserID, req.Msg.GetMachineId(), name)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return nil, errMachineNotFound()
	case err != nil:
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.RenameMachineResponse{Machine: machineProto(m)}), nil
}

func (s *machinesService) RevokeMachine(ctx context.Context, req *connect.Request[appv1.RevokeMachineRequest]) (*connect.Response[appv1.RevokeMachineResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	err = s.store.RevokeMachine(ctx, s.tenantID, sess.UserID, req.Msg.GetMachineId())
	switch {
	case errors.Is(err, store.ErrNotFound):
		return nil, errMachineNotFound()
	case err != nil:
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.RevokeMachineResponse{}), nil
}

func (s *machinesService) RevokeDevice(ctx context.Context, req *connect.Request[appv1.RevokeDeviceRequest]) (*connect.Response[appv1.RevokeDeviceResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	key := req.Msg.GetDevicePublicKey()
	if len(key) != store.MachineKeyLen {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("device_public_key must be 32 bytes"))
	}
	err = s.store.RevokeMachineDevice(ctx, s.tenantID, sess.UserID, req.Msg.GetMachineId(), key)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return nil, errMachineNotFound()
	case err != nil:
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.RevokeDeviceResponse{}), nil
}

func machineProto(m store.Machine) *appv1.Machine {
	return &appv1.Machine{
		Id: m.ID, Name: m.Name, Os: m.OS, Arch: m.Arch, AgentVersion: m.AgentVersion, ClaudeVersion: m.ClaudeVersion,
		PublicKey: m.PublicKey, TunnelUrl: m.TunnelURL, CreatedAt: m.CreatedAt.Unix(), LastSeenAt: m.LastSeenAt.Unix(),
	}
}
