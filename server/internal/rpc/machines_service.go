package rpc

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	appv1 "app.local/server/gen/app/v1"
	"app.local/server/gen/app/v1/appv1connect"
	"app.local/server/internal/keyproof"
	"app.local/server/internal/push"
	"app.local/server/internal/store"
	"connectrpc.com/connect"
)

// MachineGrants revokes the IdP grants of removed machines
// (agentgrant.Revoker); Kick asks it to work now.
type MachineGrants interface {
	Kick()
}

// DeviceNotifier pushes the "new device" notice to the owner's push
// registrations (push.Service).
type DeviceNotifier interface {
	NotifyAccountDevice(ctx context.Context, userID int64, n push.AccountDeviceNotice) (int, error)
}

// SessionRevoker revokes one of the user's sessions (auth.Sessions.Revoke):
// in the store, then its IdP grant.
type SessionRevoker interface {
	Revoke(ctx context.Context, userID, sessionID int64) error
}

// deviceNoticeTimeout bounds queueing the "new device" push.
const deviceNoticeTimeout = 5 * time.Second

// machinesService implements MachinesService: the caller's directory of
// machines running tunelo and the account's device keys (ADR 0013). The
// agent's own calls are served by package machineapi.
type machinesService struct {
	appv1connect.UnimplementedMachinesServiceHandler
	store     *store.Store
	sessions  SessionRevoker
	notifier  DeviceNotifier
	keyProofs *keyproof.Issuer
	grants    MachineGrants
	tenantID  string
	logger    *slog.Logger
}

func errMachineNotFound() error {
	return connect.NewError(connect.CodeNotFound, errors.New("machine not found"))
}

func errBadMachineName() error {
	return connect.NewError(connect.CodeInvalidArgument, errors.New("name must be 1 to 64 characters without control characters"))
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
	// The grant of the machine's sign-in is revoked in the background:
	// removing the machine never waits for the IdP.
	s.grants.Kick()
	return connect.NewResponse(&appv1.RevokeMachineResponse{}), nil
}

func (s *machinesService) GetDeviceKeyChallenge(ctx context.Context, req *connect.Request[appv1.GetDeviceKeyChallengeRequest]) (*connect.Response[appv1.GetDeviceKeyChallengeResponse], error) {
	if _, err := mustSession(ctx); err != nil {
		return nil, err
	}
	c, err := s.keyProofs.Challenge(keyproof.AccountDevice)
	if err != nil {
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	return connect.NewResponse(&appv1.GetDeviceKeyChallengeResponse{Challenge: c}), nil
}

func (s *machinesService) RegisterDevice(ctx context.Context, req *connect.Request[appv1.RegisterDeviceRequest]) (*connect.Response[appv1.RegisterDeviceResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	m := req.Msg
	if len(m.GetPublicKey()) != store.MachineKeyLen {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("public_key must be 32 bytes"))
	}
	name, ok := store.CleanMachineName(m.GetName())
	if !ok {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name must be 1 to 64 characters without control characters"))
	}
	platform, ok := store.CleanDevicePlatform(m.GetPlatform())
	if !ok {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("platform must be 1 to 32 characters of a-z, 0-9 and -"))
	}
	if err := s.keyProofs.Verify(keyproof.AccountDevice, m.GetPublicKey(), m.GetProof()); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied,
			errors.New("bad_key_proof: the proof of the device key does not check or its challenge expired; get a new challenge"))
	}
	dev, created, err := s.store.RegisterAccountDevice(ctx, s.tenantID, sess.UserID, sess.ID, store.NewAccountDevice{
		PublicKey: m.GetPublicKey(), Name: name, Platform: platform,
	})
	switch {
	case errors.Is(err, store.ErrDeviceRevoked):
		return nil, connect.NewError(connect.CodePermissionDenied,
			errors.New("device_revoked: this device key was revoked; generate a new key"))
	case errors.Is(err, store.ErrSessionDevicesRevoked):
		return nil, connect.NewError(connect.CodePermissionDenied,
			errors.New("session_devices_revoked: a device of this session was revoked; sign in again"))
	case errors.Is(err, store.ErrDeviceKeyInUse):
		return nil, connect.NewError(connect.CodeFailedPrecondition,
			errors.New("device_key_in_use: another session registered this key; generate a new key"))
	case errors.Is(err, store.ErrTooManyDevices):
		return nil, connect.NewError(connect.CodeResourceExhausted,
			fmt.Errorf("too_many_devices: an account has at most %d devices; revoke one first", store.MaxAccountDevices))
	case errors.Is(err, store.ErrNotFound):
		return nil, errUnauthenticated()
	case err != nil:
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	if created {
		s.logger.Info("account device registered", "user_id", sess.UserID, "session_id", sess.ID, "device_id", dev.ID,
			"platform", dev.Platform)
		s.notifyNewDevice(sess.UserID, dev)
	}
	return connect.NewResponse(&appv1.RegisterDeviceResponse{Device: accountDeviceProto(dev, sess.ID)}), nil
}

