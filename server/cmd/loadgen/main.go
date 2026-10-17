// Command loadgen is the load generator of the launch-readiness phase
// (round 1): fake people sign in through a fake IdP, sit in small groups,
// keep a realtime socket open and post at a steady pace, while it measures
// send -> ack (SendMessage answered) and send -> delivered (the other
// members' sockets got the message), step by step as the number of people
// grows, with the server's memory.
//
//	go run ./cmd/loadgen stack -accounts 2000
//	    a throwaway PostgreSQL, a fake IdP with accounts load0001.. and the
//	    real api on 127.0.0.1:4700 (sign-up limits off), for the dev machine
//	go run ./cmd/loadgen idp -accounts 2000 -secret-file s
//	    only the fake IdP, for a separate load-test tenant whose server
//	    trusts it (OIDC_ISSUER); the client secret is written to the file
//	go run ./cmd/loadgen run -api http://127.0.0.1:4700 -steps 100,300,1000
//	    the scenario against a running server; prints one line per step
//
// Never point it at a tenant with real people: it creates accounts, groups
// and messages.
package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: loadgen stack|idp|run [flags]")
		os.Exit(2)
	}
	var code int
	switch os.Args[1] {
	case "stack":
		code = stackMain(os.Args[2:])
	case "idp":
		code = idpMain(os.Args[2:])
	case "run":
		code = runMain(os.Args[2:])
	default:
		fmt.Fprintln(os.Stderr, "usage: loadgen stack|idp|run [flags]")
		code = 2
	}
	os.Exit(code)
}
