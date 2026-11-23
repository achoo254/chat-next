// The room of a shell command (docs/office-wire.md, part 4): the command's
// class (activity/command-class.ts) told as one of three rooms. Git, deploys
// and copies to other hosts → POST; test, lint and typecheck runners → QA;
// anything else → SERVER.
import { OfficeRoom } from "@achoo254/chat-proto/remote/remote";
import { type CommandClass, commandClass } from "../activity/command-class.ts";

export { CHECK_COMMANDS, CHECK_SCRIPT } from "../activity/command-class.ts";

const ROOM_OF_CLASS: Record<CommandClass, OfficeRoom> = {
  check: OfficeRoom.QA,
  commit: OfficeRoom.POST,
  push: OfficeRoom.POST,
  git: OfficeRoom.POST,
  deploy: OfficeRoom.POST,
  shell: OfficeRoom.SERVER,
};

/** The room of a shell command line. */
export function classifyCommand(command: string): OfficeRoom {
  return ROOM_OF_CLASS[commandClass(command)];
}
