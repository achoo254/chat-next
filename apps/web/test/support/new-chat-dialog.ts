// "Chat mới" opens at once as a shell and its content arrives with the
// create-dialogs chunk, in a new dialog element: tests act on that one.
import { screen } from "@testing-library/react";

/** The loaded "Chat mới" dialog (the one with the people search). */
export async function newChatDialog(): Promise<HTMLElement> {
	const search = await screen.findByRole("searchbox", { name: "Tìm người" }, { timeout: 8000 });
	const dialog = search.closest("dialog");
	if (dialog === null) throw new Error("the people search is not inside a dialog");
	return dialog;
}
