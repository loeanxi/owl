import { decodeBadge } from "./codec.js";
export function lookupBadge(hex) { return decodeBadge(hex).trim().toUpperCase(); }
