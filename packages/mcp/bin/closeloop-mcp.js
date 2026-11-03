#!/usr/bin/env node
// Development entry point: runs the TypeScript sources through tsx. (Phase 5 replaces this with a built bundle for npm.)
import { register } from "tsx/esm/api";

register();
await import("../src/bin.ts");