// notifyNewDevice queues the "new device" push; a failure is logged, never
// the caller's.
func (s *machinesService) notifyNewDevice(userID int64, dev store.AccountDevice) {
	ctx, cancel := context.WithTimeout(context.Background(), deviceNoticeTimeout)
	defer cancel()
	if _, err := s.notifier.NotifyAccountDevice(ctx, userID, push.AccountDeviceNotice{
		DeviceID: dev.ID, Name: dev.Name, Platform: dev.Platform, At: dev.CreatedAt,
	}); err != nil {
		s.logger.Warn("new device push failed", "user_id", userID, "device_id", dev.ID, "err", err)
	}
}

func (s *machinesService) ListDevices(ctx context.Context, req *connect.Request[appv1.ListDevicesRequest]) (*connect.Response[appv1.ListDevicesResponse], error) {
	sess, err := mustSession(ctx)
	if err != nil {
		return nil, err
	}
	list, err := s.store.ListAccountDevices(ctx, s.tenantID, sess.UserID)
	if err != nil {
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	out := make([]*appv1.AccountDevice, len(list))
	for i, d := range list {
		out[i] = accountDeviceProto(d, sess.ID)
	}
	return connect.NewResponse(&appv1.ListDevicesResponse{Devices: out}), nil
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
	sessionID, err := s.store.RevokeAccountDevice(ctx, s.tenantID, sess.UserID, key)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return nil, connect.NewError(connect.CodeNotFound, errors.New("device not found"))
	case err != nil:
		return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
	}
	// Revoking the key signs its session out, everywhere it is used. A
	// session that already ended is fine; a key revoked twice tries again,
	// so a failure here is repaired by calling RevokeDevice again.
	if sessionID != 0 {
		err := s.sessions.Revoke(ctx, sess.UserID, sessionID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return nil, internal(ctx, s.logger, req.Spec().Procedure, err)
		}
	}
	s.logger.Info("account device revoked", "user_id", sess.UserID, "session_id", sessionID)
	return connect.NewResponse(&appv1.RevokeDeviceResponse{}), nil
}

func machineProto(m store.Machine) *appv1.Machine {
	return &appv1.Machine{
		Id: m.ID, Name: m.Name, Os: m.OS, Arch: m.Arch, AgentVersion: m.AgentVersion,
		PublicKey: m.PublicKey, TunnelUrl: m.TunnelURL, CreatedAt: m.CreatedAt.Unix(), LastSeenAt: m.LastSeenAt.Unix(),
	}
}

func accountDeviceProto(d store.AccountDevice, callerSession int64) *appv1.AccountDevice {
	out := &appv1.AccountDevice{
		PublicKey: d.PublicKey, Name: d.Name, Platform: d.Platform, CreatedAt: d.CreatedAt.Unix(),
		LastSeenAt: d.LastSeenAt.Unix(), Current: d.SessionID != 0 && d.SessionID == callerSession,
	}
	if !d.RevokedAt.IsZero() {
		out.RevokedAt = d.RevokedAt.Unix()
	}
	return out
}
