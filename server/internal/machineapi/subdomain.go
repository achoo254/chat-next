package machineapi

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
)

// machineSubdomainHashChars is how many hex characters of the hash the
// subdomain keeps.
const machineSubdomainHashChars = 30

// MachineSubdomain is the subdomain Tunelo holds for the machine tunnel
// (kind "machine") of deviceID opened by the account ownerSub:
// "m-" + the first 30 hex characters of SHA-256(ownerSub "\n" deviceID).
// It must stay the formula of tunelo-server (localman-next,
// apps/tunelo-server/src/machine-subdomain.ts): only that account can open
// the name, so a tunnel address of this shape proves who opened it.
func MachineSubdomain(ownerSub, deviceID string) string {
	sum := sha256.Sum256([]byte(ownerSub + "\n" + deviceID))
	return "m-" + hex.EncodeToString(sum[:])[:machineSubdomainHashChars]
}

// machineDeviceID is the device id tunelo opens its machine tunnel with:
// "tunelo." + the machine id.
func machineDeviceID(machineID int64) string {
	return "tunelo." + strconv.FormatInt(machineID, 10)
}
