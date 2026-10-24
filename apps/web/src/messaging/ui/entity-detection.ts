// The render-time entity detector (detectEntities and its TLD list), in a
// chunk of its own: rich-text.tsx loads it after the first message renders,
// so it stays out of the startup bundle. Messages stored since the server
// detects entities already carry them; only older ones wait for this.
export { detectEntities } from "@achoo254/chat-core";
