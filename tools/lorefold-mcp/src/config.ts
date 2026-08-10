/**
 * Configuration for the Lorefold MCP bridge.
 *
 * Everything comes from the environment. There is no config file, no CLI flag
 * and no default credential: a password that lives anywhere but the process
 * environment is a password that ends up in git (AGENTS.md guardrail 3).
 */

export interface LorefoldConfig {
  /** Base URL of the Lorefold server, without a trailing slash. */
  readonly url: string;
  /**
   * HTTP Basic username. This is *not* an account — the server has none. It is
   * the presence name every write is attributed to, so it shows up in open
   * browsers as the author of the event. The server rejects a blank one.
   */
  readonly username: string;
  /**
   * The single shared graph password (`ATHENS_PASSWORD` on the server). May be
   * empty only if the server was started without a `:password`.
   */
  readonly password: string;
  /**
   * IANA timezone used to name daily notes.
   *
   * This MUST match the `TZ` of the Lorefold container (`ops/.env`). The server
   * resolves `@today` from its own container clock, so a mismatch means the
   * bridge tells the model one date while the write lands on another. See
   * `dates.ts` for why writes still go through `@today` rather than a title.
   */
  readonly timeZone: string;
}

export class LorefoldConfigError extends Error {
  override readonly name: string = 'LorefoldConfigError';
}

const DEFAULT_URL = 'http://localhost:3010';

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Reads config from a environment-like record (defaults to `process.env`).
 *
 * Throws `LorefoldConfigError` with an actionable message rather than starting
 * a server that will fail on every call.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LorefoldConfig {
  const rawUrl = (env['LOREFOLD_URL'] ?? '').trim() || DEFAULT_URL;

  let url: string;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`unsupported protocol "${parsed.protocol}"`);
    }
    url = stripTrailingSlashes(parsed.toString());
  } catch (cause) {
    throw new LorefoldConfigError(
      `LOREFOLD_URL is not a usable http(s) URL: ${JSON.stringify(rawUrl)}. ` +
        `Expected something like "${DEFAULT_URL}". (${(cause as Error).message})`,
    );
  }

  const username = (env['LOREFOLD_USERNAME'] ?? '').trim();
  if (username === '') {
    throw new LorefoldConfigError(
      'LOREFOLD_USERNAME is required and must not be blank. The Lorefold API ' +
        'uses it as the presence name that writes are attributed to, and ' +
        'rejects a blank username with 401 even when the password is correct. ' +
        'Pick a recognisable name, e.g. LOREFOLD_USERNAME=claude.',
    );
  }

  // Deliberately not required: a server started without `:password` accepts any
  // password, including none. If the server does have one, an empty value here
  // produces a clear 401 from `client.ts` rather than a confusing startup error.
  const password = env['LOREFOLD_PASSWORD'] ?? '';

  const timeZone = (env['LOREFOLD_TZ'] ?? '').trim() || hostTimeZone();
  assertValidTimeZone(timeZone);

  return { url, username, password, timeZone };
}

function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new LorefoldConfigError(
      `LOREFOLD_TZ is not a valid IANA timezone: ${JSON.stringify(timeZone)}. ` +
        'Use a name like "America/New_York", and make it match the TZ set for ' +
        'the Lorefold container in ops/.env.',
    );
  }
}
