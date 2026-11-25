// Where the AI's text can go from a session shown in the Chat app's AI panel
// («Đưa vào ô soạn tin», a Localman result's short copy): the chat's
// composer. Null on the AI Agent screens, which offer neither.
import { createContext } from "react";

/** Takes text for the chat's composer; `plain`: not the AI's markdown. Resolves true once it went in. */
export type UseText = (text: string, plain?: boolean) => Promise<boolean>;

export const UseTextContext = createContext<UseText | null>(null);
