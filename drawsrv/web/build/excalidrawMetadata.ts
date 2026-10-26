// The distributed Excalidraw component embeds upstream application settings.
// drawsrv owns persistence and does not use the upstream Firebase project.
export function stripFirebaseConfig(code: string): string {
  if (!code.includes("VITE_APP_FIREBASE_CONFIG")) return code;
  const property =
    /(?:\bVITE_APP_FIREBASE_CONFIG|["']VITE_APP_FIREBASE_CONFIG["'])\s*:\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*,?/g;
  const stripped = code.replace(property, "");
  if (stripped.includes("VITE_APP_FIREBASE_CONFIG")) {
    throw new Error("Unsupported Excalidraw Firebase configuration format");
  }
  return stripped;
}

export function assertNoFirebaseConfig(code: string, filename: string): void {
  if (
    /\bapiKey\b|VITE_APP_FIREBASE_CONFIG|\bauthDomain\b|\bdatabaseURL\b|\bstorageBucket\b|\bmessagingSenderId\b|firebaseapp\.com|firebaseio\.com/.test(
      code,
    )
  ) {
    // Never print the matched text: it may contain credentials.
    throw new Error(
      `Unexpected upstream Firebase configuration in ${filename}`,
    );
  }
}
