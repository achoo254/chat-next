// The first module of the sidecar: it must run before ws is loaded, so it is the first import of
// entry.mjs and has no import of its own. ws reads these two variables when its modules are first
// evaluated; set, they stop it from loading the optional native modules bufferutil and
// utf-8-validate, which Node would look up on disk (node_modules above the bundle). The engine
// starts the sidecar through sudo, which resets the environment, so the sidecar sets them itself
// instead of relying on what it was given.
process.env.WS_NO_BUFFER_UTIL = "1";
process.env.WS_NO_UTF_8_VALIDATE = "1";
