export function decodeBadge(hex) { return hex.match(/../g).map(pair => String.fromCharCode(parseInt(pair, 16) ^ 43)).join(""); }
