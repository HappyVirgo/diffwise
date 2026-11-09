// Fake credentials used by the secret-detection fixtures.
//
// The fixture files store placeholders such as `{{FAKE:AWS_1}}` instead of the literal strings, and each
// value below is assembled from pieces at runtime. That keeps credential-shaped strings out of the
// repository, so GitHub push protection and other secret scanners don't flag the test data, while the
// heuristic reviewer still sees exactly the same input. None of these values is a real credential.

const join = (...parts: string[]): string => parts.join("");

export const FAKES: Readonly<Record<string, string>> = {
  AWS_1: join("AKIA", "Q3EXFAKEK7Z2WQ4N"),
  AWS_2: join("AKIA", "Z7FAKEQ4TEST9X2K"),
  AWS_SECRET_2: join("q8Vt2LmZr4XwN7pK", "c1HsJ9dFy3BgTe6UaR0oWiQn"),
  GH_1: join("ghp", "_", "1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ"),
  GH_2: join("ghp", "_", "FAKE0123456789abcdefghijklmnopqrstuv"),
  STRIPE_1: join("sk", "_live_", "51FakeFakeFakeFakeFake00"),
  STRIPE_2: join("sk", "_live_", "51Hx9FakeQ2rT7mWb3Kz8LpV0nYc"),
  PEM_BEGIN_RSA: join("-----BEGIN ", "RSA PRIVATE", " KEY-----"),
  PEM_END_RSA: join("-----END ", "RSA PRIVATE", " KEY-----"),
};

/** Replaces every `{{FAKE:NAME}}` placeholder with its assembled fake value. */
export function expandFakes(text: string): string {
  return text.replace(/\{\{FAKE:([A-Z0-9_]+)\}\}/g, (match, name: string) => {
    const value = FAKES[name];
    if (value === undefined) throw new Error(`Unknown fake placeholder ${match}`);
    return value;
  });
}
