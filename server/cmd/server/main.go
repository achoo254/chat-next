// Command server is the single backend binary; each deployment runs one
// role of it, and every role scales on its own.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
)

// Roles are the processes the binary can run.
var Roles = []string{"api", "gateway", "worker", "botapi", "webhook"}

func main() {
	os.Exit(run(os.Args[1:], os.Stderr))
}

// run parses the command line and returns the process exit code.
func run(args []string, stderr io.Writer) int {
	flags := flag.NewFlagSet("server", flag.ContinueOnError)
	flags.SetOutput(stderr)
	role := flags.String("role", "", "role to run: "+strings.Join(Roles, ", "))
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if !slices.Contains(Roles, *role) {
		_, _ = fmt.Fprintf(stderr, "unknown role %q; choose one of: %s\n", *role, strings.Join(Roles, ", "))
		return 2
	}
	_, _ = fmt.Fprintf(stderr, "role %q has no implementation yet\n", *role)
	return 1
}
